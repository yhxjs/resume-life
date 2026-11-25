// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ProjectsEditor, WorkEditor } from "../projects-editor";
import { RichText } from "../rich-text";
import { richTextToMarkdown, stripRichText } from "@/lib/rich-text";
import { jsonFetch } from "@/lib/fetcher";
import type { ProjectItem } from "@/lib/modules";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));

const summary = {
  techStack: "TypeScript",
  brief: "新项目介绍",
  achievements: ["新成果甲", "新成果乙"],
};
const oldAchievements = ["旧成果甲", "旧成果乙"];
const oldSubItems = [
  { id: "brief", label: "", value: "旧项目介绍" },
  { id: "link", label: "项目链接", value: "https://example.com/project" },
  { id: "tech", label: "技术栈", value: "JavaScript" },
];

beforeEach(() => {
  vi.mocked(jsonFetch).mockReset().mockImplementation(async (url) => {
    if (url === "/api/projects") return [{ id: 1, name: "知识库项目" }];
    if (url === "/api/projects/1") return { summary };
    throw new Error(`unexpected url: ${url}`);
  });
});
afterEach(cleanup);

describe("项目摘取的预览与实际写入", () => {
  it.each(["projects", "work"] as const)("%s 切换简历后旧摘取不能写入，重开后按新目标写入", async (type) => {
    const onChange = vi.fn();
    const common = { id: "same-entry-id", start: "2024", end: "至今", description: "原有职责" };
    const editor = (resumeId: string) => type === "projects"
      ? <ProjectsEditor itemName="项目经历" items={[{ ...common, name: "同名项目", role: "参与" }]} resumeId={resumeId} status="idle" onChange={onChange} />
      : <WorkEditor itemName="工作经历" items={[{ ...common, company: "同名公司", title: "工程师" }]} resumeId={resumeId} status="idle" onChange={onChange} />;
    const view = render(editor("1"));
    fireEvent.click(screen.getByRole("button", { name: "从项目摘取" }));
    const brief = await screen.findByDisplayValue(summary.brief);
    fireEvent.change(brief, { target: { value: "针对旧简历编辑的草稿" } });
    view.rerender(editor("2"));
    expect(screen.getByRole("alert").textContent).toContain("目标条目信息已变化");
    expect(screen.getByDisplayValue("针对旧简历编辑的草稿")).toBeTruthy();
    const write = screen.getByRole("button", { name: "写入项目经历对应位置" }) as HTMLButtonElement;
    expect(write.disabled).toBe(true);
    fireEvent.click(write);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: "从项目摘取" }));
    await screen.findByDisplayValue(summary.techStack);
    expect(screen.queryByDisplayValue("针对旧简历编辑的草稿")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "写入项目经历对应位置" }));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]![0][0]).toMatchObject({ id: common.id, descriptionItems: summary.achievements });
  });

  it("条目重排与另一条更新不使当前摘取失效，实际写入仍属于原条目", async () => {
    const entry: ProjectItem = { id: "a", name: "项目甲", role: "开发", start: "", end: "", description: "甲原文" };
    const other: ProjectItem = { ...entry, id: "b", name: "项目乙", description: "乙原文" };
    const onChange = vi.fn();
    const view = render(<ProjectsEditor itemName="项目经历" items={[entry, other]} resumeId="1" status="idle" onChange={onChange} />);
    fireEvent.click(screen.getAllByRole("button", { name: "从项目摘取" })[0]!);
    await screen.findByDisplayValue(summary.techStack);
    const updatedOther = { ...other, description: "乙最新内容" };
    view.rerender(<ProjectsEditor itemName="项目经历" items={[updatedOther, entry]} resumeId="1" status="idle" onChange={onChange} />);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "写入项目经历对应位置" }));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]![0][0]).toEqual(updatedOther);
    expect(onChange.mock.calls[0]![0][1]).toMatchObject({ id: "a", name: "项目甲", descriptionItems: summary.achievements });
  });

  it.each(["projects", "work"] as const)("%s 摘取预览沿用真实名称、职位和日期", async (type) => {
    const common = { id: "entry-1", start: "2023.01", end: "2024.06", description: "已有描述" };
    if (type === "projects") {
      render(<ProjectsEditor itemName="项目经历" items={[{ ...common, name: "实际项目", role: "参与开发" }]} resumeId="1" status="idle" onChange={vi.fn()} />);
    } else {
      render(<WorkEditor itemName="工作经历" items={[{ ...common, company: "实际公司", title: "实习工程师" }]} resumeId="1" status="idle" onChange={vi.fn()} />);
    }
    fireEvent.click(screen.getByRole("button", { name: "从项目摘取" }));
    await screen.findByDisplayValue(summary.techStack);
    const preview = screen.getByRole("region", { name: "摘取后内容预览" });
    expect(preview.textContent).toContain(type === "projects" ? "实际项目" : "实际公司");
    expect(preview.textContent).toContain(type === "projects" ? "担任角色：参与开发" : "职位头衔：实习工程师");
    expect(preview.textContent).toContain("2023.01 — 2024.06");
    expect(preview.textContent).not.toContain("技术负责人 / 核心开发");
    expect(preview.textContent).not.toContain("至今");
  });

  it.each(["replace", "append"] as const)("%s 后编辑器、摘取预览及简历渲染保留纯文本技术描述", async (mode) => {
    const achievement = "封装 Array<T>，维护 <template> 与 <strong> 字面标签\n记录 &amp; 和 &lt;tag&gt;，P99 < 200ms";
    vi.mocked(jsonFetch).mockImplementation(async (url) => {
      if (url === "/api/projects") return [{ id: 1, name: "知识库项目" }];
      if (url === "/api/projects/1") return { summary: { techStack: "Map<K, V>", brief: "处理 &amp; 字面实体", achievements: [achievement] } };
      throw new Error(`unexpected url: ${url}`);
    });
    const entry: ProjectItem = {
      id: "entry-1", name: "实际项目", role: "开发", start: "", end: "",
      description: "旧描述", descriptionItems: ["<strong>原有贡献</strong> Array&lt;T&gt;"],
    };
    const onChange = vi.fn();
    const view = render(<ProjectsEditor itemName="项目经历" items={[entry]} resumeId="1" status="idle" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "从项目摘取" }));
    await screen.findByDisplayValue("Map<K, V>");
    if (mode === "append") fireEvent.click(screen.getByRole("radio", { name: "追加到现有内容" }));
    const preview = screen.getByRole("region", { name: "摘取后内容预览" });
    expect(preview.textContent).toContain(achievement);
    if (mode === "append") {
      expect(preview.textContent).toContain("原有贡献 Array<T>");
      expect(within(preview).getByText("原有贡献").tagName).toBe("STRONG");
    }
    fireEvent.click(screen.getByRole("button", { name: "写入项目经历对应位置" }));
    const saved = onChange.mock.calls[0]![0][0] as ProjectItem;
    const last = saved.descriptionItems!.at(-1)!;
    expect(stripRichText(last)).toBe(achievement);
    expect(richTextToMarkdown(last)).toBe(String.raw`封装 Array\<T\>，维护 \<template\> 与 \<strong\> 字面标签
记录 \&amp; 和 \&lt;tag\&gt;，P99 \< 200ms`);
    expect(saved.description).toBe(saved.descriptionItems!.join("\n"));
    expect(saved.subItems?.map(({ value }) => value)).toEqual(["Map<K, V>", "处理 &amp; 字面实体"]);
    if (mode === "append") expect(saved.descriptionItems![0]).toBe(entry.descriptionItems![0]);
    view.rerender(<ProjectsEditor itemName="项目经历" items={[saved]} resumeId="1" status="idle" onChange={onChange} />);
    const editors = view.container.querySelectorAll('[contenteditable="true"]');
    expect(editors[editors.length - 1]!.textContent).toBe(achievement.replace("\n", ""));
    const rendered = render(<RichText content={last} />);
    expect(rendered.container.textContent).toBe(achievement.replace("\n", ""));
    expect(rendered.container.querySelector("template, strong, script")).toBeNull();
    expect(rendered.container.querySelectorAll("br")).toHaveLength(1);
  });

  it.each([
    { mode: "replace", selected: [0], shape: "legacy" },
    { mode: "append", selected: [0], shape: "legacy" },
    { mode: "replace", selected: [1], shape: "empty-list" },
    { mode: "append", selected: [2], shape: "legacy" },
    { mode: "replace", selected: [2], shape: "list" },
    { mode: "replace", selected: [0, 1, 2], shape: "list" },
    { mode: "append", selected: [0, 1, 2], shape: "list" },
  ])("$mode 模式选取 $selected，兼容 $shape 描述并保留未选内容", async ({ mode, selected, shape }) => {
    const entry: ProjectItem = {
      id: "entry-1", name: "已有项目", role: "开发", start: "2023.01", end: "2024.06",
      description: shape === "list" ? "已经过时的整段描述" : "• 旧成果甲\n• 旧成果乙",
      subItems: oldSubItems,
      ...(shape === "list" ? { descriptionItems: oldAchievements } : shape === "empty-list" ? { descriptionItems: [] } : {}),
    };
    const onChange = vi.fn();
    render(<ProjectsEditor itemName="项目经历" items={[entry]} resumeId="1" status="idle" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "从项目摘取" }));
    await screen.findByDisplayValue(summary.techStack);
    const dialog = screen.getByRole("dialog", { name: "从项目摘取到简历" });
    const checkboxes = within(dialog).getAllByRole("checkbox");
    for (const index of [0, 1, 2]) {
      if (!selected.includes(index)) fireEvent.click(checkboxes[index]!);
    }
    if (mode === "append") fireEvent.click(within(dialog).getByRole("radio", { name: "追加到现有内容" }));
    const previewText = within(dialog).getByRole("region", { name: "摘取后内容预览" }).textContent ?? "";
    fireEvent.click(within(dialog).getByRole("button", { name: "写入项目经历对应位置" }));

    expect(onChange).toHaveBeenCalledOnce();
    const saved = onChange.mock.calls[0]![0][0] as ProjectItem;
    const expectedAchievements = selected.includes(2)
      ? (mode === "replace" ? summary.achievements : [...oldAchievements, ...summary.achievements])
      : oldAchievements;
    const expectedSubItems = oldSubItems.map((item) => ({
      ...item,
      value: item.label === "技术栈" && selected.includes(0) ? summary.techStack
        : item.label === "" && selected.includes(1) ? summary.brief : item.value,
    }));
    expect(saved.descriptionItems).toEqual(expectedAchievements);
    expect(saved.description).toBe(expectedAchievements.join("\n"));
    expect(saved.subItems).toEqual(expectedSubItems);
    expect(saved).toMatchObject({ id: entry.id, name: entry.name, role: entry.role, start: entry.start, end: entry.end });
    const expectedTexts = [...expectedAchievements, ...expectedSubItems.map((item) => item.value)];
    for (const text of expectedTexts) expect(previewText).toContain(text);
    for (const text of [...oldAchievements, ...summary.achievements, "JavaScript", summary.techStack, "旧项目介绍", summary.brief]) {
      if (!expectedTexts.includes(text)) expect(previewText).not.toContain(text);
    }
    expect(previewText).not.toContain("已经过时的整段描述");
  });

  it("取消所有成果勾选时，替换技术栈仍保留原成果并如实预览", async () => {
    const onChange = vi.fn();
    const entry: ProjectItem = {
      id: "entry-1", name: "已有项目", role: "开发", start: "", end: "",
      description: oldAchievements.join("\n"), descriptionItems: oldAchievements, subItems: oldSubItems,
    };
    render(<ProjectsEditor itemName="项目经历" items={[entry]} resumeId="1" status="idle" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "从项目摘取" }));
    await screen.findByDisplayValue(summary.techStack);
    const dialog = screen.getByRole("dialog");
    const checkboxes = within(dialog).getAllByRole("checkbox");
    fireEvent.click(checkboxes[3]!);
    fireEvent.click(checkboxes[4]!);
    const previewText = within(dialog).getByRole("region", { name: "摘取后内容预览" }).textContent;
    fireEvent.click(within(dialog).getByRole("button", { name: "写入项目经历对应位置" }));
    expect(onChange.mock.calls[0]![0][0].descriptionItems).toEqual(oldAchievements);
    for (const text of oldAchievements) expect(previewText).toContain(text);
    for (const text of summary.achievements) expect(previewText).not.toContain(text);
  });
});
