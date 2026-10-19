// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import React from "react";
import { render, screen } from "@testing-library/react";
import { ResumeDoc } from "../doc";
import { prepare } from "../doc-data";
import { DEFAULT_STYLE } from "@/lib/templates";

describe("ResumeDoc 自我评价纸面多项列表渲染", () => {
  it("无序列表风格下将多项自我评价渲染为项目符号列表 (•)", () => {
    const prepared = prepare("测试简历", [
      {
        type: "basic",
        label: "基本信息",
        content: { name: "张三", phone: "13800000000" },
      },
      {
        type: "summary",
        label: "自我评价",
        content: {
          text: "5年全栈经验\n熟练微服务架构",
          descriptionItems: ["5年全栈经验", "熟练微服务架构"],
          descriptionStyle: "unordered",
        },
      },
    ]);

    render(<ResumeDoc prepared={prepared} style={DEFAULT_STYLE} />);

    expect(screen.getByText("5年全栈经验")).toBeTruthy();
    expect(screen.getByText("熟练微服务架构")).toBeTruthy();
    // 验证包含两个 entry
    const entry0 = document.querySelector('[data-resume-entry="0"]');
    const entry1 = document.querySelector('[data-resume-entry="1"]');
    expect(entry0).toBeTruthy();
    expect(entry1).toBeTruthy();
    expect(entry0?.textContent).toContain("•");
    expect(entry1?.textContent).toContain("•");
  });

  it("有序列表风格下将多项自我评价渲染为数字序号列表 (1. 2.)", () => {
    const prepared = prepare("测试简历", [
      {
        type: "basic",
        label: "基本信息",
        content: { name: "李四", phone: "13900000000" },
      },
      {
        type: "summary",
        label: "自我评价",
        content: {
          text: "核心优势一\n核心优势二",
          descriptionItems: ["核心优势一", "核心优势二"],
          descriptionStyle: "ordered",
        },
      },
    ]);

    render(<ResumeDoc prepared={prepared} style={DEFAULT_STYLE} />);

    expect(screen.getByText("核心优势一")).toBeTruthy();
    expect(screen.getByText("核心优势二")).toBeTruthy();
    const entry0 = document.querySelector('[data-resume-entry="0"]');
    const entry1 = document.querySelector('[data-resume-entry="1"]');
    expect(entry0).toBeTruthy();
    expect(entry1).toBeTruthy();
    expect(entry0?.textContent).toContain("1.");
    expect(entry1?.textContent).toContain("2.");
  });

  it("老数据仅有多行纯文本时也能自动拆解并渲染为多项列表", () => {
    const prepared = prepare("测试简历", [
      {
        type: "basic",
        label: "基本信息",
        content: { name: "王五", phone: "13700000000" },
      },
      {
        type: "summary",
        label: "自我评价",
        content: {
          text: "纯文本第一行\n纯文本第二行",
        },
      },
    ]);

    render(<ResumeDoc prepared={prepared} style={DEFAULT_STYLE} />);

    expect(screen.getByText("纯文本第一行")).toBeTruthy();
    expect(screen.getByText("纯文本第二行")).toBeTruthy();
    const entry0 = document.querySelector('[data-resume-entry="0"]');
    const entry1 = document.querySelector('[data-resume-entry="1"]');
    expect(entry0).toBeTruthy();
    expect(entry1).toBeTruthy();
  });
});
