import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkPathsRelation } from "@/lib/repo-scanner/relation-checker";

const calls = vi.hoisted(() => ({ chat: vi.fn(), detect: vi.fn(), cli: vi.fn() }));
vi.mock("@/lib/safe-llm", async (original) => ({
  ...await original<typeof import("@/lib/safe-llm")>(), safeChat: calls.chat,
}));
vi.mock("@/lib/repo-scanner/cli-runner", () => ({ detectInstalledClis: calls.detect }));
vi.mock("@/lib/repo-scanner/cli-process", () => ({ runCliPrompt: calls.cli, textOnlyCliArgs: () => [] }));

const paths = [
  { valid: true, normalizedPath: "synthetic-alpha", projectName: "alpha" },
  { valid: true, normalizedPath: "synthetic-beta", projectName: "beta" },
];

beforeEach(() => {
  vi.resetAllMocks();
  calls.chat.mockRejectedValue(new Error("synthetic outage"));
  calls.detect.mockResolvedValue({ codex: { available: false }, claude: { available: false }, recommended: null });
});

describe("仓库关联降级", () => {
  it("没有模型、CLI 或元数据证据时返回未知而不是成功", async () => {
    const result = await checkPathsRelation(paths);
    expect(result).toMatchObject({ isRelated: null, method: "heuristic" });
    expect(result.reason).toContain("无法确认");
    expect(result.reason).not.toContain("具备初步关联特征");
    expect(calls.cli).not.toHaveBeenCalled();
  });

  it("启发式发现不同工程生态时如实标记来源", async () => {
    const result = await checkPathsRelation(paths.map((item, index) => ({ ...item, packageMetadata: { type: index ? "go" : "node" } })));
    expect(result).toMatchObject({ isRelated: false, method: "heuristic" });
  });

  it.each([true, false])("有效模型判断 %s 保持结果且标记模型来源", async (isRelated) => {
    calls.chat.mockResolvedValue(JSON.stringify({ isRelated, reason: "模型判断依据" }));
    expect(await checkPathsRelation(paths)).toEqual({ isRelated, reason: "模型判断依据", method: "model" });
    expect(calls.detect).not.toHaveBeenCalled();
  });

  it("模型返回无效字段时仍返回未知", async () => {
    calls.chat.mockResolvedValue('{"isRelated":true,"reason":123}');
    expect(await checkPathsRelation(paths)).toMatchObject({ isRelated: null, method: "heuristic" });
  });

  it("有效 CLI 判断与模型来源区分", async () => {
    calls.detect.mockResolvedValue({ codex: { available: true }, claude: { available: false }, recommended: "codex" });
    calls.cli.mockResolvedValue('{"isRelated":false,"reason":"CLI 判断依据"}');
    expect(await checkPathsRelation(paths)).toEqual({ isRelated: false, reason: "CLI 判断依据", method: "cli" });
  });
});
