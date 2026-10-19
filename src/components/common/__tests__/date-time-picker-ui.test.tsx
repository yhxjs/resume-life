// @vitest-environment jsdom
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTimePicker } from "../date-time-picker";

describe("DateTimePicker 交互测试", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T14:30:00"));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function TestWrapper({ initialValue = "" }: { initialValue?: string }) {
    const [value, setValue] = useState(initialValue);
    return (
      <div>
        <DateTimePicker value={value} onChange={setValue} ariaLabel="面试时间" />
        <span data-testid="selected-value">{value}</span>
      </div>
    );
  }

  it("打开后聚焦已选日期，日期名称包含年月日且公开选中状态", () => {
    render(<TestWrapper initialValue="2026-10-15T10:00" />);
    fireEvent.click(screen.getByRole("button", { name: "面试时间" }));
    const selected = screen.getByRole("button", { name: "2026年10月15日", pressed: true });
    expect(document.activeElement).toBe(selected);
    expect(screen.getByRole("button", { name: "2026年10月1日", pressed: false })).toBeDefined();
    expect(screen.getByRole("button", { name: "2026年11月1日", pressed: false })).toBeDefined();
    expect(screen.getByRole("button", { name: "10 点", pressed: true })).toBeDefined();
    expect(screen.getByRole("button", { name: "00 分", pressed: true })).toBeDefined();
  });

  it("浮层内 Escape 取消草稿、回焦触发器并阻止外层处理", () => {
    const outerKey = vi.fn();
    render(<div onKeyDown={outerKey}><TestWrapper initialValue="2026-10-15T10:00" /></div>);
    const trigger = screen.getByRole("button", { name: "面试时间" });
    fireEvent.click(trigger);
    const hour = screen.getByRole("button", { name: "14 点" });
    fireEvent.click(hour);
    hour.focus();
    fireEvent.keyDown(hour, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByTestId("selected-value").textContent).toBe("2026-10-15T10:00");
    expect(outerKey).not.toHaveBeenCalled();
  });

  it.each(["确定", "取消", "设为当前时间", "45 分", "明天10:00"])("%s 关闭浮层后恢复触发器焦点", (name) => {
    render(<TestWrapper initialValue="2026-10-15T10:00" />);
    const trigger = screen.getByRole("button", { name: "面试时间" });
    fireEvent.click(trigger);
    const action = screen.getByRole("button", { name });
    action.focus();
    fireEvent.click(action);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("焦点移出整个控件时收起浮层且不抢回焦点", () => {
    render(<><TestWrapper /><button>下一个字段</button></>);
    fireEvent.click(screen.getByRole("button", { name: "面试时间" }));
    const next = screen.getByRole("button", { name: "下一个字段" });
    fireEvent.blur(document.activeElement!, { relatedTarget: next });
    next.focus();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(next);
  });

  it("点击触发器展开浮层，点击确定按钮保存当前日期与时间", () => {
    render(<TestWrapper initialValue="2026-10-15T10:00" />);
    const trigger = screen.getByRole("button", { name: "面试时间" });
    fireEvent.click(trigger);

    // 弹窗展开
    expect(screen.getByRole("dialog", { name: "选择日期与时间" })).toBeDefined();

    // 点击小时 14 点
    const hourBtn = screen.getByRole("button", { name: "14 点" });
    fireEvent.click(hourBtn);

    // 点击确定按钮
    const confirmBtn = screen.getByRole("button", { name: "确定" });
    fireEvent.click(confirmBtn);

    // 验证更新且浮层关闭
    expect(screen.getByTestId("selected-value").textContent).toBe("2026-10-15T14:00");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("点击设为当前时间按钮，自动填入当前时刻并关闭", () => {
    render(<TestWrapper />);
    const trigger = screen.getByRole("button", { name: "面试时间" });
    fireEvent.click(trigger);

    const nowBtn = screen.getByRole("button", { name: "设为当前时间" });
    fireEvent.click(nowBtn);

    expect(screen.getByTestId("selected-value").textContent).toBe("2026-10-15T14:30");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("点击取消按钮放弃修改并关闭浮层", () => {
    render(<TestWrapper initialValue="2026-10-15T10:00" />);
    const trigger = screen.getByRole("button", { name: "面试时间" });
    fireEvent.click(trigger);

    // 切换到 16 点
    fireEvent.click(screen.getByRole("button", { name: "16 点" }));

    // 点击取消
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    // 仍为旧值，未保存
    expect(screen.getByTestId("selected-value").textContent).toBe("2026-10-15T10:00");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("点击分钟选项依然支持快速一步选定并关闭", () => {
    render(<TestWrapper initialValue="2026-10-15T10:00" />);
    const trigger = screen.getByRole("button", { name: "面试时间" });
    fireEvent.click(trigger);

    // 点击 45 分
    fireEvent.click(screen.getByRole("button", { name: "45 分" }));

    expect(screen.getByTestId("selected-value").textContent).toBe("2026-10-15T10:45");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
