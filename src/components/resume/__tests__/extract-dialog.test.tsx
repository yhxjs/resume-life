// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  vi.mocked(jsonFetch).mockImplementation(async (url: string) => {
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
