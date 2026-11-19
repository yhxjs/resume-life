// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ExtractDialog, type ExtractPayload } from "../extract-dialog";
import { jsonFetch } from "@/lib/fetcher";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));

const projects = [{ id: 1, name: "智能简历平台" }];
const summary = {
  techStack: "React 19, TypeScript, Next.js",
  brief: "基于 AI 的全流程简历与求职平台",
  achievements: [
    "负责前端架构设计，优化拖拽渲染性能",
    "落地 STAR 亮点提炼与代码仓库扫描",
  ],
};

beforeEach(() => {
  vi.mocked(jsonFetch).mockReset().mockImplementation(async (url: string) => {
    if (url === "/api/projects") return projects as never;
    if (url === "/api/projects/1") return { summary } as never;
    throw new Error(`unexpected url: ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function openDialog(props: Parameters<typeof ExtractDialog>[0] = {}) {
  render(<ExtractDialog {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "从项目摘取" }));
}

describe("ExtractDialog 从项目摘取到简历", () => {
  describe.each(["replace", "append"] as const)("%s 时保护已变化的目标", (mode) => {
    const original = {
      current: "过时的整段字段",
      currentDescriptionItems: ["仅参与联调，尚未上线"],
      currentName: "原项目",
      currentSecondary: { label: "角色", value: "参与开发" },
      currentStart: "2024", currentEnd: "至今",
      currentSubItems: [{ id: "tech", label: "技术栈", value: "TypeScript" }],
    };
    const changes: { name: string; patch: Partial<typeof original> }[] = [
      { name: "正文", patch: { currentDescriptionItems: ["新编辑的实际职责"] } },
      { name: "名称", patch: { currentName: "新项目" } },
      { name: "角色", patch: { currentSecondary: { label: "角色", value: "仅负责验收" } } },
      { name: "开始日期", patch: { currentStart: "2023" } },
      { name: "结束日期", patch: { currentEnd: "2025" } },
      { name: "副项", patch: { currentSubItems: [{ id: "tech", label: "技术栈", value: "Go" }] } },
    ];
    it.each(changes)("$name 改变后保留手动草稿，禁止写入并暂停合并预览", async ({ patch }) => {
      const onApply = vi.fn();
      const onWrite = vi.fn();
      const view = render(<ExtractDialog {...original} onApply={onApply} onWrite={onWrite} />);
      fireEvent.click(screen.getByRole("button", { name: "从项目摘取" }));
      const brief = await screen.findByDisplayValue(summary.brief);
      fireEvent.change(brief, { target: { value: "手动核实的项目介绍" } });
      if (mode === "append") fireEvent.click(screen.getByRole("radio", { name: "追加到现有内容" }));
      view.rerender(<ExtractDialog {...original} {...patch} onApply={onApply} onWrite={onWrite} />);
      expect(screen.getByRole("alert").textContent).toContain("目标条目信息已变化");
      expect(screen.getByDisplayValue("手动核实的项目介绍")).toBeTruthy();
      expect(screen.queryByRole("region", { name: "摘取后内容预览" })).toBeNull();
      const write = screen.getByRole("button", { name: "写入项目经历对应位置" }) as HTMLButtonElement;
      expect(write.disabled).toBe(true);
      fireEvent.click(write);
      expect(onApply).not.toHaveBeenCalled();
      expect(onWrite).not.toHaveBeenCalled();
    });
  });

  it("目标只有富文本样式或被分条覆盖的旧正文改变时，保留草稿并可写入", async () => {
    const onApply = vi.fn();
    const props = { current: "过时整段", currentDescriptionItems: ["<strong>原有职责</strong> Array&lt;T&gt;"], onApply };
    const view = render(<ExtractDialog {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "从项目摘取" }));
    await screen.findByDisplayValue(summary.techStack);
    view.rerender(<ExtractDialog {...props} current="另一个过时整段" currentDescriptionItems={["原有职责 Array&lt;T&gt;"]} />);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "写入项目经历对应位置" }));
    expect(onApply).toHaveBeenCalledOnce();
  });

  it("读取期间目标旧整段改变，晚到的源档案不能解锁；重开后载入新目标并恢复写入", async () => {
    const pending = Promise.withResolvers<{ summary: typeof summary }>();
    vi.mocked(jsonFetch).mockImplementation(async (url) => {
      if (url === "/api/projects") return projects;
      if (url === "/api/projects/1") return pending.promise;
      throw new Error(`unexpected url: ${url}`);
    });
    const onWrite = vi.fn();
    const view = render(<ExtractDialog current="原整段职责" onWrite={onWrite} />);
    fireEvent.click(screen.getByRole("button", { name: "从项目摘取" }));
    await screen.findByRole("combobox");
    view.rerender(<ExtractDialog current="新整段职责，未上线" onWrite={onWrite} />);
    await act(async () => pending.resolve({ summary }));
    const write = screen.getByRole("button", { name: "写入项目经历对应位置" }) as HTMLButtonElement;
    expect(write.disabled).toBe(true);
    fireEvent.click(write);
    expect(onWrite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: "从项目摘取" }));
    await screen.findByDisplayValue(summary.techStack);
    fireEvent.click(screen.getByRole("radio", { name: "追加到现有内容" }));
    fireEvent.click(screen.getByRole("button", { name: "写入项目经历对应位置" }));
    expect(onWrite).toHaveBeenCalledOnce();
    expect(onWrite.mock.calls[0]![0]).toContain("新整段职责，未上线");
  });

  it("目标条目缺少名称、角色和日期时，预览不填入知识库名称或示例身份", async () => {
    openDialog();
    await screen.findByDisplayValue(summary.techStack);
    const preview = screen.getByRole("region", { name: "摘取后内容预览" });
    expect(within(preview).getByRole("heading").textContent).toBe("未填写名称");
    expect(preview.textContent).not.toContain(projects[0]!.name);
    expect(preview.textContent).not.toContain("担任角色");
    expect(preview.textContent).not.toContain("至今");
  });

  describe.each(["replace", "append"] as const)("%s 模式的空草稿", (mode) => {
    it.each(["全部清空", "只勾选的技术栈为空", "只勾选的成果为空", "非空成果未勾选"])("%s时禁止空写入，重新填写后可正常提交", async (scenario) => {
      const onApply = vi.fn();
      const onWrite = vi.fn();
      openDialog({ current: "已有描述", currentDescriptionItems: ["已有描述"], onApply, onWrite });
      const tech = await screen.findByDisplayValue(summary.techStack);
      const brief = screen.getByDisplayValue(summary.brief);
      const achievements = summary.achievements.map((text) => screen.getByDisplayValue(text));
      const checkboxes = screen.getAllByRole("checkbox");
      if (mode === "append") fireEvent.click(screen.getByRole("radio", { name: "追加到现有内容" }));

      if (scenario === "全部清空") {
        fireEvent.change(tech, { target: { value: " \t " } });
        fireEvent.change(brief, { target: { value: " \n " } });
        for (const editor of achievements) fireEvent.change(editor, { target: { value: " \n " } });
      } else if (scenario === "只勾选的技术栈为空") {
        fireEvent.click(checkboxes[1]!);
        fireEvent.click(checkboxes[2]!);
        fireEvent.change(tech, { target: { value: " " } });
      } else {
        fireEvent.click(checkboxes[0]!);
        fireEvent.click(checkboxes[1]!);
        fireEvent.change(achievements[0]!, { target: { value: " " } });
        if (scenario === "非空成果未勾选") fireEvent.click(checkboxes[4]!);
        else fireEvent.change(achievements[1]!, { target: { value: " " } });
      }

      const write = screen.getByRole("button", { name: "写入项目经历对应位置" }) as HTMLButtonElement;
      expect(write.disabled).toBe(true);
      expect(screen.getByRole("region", { name: "摘取后内容预览" }).textContent).toContain("已有描述");
      fireEvent.click(write);
      expect(onApply).not.toHaveBeenCalled();
      expect(onWrite).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeTruthy();

      const restoringTech = scenario === "全部清空" || scenario === "只勾选的技术栈为空";
      const editor = restoringTech ? tech : achievements[0]!;
      fireEvent.change(editor, { target: { value: " 重新填写的真实内容 " } });
      expect(write.disabled).toBe(false);
      expect(within(screen.getByRole("region", { name: "摘取后内容预览" })).getByText("重新填写的真实内容")).toBeTruthy();
      fireEvent.click(write);
      expect(onApply).toHaveBeenCalledExactlyOnceWith({
        techStack: restoringTech ? "重新填写的真实内容" : undefined,
        brief: undefined,
        achievements: restoringTech ? (scenario === "全部清空" ? [] : undefined) : ["重新填写的真实内容"],
        mode,
      });
      const newText = restoringTech ? "【技术栈】\n重新填写的真实内容" : "【项目描述与成果】\n• 重新填写的真实内容";
      expect(onWrite).toHaveBeenCalledExactlyOnceWith(mode === "append" ? `已有描述\n\n${newText}` : newText);
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it.each(["成功", "失败"])("切换项目后忽略旧请求的%s回包，保留当前项目及手动草稿", async (outcome) => {
    const pending = Promise.withResolvers<{ summary: typeof summary }>();
    const nextSummary = { techStack: "Vue", brief: "项目乙介绍", achievements: ["项目乙成果"] };
    vi.mocked(jsonFetch).mockImplementation(async (url) => {
      if (url === "/api/projects") return [...projects, { id: 2, name: "项目乙" }];
      if (url === "/api/projects/1") return pending.promise;
      if (url === "/api/projects/2") return { summary: nextSummary };
      throw new Error(`unexpected url: ${url}`);
    });
    const onApply = vi.fn();
    openDialog({ onApply });
    const picker = await screen.findByRole("combobox", { name: "选择项目" });
    const oldSignal = vi.mocked(jsonFetch).mock.calls.find(([url]) => url === "/api/projects/1")?.[1]?.signal;
    fireEvent.change(picker, { target: { value: "2" } });
    const editor = await screen.findByDisplayValue("Vue");
    fireEvent.change(editor, { target: { value: "Vue, TypeScript" } });
    await act(async () => {
      if (outcome === "成功") pending.resolve({ summary });
      else pending.reject(new Error("旧项目读取失败"));
    });

    expect(oldSignal?.aborted).toBe(true);
    expect((picker as HTMLSelectElement).value).toBe("2");
    expect(screen.getByDisplayValue("Vue, TypeScript")).toBeTruthy();
    expect(screen.queryByText("旧项目读取失败")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "写入项目经历对应位置" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ ...nextSummary, techStack: "Vue, TypeScript", mode: "replace" });
  });

  it("当前项目读取失败时，旧项目的晚到内容不能恢复写入；重新选择后可重试", async () => {
    const pending = Promise.withResolvers<{ summary: typeof summary }>();
    vi.mocked(jsonFetch).mockImplementation(async (url) => {
      if (url === "/api/projects") return [...projects, { id: 2, name: "项目乙" }];
      if (url === "/api/projects/1") return pending.promise;
      throw new Error("项目乙读取失败");
    });
    const onApply = vi.fn();
    openDialog({ onApply });
    const picker = await screen.findByRole("combobox", { name: "选择项目" });
    fireEvent.change(picker, { target: { value: "2" } });
    await screen.findByText("项目乙读取失败");
    await act(async () => pending.resolve({ summary }));
    expect(screen.queryByDisplayValue(summary.techStack)).toBeNull();
    const write = screen.getByRole("button", { name: "写入项目经历对应位置" }) as HTMLButtonElement;
    expect(write.disabled).toBe(true);
    fireEvent.click(write);
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.change(picker, { target: { value: "1" } });
    await screen.findByDisplayValue(summary.techStack);
    expect(screen.queryByText("项目乙读取失败")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "写入项目经历对应位置" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ ...summary, mode: "replace" });
  });

  it.each(["关闭", "取消", "背景", "Escape"])("%s后重开弹窗，旧档案请求不能覆盖新草稿", async (close) => {
    const pending = Promise.withResolvers<{ summary: typeof summary }>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(projects).mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(projects).mockResolvedValueOnce({ summary });
    const onApply = vi.fn();
    openDialog({ onApply });
    await screen.findByRole("combobox", { name: "选择项目" });
    const signal = vi.mocked(jsonFetch).mock.calls[1]?.[1]?.signal;
    if (close === "背景") fireEvent.click(screen.getByRole("dialog"));
    else if (close === "Escape") fireEvent.keyDown(document, { key: "Escape" });
    else fireEvent.click(screen.getByRole("button", { name: close }));
    expect(signal?.aborted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "从项目摘取" }));
    const editor = await screen.findByDisplayValue(summary.techStack);
    fireEvent.change(editor, { target: { value: "重新打开后补写的技术栈" } });
    await act(async () => pending.resolve({ summary: { ...summary, techStack: "旧请求技术栈" } }));
    expect(screen.getByDisplayValue("重新打开后补写的技术栈")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "写入项目经历对应位置" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith({ ...summary, techStack: "重新打开后补写的技术栈", mode: "replace" });
  });

  it.each(["成功", "失败"])("关闭后重开时忽略旧项目列表的%s回包", async (outcome) => {
    const pending = Promise.withResolvers<typeof projects>();
    vi.mocked(jsonFetch).mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(projects).mockResolvedValueOnce({ summary });
    openDialog();
    const signal = vi.mocked(jsonFetch).mock.calls[0]?.[1]?.signal;
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(signal?.aborted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "从项目摘取" }));
    await screen.findByDisplayValue(summary.techStack);
    await act(async () => {
      if (outcome === "成功") pending.resolve([{ id: 9, name: "过期项目" }]);
      else pending.reject(new Error("过期列表错误"));
    });
    expect(screen.queryByRole("option", { name: "过期项目" })).toBeNull();
    expect(screen.queryByText("过期列表错误")).toBeNull();
    expect(screen.getByDisplayValue(summary.techStack)).toBeTruthy();
    expect(jsonFetch).toHaveBeenCalledTimes(3);
  });

  it("重开后等待列表期间清空旧预览并禁用写入", async () => {
    const onApply = vi.fn();
    openDialog({ onApply });
    await screen.findByDisplayValue(summary.techStack);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    const pending = Promise.withResolvers<typeof projects>();
    vi.mocked(jsonFetch).mockImplementationOnce(() => pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "从项目摘取" }));
    expect(screen.queryByDisplayValue(summary.techStack)).toBeNull();
    const write = screen.getByRole("button", { name: "写入项目经历对应位置" }) as HTMLButtonElement;
    expect(write.disabled).toBe(true);
    fireEvent.click(write);
    expect(onApply).not.toHaveBeenCalled();
    await act(async () => pending.resolve(projects));
    await screen.findByDisplayValue(summary.techStack);
  });

  it("卸载时中止在途的项目读取", async () => {
    const pending = Promise.withResolvers<typeof projects>();
    vi.mocked(jsonFetch).mockImplementationOnce(() => pending.promise);
    const view = render(<ExtractDialog onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "从项目摘取" }));
    const signal = vi.mocked(jsonFetch).mock.calls[0]?.[1]?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(projects));
    expect(jsonFetch).toHaveBeenCalledTimes(1);
  });

  it("默认渲染从项目摘取按钮并支持当前经历数据透传", () => {
    const html = renderToStaticMarkup(
      <ExtractDialog
        current=""
        currentName="已有系统项目"
        currentSubItems={[{ id: "sub1", label: "技术栈", value: "Vue 3" }]}
        currentDescriptionItems={["已有成果 1", "已有成果 2"]}
        onWrite={vi.fn()}
        onApply={vi.fn()}
      />
    );
    expect(html).toContain("从项目摘取");
  });

  it("打开对话框后渲染项目三要素草稿，点击写入按真实载荷触发 onApply 与 onWrite", async () => {
    const onApply = vi.fn();
    const onWrite = vi.fn();
    openDialog({ current: "", currentName: "", onApply, onWrite });

    // 草稿预填：三要素输入框出现真实摘要内容
    await screen.findByDisplayValue("React 19, TypeScript, Next.js");
    expect(screen.getByDisplayValue("基于 AI 的全流程简历与求职平台")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "写入项目经历对应位置" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const payload = onApply.mock.calls[0]![0] as ExtractPayload;
    expect(payload.techStack).toBe("React 19, TypeScript, Next.js");
    expect(payload.brief).toBe("基于 AI 的全流程简历与求职平台");
    expect(payload.achievements).toEqual([
      "负责前端架构设计，优化拖拽渲染性能",
      "落地 STAR 亮点提炼与代码仓库扫描",
    ]);
    expect(payload.mode).toBe("replace");

    expect(onWrite).toHaveBeenCalledTimes(1);
    const text = onWrite.mock.calls[0]![0] as string;
    expect(text).toContain("【技术栈】\nReact 19, TypeScript, Next.js");
    expect(text).toContain("【项目简要概述】\n基于 AI 的全流程简历与求职平台");
    expect(text).toContain("【项目描述与成果】\n• 负责前端架构设计，优化拖拽渲染性能\n• 落地 STAR 亮点提炼与代码仓库扫描");
  });

  it("取消勾选「项目简要概述」后 onApply 载荷不再包含 brief", async () => {
    const onApply = vi.fn();
    openDialog({ current: "", onApply });

    await screen.findByDisplayValue("React 19, TypeScript, Next.js");

    // 顺序：技术栈、项目简要概述、项目描述与成果，其后是逐条成果勾选框
    const briefCheckbox = screen.getAllByRole("checkbox")[1]!;
    fireEvent.click(briefCheckbox);
    expect((briefCheckbox as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "写入项目经历对应位置" }));

    const payload = onApply.mock.calls[0]![0] as ExtractPayload;
    expect(payload.brief).toBeUndefined();
    expect(payload.techStack).toBe("React 19, TypeScript, Next.js");
    expect(payload.achievements).toHaveLength(2);
  });

  it("切换为追加模式后 onWrite 在现有内容末尾追加而不是替换", async () => {
    const onApply = vi.fn();
    const onWrite = vi.fn();
    openDialog({ current: "已有经历内容", onApply, onWrite });

    await screen.findByDisplayValue("React 19, TypeScript, Next.js");

    fireEvent.click(screen.getByRole("radio", { name: /追加到现有内容/ }));
    fireEvent.click(screen.getByRole("button", { name: "写入项目经历对应位置" }));

    const payload = onApply.mock.calls[0]![0] as ExtractPayload;
    expect(payload.mode).toBe("append");

    const text = onWrite.mock.calls[0]![0] as string;
    expect(text.startsWith("已有经历内容\n\n【技术栈】")).toBe(true);
  });
});
