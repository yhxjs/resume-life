import { expect, test, type APIRequestContext } from "@playwright/test";
import { request as httpRequest } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptySummary } from "../../src/lib/summary";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

async function partialRequest(request: APIRequestContext, root: string, body: string) {
  const cookie = (await request.storageState()).cookies.map(item => `${item.name}=${item.value}`).join("; ");
  const response = Promise.withResolvers<{ status: number; body: string; contentType: string }>();
  const upload = httpRequest(`http://127.0.0.1:3319${root}/scan-repo`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Connection: "close" },
  }, incoming => {
    const chunks: Buffer[] = [];
    incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
    incoming.on("error", response.reject);
    incoming.on("end", () => response.resolve({ status: incoming.statusCode!, body: Buffer.concat(chunks).toString("utf8"), contentType: incoming.headers["content-type"] ?? "" }));
  });
  upload.on("error", response.reject);
  // 提前注册拒绝处理；清理尚未完成的请求时仍等待同一响应 promise。
  void response.promise.catch(() => undefined);
  await new Promise<void>((resolve, reject) => upload.write(body.slice(0, 8), error => error ? reject(error) : resolve()));
  return { response: response.promise, release: () => upload.end(body.slice(8)), close: () => upload.destroy() };
}

for (const action of ["scan", "check-relation"]) test(`源码${action}收取请求体期间项目被删除，返回404且不使用旧档案`, async ({ request }) => {
  const baseline = await exportEncryptedBackup(request);
  expect(baseline.response.ok()).toBe(true);
  const prefix = "resume-life-e2e-scan-capture-";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(directory, "README.md"), "Synthetic source.");
  let pending: Awaited<ReturnType<typeof partialRequest>> | undefined;
  try {
    const created = await request.post("/api/projects", { data: { name: `慢请求 ${action}` } });
    expect(created.status()).toBe(201);
    const root = `/api/projects/${(await created.json()).id}`;
    // 旧档案超预算，因此旧实现的 scan 也会提前失败，不会启动真实 CLI。
    expect((await request.patch(root, { data: { summary: { ...emptySummary(), responsibilities: "文".repeat(40_001) } } })).status()).toBe(200);
    pending = await partialRequest(request, root, JSON.stringify({ repoPath: directory, preferredCli: "codex", action }));
    // 在首块已经发出、正文仍未结束时，完成独立连接上的只读往返。
    for (let index = 0; index < 3; index++) expect((await request.get(root)).status()).toBe(200);
    expect((await request.delete(root)).status()).toBe(200);
    pending.release();
    const response = await pending.response;
    expect(response.status, response.body).toBe(404);
    expect(response.contentType).toContain("application/json");
    expect(JSON.parse(response.body)).toEqual({ error: "项目不存在" });
    expect((await request.get(root)).status()).toBe(404);
    expect(await (await request.get(`${root}/summary-history`)).json()).toEqual({ error: "项目不存在" });
  } finally {
    pending?.close();
    await pending?.response.catch(() => undefined);
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)) throw new Error("Unsafe cleanup path");
    fs.rmSync(resolved, { recursive: true, force: true });
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
