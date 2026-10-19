// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadingOverlay } from "../loading-overlay";
import { Modal } from "../modal";

afterEach(() => {
  cleanup();
});

describe("LoadingOverlay 通用加载遮罩组件", () => {
  it("show 为 false 时不渲染任何内容", () => {
    const { container } = render(<LoadingOverlay show={false} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("show 为 true 时正确渲染默认文案与无障碍属性", () => {
    render(<LoadingOverlay show={true} />);
    const overlay = screen.getByRole("status");
    expect(overlay).toBeTruthy();
    expect(overlay.getAttribute("aria-busy")).toBe("true");
    expect(overlay.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("正在处理中，请稍候…")).toBeTruthy();
  });

  it("支持自定义 message 与 description", () => {
    render(
      <LoadingOverlay
        show={true}
        message="正在恢复全量数据…"
        description="正在执行数据库大事务，请勿关闭页面"
      />
    );
    expect(screen.getByText("正在恢复全量数据…")).toBeTruthy();
    expect(screen.getByText("正在执行数据库大事务，请勿关闭页面")).toBeTruthy();
  });

  it("支持全屏 fixed 模式与容器内 absolute 模式切换", () => {
    const { rerender } = render(<LoadingOverlay show={true} fullScreen={false} />);
    let overlay = screen.getByRole("status");
    expect(overlay.className).toContain("absolute inset-0");

    rerender(<LoadingOverlay show={true} fullScreen={true} />);
    overlay = screen.getByRole("status");
    expect(overlay.className).toContain("fixed inset-0");
  });

  it("拦截遮罩点击事件冒泡，防止误触底层按钮", () => {
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <button type="button">底座按钮</button>
        <LoadingOverlay show={true} />
      </div>
    );
    const overlay = screen.getByRole("status");
    fireEvent.click(overlay);
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it("当提供 onCancel 时渲染取消按钮并能正常触发", () => {
    const onCancel = vi.fn();
    render(<LoadingOverlay show={true} onCancel={onCancel} cancelText="中止操作" />);
    const cancelBtn = screen.getByRole("button", { name: "中止操作" });
    expect(cancelBtn).toBeTruthy();
    fireEvent.click(cancelBtn);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("Modal 加载遮罩与防误触拦截", () => {
  it("loading 为 true 时在弹窗内展示遮罩，并禁止 ESC 和背景点击关闭", () => {
    const onClose = vi.fn();
    render(
      <Modal
        open={true}
        title="测试弹窗"
        onClose={onClose}
        loading={true}
        loadingText="正在打包作品集…"
        loadingDescription="正在压缩资源"
      >
        <div>弹窗内容</div>
      </Modal>
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("正在打包作品集…")).toBeTruthy();
    expect(screen.getByText("正在压缩资源")).toBeTruthy();

    // 点击背景遮罩不应触发 onClose
    const overlay = dialog.parentElement;
    expect(overlay).toBeTruthy();
    if (overlay) {
      fireEvent.click(overlay);
      expect(onClose).not.toHaveBeenCalled();
    }

    // 按 ESC 键不应触发 onClose
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("loading 为 false 时正常支持 ESC 与背景点击关闭", () => {
    const onClose = vi.fn();
    render(
      <Modal
        open={true}
        title="测试弹窗"
        onClose={onClose}
        loading={false}
      >
        <div>弹窗内容</div>
      </Modal>
    );

    expect(screen.queryByRole("status")).toBeNull();

    // 点击背景遮罩应触发 onClose
    const dialog = screen.getByRole("dialog");
    const overlay = dialog.parentElement;
    expect(overlay).toBeTruthy();
    if (overlay) {
      fireEvent.click(overlay);
      expect(onClose).toHaveBeenCalledTimes(1);
    }

    // 按 ESC 键应触发 onClose
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
