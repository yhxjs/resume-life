// @vitest-environment jsdom
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePortfolioJs } from "../portfolio-generator";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

function runScript(reducedMotion = false) {
  const page = document.implementation.createHTMLDocument("resume");
  page.body.innerHTML = '<button id="theme-toggle"></button><a data-mag>查看简历</a><div class="scroll-progress"></div><section id="top"></section><nav><a href="#resume-0">工作经历</a></nav><a href="#resume-0">了解我的经历 <span>↓</span></a><a href="#resume-0">继续了解</a><section id="resume-0"></section><a href="#top">回到顶部</a><a href="resume.html" target="_blank">完整简历</a><a href="https://example.com">在线作品</a>';
  const addEventListener = vi.fn();
  const observe = vi.fn();
  runInNewContext(generatePortfolioJs(), {
    document: page, localStorage,
    window: { matchMedia: (query: string) => ({ matches: query.includes("reduced-motion") ? reducedMotion : true }), addEventListener, innerHeight: 800, scrollY: 0 },
    IntersectionObserver: class { observe = observe; unobserve = vi.fn(); },
  });
  page.dispatchEvent(new Event("DOMContentLoaded"));
  return { page, addEventListener };
}

describe("动态简历脚本", () => {
  it.each([false, true])("页内导航只滚动当前文档，不触发 srcdoc 的工作台地址跳转（减少动效：%s）", (reducedMotion) => {
    const { page } = runScript(reducedMotion);
    const scroll = vi.fn();
    const topScroll = vi.fn();
    page.getElementById("resume-0")!.scrollIntoView = scroll;
    page.getElementById("top")!.scrollIntoView = topScroll;
    const links = page.querySelectorAll('a[href="#resume-0"]');
    links.forEach((link) => {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      (link.querySelector("span") ?? link).dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
    expect(scroll).toHaveBeenCalledTimes(3);
    expect(scroll).toHaveBeenCalledWith({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    page.querySelector('a[href="#top"]')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(topScroll).toHaveBeenCalledOnce();
  });

  it("完整简历和外部作品链接保留原有跳转", () => {
    const { page } = runScript();
    for (const selector of ['a[href="resume.html"]', 'a[href="https://example.com"]']) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      page.querySelector(selector)!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it("降低动效偏好关闭磁性位移，主题切换仍可用", () => {
    const { page } = runScript(true);
    const button = page.querySelector<HTMLAnchorElement>("[data-mag]")!;
    button.dispatchEvent(new MouseEvent("mousemove", { clientX: 80, clientY: 40 }));
    expect(button.style.transform).toBe("");
    page.getElementById("theme-toggle")!.click();
    expect(page.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("正常偏好启用磁性按钮并在鼠标离开时复原", () => {
    const { page, addEventListener } = runScript();
    const button = page.querySelector<HTMLAnchorElement>("[data-mag]")!;
    button.dispatchEvent(new MouseEvent("mousemove", { clientX: 80, clientY: 40 }));
    expect(button.style.transform).toContain("translate(");
    button.dispatchEvent(new MouseEvent("mouseleave"));
    expect(button.style.transform).toBe("");
    expect(addEventListener).toHaveBeenCalledWith("scroll", expect.any(Function), { passive: true });
  });

  it.each(["getItem", "setItem"] as const)("存储 %s 不可用时主题仍可切换", (method) => {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new DOMException("unavailable", "SecurityError"); });
    const { page } = runScript();
    expect(page.documentElement.getAttribute("data-theme")).toBe("dark");
    page.getElementById("theme-toggle")!.click();
    expect(page.documentElement.getAttribute("data-theme")).toBe("light");
    expect(page.getElementById("theme-toggle")!.getAttribute("aria-label")).toBe("切换为深色");
  });

  it("保存主题并在重新打开时恢复", () => {
    const { page } = runScript();
    page.getElementById("theme-toggle")!.click();
    expect(localStorage.getItem("portfolio-theme")).toBe("light");
    expect(runScript().page.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
