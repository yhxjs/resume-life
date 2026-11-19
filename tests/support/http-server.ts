import type { Server } from "node:http";
import { randomInt } from "node:crypto";

/** OS 临时端口在 Windows 上可能落到 fetch 禁止的 6665 等端口；只保留高位端口。 */
export async function listenForFetch(server: Server): Promise<void> {
  for (let attempt = 0; attempt < 32; attempt++) {
    try { await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      // 不使用 listen(0)：系统可能连续分配低位端口，重绑 32 次仍无可用结果。
      try { server.listen(randomInt(16384, 65536), "127.0.0.1"); }
      catch (error) {
        server.off("error", onError);
        server.off("listening", onListening);
        reject(error);
      }
    }); } catch (error) {
      // Windows 的保留端口可能对随机高位端口返回 EACCES，换端口仍有机会成功。
      if (["EADDRINUSE", "EACCES"].includes((error as NodeJS.ErrnoException)?.code ?? "")) continue;
      throw error;
    }
    const address = server.address();
    // Fetch 标准禁用端口的最大值为 10080；不影响真实请求或提供方的业务回复。
    if (address && typeof address !== "string" && address.port > 10080) return;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  throw new Error("无法为合成 HTTP 服务分配 fetch 可用的高位端口");
}
