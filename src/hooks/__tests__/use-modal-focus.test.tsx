// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useModalFocus } from "../use-modal-focus";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    return (this.hidden ? [] : [new DOMRect(0, 0, 100, 20)]) as unknown as DOMRectList;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Dialog({ hidden = false, tabIndex }: { hidden?: boolean; tabIndex?: number }) {
  const ref = useModalFocus(true, () => {}, "[contenteditable]");
  return <div ref={ref} tabIndex={-1}>
    <button>关闭</button>
    <div role="textbox" contentEditable suppressContentEditableWarning hidden={hidden} tabIndex={tabIndex} />
  </div>;
}

it("原生 contenteditable 获得首焦点并参与 Tab/Shift+Tab 围栏", () => {
  render(<Dialog />);
  const editor = screen.getByRole("textbox");
  const close = screen.getByRole("button");
  expect(document.activeElement).toBe(editor);
  fireEvent.keyDown(editor, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(editor);
});

it.each([{ hidden: true }, { tabIndex: -1 }])("不把不可见或显式移出 Tab 顺序的编辑区当作首焦点：%j", (props) => {
  render(<Dialog {...props} />);
  expect(document.activeElement).toBe(screen.getByRole("button"));
});
