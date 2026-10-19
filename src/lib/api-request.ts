import {
  MAX_JSON_REQUEST_BYTES,
  RequestFormatError,
  RequestTooLargeError,
  readJsonBody,
  readTextBody,
} from "./request-limits";

export type ApiJsonResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response };

type ApiJsonOptions<T> = {
  allowEmpty?: boolean;
  emptyValue?: T;
};

function errorResponse(error: RequestFormatError | RequestTooLargeError): Response {
  const tooLarge = error instanceof RequestTooLargeError;
  return Response.json(
    { error: tooLarge ? "请求体超过 1 MiB" : "请求体必须是有效 JSON" },
    { status: tooLarge ? 413 : 400 },
  );
}

export async function parseApiJson<T>(
  request: Request,
  options: ApiJsonOptions<T> = {},
): Promise<ApiJsonResult<T>> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return {
      ok: false,
      response: Response.json(
        { error: "Content-Type 必须为 application/json" },
        { status: 415 },
      ),
    };
  }

  try {
    if (options.allowEmpty) {
      const text = await readTextBody(request, MAX_JSON_REQUEST_BYTES);
      if (!text.trim()) return { ok: true, data: options.emptyValue as T };
      try {
        return { ok: true, data: JSON.parse(text) as T };
      } catch {
        throw new RequestFormatError("Invalid JSON request body");
      }
    }
    return { ok: true, data: await readJsonBody<T>(request, MAX_JSON_REQUEST_BYTES) };
  } catch (error) {
    if (error instanceof RequestFormatError || error instanceof RequestTooLargeError) {
      return { ok: false, response: errorResponse(error) };
    }
    throw error;
  }
}
