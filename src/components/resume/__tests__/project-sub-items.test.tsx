// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectSubItems } from "../project-sub-items";
import type { EntrySubItem } from "@/lib/modules";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ProjectSubItems 自定义副项组件", () => {
  it("无副项时显示空状态提示", () => {
    render(
      <ProjectSubItems
        item={{ subItems: [] }}
        itemIndex={0}
        onChange={vi.fn()}
        onAnnouncement={vi.fn()}
      />
    );
    expect(screen.getByText(/暂无副项/)).toBeDefined();
  });

  it("点击预设标签按钮新增对应副项", () => {
    const onChange = vi.fn();
    render(
      <ProjectSubItems
        item={{ subItems: [] }}
        itemIndex={0}
        onChange={onChange}
        onAnnouncement={vi.fn()}
      />
    );
    const techBtn = screen.getByRole("button", { name: /技术栈/i });
    fireEvent.click(techBtn);
    expect(onChange).toHaveBeenCalledWith({
      subItems: [expect.objectContaining({ label: "技术栈", value: "" })],
    });
  });

  it("副项的值使用 textarea 渲染，支持换行输入与自动折行", () => {
    const subItems: EntrySubItem[] = [
      { id: "sub-1", label: "技术栈", value: "Java 8、Spring Boot 2.x、MySQL\nRedis、Kafka" },
    ];
    const onChange = vi.fn();
    render(
      <ProjectSubItems
        item={{ subItems }}
        itemIndex={0}
        onChange={onChange}
        onAnnouncement={vi.fn()}
      />
    );

    const labelInput = screen.getByDisplayValue("技术栈");
    expect(labelInput.tagName.toLowerCase()).toBe("input");

    const valueTextarea = screen.getByPlaceholderText("内容，如：React 19, TypeScript, Tailwind CSS") as HTMLTextAreaElement;
    expect(valueTextarea.tagName.toLowerCase()).toBe("textarea");
    expect(valueTextarea.value).toBe("Java 8、Spring Boot 2.x、MySQL\nRedis、Kafka");
    expect(valueTextarea.className).toContain("break-words");

    fireEvent.change(valueTextarea, {
      target: { value: "Java 8、Spring Boot 2.x、MySQL\nRedis、Kafka、Dubbo、Docker" },
    });
    expect(onChange).toHaveBeenCalledWith({
      subItems: [
        {
          id: "sub-1",
          label: "技术栈",
          value: "Java 8、Spring Boot 2.x、MySQL\nRedis、Kafka、Dubbo、Docker",
        },
      ],
    });
  });

  it("支持修改标签名", () => {
    const subItems: EntrySubItem[] = [
      { id: "sub-1", label: "技术栈", value: "React 19" },
    ];
    const onChange = vi.fn();
    render(
      <ProjectSubItems
        item={{ subItems }}
        itemIndex={0}
        onChange={onChange}
        onAnnouncement={vi.fn()}
      />
    );

    const labelInput = screen.getByDisplayValue("技术栈");
    fireEvent.change(labelInput, { target: { value: "前端技术" } });
    expect(onChange).toHaveBeenCalledWith({
      subItems: [{ id: "sub-1", label: "前端技术", value: "React 19" }],
    });
  });

  it("支持删除副项", () => {
    const subItems: EntrySubItem[] = [
      { id: "sub-1", label: "技术栈", value: "React" },
      { id: "sub-2", label: "团队规模", value: "5人" },
    ];
    const onChange = vi.fn();
    render(
      <ProjectSubItems
        item={{ subItems }}
        itemIndex={0}
        onChange={onChange}
        onAnnouncement={vi.fn()}
      />
    );

    const deleteButtons = screen.getAllByTitle("删除此副项");
    fireEvent.click(deleteButtons[0]!);
    expect(onChange).toHaveBeenCalledWith({
      subItems: [{ id: "sub-2", label: "团队规模", value: "5人" }],
    });
  });

  it("支持上下调整副项顺序", () => {
    const subItems: EntrySubItem[] = [
      { id: "sub-1", label: "技术栈", value: "React" },
      { id: "sub-2", label: "团队规模", value: "5人" },
    ];
    const onChange = vi.fn();
    const onAnnouncement = vi.fn();
    render(
      <ProjectSubItems
        item={{ subItems }}
        itemIndex={0}
        onChange={onChange}
        onAnnouncement={onAnnouncement}
      />
    );

    const downButtons = screen.getAllByTitle("下移副项");
    fireEvent.click(downButtons[0]!);
    expect(onChange).toHaveBeenCalledWith({
      subItems: [
        { id: "sub-2", label: "团队规模", value: "5人" },
        { id: "sub-1", label: "技术栈", value: "React" },
      ],
    });
    expect(onAnnouncement).toHaveBeenCalledWith("副项已移到第 2 位");
  });
});
