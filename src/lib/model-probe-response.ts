export const MODEL_PROBE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** 有界读取设置页探测请求的上游 JSON，超限时立即取消响应流。 */
export async function readModelProbeJson<T>(response: Response): Promise<T> {
  if (!response.body) throw new Error("模型服务响应缺少正文");
  const tooLarge = () => new Error("模型服务响应超过字节上限");
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MODEL_PROBE_MAX_RESPONSE_BYTES) {
    void response.body.cancel().catch(() => {});
    throw tooLarge();
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let reachedEnd = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEnd = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > MODEL_PROBE_MAX_RESPONSE_BYTES) throw tooLarge();
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as T;
  } catch (error) {
    if (!reachedEnd) void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
