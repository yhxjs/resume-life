// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ResumeVersionDiff } from "../resume-version-diff";
import { resolveStyle } from "@/lib/templates";
import type { ResumeSnapshot } from "@/lib/resume-version-types";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function snapshot(description: string, value = ""): ResumeSnapshot {
  return {
    title: "工程师简历", template: "classic", style_overrides: {}, resolved_style: resolveStyle("classic", []),
    modules: [{ key: "work", type: "work", label: "工作经历", sort: 0, content: [{
      id: "a", company: "甲公司", title: "工程师", start: "2023", end: "2024", description,
      subItems: [{ id: "tech", label: "技术栈", value }],
    }] }],
  };
}

function fieldCells(label: string, sectionName = "工作经历差异"): [HTMLElement, HTMLElement] {
  const section = screen.getByRole("region", { name: sectionName });
  const heading = within(section).getByText(label, { exact: true });
  const cells = heading.parentElement!.nextElementSibling!.children;
  return [cells[0] as HTMLElement, cells[1] as HTMLElement];
}

function showChanges(before: ResumeSnapshot, after: ResumeSnapshot) {
  render(<ResumeVersionDiff before={before} after={after} beforeLabel="版本一" afterLabel="版本二" />);
  fireEvent.click(screen.getByRole("checkbox", { name: "仅看变化" }));
}

describe("版本对比的可见文本", () => {
  it.each([
    ["封装 Array&lt;T&gt;", "封装 Array&lt;U&gt;", "封装 Array<T>", "封装 Array<U>", "T", "U"],
    ["记录 &amp;lt;old&amp;gt; 与 &lt;template&gt;", "记录 &amp;lt;new&amp;gt; 与 &lt;template&gt;", "记录 &lt;old&gt; 与 <template>", "记录 &lt;new&gt; 与 <template>", "old", "new"],
  ])("保留富文本技术正文并标出实际修改：%s", (old, next, oldText, newText, removed, added) => {
    showChanges(snapshot(`<strong>${old}</strong>`), snapshot(`<strong>${next}</strong>`));
    const [left, right] = fieldCells("甲公司 · 描述");
    expect(left.textContent).toBe(oldText);
    expect(right.textContent).toBe(newText);
    expect(left.querySelector("del")?.textContent).toContain(removed);
    expect(right.querySelector("ins")?.textContent).toContain(added);
  });

  it.each(["changed", "added", "removed"] as const)("%s 的纯文本副项保留标签与实体字面量", (status) => {
    const old = status === "added" ? "" : "Array<T> 与 &amp; 字面量";
    const next = status === "removed" ? "" : "Array<U> 与 &amp; 字面量";
    showChanges(snapshot("稳定正文", old), snapshot("稳定正文", next));
    const [left, right] = fieldCells("技术栈 · 内容");
    expect(left.textContent).toBe(old || "— 无此内容");
    expect(right.textContent).toBe(next || "— 无此内容");
    if (status === "changed") {
      expect(left.querySelector("del")?.textContent).toBe("T");
      expect(right.querySelector("ins")?.textContent).toBe("U");
    }
  });

  it.each(["added", "removed"] as const)("%s 富文本成果仍保留格式、换行及技术正文", (status) => {
    const stored = "<strong>封装 Array&lt;T&gt;</strong><br>记录 &amp;lt;tag&amp;gt;";
    showChanges(snapshot(status === "removed" ? stored : ""), snapshot(status === "added" ? stored : ""));
    const cells = fieldCells("甲公司 · 描述");
    const content = cells[status === "added" ? 1 : 0];
    expect(content.textContent).toBe("封装 Array<T>记录 &lt;tag&gt;");
    expect(content.querySelector("strong")?.textContent).toBe("封装 Array<T>");
    expect(content.querySelectorAll("br")).toHaveLength(1);
    expect(cells[status === "added" ? 0 : 1].textContent).toBe("— 无此内容");
  });

  it("简历名称等非正文的修改逐字比较，不解释标签或实体", () => {
    const before = snapshot("稳定正文");
    const after = snapshot("稳定正文");
    before.title = "简历 <T> &amp; 原文";
    after.title = "简历 <U> &amp; 原文";
    showChanges(before, after);
    const [left, right] = fieldCells("简历名称", "简历设置差异");
    expect(left.textContent).toBe(before.title);
    expect(right.textContent).toBe(after.title);
    expect(left.querySelector("del")?.textContent).toBe("T");
    expect(right.querySelector("ins")?.textContent).toBe("U");
  });
});
