import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirmDialog, alertDialog } from "@/components/common/confirm-dialog";
import { DrillStartForm } from "@/components/drills/drill-start-form";
import { useDrillsPage } from "@/hooks/use-drills-page";
import { useCursorList } from "@/hooks/use-cursor-list";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { useResumeOptions } from "@/hooks/use-resume-options";
import { useApplicationPreparation } from "@/hooks/use-application-preparation";
import { useTypewriter } from "@/hooks/use-typewriter";
import { useStylePreview, useTemplateLibrary } from "@/hooks/use-template-library";
import { jsonFetch } from "@/lib/fetcher";
import { fetchSse } from "@/lib/fetch-sse";
import { useRouter, useSearchParams } from "next/navigation";
import DrillsPage from "../drills/page";
import KnowledgePage from "../knowledge/page";
import ResumesPage from "../resumes/page";
import NotebookPage from "../notebook/page";
import JargonDecoderPage from "../tools/decoder/page";
import IntrosPage from "../intros/page";
import { ResumeVersionSelect } from "@/components/resume/resume-version-select";
import { ApplicationDialog } from "@/components/application/application-dialog";
import type { Application } from "@/lib/applications-types";
import ResumeDefensePage from "../tools/defense/page";
import ReviewPage from "../review/page";
import JdPortraitPage from "../tools/jd/page";
import SalaryNegotiationListPage from "../tools/salary/page";
import StyleFactoryPage from "../styles/page";

let slots: unknown[] = [];
let cursor = 0;
let effects: Array<() => void | (() => void)> = [];

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initialValue: unknown) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = initialValue;
    return [slots[index], (next: unknown) => {
      slots[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(slots[index]) : next;
    }];
  },
  useEffect: (effect: () => void | (() => void)) => { effects.push(effect); },
  useRef: (initialValue: unknown) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { current: initialValue };
    return slots[index];
  },
  useCallback: (fn: (...args: unknown[]) => unknown) => fn,
  useId: () => "test-id",
}));
vi.mock("next/navigation", () => ({ useRouter: vi.fn(), useSearchParams: vi.fn() }));
vi.mock("@/hooks/use-modal-focus", () => ({ useModalFocus: () => ({ current: null }) }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn(), alertDialog: vi.fn() }));
vi.mock("@/hooks/use-drills-page", () => ({ useDrillsPage: vi.fn() }));
vi.mock("@/hooks/use-cursor-list", () => ({ useCursorList: vi.fn() }));
vi.mock("@/hooks/use-copy-feedback", () => ({ useCopyFeedback: vi.fn() }));
vi.mock("@/hooks/use-resume-options", () => ({ useResumeOptions: vi.fn() }));
vi.mock("@/hooks/use-typewriter", () => ({ useTypewriter: vi.fn() }));
vi.mock("@/hooks/use-auto-scroll", () => ({
  useAutoScroll: () => ({ containerRef: () => {}, handleScroll: () => {}, scrollToBottom: () => {} }),
}));
vi.mock("@/hooks/use-template-library", () => ({ useTemplateLibrary: vi.fn(), useStylePreview: vi.fn() }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: vi.fn() }));

type Props = {
  children?: ReactNode;
  id?: string;
  title?: string;
  onChange?: (event: { target: { value: string } }) => void;
  onClick?: () => void | Promise<void>;
  onSubmit?: (event: { preventDefault: () => void }) => void | Promise<void>;
  "aria-label"?: string;
  placeholder?: string;
};

function findElement(root: ReactNode, match: (element: ReactElement<Props>) => boolean) {
  let found: ReactElement<Props> | undefined;
  function visit(node: ReactNode) {
    if (!isValidElement<Props>(node) || found) return;
    if (match(node)) found = node;
    else Children.forEach(node.props.children, visit);
  }
  visit(root);
  if (!found) throw new Error("页面中未找到目标操作元素");
  return found;
}

function render(page: () => ReactElement) {
  cursor = 0;
  return page();
}

const routerPush = vi.fn();
beforeEach(() => {
  slots = [];
  effects = [];
  vi.clearAllMocks();
  vi.mocked(useRouter).mockReturnValue({ push: routerPush } as never);
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as never);
  vi.mocked(confirmDialog).mockResolvedValue(true);
  vi.mocked(alertDialog).mockResolvedValue(undefined);
  vi.mocked(useCursorList).mockReturnValue({
    items: null, nextCursor: null, loadingMore: false, listError: "", failedCursor: null,
    loadMore: vi.fn(), reload: vi.fn(),
  } as never);
  vi.mocked(useCopyFeedback).mockReturnValue({ copiedText: "", copy: vi.fn().mockResolvedValue(true) } as never);
  vi.mocked(useResumeOptions).mockReturnValue({ resumes: [{ id: 4, title: "主简历", versions: [{ id: 41, version: 1, name: "通用版" }, { id: 42, version: 2, name: "技术岗" }] }], resumesError: "" } as never);
  vi.mocked(useTypewriter).mockReturnValue({
    displayedText: "", isTyping: false, reset: vi.fn(), appendDelta: vi.fn(), flush: vi.fn(),
  } as never);
  vi.mocked(useTemplateLibrary).mockReturnValue({ draft: {} } as never);
  vi.mocked(useStylePreview).mockReturnValue({
    previewRef: { current: null }, paperRef: { current: null }, scale: 1,
    paperHeight: 1122, mobileTab: "inspector", setMobileTab: vi.fn(),
  } as never);
  vi.mocked(fetchSse).mockReset();
});

describe("非面试页面的真实操作", () => {
  it("知识库首次加载项目并写入页面状态，卸载后不再接收迟到响应", async () => {
    const projects = [{ id: 7, name: "计费引擎", summary_updated_at: "", updated_at: "", material_count: 2 }];
    vi.mocked(jsonFetch).mockResolvedValueOnce(projects);
    render(KnowledgePage);
    effects[0]?.();
    await Promise.resolve();
    expect(jsonFetch).toHaveBeenCalledWith("/api/projects");
    expect(slots[0]).toEqual(projects);

    vi.mocked(jsonFetch).mockResolvedValueOnce([]);
    render(KnowledgePage);
    const cleanup = effects[1]?.();
    cleanup?.();
    await Promise.resolve();
    expect(slots[0]).toEqual(projects);
  });

  it("知识库新建项目会去空白、POST 并导航到新档案", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ id: 12 });
    const input = findElement(render(KnowledgePage), (element) => element.props.id === "knowledge-project-name");
    input.props.onChange?.({ target: { value: "  支付平台  " } });
    const create = findElement(render(KnowledgePage), (element) => element.type === "button" && element.props.children === "立即创建");
    await create.props.onClick?.();

    expect(jsonFetch).toHaveBeenCalledWith("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "支付平台" }),
    });
    expect(routerPush).toHaveBeenCalledWith("/knowledge/12");
  });

  it("知识库创建失败时反馈错误并解除进行中状态", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("项目保存失败"));
    const input = findElement(render(KnowledgePage), (element) => element.props.id === "knowledge-project-name");
    input.props.onChange?.({ target: { value: "计费引擎" } });
    const create = findElement(render(KnowledgePage), (element) => element.type === "button" && element.props.children === "立即创建");
    await create.props.onClick?.();
    expect(alertDialog).toHaveBeenCalledWith({ title: "创建失败", message: "项目保存失败" });
    expect(slots[3]).toBe(false);
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("知识库取消删除不发请求，确认后删除并刷新列表", async () => {
    slots[0] = [{ id: 7, name: "计费引擎", summary_updated_at: "", updated_at: "", material_count: 2 }];
    const remove = findElement(render(KnowledgePage), (element) => element.props.title === "删除项目材料与总结");
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    await remove.props.onClick?.();
    expect(jsonFetch).not.toHaveBeenCalled();

    vi.mocked(jsonFetch).mockResolvedValueOnce(undefined).mockResolvedValueOnce([]);
    await remove.props.onClick?.();
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ danger: true, message: expect.stringContaining("计费引擎") }));
    expect(jsonFetch).toHaveBeenCalledWith("/api/projects/7", { method: "DELETE" });
    expect(jsonFetch).toHaveBeenCalledWith("/api/projects");
  });

  it("简历新建按清理后的标题提交并进入工作台", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ id: 8 });
    const input = findElement(render(ResumesPage), (element) => element.type === "input");
    input.props.onChange?.({ target: { value: "  Java 后端  " } });
    const create = findElement(render(ResumesPage), (element) => element.type === "button" && element.props.children === "立即创建");
    await create.props.onClick?.();

    expect(jsonFetch).toHaveBeenCalledWith("/api/resumes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Java 后端" }),
    });
    expect(routerPush).toHaveBeenCalledWith("/resumes/8");
  });

  it("简历列表加载失败会保存错误信息而不冒出空数据", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("列表暂不可用"));
    render(ResumesPage);
    effects[0]?.();
    await vi.waitFor(() => expect(slots[1]).toBe("列表暂不可用"));
    expect(jsonFetch).toHaveBeenCalledWith("/api/resumes");
    expect(slots[0]).toBeNull();
  });

  it("简历复制后刷新，删除必须经过确认", async () => {
    slots[0] = [{ id: 5, title: "主投版", created_at: "2026-01-01", updated_at: "2026-01-01" }];
    const page = render(ResumesPage);
    const copy = findElement(page, (element) => element.props.title === "复制为此简历的新副本");
    vi.mocked(jsonFetch).mockResolvedValue(undefined);
    await copy.props.onClick?.();
    expect(jsonFetch).toHaveBeenCalledWith("/api/resumes/5/copy", { method: "POST" });
    expect(jsonFetch).toHaveBeenCalledWith("/api/resumes");

    vi.mocked(jsonFetch).mockClear();
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    const remove = findElement(page, (element) => element.props.title === "彻底删除此简历");
    await remove.props.onClick?.();
    expect(jsonFetch).not.toHaveBeenCalled();
    await remove.props.onClick?.();
    expect(jsonFetch).toHaveBeenCalledWith("/api/resumes/5", { method: "DELETE" });
  });

  it("练习切换题库模式后清理输入，提交正确来源并导航", async () => {
    vi.mocked(useDrillsPage).mockReturnValue({ projectId: 4, drills: [], directions: [], projects: [] } as never);
    vi.mocked(jsonFetch).mockResolvedValue({ id: 19 });
    const form = () => findElement(render(DrillsPage), (element) => element.type === DrillStartForm)
      .props as React.ComponentProps<typeof DrillStartForm>;

    form().onModeChange("bank");
    form().onBankDirectionChange("  前端  ");
    form().onBankJdChange("  远程岗位  ");
    form().onCountChange(3);
    await form().onStart();

    expect(jsonFetch).toHaveBeenCalledWith("/api/drills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "bank", direction: "前端", jd: "远程岗位", count: 3 }),
    });
    expect(routerPush).toHaveBeenCalledWith("/drills/19");
  });

  it("练习创建失败后解锁按钮、提示原因，切换模式会清掉错误", async () => {
    vi.mocked(useDrillsPage).mockReturnValue({ projectId: 4, drills: [], directions: [], projects: [] } as never);
    vi.mocked(jsonFetch).mockRejectedValue(new Error("出题失败"));
    const form = () => findElement(render(DrillsPage), (element) => element.type === DrillStartForm)
      .props as React.ComponentProps<typeof DrillStartForm>;

    await form().onStart();
    expect(jsonFetch).toHaveBeenCalledWith("/api/drills", expect.objectContaining({ body: JSON.stringify({ source: "project", project_id: 4, count: 5 }) }));
    expect(form().starting).toBe(false);
    expect(form().error).toBe("出题失败");
    form().onModeChange("bank");
    expect(form().error).toBe("");
  });

  it("错题本分类与来源筛选生成正确查询，删除后刷新列表和分类", async () => {
    const entry = {
      id: 9, category_id: 2, category_name: "系统设计", source: "interview", source_label: "项目面试",
      question: "如何设计缓存？", answer: "我的回答", comment: "补上失效策略", reference: "参考答案",
      scores: null, created_at: "2026-01-01", updated_at: "2026-01-01",
    };
    const reload = vi.fn();
    vi.mocked(useCursorList).mockReturnValue({
      items: [entry], nextCursor: null, loadingMore: false, listError: "", failedCursor: null,
      loadMore: vi.fn(), reload,
    } as never);
    vi.mocked(jsonFetch).mockResolvedValue([{ id: 2, name: "系统设计", entry_count: 1 }]);
    render(NotebookPage);
    effects[0]?.();
    await Promise.resolve();
    expect(slots[0]).toEqual([{ id: 2, name: "系统设计", entry_count: 1 }]);

    findElement(render(NotebookPage), (element) => element.type === "button" && element.key === "2")
      .props.onClick?.();
    findElement(render(NotebookPage), (element) => element.props["aria-label"] === "按来源过滤")
      .props.onChange?.({ target: { value: "interview" } });
    findElement(render(NotebookPage), (element) => element.props["aria-label"] === "搜索错题")
      .props.onChange?.({ target: { value: "  缓存  " } });
    const page = render(NotebookPage);
    const query = vi.mocked(useCursorList).mock.lastCall?.[0] as { queryKey: string; buildUrl: (cursor: string) => string };
    expect(query.queryKey).toBe("notebook:2:interview:缓存");
    expect(query.buildUrl("next")).toBe("/api/notebook?category_id=2&source=interview&q=%E7%BC%93%E5%AD%98&cursor=next");

    const remove = findElement(page, (element) => element.type === "button" && element.props.children === "移出");
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    await remove.props.onClick?.();
    expect(jsonFetch).not.toHaveBeenCalledWith("/api/notebook/9", { method: "DELETE" });
    await remove.props.onClick?.();
    expect(jsonFetch).toHaveBeenCalledWith("/api/notebook/9", { method: "DELETE" });
    expect(reload).toHaveBeenCalledOnce();
    expect(jsonFetch).toHaveBeenCalledWith("/api/notebook/categories");
  });

  it("暗号解码去除输入空白后提交并导航，失败时解锁", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 23 });
    findElement(render(JargonDecoderPage), (element) => element.type === "textarea")
      .props.onChange?.({ target: { value: "  抗压能力强  " } });
    const start = findElement(render(JargonDecoderPage),
      (element) => element.type === "button" && element.props.children === "启动暗号解码器 →");
    await start.props.onClick?.();
    expect(jsonFetch).toHaveBeenCalledWith("/api/tools/jargon-decodings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "抗压能力强" }),
    });
    expect(routerPush).toHaveBeenCalledWith("/tools/decoder/23");

    slots = [];
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("上游不可用"));
    findElement(render(JargonDecoderPage), (element) => element.type === "textarea")
      .props.onChange?.({ target: { value: "扁平化管理" } });
    await findElement(render(JargonDecoderPage),
      (element) => element.type === "button" && element.props.children === "启动暗号解码器 →")
      .props.onClick?.();
    expect(slots[1]).toBe(false);
    expect(slots[2]).toBe("上游不可用");
  });

  it("自我介绍使用默认简历和清理后的 JD 生成，并在完成后进入详情", async () => {
    render(IntrosPage);
    effects[1]?.();
    expect(slots[0]).toBe(4);
    findElement(render(IntrosPage), (element) => element.type === "textarea")
      .props.onChange?.({ target: { value: "  Java 架构师  " } });
    vi.mocked(fetchSse).mockResolvedValueOnce(undefined as never);
    await findElement(render(IntrosPage),
      (element) => element.type === "button" && element.props.children === "立即生成两版自我介绍")
      .props.onClick?.();
    expect(fetchSse).toHaveBeenCalledWith("/api/intros", expect.objectContaining({
      body: { resume_id: 4, resume_version_id: 42, jd: "Java 架构师" }, signal: expect.any(AbortSignal),
    }));
    const request = vi.mocked(fetchSse).mock.calls[0]?.[1] as { onDone: (result: { id: number }) => void };
    request.onDone({ id: 31 });
    expect(routerPush).toHaveBeenCalledWith("/intros/31");
  });

  it("自我介绍使用用户选择的历史发布版", async () => {
    slots[0] = 4;
    findElement(render(IntrosPage), (element) => element.type === "textarea")
      .props.onChange?.({ target: { value: "后端工程师" } });
    const select = findElement(render(IntrosPage), (element) => element.type === ResumeVersionSelect);
    (select.props.onChange as unknown as (id: number) => void)(41);
    await findElement(render(IntrosPage), (element) => element.type === "button" && element.props.children === "立即生成两版自我介绍").props.onClick?.();
    expect(fetchSse).toHaveBeenCalledWith("/api/intros", expect.objectContaining({
      body: { resume_id: 4, resume_version_id: 41, jd: "后端工程师" },
    }));
  });

  it("未发布版本的简历不会启动自我介绍生成", async () => {
    vi.mocked(useResumeOptions).mockReturnValue({ resumes: [{ id: 4, title: "草稿", versions: [] }], resumesError: "" } as never);
    slots[0] = 4;
    findElement(render(IntrosPage), (element) => element.type === "textarea")
      .props.onChange?.({ target: { value: "后端工程师" } });
    const button = findElement(render(IntrosPage), (element) => element.type === "button" && element.props.children === "立即生成两版自我介绍");
    expect(button.props).toMatchObject({ disabled: true });
    await button.props.onClick?.();
    expect(fetchSse).not.toHaveBeenCalled();
  });

  it("编辑投递仍提交已绑定的旧发布版，不自动切换最新版本", async () => {
    const application = { id: 8, company: "研发公司", role: "后端", stage: "interested", resume_id: 4, resume_version_id: 41 } as Application;
    vi.mocked(jsonFetch).mockResolvedValue(application);
    const onSuccess = vi.fn();
    const tree = render(() => ApplicationDialog({ initialData: application, onClose: vi.fn(), onSuccess }));
    await findElement(tree, (element) => element.type === "form").props.onSubmit?.({ preventDefault: vi.fn() });
    expect(jsonFetch).toHaveBeenCalledWith("/api/applications/8", expect.objectContaining({ method: "PATCH" }));
    const request = vi.mocked(jsonFetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({ resume_id: 4, resume_version_id: 41 });
    expect(onSuccess).toHaveBeenCalledWith(application);
  });

  it("排雷从链接带入固定版本，并发送该版本进行扫描", async () => {
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams("resumeId=4&resumeVersionId=41") as never);
    vi.mocked(jsonFetch).mockResolvedValue({ items: [] });
    const wrapper = ResumeDefensePage();
    const content = (wrapper.props as { children: ReactElement }).children.type as () => ReactElement;
    render(content);
    effects.splice(0).forEach((effect) => effect());
    await Promise.resolve();
    vi.mocked(jsonFetch).mockClear().mockResolvedValue({ id: 91 });
    await findElement(render(content), (element) => element.type === "form").props.onSubmit?.({ preventDefault: vi.fn() });
    expect(jsonFetch).toHaveBeenCalledWith("/api/tools/resume-defenses", expect.objectContaining({
      method: "POST", body: JSON.stringify({ targetRole: "", resumeId: 4, resume_version_id: 41 }),
    }));
    expect(routerPush).toHaveBeenCalledWith("/tools/defense/91");
  });

  it("投递准备页生成诊断和自我介绍均携带绑定版本", async () => {
    slots[0] = { application: { id: 8, company: "研发公司", role: "后端", resume_id: 4, resume_version_id: 41, jd: "后端岗位" } };
    vi.mocked(jsonFetch).mockResolvedValue(slots[0]);
    cursor = 0;
    function Preparation() { return useApplicationPreparation("8"); }
    const preparation = Preparation();
    await preparation.generate("diagnosis");
    const request = vi.mocked(jsonFetch).mock.calls.find(([path]) => path === "/api/resumes/4/diagnose")?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({ application_id: 8, resume_id: 4, resume_version_id: 41 });
    await preparation.generate("intro");
    expect(fetchSse).toHaveBeenCalledWith("/api/intros", expect.objectContaining({
      body: expect.objectContaining({ application_id: 8, resume_id: 4, resume_version_id: 41 }),
    }));
  });

  it("复盘页加载失败显示错误，空评分结果不展示趋势图", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("复盘暂不可用"));
    render(ReviewPage);
    effects[0]?.();
    await vi.waitFor(() => expect(slots[1]).toBe("复盘暂不可用"));
    expect(jsonFetch).toHaveBeenCalledWith("/api/review");
    expect(findElement(render(ReviewPage), (element) => (element.props as { message?: string }).message === "复盘暂不可用")).toBeTruthy();

    slots = [];
    effects = [];
    const empty = {
      totals: { drills: 0, interviews: 0, scoredAnswers: 0 }, overall: null, overallScore: null,
      drillAvg: null, interviewAvg: null, sessions: [], projects: [],
    };
    vi.mocked(jsonFetch).mockResolvedValueOnce(empty);
    render(ReviewPage);
    effects[0]?.();
    await vi.waitFor(() => expect(slots[0]).toEqual(empty));
    expect(findElement(render(ReviewPage), (element) => element.props.children ===
      "还没有已评分的作答记录。先到「题目练习」答几道题，或完成一场「模拟面试」，这里就会长出你的成绩曲线。")).toBeTruthy();
  });

  it("JD 画像按清理后的岗位描述提交，失败时解除生成状态", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 17 });
    findElement(render(JdPortraitPage), (element) => element.type === "textarea")
      .props.onChange?.({ target: { value: "  高级后端工程师  " } });
    await findElement(render(JdPortraitPage),
      (element) => element.type === "button" && element.props.children === "生成考点画像雷达 →")
      .props.onClick?.();
    expect(jsonFetch).toHaveBeenCalledWith("/api/tools/jd-portraits", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jd: "高级后端工程师" }),
    });
    expect(routerPush).toHaveBeenCalledWith("/tools/jd/17");

    slots = [];
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("画像生成失败"));
    findElement(render(JdPortraitPage), (element) => element.type === "textarea")
      .props.onChange?.({ target: { value: "前端架构" } });
    await findElement(render(JdPortraitPage),
      (element) => element.type === "button" && element.props.children === "生成考点画像雷达 →")
      .props.onClick?.();
    expect(slots[1]).toBe(false);
    expect(slots[2]).toBe("画像生成失败");
  });

  it("薪酬谈判校验必填项，并提交清理后的自定义公司与薪资", async () => {
    const start = () => findElement(render(SalaryNegotiationListPage),
      (element) => element.type === "button" && element.props.children === "开局！进入薪资博弈对决");
    await start().props.onClick?.();
    expect(slots[7]).toBe("请填写目标岗位与期望薪资");
    expect(jsonFetch).not.toHaveBeenCalled();

    findElement(render(SalaryNegotiationListPage), (element) => element.type === "button" && element.key === "custom")
      .props.onClick?.();
    findElement(render(SalaryNegotiationListPage),
      (element) => element.props.placeholder?.startsWith("请输入自定义公司类型") === true)
      .props.onChange?.({ target: { value: "  民营独角兽  " } });
    findElement(render(SalaryNegotiationListPage),
      (element) => element.props.placeholder?.startsWith("例如：资深前端工程师") === true)
      .props.onChange?.({ target: { value: "  技术负责人  " } });
    findElement(render(SalaryNegotiationListPage),
      (element) => element.props.placeholder?.startsWith("例如：35k") === true)
      .props.onChange?.({ target: { value: "  45k  " } });
    vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 26 });
    await start().props.onClick?.();
    expect(jsonFetch).toHaveBeenCalledWith("/api/tools/salary-negotiations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_company_tier: "民营独角兽", target_role: "技术负责人", expected_salary: "45k",
        current_or_competing_offer: "", hr_style: "standard",
      }),
    });
    expect(routerPush).toHaveBeenCalledWith("/tools/salary/26");
  });

  it("样式工厂移动端预览按钮切换到实时预览", () => {
    const page = render(StyleFactoryPage);
    findElement(page, (element) => element.type === "button" &&
      String(element.props.children).includes("实时预览")).props.onClick?.();
    expect(vi.mocked(useStylePreview).mock.results[0]?.value.setMobileTab).toHaveBeenCalledWith("preview");
  });
});
