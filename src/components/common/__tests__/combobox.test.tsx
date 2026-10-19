// @vitest-environment jsdom
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Combobox } from "../combobox";

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Picker() {
  const [value, setValue] = useState("model-a");
  return <Combobox value={value} onChange={setValue} options={["model-a", "model-b"]} ariaLabel="模型" />;
}

it("初始和 Escape 收起后仍能读取当前选择", () => {
  render(<Picker />);
  const input = screen.getByRole("combobox", { name: "模型" });
  expect(screen.getByRole("combobox", { description: "当前选择：model-a" })).toBe(input);
  fireEvent.focus(input);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("combobox", { description: "当前选择：model-a" })).toBe(input);
});

it("键盘确认的新值在可访问描述中同步更新", () => {
  render(<Picker />);
  const input = screen.getByRole("combobox");
  fireEvent.focus(input);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("combobox", { description: "当前选择：model-b" })).toBe(input);
});

it("自由输入确认后读出新值，未确认的查询不改变当前选择", () => {
  render(<Picker />);
  const input = screen.getByRole("combobox") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "custom-model" } });
  expect(input.value).toBe("custom-model");
  expect(screen.getByRole("combobox", { description: "当前选择：model-a" })).toBe(input);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByRole("combobox", { description: "当前选择：custom-model" })).toBe(input);
  expect(input.value).toBe("");
});
