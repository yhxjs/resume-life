// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { RichTextEditor } from "../rich-text-editor";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("首次展示与外部草稿切换在绘制前已有完整正文，不短暂显示空白或旧内容", () => {
  const observed: string[] = [];
  function Preview({ value }: { value: string }) {
    const root = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      observed.push(root.current!.querySelector('[role="textbox"]')!.innerHTML);
    }, [value]);
    return <div ref={root}><RichTextEditor value={value} onChange={vi.fn()} ariaLabel="项目描述" /></div>;
  }
  const first = "负责<strong>Map&lt;K, V&gt;</strong> 与 &amp;amp;";
  const second = "更正后的<strong>职责</strong>，尚未上线。";
  const view = render(<Preview value={first} />);
  view.rerender(<Preview value={second} />);
  expect(observed).toEqual([first, second]);
});

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

it("禁用时阻止编辑、粘贴和格式快捷键，恢复后可正常编辑", () => {
  const exec = vi.fn(() => true);
  Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
  const onChange = vi.fn();
  const view = render(<RichTextEditor value="原草稿" onChange={onChange} disabled ariaLabel="项目描述" />);
  const editor = screen.getByRole("textbox", { name: "项目描述" });
  expect(editor.getAttribute("contenteditable")).toBe("false");
  expect(editor.getAttribute("aria-disabled")).toBe("true");
  expect(editor.getAttribute("tabindex")).toBe("-1");
  expect((screen.getByRole("button", { name: "加粗文本" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "设置文字颜色" }) as HTMLButtonElement).disabled).toBe(true);
  editor.innerHTML = "意外晚到输入";
  fireEvent.input(editor);
  fireEvent.keyDown(editor, { key: "b", ctrlKey: true });
  fireEvent.paste(editor, { clipboardData: { getData: () => "粘贴文本" } });
  fireEvent.click(screen.getByRole("button", { name: "加粗文本" }));
  fireEvent.click(screen.getByRole("button", { name: "设置文字颜色" }));
  expect(onChange).not.toHaveBeenCalled();
  expect(exec).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "商务蓝" })).toBeNull();
  view.rerender(<RichTextEditor value="恢复后的草稿" onChange={onChange} disabled={false} ariaLabel="项目描述" />);
  expect(editor.getAttribute("contenteditable")).toBe("true");
  expect(editor.getAttribute("aria-disabled")).not.toBe("true");
  editor.innerHTML = "手动<strong>改写</strong>";
  fireEvent.input(editor);
  expect(onChange).toHaveBeenCalledExactlyOnceWith("手动<strong>改写</strong>");
  fireEvent.click(screen.getByRole("button", { name: "加粗文本" }));
  expect(exec).toHaveBeenCalledWith("bold", false);
});

it("色板展开后禁用时隐藏选项，禁用期间跟随外部值更新", () => {
  const onChange = vi.fn();
  const view = render(<RichTextEditor value="原草稿" onChange={onChange} ariaLabel="项目描述" />);
  fireEvent.click(screen.getByRole("button", { name: "设置文字颜色" }));
  expect(screen.getByRole("button", { name: "商务蓝" })).toBeTruthy();
  view.rerender(<RichTextEditor value="新确认的草稿" onChange={onChange} disabled ariaLabel="项目描述" />);
  expect(screen.queryByRole("button", { name: "商务蓝" })).toBeNull();
  expect(screen.getByRole("button", { name: "设置文字颜色" }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("textbox", { name: "项目描述" }).textContent).toBe("新确认的草稿");
  expect(onChange).not.toHaveBeenCalled();
});
