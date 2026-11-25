import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listenForFetch } from "../../../tests/support/http-server";

const directories: string[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();
const apiKey = "synthetic-eval-proxy-api-key";
const username = "synthetic-eval-proxy-user";
const password = "synthetic-eval-proxy-password";
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

async function listen(server: Server) {
  servers.push(server);
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await listenForFetch(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local server address");
  return `127.0.0.1:${address.port}`;
}

async function service(vision: boolean) {
  const requests: { authorization: string | undefined; proxyAuthorization: string | undefined }[] = [];
  const target = await listen(createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    requests.push({ authorization: req.headers.authorization, proxyAuthorization: req.headers["proxy-authorization"] as string | undefined });
    const content = vision ? "合成文字，仅验证代理传输，不验证识图。"
      : JSON.stringify({ isRelated: null, reason: "合成结果，仅验证代理传输。" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
  }));
  const connections: { target: string | undefined; authorization: string | undefined }[] = [];
  const proxy = createServer((_req, res) => { res.writeHead(405); res.end(); });
  proxy.on("connect", (req, client, head) => {
    connections.push({ target: req.url, authorization: req.headers["proxy-authorization"] as string | undefined });
    if (req.url !== target || req.headers["proxy-authorization"] !== authorization) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(Number(target.split(":")[1]), "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  });
  const proxyAddress = await listen(proxy);
  return { requests, connections, target, baseUrl: `http://${target}/v1`, proxyUrl: `http://${proxyAddress}` };
}

async function run(vision: boolean, live: boolean, config: Record<string, string>) {
  const production = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-eval-proxy-sentinel-"));
  directories.push(production);
  fs.writeFileSync(path.join(production, "sentinel.txt"), "unchanged");
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(?:PROMPT|VISION)_EVAL_/.test(name)) delete env[name];
  const child = spawn(process.execPath, [path.resolve(`scripts/eval-${vision ? "vision" : "prompts"}.mjs`),
    ...(!vision ? ["--suite=repo"] : []), ...(live ? ["--live"] : [])], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, ...config, RESUME_LIFE_DATA_DIR: production },
  });
  let text = "";
  child.stdout.on("data", data => { text += data; });
  child.stderr.on("data", data => { text += data; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Local proxy evaluation exceeded 30s")); }, 30_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", status => { clearTimeout(timer); resolve(status); });
  });
  const output = text.match(/(?:提示词快照（零模型调用）|真实模型评估|视觉评估目录)：([^\r\n]+)/)?.[1];
  if (output) directories.push(output);
  expect(output).toBeDefined();
  expect(fs.readdirSync(production)).toEqual(["sentinel.txt"]);
  expect(fs.readFileSync(path.join(production, "sentinel.txt"), "utf8")).toBe("unchanged");
  const reports = fs.readdirSync(output!).filter(name => name.endsWith(".json"))
    .map(name => fs.readFileSync(path.join(output!, name), "utf8"));
  for (const secret of [apiKey, username, password, authorization]) {
    expect(text).not.toContain(secret);
    for (const report of reports) expect(report).not.toContain(secret);
  }
  const summary = JSON.parse(fs.readFileSync(path.join(output!, "summary.json"), "utf8"));
  return { code, text, output: output!, summary };
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !/^resume-life-(?:eval-proxy-sentinel|prompt-eval|vision-eval)-/.test(path.basename(target))) {
      throw new Error("Unsafe proxy evaluation cleanup path");
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe.each([false, true])("评测专用代理：vision=%s（仅本地合成服务）", vision => {
  const prefix = vision ? "VISION_EVAL" : "PROMPT_EVAL";
  const configuration = (baseUrl: string) => ({
    [`${prefix}_BASE_URL`]: baseUrl, [`${prefix}_API_KEY`]: apiKey, [`${prefix}_MODEL`]: "synthetic-model",
  });

  it.each([false, true])("真实入口经过认证代理，凭证嵌入 URL=%s，报告与控制台不含凭证", async embedded => {
    const local = await service(vision);
    const result = await run(vision, true, {
      ...configuration(local.baseUrl),
      [`${prefix}_PROXY_URL`]: embedded ? local.proxyUrl.replace("http://", `http://${username}:${password}@`) : local.proxyUrl,
      ...(!embedded ? { [`${prefix}_PROXY_USERNAME`]: username, [`${prefix}_PROXY_PASSWORD`]: password } : {}),
    });
    expect(result.code, result.text).toBe(0);
    expect(result.summary).toMatchObject({ status: "completed", mode: "live", semanticQuality: "pending-human-review" });
    expect(local.requests).toHaveLength(vision ? 7 : 5);
    expect(local.connections.length).toBeGreaterThan(0);
    expect(local.connections.every(item => item.target === local.target && item.authorization === authorization)).toBe(true);
    expect(local.requests.every(item => item.authorization === `Bearer ${apiKey}` && item.proxyAuthorization === undefined)).toBe(true);
  });

  it("未指定代理地址时继续直连，单独提供认证字段不启用代理", async () => {
    const local = await service(vision);
    const result = await run(vision, true, {
      ...configuration(local.baseUrl), [`${prefix}_PROXY_USERNAME`]: username, [`${prefix}_PROXY_PASSWORD`]: password,
    });
    expect(result.code, result.text).toBe(0);
    expect(local.requests).toHaveLength(vision ? 7 : 5);
    expect(local.connections).toHaveLength(0);
  });

  it("快照忽略残留 live 标志和无效代理配置，零网络、零数据库", async () => {
    const local = await service(vision);
    const result = await run(vision, false, {
      ...configuration(local.baseUrl), [`${prefix}_LIVE`]: "1", [`${prefix}_PROXY_URL`]: `ftp://${username}:${password}@invalid.invalid`,
    });
    expect(result.code, result.text).toBe(0);
    expect(result.summary).toMatchObject({ status: "completed", mode: "snapshot" });
    expect(local.requests).toHaveLength(0);
    expect(local.connections).toHaveLength(0);
    expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
  });

  it("真实入口拒绝无效代理协议，不回退直连，也不泄漏 URL 凭证", async () => {
    const local = await service(vision);
    const result = await run(vision, true, {
      ...configuration(local.baseUrl), [`${prefix}_PROXY_URL`]: `ftp://${username}:${password}@invalid.invalid`,
    });
    expect(result.code).toBe(1);
    expect(result.summary).toMatchObject({ status: "incomplete", recordedSamples: 0 });
    expect(local.requests).toHaveLength(0);
    expect(local.connections).toHaveLength(0);
  });
});
