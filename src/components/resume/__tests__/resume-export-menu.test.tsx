// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ResumeExportMenu } from "../resume-export-menu";

describe("ResumeExportMenu", () => {
  afterEach(() => {
    cleanup();
  });

  it("默认渲染导出/打印主触发按钮", () => {
    render(<ResumeExportMenu onRequestExport={vi.fn()} />);
    const button = screen.getByRole("button", { name: /导出 \/ 打印/ });
    expect(button).toBeDefined();
    expect(button.getAttribute("aria-haspopup")).toBe("true");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("点击触发按钮展开菜单，按 Escape 键关闭并归还焦点", () => {
    render(<ResumeExportMenu onRequestExport={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /导出 \/ 打印/ });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("A4 打印 / 导出 PDF")).toBeDefined();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("A4 打印 / 导出 PDF")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
