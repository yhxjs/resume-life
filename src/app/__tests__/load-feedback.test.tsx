import { resolveStyle } from "@/lib/templates";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonFetch } from "@/lib/fetcher";
import ResumesPage from "../resumes/page";
import KnowledgePage from "../knowledge/page";
import IntrosPage from "../intros/page";
import InterviewsPage from "../interviews/page";
import NotebookPage from "../notebook/page";
import JdPage from "../tools/jd/page";
import SalaryPage from "../tools/salary/page";
import ReviewPage from "../review/page";
import DrillsPage from "../drills/page";
import DecoderPage from "../tools/decoder/page";
import GapPage from "../tools/gap/page";
import SettingsPage from "../settings/page";
import PortfolioPage from "../tools/portfolio/page";
import InterviewPage from "../interviews/[id]/page";
import ProjectDetailPage from "../knowledge/[id]/page";
import { ResumeEditor } from "@/components/resume/resume-editor";
import { ResumeVersionsPage } from "@/components/resume/resume-versions-page";
import PrintPage from "../resumes/[id]/print/page";
import SalaryDetailPage from "../tools/salary/[id]/page";
import DefenseDetailPage from "../tools/defense/[id]/page";
import { LlmUsagePanel } from "@/components/settings/llm-usage-panel";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { fetchSse } from "@/lib/fetch-sse";
import { useInterviewCommands } from "@/hooks/use-interview-session";
import DrillPage from "../drills/[id]/page";
import IntroPage from "../intros/[id]/page";
import SeriesPage from "../interviews/series/[id]/page";
import JdDetailPage from "../tools/jd/[id]/page";
import GapDetailPage from "../tools/gap/[id]/page";
import DecoderDetailPage from "../tools/decoder/[id]/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ id: "9001" }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({
  confirmDialog: vi.fn().mockResolvedValue(true), alertDialog: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(jsonFetch).mockRejectedValue(new Error("服务器暂不可用"));
  vi.mocked(confirmDialog).mockResolvedValue(true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("主要页面的加载失败反馈", () => {
  it.each([
    ["简历管理", ResumesPage], ["知识库", KnowledgePage], ["自我介绍", IntrosPage],
    ["模拟面试", InterviewsPage], ["错题本", NotebookPage], ["JD 画像", JdPage],
    ["薪酬谈判", SalaryPage], ["能力复盘", ReviewPage], ["练习详情", DrillPage],
    ["自我介绍详情", IntroPage], ["进阶面试", SeriesPage], ["画像详情", JdDetailPage],
    ["空窗对策详情", GapDetailPage], ["解码详情", DecoderDetailPage],
    ["题目练习", DrillsPage], ["解码历史", DecoderPage], ["空窗对策", GapPage],
    ["设置", SettingsPage], ["作品集", PortfolioPage], ["面试详情", InterviewPage],
    ["项目详情", ProjectDetailPage], ["简历编辑", () => <ResumeEditor id="9001" />],
    ["版本树", () => <ResumeVersionsPage resumeId="9001" />], ["简历打印", PrintPage],
    ["薪酬详情", SalaryDetailPage], ["排雷详情", DefenseDetailPage],
    ["用量统计", LlmUsagePanel],
  ])("%s 失败后停止加载并提供页内重试", async (_name, Page) => {
    render(<Page />);
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("服务器暂不可用"))).toBe(true);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    const requests = vi.mocked(jsonFetch).mock.calls.length;
    fireEvent.click(screen.getAllByRole("button", { name: "重试加载" })[0]!);
    await waitFor(() => expect(vi.mocked(jsonFetch).mock.calls.length).toBeGreaterThan(requests));
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
  });

  it.each([["简历", ResumesPage, "/api/resumes"], ["项目", KnowledgePage, "/api/projects"]])(
    "%s 列表重试时恢复加载，成功后显示内容并清除错误",
    async (_name, Page, path) => {
      render(<Page />);
      await screen.findByRole("alert");
      let finish!: (value: unknown) => void;
      vi.mocked(jsonFetch).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
      fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
      await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
      expect(screen.queryByRole("alert")).toBeNull();
      finish([{ id: 5, title: "后端工程师", name: "计费引擎", created_at: "2026-10-01", updated_at: "2026-10-01", summary_updated_at: "", material_count: 2 }]);
      await waitFor(() => expect(screen.getByText(_name === "简历" ? "后端工程师" : "计费引擎")).toBeTruthy());
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(jsonFetch).toHaveBeenLastCalledWith(path);
    },
  );

  it("复制简历后的列表刷新失败仍保留原简历和新建输入", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce([{ id: 5, title: "主投简历", created_at: "2026-10-01", updated_at: "2026-10-01" }]);
    render(<ResumesPage />);
    await screen.findByText("主投简历");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "待创建简历" } });
    vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 6 }).mockRejectedValueOnce(new Error("刷新列表失败"));
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await screen.findByRole("alert");
    expect(screen.getByText("主投简历")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("待创建简历");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("设置读取失败时不会显示空白配置表单或允许保存", async () => {
    render(<SettingsPage />);
    await screen.findByRole("alert");
    expect(screen.queryByPlaceholderText("sk-…")).toBeNull();
    expect(screen.queryByRole("button", { name: "保存设置" })).toBeNull();
  });

  it("项目选项失败后仍可切换到岗位通用练习", async () => {
    render(<DrillsPage />);
    await screen.findByText("项目列表加载失败：服务器暂不可用");
    fireEvent.click(screen.getByRole("tab", { name: "岗位通用题库" }));
    expect(screen.getByRole("button", { name: "开始通用练习" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("面试历史部分失败时仍显示已成功加载的记录", async () => {
    vi.mocked(jsonFetch).mockImplementation(async (url) => {
      if (String(url).startsWith("/api/interviews/series")) throw new Error("进阶历史加载失败");
      if (String(url).startsWith("/api/interviews")) return {
        items: [{ id: 1, resume_title: "已加载的面试", jd: "后端岗位", style: "gentle", status: "ongoing", answered: 1, rounds: 3, created_at: "2026-10-01" }], nextCursor: null,
      };
      return [];
    });
    render(<InterviewsPage />);
    await screen.findByRole("alert");
    expect(await screen.findByText("已加载的面试")).toBeTruthy();
  });

  it.each([["JD 画像", JdDetailPage], ["空窗对策", GapDetailPage], ["暗号解码", DecoderDetailPage]])(
    "%s 删除失败仍显示错误并保留报告",
    async (_name, Page) => {
      vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 9001, result: null, created_at: "2026-10-01", jd: "测试岗位", text: "测试文本", raw_story: "测试经历", scenario_type: "gap", target_role: "后端", persona_style: "pragmatic" });
      render(<Page />);
      const button = await screen.findByRole("button", { name: /删除/ });
      vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("删除暂不可用"));
      fireEvent.click(button);
      expect((await screen.findByRole("alert")).textContent).toContain("删除暂不可用");
      expect(screen.getByRole("button", { name: /删除/ })).toBeTruthy();
    },
  );

  it("版本对照的一侧失败后仍可查看已加载的另一侧，重试能恢复对照", async () => {
    const snapshot = { resolved_style: resolveStyle("classic", []), title: "成功加载的版本", template: "classic", style_overrides: {}, modules: [] };
    const versions = { versions: [
      { id: 2, version: 2, name: "新版", parent_id: 1, description: "", created_at: "2026-10-01" },
      { id: 1, version: 1, name: "父版本", parent_id: null, description: "", created_at: "2026-10-01" },
    ], base_version_id: 2, draft_revision: "r1" };
    let failParent = true;
    vi.mocked(jsonFetch).mockImplementation(async (url) => {
      if (url === "/api/resumes/9001/versions") return { ...versions };
      if (url === "/api/resumes/9001/versions/1" && failParent) throw new Error("父版本加载失败");
      return { snapshot };
    });
    render(<ResumeVersionsPage resumeId="9001" />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看此版本" }));
    expect(await screen.findByRole("region", { name: "已发布简历预览" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "左右对照" }));
    await screen.findByRole("alert");
    failParent = false;
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(await screen.findByRole("region", { name: "简历左右对照" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "正在加载版本快照…" })).toBeNull();
    expect(vi.mocked(jsonFetch).mock.calls.filter(([url]) => url === "/api/resumes/9001/versions/1")).toHaveLength(2);
  });

  it("参照版本仍在加载时可以立即查看已返回的当前版本", async () => {
    vi.mocked(jsonFetch).mockImplementation(async (url) => {
      if (url === "/api/resumes/9001/versions") return { versions: [
        { id: 2, version: 2, name: "新版", parent_id: 1, description: "", created_at: "2026-10-01" },
        { id: 1, version: 1, name: "旧版", parent_id: null, description: "", created_at: "2026-10-01" },
      ], base_version_id: 2, draft_revision: "r1" };
      if (url === "/api/resumes/9001/versions/1") return new Promise(() => {});
      return { snapshot: { resolved_style: resolveStyle("classic", []), title: "当前版本", template: "classic", style_overrides: {}, modules: [] } };
    });
    render(<ResumeVersionsPage resumeId="9001" />);
    fireEvent.click(await screen.findByRole("button", { name: "查看此版本" }));
    expect(await screen.findByRole("region", { name: "已发布简历预览" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "正在加载版本快照…" })).toBeNull();
  });

  it("面试回答提交后的数据刷新失败会保留输入并解除进行中状态", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 9001, turns: [{ id: 1, answered_at: "" }] });
    vi.mocked(fetchSse).mockImplementation(async (_url, options) => { await options.onDone?.({}); });
    const { result } = renderHook(() => useInterviewCommands("9001"));
    await waitFor(() => expect(result.current.current?.id).toBe(1));
    act(() => result.current.setAnswer("尚需保留的真实回答"));
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("最新面试记录加载失败"));
    await act(() => result.current.submitAnswer());
    expect(result.current.answer).toBe("尚需保留的真实回答");
    expect(result.current.error).toBe("最新面试记录加载失败");
    expect(result.current.busy).toBe(false);
  });
});
