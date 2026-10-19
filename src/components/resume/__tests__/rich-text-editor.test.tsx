// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RichTextEditor } from "../rich-text-editor";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("click 激活色板和加粗，格式化时恢复离开编辑区前的选区", () => {
  const exec = vi.fn(() => true);
  Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
  Object.defineProperty(document, "queryCommandState", { configurable: true, value: () => true });
  render(<RichTextEditor value="选中这段文字" onChange={vi.fn()} ariaLabel="项目描述" />);
  const editor = screen.getByRole("textbox", { name: "项目描述" });
  const range = document.createRange();
  range.setStart(editor.firstChild!, 0);
  range.setEnd(editor.firstChild!, 2);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent.mouseUp(editor);
  fireEvent.blur(editor);
  window.getSelection()!.removeAllRanges();
  const colors = screen.getByRole("button", { name: "设置文字颜色" });
  fireEvent.click(colors);
  expect(colors.getAttribute("aria-expanded")).toBe("true");
  const colorOption = screen.getByRole("button", { name: "商务蓝" });
  fireEvent.click(colorOption);
  expect(exec).toHaveBeenCalledWith("foreColor", false, expect.any(String));
  expect(window.getSelection()!.toString()).toBe("选中");
  fireEvent.click(screen.getByRole("button", { name: "加粗文本" }));
  expect(exec).toHaveBeenCalledWith("bold", false);
  expect(screen.getByRole("button", { name: "加粗文本" }).getAttribute("aria-pressed")).toBe("true");
});
