import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage } from "../llm";

const directories: string[] = [];
const servers: Server[] = [];
const key = "synthetic-vision-eval-key";
type RequestBody = { model: string; max_tokens: number; response_format?: unknown; messages: ChatMessage[] };
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

async function service(badFirst = false, firstReply?: string) {
  const requests: RequestBody[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    const content = requests.length === 1 && firstReply !== undefined ? firstReply
      : badFirst && requests.length === 1 ? "！！！" : "合成协议回复；这段回复没有验证任何识图语义。";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing service address");
  return { requests, config: { VISION_EVAL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, VISION_EVAL_API_KEY: key, VISION_EVAL_MODEL: "synthetic-vision" } };
}

async function run(args: string[], config: Record<string, string> = {}) {
  const production = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-vision-eval-sentinel-"));
  directories.push(production);
  fs.writeFileSync(path.join(production, "sentinel.txt"), "unchanged");
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("VISION_EVAL_")) delete env[name];
  const child = spawn(process.execPath, [path.resolve("scripts/eval-vision.mjs"), ...args], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, RESUME_LIFE_DATA_DIR: production, ...config },
  });
  let text = "";
  child.stdout.on("data", data => { text += data; });
  child.stderr.on("data", data => { text += data; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Vision eval exceeded 30s")); }, 30_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", status => { clearTimeout(timer); resolve(status); });
  });
  expect(fs.readdirSync(production)).toEqual(["sentinel.txt"]);
  expect(fs.readFileSync(path.join(production, "sentinel.txt"), "utf8")).toBe("unchanged");
  expect(text).not.toContain(key);
  const output = text.match(/视觉评估目录：([^\r\n]+)/)?.[1];
  if (output) directories.push(output);
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(output!, `${name}.json`), "utf8"));
  return { code, output, text, read };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("resume-life-vision-eval-")) throw new Error("Unsafe cleanup path");
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe("视觉评测入口（仅本地合成服务）", () => {
  it("快照覆盖残留 live 标志，保存可审阅图片、页序与哈希，不发送请求", async () => {
    const local = await service();
    const result = await run([], { ...local.config, VISION_EVAL_LIVE: "1" });
    expect(result.code, result.text).toBe(0);
    expect(local.requests).toHaveLength(0);
    expect(fs.existsSync(path.join(result.output!, "data"))).toBe(false);
    const summary = result.read("summary");
    expect(summary).toMatchObject({ suite: "vision-ocr", mode: "snapshot", expectedSamples: 7, recordedSamples: 7, status: "completed", protocolCounts: { "not-run": 7, pass: 0, fail: 0, error: 0 }, semanticQuality: "not-evaluated" });
    for (const entry of summary.results) {
      const sample = result.read(entry.id);
      expect(sample.raw).toBeNull();
      expect(JSON.stringify(sample)).not.toContain("base64,");
      expect(JSON.stringify(sample)).not.toContain(key);
      expect(sample.semanticReviewItems.every((item: { verdict: string }) => item.verdict === "pending")).toBe(true);
      for (const page of sample.pages) {
        const png = fs.readFileSync(path.join(result.output!, page.file));
        expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        expect(png.length).toBe(page.bytes);
        expect(digest(png)).toBe(page.sha256);
      }
    }
    const multi = result.read("multiple-pages-in-given-order");
    expect(multi.pages.map((page: { pageNumber: number }) => page.pageNumber)).toEqual([2, 3]);
    expect(multi.assembledMessages[1].content.filter((part: { type: string }) => part.type === "text").map((part: { text: string }) => part.text).join("")).toContain("[Page 2]\n\n[Page 3]");
  });

  it.each([false, true])("实际传图片到安全视觉调用层，协议失败=%s，语义始终待审阅", async bad => {
    const local = await service(bad);
    const result = await run(["--live"], local.config);
    expect(result.code, result.text).toBe(bad ? 1 : 0);
    expect(local.requests).toHaveLength(7);
    const summary = result.read("summary");
    expect(summary).toMatchObject({ mode: "live", recordedSamples: 7, status: bad ? "failed" : "completed", protocolCounts: { "not-run": 0, pass: bad ? 6 : 7, fail: bad ? 1 : 0, error: 0 }, semanticQuality: "pending-human-review" });
    for (const [index, request] of local.requests.entries()) {
      const sample = result.read(summary.results[index].id);
      expect(request.model).toBe("synthetic-vision");
      expect(request.max_tokens).toBe(2400);
      expect(request.response_format).toBeUndefined();
      expect(digest(JSON.stringify(request.messages))).toBe(sample.promptHash);
      const user = request.messages[1]!.content;
      if (typeof user === "string") throw new Error("Expected multimodal content");
      const images = user.filter(part => part.type === "image_url");
      expect(images).toHaveLength(sample.pages.length);
      for (const [imageIndex, image] of images.entries()) {
        const png = Buffer.from(image.image_url.url.split(",")[1]!, "base64");
        expect(digest(png)).toBe(sample.pages[imageIndex].sha256);
        expect(image.image_url.detail).toBe("high");
      }
      expect(sample.semanticReview).toBe("pending-human-review");
      expect(sample.semanticReviewItems.every((item: { verdict: string }) => item.verdict === "pending")).toBe(true);
      expect(JSON.stringify(sample)).not.toContain("base64,");
    }
    expect(result.read("two-column-reading-order").raw).toBe(bad ? "！！！" : "合成协议回复；这段回复没有验证任何识图语义。");
    expect(fs.existsSync(path.join(result.output!, "data", "resume-life.db"))).toBe(true);
  });

  it.each([["--live"], ["--unknown"], ["--live", "--live"]])("缺少凭证或参数无效时不创建评估目录：%j", async (...args) => {
    const result = await run(args);
    expect(result.code).toBe(1);
    expect(result.output).toBeUndefined();
  });

  it("不可见字母填充符不能通过视觉协议，完整保存原回复供复查", async () => {
    const raw = "\u115f\u1160\u3164\uffa0\u200b…";
    const local = await service(false, raw);
    const result = await run(["--live"], local.config);
    expect(result.code, result.text).toBe(1);
    expect(local.requests).toHaveLength(7);
    expect(result.read("summary")).toMatchObject({ status: "failed", protocolCounts: { pass: 6, fail: 1, error: 0 } });
    expect(result.read("two-column-reading-order")).toMatchObject({ raw, protocol: "fail", failureStage: "validation", semanticReview: "pending-human-review" });
  });

  it("准备配置失败时记录样本缺失，零请求", async () => {
    const local = await service();
    const result = await run(["--live"], { ...local.config, VISION_EVAL_API_FORMAT: "invalid" });
    expect(result.code).toBe(1);
    expect(local.requests).toHaveLength(0);
    expect(result.read("summary")).toMatchObject({ status: "incomplete", expectedSamples: 7, recordedSamples: 0, missingSamples: 7 });
  });
});
