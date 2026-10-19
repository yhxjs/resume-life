import { errorMessage } from "@/lib/error-message";
import { logServerError } from "@/lib/server-errors";
import { assertDataGeneration, DataGenerationConflictError } from "@/lib/data-generation";
export type SseEmitter = {
  sendDelta: (text: string, extra?: Record<string, unknown>) => void;
  sendDone: (payload: unknown) => void;
  sendError: (error: string | Error) => void;
  signal: AbortSignal;
};

/**
 * 构造 Next.js App Router 适用的标准 Server-Sent Events (SSE) Response
 * 规范：
 * - event: delta -> data: { text, ...extra }
 * - event: done  -> data: { ...payload }
 * - event: error -> data: { error: message }
 * - : keep-alive 每 15s 心跳
 *
 * requestId 由各路由从请求上取来传入（`requestIdFrom(req)`）。签名刻意不接收
 * Request 本身：这个模块是纯流构造器，不该知道请求从哪来；而且 handler 里
 * 拿不到 Request 的地方（如 interview-commands）也能把 ID 传进来。
 */
export function createSseResponse(
  handler: (emitter: SseEmitter) => Promise<void>,
  requestId?: string
): Response {
  const encoder = new TextEncoder();
  const abortController = new AbortController();

  const stream = new ReadableStream({
    async start(controller) {
      let isClosed = false;

      const safeEnqueue = (str: string) => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(str));
        } catch {
          isClosed = true;
        }
      };

      const emitter: SseEmitter = {
        signal: abortController.signal,
        sendDelta(text, extra) {
          if (isClosed) return;
          assertDataGeneration();
          const payload = JSON.stringify({ text, ...(extra || {}) });
          safeEnqueue(`event: delta\ndata: ${payload}\n\n`);
        },
        sendDone(payload) {
          if (isClosed) return;
          assertDataGeneration();
          const data = JSON.stringify(payload);
          safeEnqueue(`event: done\ndata: ${data}\n\n`);
          isClosed = true;
          try {
            controller.close();
          } catch {}
        },
        sendError(error) {
          if (isClosed) return;
          let message = errorMessage(error);
          try {
            assertDataGeneration();
          } catch (conflict) {
            if (!(conflict instanceof DataGenerationConflictError)) throw conflict;
            message = conflict.message;
          }
          safeEnqueue(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
          isClosed = true;
          try {
            controller.close();
          } catch {}
        },
      };

      // 定时保活心跳，防止中间代理/网关闲置超时
      const heartbeatTimer = setInterval(() => {
        safeEnqueue(": keep-alive\n\n");
      }, 15000);

      try {
        await handler(emitter);
      } catch (err) {
        if (err instanceof DataGenerationConflictError) {
          emitter.sendError(err.message);
          return;
        }
        // 已知的业务错误（LlmConfigError 等）由各生产者自行 catch 并保留原文案，这里只兜漏网的。
        const loggedId = logServerError("sse.handler", err, { requestId, status: 500 });
        emitter.sendError(`服务端处理失败（${loggedId}）`);
      } finally {
        clearInterval(heartbeatTimer);
        if (!isClosed) {
          try {
            controller.close();
          } catch {}
          isClosed = true;
        }
      }
    },
    cancel() {
      // 客户端主动断开连接（如刷新或关闭页面）
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
