import { apiFetch } from "./api-fetch";
import { HttpError } from "./fetcher";

/** 已收到格式完整的服务端失败事件；不把断流或完成回调失败冒充服务端拒绝。 */
export class SseServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SseServerError";
  }
}

export type SseOptions<TDone = unknown> = {
  method?: "GET" | "POST" | "PATCH";
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  onDelta?: (deltaText: string, extra?: Record<string, unknown>) => void;
  onDone?: (data: TDone) => void | Promise<void>;
  onError?: (error: Error) => void;
};

/** 前端 SSE 客户端：只有 done 代表完成；截断、服务端错误及回调错误都交回调用者。 */
export async function fetchSse<TDone = unknown>(
  url: string,
  options: SseOptions<TDone>
): Promise<void> {
  const { method = "POST", headers = {}, body, signal, onDelta, onDone, onError } = options;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const onAbort = () => { void reader?.cancel().catch(() => {}); };

  try {
    if (signal?.aborted) return;
    const res = await apiFetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
    if (signal?.aborted) return;

    if (!(res.headers.get("content-type") || "").includes("text/event-stream")) {
      // 先判状态码再解析正文：SSE 期间后端重启会返回 HTML 错误页，直接 res.json() 会抛出
      // 「Unexpected token '<'」这类与真实原因无关的报错
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        if (res.ok) throw new Error("响应内容不是有效 JSON，未确认操作完成，请先核对已有结果");
      }
      if (!res.ok) {
        const data = json && typeof json === "object" ? json as { error?: unknown } : null;
        const message = typeof data?.error === "string" && data.error.trim()
          ? data.error
          : `请求错误 HTTP ${res.status}`;
        throw new HttpError(message, res.status);
      }
      if (signal?.aborted) return;
      await onDone?.(json as TDone);
      return;
    }
    if (!res.ok) throw new HttpError(`请求错误 HTTP ${res.status}`, res.status);
    reader = res.body?.getReader();
    if (!reader) throw new Error("当前运行环境不支持读取流响应");
    signal?.addEventListener("abort", onAbort, { once: true });

    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "message";
    let dataLines: string[] = [];

    const dispatchEvent = async (): Promise<boolean> => {
      const event = currentEvent;
      const rawData = dataLines.join("\n");
      currentEvent = "message";
      dataLines = [];
      if (!rawData) return false;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawData);
      } catch {
        if (event !== "delta") throw new Error("流式响应事件格式无效");
        parsed = rawData;
      }
      if (event === "delta") {
        if (typeof parsed === "string") onDelta?.(parsed);
        else {
          const data = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
          onDelta?.(typeof data.text === "string" ? data.text : "", data);
        }
      } else if (event === "done") {
        await onDone?.(parsed as TDone);
        return true;
      } else if (event === "error") {
        const data = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
        if (typeof data.error !== "string" || !data.error.trim()) throw new Error("流式响应错误事件格式无效");
        throw new SseServerError(data.error);
      }
      return false;
    };

    const handleLine = async (rawLine: string): Promise<boolean> => {
      const line = rawLine.replace(/\r$/, "");
      if (!line) return dispatchEvent();
      if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      return false;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) return;
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (await handleLine(line)) return;
        if (signal?.aborted) return;
      }
      if (done) break;
    }
    if (buffer && await handleLine(buffer)) return;
    if (await dispatchEvent()) return;
    throw new Error("流式响应意外中断，未收到完成事件，请重试");
  } catch (err) {
    if (signal?.aborted) return;
    const error = err instanceof Error ? err : new Error(String(err));
    onError?.(error);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader?.cancel().catch(() => {});
  }
}
