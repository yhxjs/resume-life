import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let directory: string;
let db: DatabaseSync;
let post: typeof import("../../app/api/settings/test/route").POST;

const probe = (signal?: AbortSignal, format = "openai_chat") => post(new Request("http://localhost/api/settings/test", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ base_url: "https://unsaved.invalid/v1", api_key: "synthetic", model: "unsaved-model", api_format: format }),
  signal,
}));
const reply = () => Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 12, completion_tokens: 2 } });

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-probe-governance-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  vi.stubEnv("RESUME_LIFE_SETTINGS_KEY", "synthetic-encryption-key");
  db = (await import("../db")).getDb();
  post = (await import("../../app/api/settings/test/route")).POST;
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-probe-governance-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

it.each(["openai_chat", "openai_responses", "anthropic_messages"])("未保存的 %s 配置探测有输出预算并记录 usage", async (format) => {
  const { readSettings } = await import("../settings");
  const before = readSettings();
  const upstream = vi.fn<typeof fetch>(async () => format === "openai_chat" ? reply() : Response.json({
    ...(format === "openai_responses" ? { output_text: "ok" } : { content: [{ type: "text", text: "ok" }] }),
    usage: { input_tokens: 12, output_tokens: 2 },
  }));
  vi.stubGlobal("fetch", upstream);
  const response = await probe(undefined, format);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, reply: "ok" });
  const body = JSON.parse(upstream.mock.calls[0]![1]!.body as string);
  expect(body.max_tokens ?? body.max_output_tokens).toBeGreaterThan(0);
  expect(body.max_tokens ?? body.max_output_tokens).toBeLessThanOrEqual(1024);
  expect(body.stream).not.toBe(true);
  expect(upstream.mock.calls[0]![0]).toMatch(/^https:\/\/unsaved.invalid\/v1\//);
  expect(readSettings()).toEqual(before);
  expect(db.prepare("SELECT feature,model,status,input_tokens,output_tokens FROM llm_call_logs").all()).toEqual([
    { feature: "模型连接测试", model: "unsaved-model", status: "ok", input_tokens: 12, output_tokens: 2 },
  ]);
});

it("连接测试与普通模型调用共用三个名额，超限立即 429 且不转发", async () => {
  const { writeSettings } = await import("../settings");
  writeSettings({ base_url: "https://saved.invalid/v1", api_key: "synthetic", model_parse: "saved-model" });
  const { safeChat } = await import("../safe-llm");
  const releases: (() => void)[] = [];
  const upstream = vi.fn<typeof fetch>(async (_url, options) => new Promise<Response>((resolve, reject) => {
    const stream = JSON.parse(options!.body as string).stream;
    releases.push(() => resolve(stream ? new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n') : reply()));
    options!.signal?.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
  }));
  vi.stubGlobal("fetch", upstream);
  const running: Promise<unknown>[] = [safeChat("parse", { feature: "简历润色" }, "固定规则", []), probe(), probe()];
  try {
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(3));
    const fourth = probe();
    running.push(fourth);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await Promise.race([fourth.then((response) => response.status), new Promise((resolve) => { timer = setTimeout(() => resolve("pending"), 250); })]);
      expect(status).toBe(429);
      expect(upstream).toHaveBeenCalledTimes(3);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    releases.forEach((release) => release());
    await Promise.allSettled(running);
  }
  vi.stubGlobal("fetch", vi.fn(async () => reply()));
  expect((await probe()).status).toBe(200);
});

it("其它进程占满共享租约时探测立即 429，释放后可调用", async () => {
  const { acquireLlmLease, releaseLlmLease } = await import("../shared-budgets");
  const leases = Array.from({ length: 3 }, () => acquireLlmLease({ maxConcurrent: 3, leaseMs: 60_000 }));
  const upstream = vi.fn(async () => reply());
  vi.stubGlobal("fetch", upstream);
  try {
    expect(leases.every(Boolean)).toBe(true);
    expect((await probe()).status).toBe(429);
    expect(upstream).not.toHaveBeenCalled();
  } finally {
    for (const lease of leases) if (lease) releaseLlmLease(lease);
  }
  expect((await probe()).status).toBe(200);
  expect(upstream).toHaveBeenCalledOnce();
});

it("客户端取消中止上游并记录 cancelled，随后名额可再次使用", async () => {
  let upstreamSignal: AbortSignal | null | undefined;
  let release: (() => void) | undefined;
  const upstream = vi.fn<typeof fetch>(async (_url, options) => new Promise<Response>((resolve, reject) => {
    release = () => resolve(reply());
    upstreamSignal = options!.signal;
    upstreamSignal?.addEventListener("abort", () => reject(upstreamSignal!.reason), { once: true });
  }));
  vi.stubGlobal("fetch", upstream);
  const controller = new AbortController();
  const running = probe(controller.signal);
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce());
  controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await Promise.race([running.then((response) => response.status), new Promise((resolve) => { timer = setTimeout(() => resolve("pending"), 250); })]);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(status).toBe(499);
  } finally {
    clearTimeout(timer);
    release?.();
    await running;
  }
  expect(db.prepare("SELECT status,error_code FROM llm_call_logs").all()).toEqual([{ status: "cancelled", error_code: "cancelled" }]);
  vi.stubGlobal("fetch", vi.fn(async () => reply()));
  expect((await probe()).status).toBe(200);
});

it("探测整体 15 秒截止且失败入账，不重试付费请求", async () => {
  vi.useFakeTimers();
  const upstream = vi.fn<typeof fetch>(async (_url, options) => new Promise<Response>((_resolve, reject) => {
    options!.signal?.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
  }));
  vi.stubGlobal("fetch", upstream);
  const running = probe();
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(15_001);
  expect((await running).status).toBe(504);
  expect(upstream).toHaveBeenCalledOnce();
  expect(db.prepare("SELECT status,error_code,attempts FROM llm_call_logs").all()).toEqual([{ status: "failed", error_code: "timeout", attempts: 0 }]);
});

it("上游 503 只调用一次并记录失败", async () => {
  const upstream = vi.fn(async () => new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", upstream);
  expect((await probe()).status).toBe(502);
  expect(upstream).toHaveBeenCalledOnce();
  expect(db.prepare("SELECT status,error_code,attempts FROM llm_call_logs").all()).toEqual([{ status: "failed", error_code: "http_503", attempts: 0 }]);
});
