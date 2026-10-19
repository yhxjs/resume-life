import { describe, expect, it, vi } from "vitest";

import {
  MAX_JSON_REQUEST_BYTES,
  MAX_MULTIPART_REQUEST_BYTES,
  MAX_PROJECT_MATERIAL_CHARS,
  MAX_UPLOAD_FILE_BYTES,
  RequestFormatError,
  RequestTooLargeError,
  assertContentLength,
  assertProjectMaterial,
  assertProjectMaterialTitle,
  readJsonBody,
} from "../request-limits";

function requestWithBody(
  body: ReadableStream<Uint8Array> | null,
  contentLength?: string,
  json = vi.fn(),
): Request {
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("Content-Length", contentLength);
  return { body, headers, json } as unknown as Request;
}

function streamFromChunks(
  chunks: Uint8Array[],
  options: { cancel?: () => void; close?: boolean } = {},
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (options.close !== false) controller.close();
    },
    cancel: options.cancel,
  });
}

describe("request limit constants", () => {
  it("allows 200 material title code points and rejects one more", () => {
    expect(() => assertProjectMaterialTitle("😀".repeat(200))).not.toThrow();
    expect(() => assertProjectMaterialTitle("😀".repeat(201))).toThrow(RequestTooLargeError);
    expect(() => assertProjectMaterialTitle("中".repeat(201))).toThrow(RequestTooLargeError);
  });
  it("exports the agreed request and persistence budgets", () => {
    expect(MAX_JSON_REQUEST_BYTES).toBe(1 * 1024 * 1024);
    expect(MAX_MULTIPART_REQUEST_BYTES).toBe(12 * 1024 * 1024);
    expect(MAX_UPLOAD_FILE_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_PROJECT_MATERIAL_CHARS).toBe(200_000);
  });
});

describe("assertContentLength", () => {
  it("does nothing when Content-Length is missing", () => {
    expect(() => assertContentLength(requestWithBody(null), 10)).not.toThrow();
  });

  it("allows the exact byte boundary and the largest safe integer", () => {
    expect(() => assertContentLength(requestWithBody(null, "10"), 10)).not.toThrow();
    expect(() =>
      assertContentLength(
        requestWithBody(null, String(Number.MAX_SAFE_INTEGER)),
        Number.MAX_SAFE_INTEGER,
      ),
    ).not.toThrow();
  });

  it("rejects one byte over the limit with the public 413 error shape", () => {
    expect.assertions(4);
    try {
      assertContentLength(requestWithBody(null, "11"), 10);
    } catch (error) {
      expect(error).toBeInstanceOf(RequestTooLargeError);
      expect(error).toBeInstanceOf(Error);
      expect((error as RequestTooLargeError).name).toBe("RequestTooLargeError");
      expect((error as RequestTooLargeError).status).toBe(413);
    }
  });

  it.each(["-1", "1.5", "1, 2", "+1", "01", "1e3", "", "9007199254740992"])(
    "rejects non-canonical Content-Length %j with the explicit format error shape",
    (contentLength) => {
      let error: unknown;
      try {
        assertContentLength(requestWithBody(null, contentLength), Number.MAX_SAFE_INTEGER);
      } catch (cause) {
        error = cause;
      }

      expect(error).toBeInstanceOf(RequestFormatError);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).name).toBe("RequestFormatError");
    },
  );
});

describe("readJsonBody", () => {
  it("checks Content-Length before acquiring a body reader", async () => {
    const getReader = vi.fn();
    const request = {
      body: { getReader },
      headers: new Headers({ "Content-Length": "11" }),
      json: vi.fn(),
    } as unknown as Request;

    await expect(readJsonBody(request, 10)).rejects.toBeInstanceOf(RequestTooLargeError);
    expect(getReader).not.toHaveBeenCalled();
  });

  it("allows an exact streamed byte boundary without Content-Length", async () => {
    const bytes = new TextEncoder().encode('{"a":1}');
    const request = requestWithBody(streamFromChunks([bytes.slice(0, 3), bytes.slice(3)]));

    await expect(readJsonBody(request, bytes.byteLength)).resolves.toEqual({ a: 1 });
  });

  it("copies reused one-byte views immediately and ignores empty chunks", async () => {
    const bytes = new TextEncoder().encode('{"copied":true}');
    const shared = new Uint8Array(1);
    let index = 0;
    let emitEmpty = true;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitEmpty) {
          emitEmpty = false;
          controller.enqueue(new Uint8Array(0));
          return;
        }
        if (index === bytes.byteLength) {
          controller.close();
          return;
        }

        shared[0] = bytes[index]!;
        index += 1;
        emitEmpty = true;
        controller.enqueue(shared);
      },
    }, { highWaterMark: 0 });

    await expect(readJsonBody(requestWithBody(body), bytes.byteLength)).resolves.toEqual({
      copied: true,
    });
  });

  it("rejects a streamed body one byte over the limit without Content-Length", async () => {
    const bytes = new TextEncoder().encode('{"a":1}');

    await expect(
      readJsonBody(requestWithBody(streamFromChunks([bytes])), bytes.byteLength - 1),
    ).rejects.toBeInstanceOf(RequestTooLargeError);
  });

  it("rejects actual bytes over the limit when Content-Length declares a smaller body", async () => {
    const bytes = new TextEncoder().encode('{"actual":"larger"}');

    await expect(
      readJsonBody(requestWithBody(streamFromChunks([bytes]), "1"), bytes.byteLength - 1),
    ).rejects.toBeInstanceOf(RequestTooLargeError);
  });

  it("uses UTF-8 bytes rather than JavaScript character length", async () => {
    const source = '{"value":"你"}';
    const bytes = new TextEncoder().encode(source);
    const multibyteStart = bytes.indexOf(0xe4);

    await expect(
      readJsonBody(
        requestWithBody(
          streamFromChunks([bytes.slice(0, multibyteStart + 1), bytes.slice(multibyteStart + 1)]),
        ),
        bytes.byteLength,
      ),
    ).resolves.toEqual({ value: "你" });
    await expect(
      readJsonBody(requestWithBody(streamFromChunks([bytes])), source.length),
    ).rejects.toBeInstanceOf(RequestTooLargeError);
  });

  it("uses the default one MiB JSON budget", async () => {
    const bytes = new Uint8Array(MAX_JSON_REQUEST_BYTES + 1).fill(0x20);

    await expect(readJsonBody(requestWithBody(streamFromChunks([bytes])))).rejects.toBeInstanceOf(
      RequestTooLargeError,
    );
  });

  it("wraps empty bodies, invalid UTF-8, and invalid JSON as request format errors", async () => {
    const emptyError = await readJsonBody(requestWithBody(null), 10).catch((error: unknown) => error);
    const utf8Error = await readJsonBody(
      requestWithBody(streamFromChunks([Uint8Array.of(0xff)])),
      10,
    ).catch((error: unknown) => error);
    const jsonError = await readJsonBody(
      requestWithBody(streamFromChunks([new TextEncoder().encode("{broken")])),
      10,
    ).catch((error: unknown) => error);

    expect(emptyError).toBeInstanceOf(RequestFormatError);
    expect(utf8Error).toBeInstanceOf(RequestFormatError);
    expect(jsonError).toBeInstanceOf(RequestFormatError);
    expect((emptyError as Error).name).toBe("RequestFormatError");
    expect((utf8Error as Error).name).toBe("RequestFormatError");
    expect((jsonError as Error).name).toBe("RequestFormatError");
    expect(emptyError).not.toBeInstanceOf(RequestTooLargeError);
    expect(utf8Error).not.toBeInstanceOf(RequestTooLargeError);
    expect(jsonError).not.toBeInstanceOf(RequestTooLargeError);
  });

  it("parses the stream directly without calling request.json", async () => {
    const json = vi.fn(() => Promise.resolve({ wrong: true }));
    const bytes = new TextEncoder().encode('{"right":true}');
    const request = requestWithBody(streamFromChunks([bytes]), undefined, json);

    await expect(readJsonBody(request)).resolves.toEqual({ right: true });
    expect(json).not.toHaveBeenCalled();
  });

  it("cancels unread data and releases the reader lock on overflow", async () => {
    const cancel = vi.fn();
    const bytes = new TextEncoder().encode('{"tooLarge":true}');
    const body = streamFromChunks([bytes], { cancel, close: false });

    await expect(readJsonBody(requestWithBody(body), bytes.byteLength - 1)).rejects.toBeInstanceOf(
      RequestTooLargeError,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("rejects and unlocks without waiting for a pending cancel", async () => {
    let markCancelStarted!: () => void;
    let releaseCancel!: () => void;
    const cancelStarted = new Promise<void>((resolve) => {
      markCancelStarted = resolve;
    });
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const cancel = vi.fn(() => {
      markCancelStarted();
      return cancelGate;
    });
    const body = streamFromChunks([Uint8Array.of(1, 2)], { cancel, close: false });
    const result = readJsonBody(requestWithBody(body), 1);
    const settled = result.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );

    await cancelStarted;
    try {
      const outcome = await Promise.race([
        settled,
        new Promise<{ status: "pending" }>((resolve) => {
          queueMicrotask(() => resolve({ status: "pending" }));
        }),
      ]);

      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(RequestTooLargeError);
      }
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    } finally {
      releaseCancel();
      await settled;
    }
  });

  it("cancels and unlocks after a reader failure while preserving the read error", async () => {
    const readError = new SyntaxError("read failed");
    const cancel = vi.fn();
    const releaseLock = vi.fn();
    const request = {
      body: {
        getReader: () => ({
          read: vi.fn().mockRejectedValue(readError),
          cancel,
          releaseLock,
        }),
      },
      headers: new Headers(),
      json: vi.fn(),
    } as unknown as Request;

    await expect(readJsonBody(request, 10)).rejects.toBe(readError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("preserves an undefined read rejection when cleanup fails", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("cancel failed"));
    const releaseLock = vi.fn(() => {
      throw new Error("release failed");
    });
    const request = {
      body: {
        getReader: () => ({
          read: vi.fn().mockRejectedValue(undefined),
          cancel,
          releaseLock,
        }),
      },
      headers: new Headers(),
      json: vi.fn(),
    } as unknown as Request;

    const outcome = await readJsonBody(request, 10).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );

    expect(outcome).toEqual({ status: "rejected", reason: undefined });
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("does not let cancel or release failures replace an overflow error", async () => {
    const request = {
      body: {
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: false, value: Uint8Array.of(1, 2) }),
          cancel: vi.fn().mockRejectedValue(new Error("cancel failed")),
          releaseLock: vi.fn(() => {
            throw new Error("release failed");
          }),
        }),
      },
      headers: new Headers(),
      json: vi.fn(),
    } as unknown as Request;

    await expect(readJsonBody(request, 1)).rejects.toBeInstanceOf(RequestTooLargeError);
  });

  it("releases the reader lock without cancellation after natural EOF", async () => {
    const cancel = vi.fn();
    const bytes = new TextEncoder().encode("null");
    const body = streamFromChunks([bytes], { cancel });

    await expect(readJsonBody(requestWithBody(body), bytes.byteLength)).resolves.toBeNull();
    expect(cancel).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });
});

describe("assertProjectMaterial", () => {
  it("counts Unicode code points and allows the exact boundary", () => {
    expect(() => assertProjectMaterial("😀".repeat(MAX_PROJECT_MATERIAL_CHARS))).not.toThrow();
  });

  it("rejects one Unicode code point over the boundary", () => {
    expect(() => assertProjectMaterial("😀".repeat(MAX_PROJECT_MATERIAL_CHARS) + "a")).toThrow(
      RequestTooLargeError,
    );
  });
});
