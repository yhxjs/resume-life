export const MAX_JSON_REQUEST_BYTES = 1 * 1024 * 1024;
export const MAX_MULTIPART_REQUEST_BYTES = 12 * 1024 * 1024;
export const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PROJECT_MATERIAL_CHARS = 200_000;
export const MAX_PROJECT_MATERIAL_TITLE_CHARS = 200;

export class RequestTooLargeError extends Error {
  readonly status = 413;

  constructor(message = "Request body exceeds the allowed size") {
    super(message);
    this.name = "RequestTooLargeError";
  }
}

export class RequestFormatError extends TypeError {
  constructor(message = "Invalid request format") {
    super(message);
    this.name = "RequestFormatError";
  }
}

export function assertContentLength(request: Request, maxBytes: number): void {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength === null) return;

  if (!/^(?:0|[1-9]\d*)$/.test(contentLength)) {
    throw new RequestFormatError("Content-Length must be a canonical non-negative safe integer");
  }

  const length = Number(contentLength);
  if (!Number.isSafeInteger(length)) {
    throw new RequestFormatError("Content-Length must be a canonical non-negative safe integer");
  }
  if (length > maxBytes) throw new RequestTooLargeError();
}

function decodeTextBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RequestFormatError("Invalid UTF-8 request body");
  }
}

function parseJsonBytes<T>(bytes: Uint8Array): T {
  try {
    return JSON.parse(decodeTextBytes(bytes)) as T;
  } catch (error) {
    if (error instanceof RequestFormatError) throw error;
    throw new RequestFormatError("Invalid JSON request body");
  }
}

async function readBody<T>(
  request: Request,
  maxBytes: number,
  parse: (bytes: Uint8Array) => T,
): Promise<T> {
  assertContentLength(request, maxBytes);

  if (!request.body) {
    return parse(new Uint8Array(0));
  }

  const reader = request.body.getReader();
  let body = new Uint8Array(0);
  let totalBytes = 0;
  let naturalEof = false;
  let hasPrimaryError = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        naturalEof = true;
        break;
      }

      if (value.byteLength === 0) continue;

      const nextTotalBytes = totalBytes + value.byteLength;
      if (nextTotalBytes > maxBytes) throw new RequestTooLargeError();
      if (nextTotalBytes > body.byteLength) {
        let nextCapacity = Math.min(body.byteLength === 0 ? 1024 : body.byteLength * 2, maxBytes);
        if (nextCapacity < nextTotalBytes) nextCapacity = nextTotalBytes;
        const grown = new Uint8Array(nextCapacity);
        grown.set(body.subarray(0, totalBytes));
        body = grown;
      }
      body.set(value, totalBytes);
      totalBytes = nextTotalBytes;
    }
  } catch (error) {
    hasPrimaryError = true;
    if (!naturalEof) {
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        // Cleanup must not replace the read or size-limit error.
      }
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch (error) {
      if (!hasPrimaryError) throw error;
    }
  }

  return parse(body.subarray(0, totalBytes));
}

export function readTextBody(
  request: Request,
  maxBytes = MAX_JSON_REQUEST_BYTES,
): Promise<string> {
  return readBody(request, maxBytes, decodeTextBytes);
}

export function readJsonBody<T>(
  request: Request,
  maxBytes = MAX_JSON_REQUEST_BYTES,
): Promise<T> {
  return readBody(request, maxBytes, parseJsonBytes<T>);
}

export function assertProjectMaterial(content: string): void {
  let codePoints = 0;
  const iterator = content[Symbol.iterator]();
  while (!iterator.next().done) {
    codePoints += 1;
    if (codePoints > MAX_PROJECT_MATERIAL_CHARS) throw new RequestTooLargeError();
  }
}

export function assertProjectMaterialTitle(title: string): void {
  let codePoints = 0;
  const iterator = title[Symbol.iterator]();
  while (!iterator.next().done) {
    codePoints += 1;
    if (codePoints > MAX_PROJECT_MATERIAL_TITLE_CHARS) throw new RequestTooLargeError();
  }
}
