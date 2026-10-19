import { expect, test } from "@playwright/test";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function rawResponse(pathname: string, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(3319, "127.0.0.1", () => {
      socket.write("GET " + pathname + " HTTP/1.1\r\nHost: " + host + "\r\nConnection: close\r\n\r\n");
    });
    let response = "";
    socket.on("data", (chunk) => { response += chunk.toString("latin1"); });
    socket.on("error", reject);
    socket.on("end", () => {
      if (!/^HTTP\/1\.1 \d{3}/u.test(response)) reject(new Error("服务未返回 HTTP 响应"));
      else resolve(response);
    });
  });
}

async function rawStatus(pathname: string, host: string): Promise<number> {
  const response = await rawResponse(pathname, host);
  return Number(/^HTTP\/1\.1 (\d{3})/u.exec(response)![1]);
}

test("公开上传路径与 API 均拒绝非法 Host", async () => {
  expect(await rawStatus("/uploads/nonexistent-avatar.png", "attacker.invalid")).toBe(403);
  expect(await rawStatus("/api/health", "attacker.invalid")).toBe(403);
  expect(await rawStatus("/uploads/nonexistent-avatar.png", "127.0.0.1:3319")).toBe(404);
});

test("公开上传路径始终阻断静态文件访问", async () => {
  const filename = `synthetic-${randomUUID()}.png`;
  const filepath = path.join(process.cwd(), "public", "uploads", filename);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, "synthetic-only", { flag: "wx" });
  try {
    const response = await rawResponse(`/uploads/${filename}`, "127.0.0.1:3319");
    expect(response).toMatch(/^HTTP\/1\.1 404/u);
    expect(response).not.toContain("synthetic-only");
    expect(await rawStatus(`/uploads/${filename}`, "attacker.invalid")).toBe(403);
  } finally {
    fs.rmSync(filepath);
  }
});
