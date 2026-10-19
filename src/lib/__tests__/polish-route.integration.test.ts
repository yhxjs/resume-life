import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir: string;
let db: DatabaseSync;

// 必须用 vi.hoisted：mock 工厂只在首次求值时执行一次，若在工厂内联 vi.fn()，
// 本文件的每条用例都会拿到同一个函数实例、调用记录跨用例累积，
// 末条「未触达模型」的 not.toHaveBeenCalled() 会被前几条的调用污染而假失败。
const safeLlm = vi.hoisted(() => ({ safeChat: vi.fn() }));
vi.mock("@/lib/safe-llm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/safe-llm")>(),
  ...safeLlm,
}));

beforeEach(async () => {
  vi.resetModules();
  safeLlm.safeChat.mockReset();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-polish-route-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
  db.exec(
    "INSERT INTO resumes (id, title, template, created_at, updated_at) VALUES (1, '测试简历', 'classic', '', '')"
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-polish-route-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const request = (body: unknown) =>
  new Request("http://127.0.0.1/api/resumes/1/polish", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1", host: "127.0.0.1" },
    body: JSON.stringify(body),
  });
const idContext = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

async function callPolish(body: unknown) {
  const route = await import("@/app/api/resumes/[id]/polish/route");
  return route.POST(request(body), idContext(1));
}

describe("polish 路由", () => {
  it("模型返回合法 JSON 时回传 result", async () => {
    const { safeChat } = await import("@/lib/safe-llm");
    vi.mocked(safeChat).mockResolvedValue(
      JSON.stringify({ draft: "润色后的内容", quantifiedTips: [], highlights: ["性能调优"] })
    );
    const res = await callPolish({ text: "原文", moduleType: "projects", mode: "star" });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.result.draft).toBe("润色后的内容");
    expect(payload.result.highlights).toEqual(["性能调优"]);
    expect(vi.mocked(safeChat)).toHaveBeenCalledWith(
      "summary",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ requireJson: true })
    );
  });

  it("支持 condense 模式调用并回传精简合并结果", async () => {
    const { safeChat } = await import("@/lib/safe-llm");
    vi.mocked(safeChat).mockResolvedValue(
      JSON.stringify({
        draft: "• 主导交易核心重构，吞吐量提升 [请填入真实数据]",
        draftItems: ["主导交易核心重构，吞吐量提升 [请填入真实数据]"],
        quantifiedTips: [],
        highlights: ["架构重构"],
      })
    );
    const res = await callPolish({ text: "琐碎流水账内容", moduleType: "projects", mode: "condense" });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.result.draft).toContain("主导交易核心重构");
    expect(payload.result.draftItems).toEqual(["主导交易核心重构，吞吐量提升 [请填入真实数据]"]);
  });

  it("当模型返回中包含公司与岗位抬头时，路由会自动清洗剔除", async () => {
    const { safeChat } = await import("@/lib/safe-llm");
    vi.mocked(safeChat).mockResolvedValue(
      JSON.stringify({
        draft: "锐捷网络 | C软件工程师\n• 承担控制面三层域工作包开发\n• 负责性能优化",
        quantifiedTips: [],
        highlights: ["C语言"],
      })
    );
    const res = await callPolish({
      text: "承担开发",
      moduleType: "work",
      mode: "star",
      context: { company: "锐捷网络", title: "C软件工程师" },
    });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.result.draft).toBe("• 承担控制面三层域工作包开发\n• 负责性能优化");
  });

  it("模型返回非 JSON 时返回 502 解析失败", async () => {
    const { safeChat } = await import("@/lib/safe-llm");
    vi.mocked(safeChat).mockResolvedValue("这不是 JSON");
    const res = await callPolish({ text: "原文", moduleType: "projects", mode: "star" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("解析失败");
  });

  it("JSON 合法但缺少 draft 时同样按解析失败处理", async () => {
    const { safeChat } = await import("@/lib/safe-llm");
    vi.mocked(safeChat).mockResolvedValue(JSON.stringify({ highlights: ["x"] }));
    const res = await callPolish({ text: "原文", moduleType: "projects", mode: "star" });
    expect(res.status).toBe(502);
  });

  it("上游调用失败时返回 502", async () => {
    const { safeChat } = await import("@/lib/safe-llm");
    vi.mocked(safeChat).mockRejectedValue(new Error("upstream down"));
    const res = await callPolish({ text: "原文", moduleType: "projects", mode: "star" });
    expect(res.status).toBe(502);
    // 两条 catch 都返回 502，只有文案能区分是上游失败还是结果解析失败
    expect((await res.json()).error).toContain("upstream down");
  });

  it("简历不存在时返回 404（未触达模型）", async () => {
    const { safeChat } = await import("@/lib/safe-llm");
    const route = await import("@/app/api/resumes/[id]/polish/route");
    const res = await route.POST(request({ text: "原文" }), idContext(999));
    expect(res.status).toBe(404);
    expect(vi.mocked(safeChat)).not.toHaveBeenCalled();
  });
});
