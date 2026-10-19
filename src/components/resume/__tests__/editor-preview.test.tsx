// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ResumeEditorPreview } from "../editor-preview";
import type { ModuleData } from "@/lib/modules";
import { ResumeSaveQueue } from "@/lib/resume-save-queue-core";
import type { ResumeDocument } from "@/lib/resume-save-queue-draft";
import type { ResumeExportIssue } from "@/lib/resume-export-check";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  setManualScale: vi.fn(),
  resetToAuto: vi.fn(),
  downloadCheckedResume: vi.fn(async () => {}),
  getResumeSaveQueue: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/hooks/use-resume-zoom", async () => {
  const { useRef } = await import("react");
  return {
    useResumeZoom: () => ({
      scale: 1,
      isAutoFit: true,
      canZoomIn: true,
      canZoomOut: true,
      viewportClassName: "",
      containerRef: useRef<HTMLDivElement | null>(null),
      paperRef: useRef<HTMLDivElement | null>(null),
      paperHeight: 1123,
      zoomIn: mocks.zoomIn,
      zoomOut: mocks.zoomOut,
      setManualScale: mocks.setManualScale,
      resetToAuto: mocks.resetToAuto,
      handleViewportPointerDown: () => {},
    }),
  };
});
vi.mock("@/lib/resume-save-queue", () => ({
  getResumeSaveQueue: mocks.getResumeSaveQueue,
}));
vi.mock("@/lib/resume-export-client", () => ({
  downloadCheckedResume: mocks.downloadCheckedResume,
  measureResumeExportLayout: () => [],
}));
vi.mock("@/components/resume/doc", () => ({
  prepare: () => ({ title: "", modules: [] }),
  ResumeDoc: () => <div data-testid="paper-doc" />,
}));
vi.mock("@/components/resume/template-picker", () => ({
  TemplatePicker: ({ onChange }: { onChange: (tpl: string) => void }) => (
    <button type="button" onClick={() => onChange("modern")}>切换模板</button>
  ),
}));
vi.mock("@/components/resume/diagnose-dialog", () => ({
  DiagnoseDialog: () => null,
}));
vi.mock("@/components/resume/anonymize-export-dialog", () => ({
  AnonymizeExportDialog: () => null,
}));
vi.mock("@/components/resume/page-break-guide", () => ({
  PageBreakGuide: () => null,
}));
vi.mock("@/components/resume/spacing-tuning-popover", () => ({
  SpacingTuningPopover: ({ showPageBreakGuide, onTogglePageBreakGuide }: {
    showPageBreakGuide: boolean; onTogglePageBreakGuide: (show: boolean) => void;
  }) => <input type="checkbox" aria-label="分页警戒线" checked={showPageBreakGuide}
    onChange={(event) => onTogglePageBreakGuide(event.target.checked)} />,
}));
vi.mock("@/components/resume/zoom-controls", () => ({
  ZoomControls: ({ onZoomIn, onZoomOut, onResetAutoFit }: {
    onZoomIn: () => void; onZoomOut: () => void; onResetAutoFit: () => void;
  }) => (
    <div>
      <button type="button" onClick={onZoomIn}>放大</button>
      <button type="button" onClick={onZoomOut}>缩小</button>
      <button type="button" onClick={onResetAutoFit}>重置自适应</button>
    </div>
  ),
}));
vi.mock("@/components/resume/module-outline", () => ({
  ModuleOutline: ({ onSelect, onOrderCommit, onAddModule }: {
    onSelect: (key: string) => void;
    onOrderCommit: (keys: string[]) => void;
    onAddModule: () => void;
  }) => (
    <div>
      <button type="button" onClick={() => onSelect("skills")}>大纲定位技能</button>
      <button type="button" onClick={() => onOrderCommit(["skills", "work"])}>提交排序</button>
      <button type="button" onClick={onAddModule}>新增模块</button>
    </div>
  ),
}));
vi.mock("@/components/resume/resume-export-menu", () => ({
  ResumeExportMenu: ({ onRequestExport }: { onRequestExport: (format: "print" | "markdown" | "docx" | "anonymize" | "portfolio") => void }) => (
    <div>
      <button type="button" onClick={() => onRequestExport("markdown")}>导出 Markdown</button>
      <button type="button" onClick={() => onRequestExport("print")}>打印</button>
      <button type="button" onClick={() => onRequestExport("portfolio")}>导出作品集</button>
    </div>
  ),
}));
vi.mock("@/components/resume/resume-export-check-dialog", () => ({
  ResumeExportCheckDialog: ({ open, continueLabel, onContinue, onLocate }: {
    open: boolean; continueLabel: string; onContinue: (confirmed: boolean, skipExportCheck: boolean) => void;
    onLocate: (issue: ResumeExportIssue) => void;
  }) =>
    open ? (
      <div>
        <p>导出检查已打开：{continueLabel}</p>
        <button type="button" onClick={() => onContinue(true, false)}>确认继续</button>
        <button type="button" onClick={() => onLocate({
          id: "layout", kind: "pagination", severity: "warning", moduleKey: "__layout__",
          moduleLabel: "布局", excerpt: "", message: "分页溢出",
        })}>定位布局问题</button>
      </div>
    ) : null,
}));

const modules: ModuleData[] = [
  { key: "skills", type: "skills", label: "技能", sort: 1, content: { items: ["React", "TypeScript"] } },
];

function renderPreview(id = "r-1") {
  return render(
    <ResumeEditorPreview
      id={id}
      titleDraft="我的简历"
      modules={modules}
      template="classic"
      customs={[]}
      mobileTab="preview"
      onSwitchTemplate={vi.fn()}
      onApplySuggestion={vi.fn(() => true)}
      onUpdateStyleOverrides={vi.fn()}
    />
  );
}

beforeEach(() => {
  mocks.getResumeSaveQueue.mockReturnValue({ flush: async () => {}, needsUnloadWarning: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("ResumeEditorPreview 预览与导出交互", () => {
  it("减少动效时大纲定位直接设置预览滚动位置，不启动逐帧动画", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    vi.useFakeTimers();
    try {
      vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
      const { container } = render(<ResumeEditorPreview
        id="r-1" titleDraft="我的简历" modules={modules} template="classic" customs={[]}
        mobileTab="preview" onSwitchTemplate={vi.fn()} onApplySuggestion={vi.fn(() => true)}
        locateTarget={{ key: "skills", timestamp: 1 }}
      />);
      const target = screen.getByTestId("paper-doc");
      target.setAttribute("data-resume-module", "skills");
      Object.defineProperties(target, {
        offsetTop: { value: 1000 }, offsetHeight: { value: 100 }, offsetParent: { value: target.parentElement },
      });
      const viewport = container.querySelector<HTMLElement>(".zoom-viewport")!;
      Object.defineProperty(viewport, "clientHeight", { value: 400 });
      await act(async () => { vi.advanceTimersByTime(25); });
      expect(viewport.scrollTop).toBe(865);
      expect(target.classList.contains("resume-highlight-pulse")).toBe(true);
      expect(frame).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])("导出布局问题定位遵循减少动效偏好 %s", (reduce) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduce })));
    const scrollIntoView = vi.fn();
    renderPreview();
    const paper = screen.getByTestId("paper-doc").parentElement!;
    paper.scrollIntoView = scrollIntoView;
    fireEvent.click(screen.getByRole("button", { name: "导出 Markdown" }));
    fireEvent.click(screen.getByRole("button", { name: "定位布局问题" }));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: reduce ? "auto" : "smooth", block: "center" });
  });

  it("实际作品集弹窗等待最新正文保存，然后才 POST 并下载", async () => {
    let resolveSave!: (document: ResumeDocument) => void;
    let localDraft = "";
    const patch = vi.fn<(body: Record<string, unknown>, signal: AbortSignal) => Promise<ResumeDocument>>(() => new Promise<ResumeDocument>((resolve) => { resolveSave = resolve; }));
    const queue = new ResumeSaveQueue(patch, { read: () => "", write: (value) => { localDraft = value; } });
    mocks.getResumeSaveQueue.mockReturnValue(queue);
    const fetchMock = vi.fn().mockImplementation((url: string) => Promise.resolve(
      url === "/api/portfolio/sources" ? { ok: true, json: async () => ({ resumes: [], projects: [] }) }
        : { ok: true, blob: async () => new Blob(["zip"]) },
    ));
    const createObjectURL = vi.fn(() => "blob:export");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    queue.edit({ modules: { skills: { items: ["最新的技能内容"] } } });
    renderPreview("1");
    try {
      fireEvent.click(screen.getByRole("button", { name: "导出作品集" }));
      await screen.findByText("项目库暂无可用档案");
      fireEvent.click(screen.getByRole("button", { name: "生成并下载静态站点 Zip 包" }));
      await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
      expect(patch.mock.calls[0]?.[0]).toMatchObject({ modules: { skills: { items: ["最新的技能内容"] } } });
      expect(localDraft).toContain("最新的技能内容");
      expect(fetchMock).not.toHaveBeenCalledWith("/api/portfolio/export", expect.anything());
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(click).not.toHaveBeenCalled();
      await act(async () => resolveSave({ resume: { title: "我的简历" }, modules }));
      await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
      expect(localDraft).toBe("");
      expect(queue.needsUnloadWarning).toBe(false);
      expect(fetchMock).toHaveBeenCalledWith("/api/portfolio/export", expect.objectContaining({ method: "POST", body: expect.stringContaining('"resumeId":1') }));
      expect(screen.queryByText("导出个人作品集与静态网页")).toBeNull();
    } finally {
      queue.disposeAutoWork();
    }
  });

  it("实际保存队列遇到 409 时阻止作品集 POST，保留草稿与弹窗", async () => {
    let localDraft = "";
    const conflict = Object.assign(new Error("草稿保存冲突，请刷新后重试"), { status: 409 });
    const patch = vi.fn().mockRejectedValue(conflict);
    const queue = new ResumeSaveQueue(patch, { read: () => "", write: (value) => { localDraft = value; } });
    mocks.getResumeSaveQueue.mockReturnValue(queue);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ resumes: [], projects: [] }) });
    const createObjectURL = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    queue.edit({ title: "未保存的标题" });
    renderPreview("1");
    try {
      fireEvent.click(screen.getByRole("button", { name: "导出作品集" }));
      await screen.findByText("项目库暂无可用档案");
      fireEvent.click(screen.getByRole("button", { name: "生成并下载静态站点 Zip 包" }));
      await screen.findByText("草稿保存冲突，请刷新后重试");
      expect(patch).toHaveBeenCalledTimes(1);
      expect(localDraft).toContain("未保存的标题");
      expect(queue.needsUnloadWarning).toBe(true);
      expect(screen.getByText("导出个人作品集与静态网页")).toBeTruthy();
      expect(fetchMock).not.toHaveBeenCalledWith("/api/portfolio/export", expect.anything());
      expect(createObjectURL).not.toHaveBeenCalled();
    } finally {
      queue.disposeAutoWork();
    }
  });

  it("保存队列仍提示未保存时拒绝作品集导出", async () => {
    mocks.getResumeSaveQueue.mockReturnValue({ flush: async () => {}, needsUnloadWarning: true });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ resumes: [], projects: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    renderPreview("1");
    fireEvent.click(screen.getByRole("button", { name: "导出作品集" }));
    await screen.findByText("项目库暂无可用档案");
    fireEvent.click(screen.getByRole("button", { name: "生成并下载静态站点 Zip 包" }));
    await screen.findByText("草稿尚未保存成功，请先解决保存问题再导出");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/portfolio/export", expect.anything());
  });

  it("分页偏好读取被拒绝时仍渲染预览并默认关闭警戒线", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage is unavailable", "SecurityError");
    });
    expect(() => renderPreview()).not.toThrow();
    expect(screen.getByTestId("paper-doc")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "分页警戒线" }) as HTMLInputElement).checked).toBe(false);
  });

  it("分页偏好写入被拒绝时仍可在当前页面来回切换", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is unavailable", "SecurityError");
    });
    renderPreview();
    const toggle = screen.getByRole("checkbox", { name: "分页警戒线" }) as HTMLInputElement;
    const errors: unknown[] = [];
    const captureError = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault(); };
    window.addEventListener("error", captureError);
    try {
      fireEvent.click(toggle);
      expect(toggle.checked).toBe(true);
      fireEvent.click(toggle);
      expect(toggle.checked).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener("error", captureError);
    }
  });

  it("正常存储仍读取并持久化分页偏好", () => {
    localStorage.setItem("resume_page_break_guide", "true");
    renderPreview();
    const toggle = screen.getByRole("checkbox", { name: "分页警戒线" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(localStorage.getItem("resume_page_break_guide")).toBe("false");
  });

  it("渲染纸张与字数统计", () => {
    renderPreview();
    expect(screen.getByTestId("paper-doc")).toBeTruthy();
    expect(screen.getByText(/字/)).toBeTruthy();
  });

  it("点击放大调用缩放回调", () => {
    // mobileTab="edit" 时挂载副作用不触发 resetToAuto，点击回调可精确计数
    render(
      <ResumeEditorPreview
        id="r-1"
        titleDraft="我的简历"
        modules={modules}
        template="classic"
        customs={[]}
        mobileTab="edit"
        onSwitchTemplate={vi.fn()}
        onApplySuggestion={vi.fn(() => true)}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(mocks.zoomIn).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "重置自适应" }));
    expect(mocks.resetToAuto).toHaveBeenCalledTimes(1);
  });

  it("点击导出 Markdown 打开导出检查弹窗，确认后携带 md 格式与标题下载", async () => {
    const onSwitchTemplate = vi.fn();
    render(
      <ResumeEditorPreview
        id="r-1"
        titleDraft="我的简历"
        modules={modules}
        template="classic"
        customs={[]}
        mobileTab="preview"
        onSwitchTemplate={onSwitchTemplate}
        onApplySuggestion={vi.fn(() => true)}
      />
    );

    // 状态变化：初始无导出检查弹窗 → 点击后打开
    expect(screen.queryByText(/导出检查已打开/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "导出 Markdown" }));
    expect(screen.getByText(/导出检查已打开/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "确认继续" }));
    await waitFor(() => {
      expect(mocks.downloadCheckedResume).toHaveBeenCalledWith("r-1", "我的简历", "md", true, { skipExportCheck: false });
    });
  });

  it("模板切换与大纲排序回调透传", () => {
    const onSwitchTemplate = vi.fn();
    const onSelectModule = vi.fn();
    const onOrderCommit = vi.fn();
    const onAddModule = vi.fn();
    render(
      <ResumeEditorPreview
        id="r-1"
        titleDraft="我的简历"
        modules={modules}
        template="classic"
        customs={[]}
        mobileTab="preview"
        onSwitchTemplate={onSwitchTemplate}
        onSelectModule={onSelectModule}
        onOrderCommit={onOrderCommit}
        onAddModule={onAddModule}
        onApplySuggestion={vi.fn(() => true)}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "切换模板" }));
    expect(onSwitchTemplate).toHaveBeenCalledWith("modern");

    fireEvent.click(screen.getByRole("button", { name: "大纲定位技能" }));
    expect(onSelectModule).toHaveBeenCalledWith("skills");

    fireEvent.click(screen.getByRole("button", { name: "提交排序" }));
    expect(onOrderCommit).toHaveBeenCalledWith(["skills", "work"]);

    fireEvent.click(screen.getByRole("button", { name: "新增模块" }));
    expect(onAddModule).toHaveBeenCalledTimes(1);
  });

  it("在大纲排序下方渲染样式调整按钮，点击可展开与关闭样式面板", () => {
    const onUpdateStyleOverrides = vi.fn();
    render(
      <ResumeEditorPreview
        id="r-1"
        titleDraft="我的简历"
        modules={modules}
        template="classic"
        customs={[]}
        mobileTab="preview"
        onSwitchTemplate={vi.fn()}
        onApplySuggestion={vi.fn(() => true)}
        onUpdateStyleOverrides={onUpdateStyleOverrides}
      />
    );

    const styleBtn = screen.getByRole("button", { name: /样式调整/ });
    expect(styleBtn).toBeTruthy();

    // 点击打开面板
    fireEvent.click(styleBtn);
    expect(screen.getByRole("button", { name: "存为模板" })).toBeTruthy();

    // 点击关闭按钮
    fireEvent.click(screen.getByRole("button", { name: "关闭样式面板" }));
    expect(screen.queryByRole("button", { name: "存为模板" })).toBeNull();
  });
});
