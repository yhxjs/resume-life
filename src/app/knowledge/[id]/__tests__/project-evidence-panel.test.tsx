// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectEvidencePanel } from "../project-evidence-panel";
import { jsonFetch } from "@/lib/fetcher";
import { emptySummary } from "@/lib/summary";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const file = { locator: "仓库1 demo / src/store.ts", content: "const cache = new Map();\nexport const size = 2;", receipt: "a".repeat(64), truncated: true, capturedAt: "2026-11-20T01:00:00Z" };
function mount() {
  return render(<ProjectEvidencePanel projectId={1} materials={[{ id: 2, title: "设计文档" }]} sourceFiles={[file]} hasMore={false} loadingMore={false} onLoadMore={vi.fn()} />);
}
describe("指着材料追问", () => {
  it("默认手动；智能推荐隐藏追问方式，按所选数量提交并展示实际题目", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ id: 8, count: 2, questions: ["如何验证缓存的一致性？", "假设进程重启，缓存如何恢复？"] });
    mount();
    expect(screen.getByRole("button", { name: "手动" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByLabelText("依据来源"), { target: { value: `scan:${file.receipt}` } });
    fireEvent.change(screen.getByLabelText("追问方式"), { target: { value: "alternative" } });
    fireEvent.change(screen.getByLabelText("替代方案"), { target: { value: "Redis" } });
    fireEvent.click(screen.getByRole("button", { name: "智能推荐" }));
    expect(screen.queryByLabelText("追问方式")).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(5);
    expect((screen.getByRole("radio", { name: "3 题" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "5 题" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "一键生成推荐题" })));
    const [url, options] = vi.mocked(jsonFetch).mock.calls[0]!;
    expect(url).toBe("/api/projects/1/evidence-drill/recommend");
    expect(JSON.parse(options!.body as string)).toEqual({ scanFile: file, startLine: 1, endLine: 1, count: 5 });
    expect(screen.getByText(/已生成并保存 2 道推荐题/)).toBeTruthy();
    expect(screen.getByRole("list", { name: "推荐题目" }).children).toHaveLength(2);
    expect(screen.getByRole("link", { name: "开始答辩练习 →" }).getAttribute("href")).toBe("/drills/8");
    fireEvent.click(screen.getByRole("button", { name: "手动" }));
    expect((screen.getByLabelText("替代方案") as HTMLInputElement).value).toBe("Redis");
  });
  it("推荐生成期间防止重复提交；卸载后中止请求并忽略晚到响应", async () => {
    const pending = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    const view = mount();
    fireEvent.change(screen.getByLabelText("依据来源"), { target: { value: `scan:${file.receipt}` } });
    fireEvent.click(screen.getByRole("button", { name: "智能推荐" }));
    const generate = screen.getByRole("button", { name: "一键生成推荐题" });
    fireEvent.click(generate); fireEvent.click(generate);
    expect(vi.mocked(jsonFetch)).toHaveBeenCalledOnce();
    expect(screen.getByText("正在分析所选摘录，生成并保存推荐题…")).toBeTruthy();
    const options = vi.mocked(jsonFetch).mock.calls[0]![1]!;
    view.unmount();
    expect(options.signal!.aborted).toBe(true);
    await act(async () => pending.resolve({ id: 8, count: 1, questions: ["晚到题目"] }));
    expect(screen.queryByRole("link", { name: "开始答辩练习 →" })).toBeNull();
  });
  it("无依据不能智能生成，失败保留数量与摘录并提供查看练习入口", async () => {
    vi.mocked(jsonFetch).mockRejectedValue(new Error("连接中断"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "智能推荐" }));
    expect(screen.getByRole("button", { name: "一键生成推荐题" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("依据来源"), { target: { value: `scan:${file.receipt}` } });
    fireEvent.click(screen.getByRole("radio", { name: "1 题" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "一键生成推荐题" })));
    expect(screen.getByRole("alert").textContent).toContain("连接中断");
    expect(screen.getByRole("link", { name: "查看练习列表" })).toBeTruthy();
    expect((screen.getByRole("radio", { name: "1 题" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("依据来源") as HTMLSelectElement).value).toBe(`scan:${file.receipt}`);
  });
  it("没有导入材料时列出已保存章节；长行允许连续摘录，未保存内容不冒充原文", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ id: 8, count: 1 });
    const summary = { ...emptySummary(), architecture: "架构说明。".repeat(80) + "待核实容量" };
    render(<ProjectEvidencePanel projectId={1} savedSummary={summary} materials={[]} sourceFiles={[]} hasMore={false} loadingMore={false} onLoadMore={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("依据来源"), { target: { value: "summary:architecture" } });
    expect(screen.getByRole("option", { name: "已保存项目档案 · 架构设计（待核实）" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/档案摘录（/), { target: { value: "未保存草稿" } });
    expect(screen.getByRole("button", { name: "创建依据深挖题" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText(/档案摘录（/), { target: { value: "待核实容量" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "创建依据深挖题" })));
    expect(JSON.parse(vi.mocked(jsonFetch).mock.calls[0]![1]!.body as string)).toMatchObject({ summaryKey: "architecture", summaryContent: summary.architecture, summaryQuote: "待核实容量" });
  });
  it("无任何来源时解释原因并提供导入入口，不显示可操作的空下拉框", () => {
    const onImportMaterial = vi.fn();
    render(<ProjectEvidencePanel projectId={1} materials={[]} sourceFiles={[]} hasMore={false} loadingMore={false} onLoadMore={vi.fn()} onImportMaterial={onImportMaterial} onSourceFilesChange={vi.fn()} />);
    expect((screen.getByLabelText("依据来源") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText(/旧扫描只保存总结/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "导入设计材料" }));
    expect(onImportMaterial).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "选择代码目录并读取" })).toBeTruthy();
  });
  it("读取已记录目录补充选项，卸载后晚到响应不回填", async () => {
    const pending = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    const onSourceFilesChange = vi.fn();
    const view = render(<ProjectEvidencePanel projectId={1} materials={[]} sourceFiles={[]} hasMore={false} loadingMore={false} onLoadMore={vi.fn()} repoPaths={["D:/repo"]} onSourceFilesChange={onSourceFilesChange} />);
    fireEvent.click(screen.getByRole("button", { name: "从已记录目录读取代码" }));
    const [url, options] = vi.mocked(jsonFetch).mock.calls[0]!;
    expect(url).toBe("/api/projects/1/evidence-sources");
    expect(JSON.parse(options!.body as string)).toEqual({ repoPaths: ["D:/repo"] });
    view.unmount();
    await act(async () => pending.resolve({ sourceFiles: [file] }));
    expect(options!.signal!.aborted).toBe(true);
    expect(onSourceFilesChange).not.toHaveBeenCalled();
  });
  it("选择代码行并保存明确的条件，成功后链接到可回看的题目", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ id: 8, count: 1 });
    mount();
    fireEvent.change(screen.getByLabelText("依据来源"), { target: { value: `scan:${file.receipt}` } });
    fireEvent.change(screen.getByLabelText("起始行"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("结束行"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("追问方式"), { target: { value: "alternative" } });
    fireEvent.change(screen.getByLabelText("替代方案"), { target: { value: "Redis" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "创建依据深挖题" })));
    expect(JSON.parse(vi.mocked(jsonFetch).mock.calls[0]![1]!.body as string)).toEqual({ scanFile: file, startLine: 2, endLine: 2, mode: "alternative", baseline: "", change: "Redis" });
    expect(screen.getByRole("link", { name: "开始答辩练习 →" }).getAttribute("href")).toBe("/drills/8");
    expect(screen.getByText(/仅采集文件前缀/)).toBeTruthy();
  });
  it("材料读取晚到不覆盖已切换的代码依据", async () => {
    const pending = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    mount();
    fireEvent.change(screen.getByLabelText("依据来源"), { target: { value: "material:2" } });
    const signal = vi.mocked(jsonFetch).mock.calls[0]![1]!.signal!;
    fireEvent.change(screen.getByLabelText("依据来源"), { target: { value: `scan:${file.receipt}` } });
    await act(async () => pending.resolve({ id: 2, title: "设计文档", content: "不应回填的旧材料", revision: "b".repeat(64), source: "paste", filename: "", created_at: "" }));
    expect(signal.aborted).toBe(true);
    expect(screen.queryByText(/不应回填/)).toBeNull();
    expect(screen.getByRole("button", { name: "创建依据深挖题" }).hasAttribute("disabled")).toBe(false);
  });
  it("非法范围不能提交，网络失败后保留条件供幂等重试", async () => {
    vi.mocked(jsonFetch).mockRejectedValue(new Error("网络中断"));
    mount();
    fireEvent.change(screen.getByLabelText("依据来源"), { target: { value: `scan:${file.receipt}` } });
    fireEvent.change(screen.getByLabelText("结束行"), { target: { value: "99" } });
    expect(screen.getByRole("button", { name: "创建依据深挖题" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("结束行"), { target: { value: "1" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "创建依据深挖题" })));
    expect(screen.getByRole("alert").textContent).toContain("相同题目会直接复用");
    expect((screen.getByLabelText("依据来源") as HTMLSelectElement).value).toBe(`scan:${file.receipt}`);
  });
});
