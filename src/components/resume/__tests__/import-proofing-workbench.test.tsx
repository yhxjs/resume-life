// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { ImportProofingWorkbench } from "../import-proofing-workbench";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

function Fixture({ original = "示例科技与示例科技合作" }: { original?: string }) {
  const [company, setCompany] = useState("示例科技");
  return <ImportProofingWorkbench
    draft={{ title: "测试简历", modules: { work: [{ company }] } }}
    sourceText={original}
    ocrInfo={{ engine: "local", pageCount: 2, sourceType: "pdf" }}
    manualDraft={false}
    creating={false}
    error=""
    onTitleChange={vi.fn()}
    onConfirm={vi.fn()}
    onBack={vi.fn()}
    renderEditors={(onLocate) => <input aria-label="公司名称" value={company}
      onFocus={() => onLocate("work[0].company")}
      onChange={(event) => setCompany(event.target.value)} />}
  />;
}

describe("简历导入原文校对工作台", () => {
  it("字段定位默认首个匹配，并能在重复项之间切换", () => {
    const { container } = render(<Fixture />);
    fireEvent.click(screen.getByRole("button", { name: "定位原文：工作 1 · 公司" }));
    expect(screen.getByRole("status", { name: "原文定位状态" }).textContent).toContain("第 1 / 2 处");
    expect(container.querySelector('mark[aria-current="location"]')?.textContent).toBe("示例科技");
    expect(container.querySelector('mark[aria-current="location"]')?.getAttribute("data-match-index")).toBe("0");

    fireEvent.click(screen.getByRole("button", { name: "下一个匹配" }));
    expect(screen.getByRole("status", { name: "原文定位状态" }).textContent).toContain("第 2 / 2 处");
    expect(container.querySelector('mark[aria-current="location"]')?.getAttribute("data-match-index")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "上一个匹配" }));
    expect(container.querySelector('mark[aria-current="location"]')?.getAttribute("data-match-index")).toBe("0");
  });

  it("编辑字段后重算匹配，未找到时保留只读原文", () => {
    const { container } = render(<Fixture />);
    const fieldButton = screen.getByRole("button", { name: "定位原文：工作 1 · 公司" });
    expect(within(fieldButton).getByText("待核对")).toBeTruthy();
    fireEvent.focus(screen.getByRole("textbox", { name: "公司名称" }));
    expect(within(fieldButton).getByText("原文已定位")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "公司名称" }), { target: { value: "另一家公司" } });
    expect(screen.getByRole("status", { name: "原文定位状态" }).textContent).toContain("原文未找到");
    expect(within(fieldButton).getByText("原文未找到")).toBeTruthy();
    expect(container.querySelector("mark")).toBeNull();
    expect(screen.getByLabelText("导入原文").textContent).toContain("示例科技与示例科技合作");
  });

  it("显示 OCR 元信息并复制完整原文", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    render(<Fixture original={"第一页\n第二页"} />);
    expect(screen.getByText(/本地离线 OCR/)).toBeTruthy();
    expect(screen.getByText(/2 页/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "复制原文" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith("第一页\n第二页"));
  });

  it("重新复制时清除旧成功，等待时禁用按钮，失败重试不改变原文、定位或编辑草稿", async () => {
    const copy = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    const original = "示例科技 <T> &amp;\n只参与校验，尚未上线。";
    render(<Fixture original={original} />);
    fireEvent.change(screen.getByRole("textbox", { name: "公司名称" }), { target: { value: "编辑中的公司" } });
    fireEvent.click(screen.getByRole("button", { name: "定位原文：工作 1 · 公司" }));
    const button = screen.getByRole("button", { name: "复制原文" });
    fireEvent.click(button);
    await screen.findByRole("status", { name: "原文复制状态" });
    let reject!: (reason: Error) => void;
    copy.mockReturnValueOnce(new Promise<void>((_resolve, no) => { reject = no; }));
    fireEvent.click(button);
    expect(screen.queryByRole("status", { name: "原文复制状态" })).toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { reject(new Error("denied")); });
    expect((await screen.findByRole("alert")).textContent).toContain("手动复制");
    fireEvent.click(button);
    await screen.findByRole("status", { name: "原文复制状态" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(copy).toHaveBeenLastCalledWith(original);
    expect((screen.getByRole("textbox", { name: "公司名称" }) as HTMLInputElement).value).toBe("编辑中的公司");
    expect(screen.getByRole("status", { name: "原文定位状态" }).textContent).toContain("原文未找到");
    expect(screen.getByLabelText("导入原文").textContent).toBe(original);
  });

  it("原文更新后不沿用旧复制结果，空原文禁止复制", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    const { rerender } = render(<Fixture original="旧原文" />);
    fireEvent.click(screen.getByRole("button", { name: "复制原文" }));
    await screen.findByRole("status", { name: "原文复制状态" });
    rerender(<Fixture original="新原文" />);
    expect(screen.queryByRole("status", { name: "原文复制状态" })).toBeNull();
    rerender(<Fixture original="" />);
    expect((screen.getByRole("button", { name: "复制原文" }) as HTMLButtonElement).disabled).toBe(true);
    expect(copy).toHaveBeenCalledOnce();
  });

  it.each([false, true])("窄屏原文定位遵循减少动效偏好 %s，聚焦输入框不打断编辑", (reduce) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduce })));
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    render(<Fixture />);
    const paneScroll = vi.fn();
    screen.getByLabelText("导入原文").scrollTo = paneScroll;
    fireEvent.focus(screen.getByRole("textbox", { name: "公司名称" }));
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "定位原文：工作 1 · 公司" }));
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ behavior: reduce ? "auto" : "smooth" }));
    expect(paneScroll).toHaveBeenCalledWith(expect.objectContaining({ behavior: reduce ? "auto" : "smooth" }));
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  });
});
