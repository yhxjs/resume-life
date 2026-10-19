// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SummaryEditor } from "../module-content-editors";

afterEach(() => {
  cleanup();
});

describe("SummaryEditor 自我评价多项展示形式", () => {
  it("将多行文本或已有多项条目展示为多行独立条目", () => {
    const onChange = vi.fn();
    render(
      <SummaryEditor
        content={{ text: "5年全栈开发经验\n精通 React 与 Node.js 体系" }}
        onChange={onChange}
        status="idle"
      />
    );

    expect(screen.getByText("自我评价要点")).toBeTruthy();
    expect(screen.getByText("支持分行拖拽排版")).toBeTruthy();
    expect(screen.getByRole("button", { name: "• 无序列表" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1. 有序列表" })).toBeTruthy();

    expect(screen.getByLabelText("自我评价第 1 行")).toBeTruthy();
    expect(screen.getByLabelText("自我评价第 2 行")).toBeTruthy();
    expect(screen.getByText("+ 添加一行评价")).toBeTruthy();
  });

  it("点击『+ 添加一行评价』能够新增一行条目", () => {
    const onChange = vi.fn();
    render(
      <SummaryEditor
        content={{ text: "优势一" }}
        onChange={onChange}
        status="idle"
      />
    );

    fireEvent.click(screen.getByText("+ 添加一行评价"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptionItems: ["优势一", ""],
      })
    );
  });

  it("点击删除按钮能够删除对应行条目", () => {
    const onChange = vi.fn();
    render(
      <SummaryEditor
        content={{
          text: "优势一\n优势二",
          descriptionItems: ["优势一", "优势二"],
        }}
        onChange={onChange}
        status="idle"
      />
    );

    const deleteButtons = screen.getAllByTitle("删除该行");
    expect(deleteButtons).toHaveLength(2);

    fireEvent.click(deleteButtons[1]!);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptionItems: ["优势一"],
        text: "优势一",
      })
    );
  });

  it("支持有序列表与无序列表风格切换", () => {
    const onChange = vi.fn();
    render(
      <SummaryEditor
        content={{
          text: "优势一\n优势二",
          descriptionItems: ["优势一", "优势二"],
          descriptionStyle: "unordered",
        }}
        onChange={onChange}
        status="idle"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "1. 有序列表" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptionStyle: "ordered",
      })
    );
  });

  it("支持上下调整条目顺序", () => {
    const onChange = vi.fn();
    render(
      <SummaryEditor
        content={{
          text: "第一条\n第二条",
          descriptionItems: ["第一条", "第二条"],
        }}
        onChange={onChange}
        status="idle"
      />
    );

    const downButtons = screen.getAllByTitle("下移此行");
    fireEvent.click(downButtons[0]!);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptionItems: ["第二条", "第一条"],
        text: "第二条\n第一条",
      })
    );
  });

  it("传递正确的参数给 renderActions 并支持采纳写回", () => {
    const onChange = vi.fn();
    render(
      <SummaryEditor
        content={{
          text: "原优势一",
          descriptionItems: ["原优势一"],
          descriptionStyle: "unordered",
        }}
        onChange={onChange}
        status="idle"
        renderActions={({ text, items, descriptionStyle, updateText }) => (
          <button
            type="button"
            onClick={() => updateText("新优势A\n新优势B", ["新优势A", "新优势B"], "replace")}
          >
            自定义润色按钮 ({text}, {items?.length}, {descriptionStyle})
          </button>
        )}
      />
    );

    const actionBtn = screen.getByRole("button", {
      name: "自定义润色按钮 (原优势一, 1, unordered)",
    });
    expect(actionBtn).toBeTruthy();

    fireEvent.click(actionBtn);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptionItems: ["新优势A", "新优势B"],
        text: "新优势A\n新优势B",
      }),
      { immediate: true }
    );
  });
});
