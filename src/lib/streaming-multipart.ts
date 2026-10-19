import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import Busboy from "busboy";

import {
  MAX_MULTIPART_REQUEST_BYTES,
  MAX_UPLOAD_FILE_BYTES,
  RequestTooLargeError,
  assertContentLength,
} from "./request-limits";

const TEMP_DIRECTORY_PREFIX = "resume-life-upload-";
const MAX_FIELD_BYTES = 64 * 1024;

export class MultipartFormatError extends Error {
  constructor(message = "Invalid multipart form data") {
    super(message);
    this.name = "MultipartFormatError";
  }
}

function isMultipartContentType(contentType: string | null): contentType is string {
  return contentType !== null && /^\s*multipart\/form-data(?:\s*;|$)/i.test(contentType);
}

export function isMultipartFormDataRequest(request: Request): boolean {
  return isMultipartContentType(request.headers.get("Content-Type"));
}

export type ParsedUpload = {
  fields: Record<string, string>;
  file: { path: string; filename: string; mimeType: string; bytes: number } | null;
  dispose(): void;
};

function safeUploadDirectory(directory: string): string {
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir())
    || !path.basename(resolved).startsWith(TEMP_DIRECTORY_PREFIX)
  ) {
    throw new Error("Refusing to remove an unsafe upload directory");
  }
  return resolved;
}

function removeUploadDirectory(directory: string): void {
  fs.rmSync(safeUploadDirectory(directory), { recursive: true, force: true });
}

function cancelWithoutWaiting(cancel: () => unknown): void {
  try {
    void Promise.resolve(cancel()).catch(() => undefined);
  } catch {
    // Cancellation cleanup must not replace the primary error.
  }
}

function destroyWritable(stream: Writable | undefined): void {
  if (!stream || stream.destroyed) return;
  try {
    if (stream.listenerCount("error") === 0) stream.once("error", () => undefined);
    stream.destroy();
  } catch {
    // Stream cleanup must not replace the primary error.
  }
}

function waitForDrain(stream: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Multipart parser closed before draining"));
    };

    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

export async function parseMultipartUpload(request: Request): Promise<ParsedUpload> {
  assertContentLength(request, MAX_MULTIPART_REQUEST_BYTES);

  const requestBody = request.body;
  const fields: Record<string, string> = {};
  const activeWriters = new Set<fs.WriteStream>();
  const writePromises: Promise<void>[] = [];
  let parser: ReturnType<typeof Busboy> | undefined;
  let sizeProbe: ReturnType<typeof Busboy> | undefined;
  let directory: string | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let parsedFile: ParsedUpload["file"] = null;
  let hasFailure = false;
  let failure: unknown;
  let naturalEof = false;
  let rejectFailure!: (error?: unknown) => void;
  const failureSignal = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  void failureSignal.catch(() => undefined);

  const destroyStreams = () => {
    destroyWritable(parser);
    destroyWritable(sizeProbe);
    for (const writer of activeWriters) destroyWritable(writer);
  };
  const fail = (error: unknown) => {
    if (hasFailure) return;
    hasFailure = true;
    failure = error;
    rejectFailure(error);
    destroyStreams();
  };

  try {
    const contentType = request.headers.get("Content-Type");
    if (!isMultipartContentType(contentType)) {
      throw new MultipartFormatError();
    }
    if (!requestBody) throw new MultipartFormatError();

    const headers = { "content-type": contentType };
    let createdParser: ReturnType<typeof Busboy>;
    let createdSizeProbe: ReturnType<typeof Busboy>;
    try {
      createdParser = Busboy({
        headers,
        defParamCharset: "utf-8",
        preservePath: true,
        limits: {
          files: 1,
          fileSize: MAX_UPLOAD_FILE_BYTES,
          fields: 8,
          fieldSize: MAX_FIELD_BYTES,
          parts: 10,
        },
      });

      // Busboy flags equality as truncated, so a probe with one-byte lookahead
      // distinguishes an allowed exact boundary from a true overflow.
      createdSizeProbe = Busboy({
        headers,
        defParamCharset: "utf-8",
        preservePath: true,
        limits: {
          fileSize: MAX_UPLOAD_FILE_BYTES + 1,
          fieldSize: MAX_FIELD_BYTES + 1,
          parts: 11,
        },
      });
    } catch {
      throw new MultipartFormatError();
    }
    parser = createdParser;
    sizeProbe = createdSizeProbe;

    const uploadDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), TEMP_DIRECTORY_PREFIX),
    );
    directory = uploadDirectory;

    createdParser.on("field", (name, value) => {
      fields[name] = value;
    });
    createdParser.on("file", (_name, file, info) => {
      const filePath = path.join(uploadDirectory, randomUUID());
      let writer: fs.WriteStream;
      try {
        writer = fs.createWriteStream(filePath, { flags: "wx" });
      } catch (error) {
        file.resume();
        fail(error);
        return;
      }

      let bytes = 0;
      parsedFile = {
        path: filePath,
        filename: info.filename,
        mimeType: info.mimeType,
        bytes: 0,
      };
      file.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (parsedFile) parsedFile.bytes = bytes;
      });
      activeWriters.add(writer);
      const writePromise = pipeline(file, writer)
        .then(() => {
          activeWriters.delete(writer);
        })
        .catch((error: unknown) => {
          activeWriters.delete(writer);
          fail(error);
          throw error;
        });
      void writePromise.catch(() => undefined);
      writePromises.push(writePromise);
    });
    createdParser.on("filesLimit", () => fail(new MultipartFormatError()));
    createdParser.on("fieldsLimit", () => fail(new MultipartFormatError()));
    createdParser.on("error", () => fail(new MultipartFormatError()));

    createdSizeProbe.on("file", (_name, file) => {
      file.once("limit", () => fail(new RequestTooLargeError("Uploaded file exceeds the allowed size")));
      file.on("error", () => fail(new MultipartFormatError()));
      file.resume();
    });
    createdSizeProbe.on("field", (_name, _value, info) => {
      if (info.valueTruncated) fail(new MultipartFormatError());
    });
    createdSizeProbe.on("partsLimit", () => fail(new MultipartFormatError()));
    createdSizeProbe.on("error", () => fail(new MultipartFormatError()));

    const parserDone = finished(createdParser);
    const sizeProbeDone = finished(createdSizeProbe);
    void parserDone.catch(() => undefined);
    void sizeProbeDone.catch(() => undefined);

    const writeChunk = async (chunk: Buffer): Promise<void> => {
      const drains: Promise<void>[] = [];
      const parserNeedsDrain = !createdParser.write(chunk);
      if (hasFailure) throw failure;
      const sizeProbeNeedsDrain = !createdSizeProbe.write(chunk);
      if (hasFailure) throw failure;
      if (parserNeedsDrain) drains.push(waitForDrain(createdParser));
      if (sizeProbeNeedsDrain) drains.push(waitForDrain(createdSizeProbe));
      if (drains.length > 0) {
        await Promise.race([Promise.all(drains).then(() => undefined), failureSignal]);
      }
    };

    const bodyReader = requestBody.getReader();
    reader = bodyReader;
    let requestBytes = 0;
    for (;;) {
      const { done, value } = await Promise.race([bodyReader.read(), failureSignal]);
      if (done) {
        naturalEof = true;
        break;
      }
      if (value.byteLength === 0) continue;

      requestBytes += value.byteLength;
      if (requestBytes > MAX_MULTIPART_REQUEST_BYTES) throw new RequestTooLargeError();
      await writeChunk(Buffer.from(value));
    }

    createdParser.end();
    createdSizeProbe.end();
    await Promise.race([
      Promise.all([parserDone, sizeProbeDone]).then(() => undefined),
      failureSignal,
    ]);
    await Promise.race([Promise.all(writePromises).then(() => undefined), failureSignal]);
    if (hasFailure) throw failure;

    bodyReader.releaseLock();
    let disposed = false;
    return {
      fields,
      file: parsedFile,
      dispose() {
        if (disposed) return;
        removeUploadDirectory(uploadDirectory);
        disposed = true;
      },
    };
  } catch (error) {
    const primaryError = hasFailure ? failure : error;
    if (reader) {
      if (!naturalEof) cancelWithoutWaiting(() => reader?.cancel());
    } else if (requestBody) {
      cancelWithoutWaiting(() => requestBody.cancel());
    }
    destroyStreams();
    if (writePromises.length > 0) await Promise.allSettled(writePromises);
    if (directory) {
      try {
        removeUploadDirectory(directory);
      } catch {
        // Directory cleanup must not replace the primary error.
      }
    }
    if (reader) {
      try {
        reader.releaseLock();
      } catch {
        // Reader cleanup must not replace the primary error.
      }
    }
    throw primaryError;
  }
}
