// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React, { useRef } from "react";
import { BackToTop } from "../back-to-top";

describe("BackToTop 组件", () => {
  beforeEach(() => {
    window.scrollY = 0;
    window.scrollTo = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("初始未滚动时处于隐藏状态且不可聚焦", () => {
    render(<BackToTop />);
    const button = screen.getByRole("button", { hidden: true });
    expect(button).toBeDefined();
    expect(button.getAttribute("aria-label")).toBe("返回顶部");
    expect(button.getAttribute("aria-hidden")).toBe("true");
    expect(button.tabIndex).toBe(-1);
    expect(button.className).toContain("opacity-0");
    expect(button.className).toContain("pointer-events-none");
  });

  it("当页面向下滚动超过默认阈值(300px)时按钮淡入显示", () => {
    render(<BackToTop />);
    const button = screen.getByRole("button", { hidden: true });

    act(() => {
      window.scrollY = 350;
      window.dispatchEvent(new Event("scroll"));
    });

    expect(button.getAttribute("aria-hidden")).toBe("false");
    expect(button.tabIndex).toBe(0);
    expect(button.className).toContain("opacity-100");
    expect(button.className).toContain("pointer-events-auto");

    // 滚动回到 300px 以下时再次隐藏
    act(() => {
      window.scrollY = 200;
      window.dispatchEvent(new Event("scroll"));
    });

    expect(button.getAttribute("aria-hidden")).toBe("true");
    expect(button.tabIndex).toBe(-1);
    expect(button.className).toContain("opacity-0");
  });

  it("支持自定义 threshold 阈值", () => {
    render(<BackToTop threshold={500} />);
    const button = screen.getByRole("button", { hidden: true });

    act(() => {
      window.scrollY = 400;
      window.dispatchEvent(new Event("scroll"));
    });
    expect(button.className).toContain("opacity-0");

    act(() => {
      window.scrollY = 550;
      window.dispatchEvent(new Event("scroll"));
    });
    expect(button.className).toContain("opacity-100");
  });

  it("点击按钮调用 window.scrollTo 滚回顶部并触发 onScrollTop 回调", () => {
    const handleScrollTop = vi.fn();
    render(<BackToTop onScrollTop={handleScrollTop} />);

    act(() => {
      window.scrollY = 400;
      window.dispatchEvent(new Event("scroll"));
    });

    const button = screen.getByRole("button");
    fireEvent.click(button);

    expect(window.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: "smooth",
    });
    expect(handleScrollTop).toHaveBeenCalledTimes(1);
  });

  it("支持传入自定义滚动容器 target (Ref/DOM元素/选择器)", () => {
    function ContainerTest() {
      const containerRef = useRef<HTMLDivElement>(null);
      return (
        <div>
          <div ref={containerRef} id="test-scroll-container" style={{ overflowY: "auto", height: 200 }}>
            <div style={{ height: 1000 }}>长内容</div>
          </div>
          <BackToTop target={containerRef} threshold={200} />
        </div>
      );
    }

    render(<ContainerTest />);
    const container = document.getElementById("test-scroll-container")!;
    container.scrollTo = vi.fn();
    const button = screen.getByRole("button", { hidden: true });

    act(() => {
      Object.defineProperty(container, "scrollTop", { value: 250, configurable: true });
      container.dispatchEvent(new Event("scroll"));
    });

    expect(button.className).toContain("opacity-100");

    fireEvent.click(button);
    expect(container.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: "smooth",
    });
  });

  it("支持自定义 className、ariaLabel 以及自定义子元素", () => {
    render(
      <BackToTop className="custom-test-btn" ariaLabel="回顶">
        <span>TOP</span>
      </BackToTop>
    );

    const button = screen.getByRole("button", { hidden: true });
    expect(button.getAttribute("aria-label")).toBe("回顶");
    expect(button.className).toContain("custom-test-btn");
    expect(button.textContent).toContain("TOP");
  });

  it("组件卸载时正确注销 scroll 监听器", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<BackToTop />);

    unmount();
    expect(removeSpy).toHaveBeenCalledWith("scroll", expect.any(Function));
  });
});
