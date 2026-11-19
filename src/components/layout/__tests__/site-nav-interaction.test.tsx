// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SiteNav } from "../site-nav";

const controls = vi.hoisted(() => ({ pathname: "/tools" }));
vi.mock("next/navigation", () => ({ usePathname: () => controls.pathname }));
vi.mock("@/components/layout/command-palette", () => ({ CommandPalette: () => null }));
const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
let desktop = true;
function resize(matches: boolean) {
  desktop = matches;
  act(() => { for (const listener of mediaListeners) listener({ matches } as MediaQueryListEvent); });
}
beforeEach(() => {
  vi.useFakeTimers(); controls.pathname = "/tools"; desktop = true; mediaListeners.clear();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ get matches() { return desktop; }, media: "(min-width: 1024px)",
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.delete(listener),
  })));
});
afterEach(() => { cleanup(); document.body.style.overflow = ""; vi.useRealTimers(); vi.unstubAllGlobals(); });
const menu = (name = "面试演练") => {
  const trigger = screen.getByRole("button", { name });
  return { trigger, group: trigger.closest<HTMLElement>("[data-nav-dropdown]")! };
};
const advance = () => act(() => vi.advanceTimersByTime(200));

describe("站点导航输入方式与生命周期", () => {
  it.each(["简历中心", "面试演练", "题库复盘"])("%s 悬停后首次点击保持展开，再次点击才关闭", name => {
    render(<SiteNav />); const { trigger, group } = menu(name);
    fireEvent.mouseEnter(group); expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(trigger); expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.mouseLeave(group); advance(); expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(trigger); expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("仅悬停的菜单离开后关闭，重新进入清除旧计时", () => {
    render(<SiteNav />); const { trigger, group } = menu();
    fireEvent.mouseEnter(group); fireEvent.mouseLeave(group); advance(); expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.mouseEnter(group); fireEvent.mouseLeave(group); fireEvent.mouseEnter(group); advance();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("鼠标移出不隐藏已获得键盘焦点的链接，Tab 离开菜单才关闭", () => {
    render(<SiteNav />); const { trigger, group } = menu(); fireEvent.mouseEnter(group);
    const link = within(group).getByRole("link", { name: /^自我介绍/ }); act(() => link.focus());
    fireEvent.mouseLeave(group); advance(); expect(trigger.getAttribute("aria-expanded")).toBe("true"); expect(document.activeElement).toBe(link);
    act(() => screen.getByRole("link", { name: "工具箱" }).focus());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("离开旧菜单后键盘打开另一菜单，旧延时不能关闭新菜单", () => {
    render(<SiteNav />); const first = menu("简历中心"); const next = menu();
    fireEvent.mouseEnter(first.group); fireEvent.mouseLeave(first.group); fireEvent.click(next.trigger); advance();
    expect(first.trigger.getAttribute("aria-expanded")).toBe("false"); expect(next.trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.mouseDown(document.body); expect(next.trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("焦点在链接时鼠标划过其他组不隐藏焦点，主动切换仍可打开新组", () => {
    render(<SiteNav />); const first = menu("简历中心"); const next = menu(); fireEvent.click(first.trigger);
    const link = within(first.group).getByRole("link", { name: /^简历管理/ }); act(() => link.focus());
    fireEvent.mouseEnter(next.group); expect(first.trigger.getAttribute("aria-expanded")).toBe("true"); expect(document.activeElement).toBe(link);
    act(() => next.trigger.focus()); fireEvent.click(next.trigger);
    expect(first.trigger.getAttribute("aria-expanded")).toBe("false"); expect(next.trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("旧触发按钮失焦不能关闭刚悬停打开的另一组", () => {
    render(<SiteNav />); const first = menu("简历中心"); const next = menu();
    act(() => first.trigger.focus()); fireEvent.click(first.trigger); fireEvent.mouseEnter(next.group);
    const link = within(next.group).getByRole("link", { name: /^自我介绍/ }); act(() => link.focus());
    expect(next.trigger.getAttribute("aria-expanded")).toBe("true"); expect(document.activeElement).toBe(link);
  });

  it("离开后进入链接焦点取消悬停关闭计时，Escape 收起并归还焦点", () => {
    render(<SiteNav />); const { trigger, group } = menu(); fireEvent.mouseEnter(group); fireEvent.mouseLeave(group);
    const link = within(group).getByRole("link", { name: /^自我介绍/ }); act(() => link.focus()); advance();
    expect(trigger.getAttribute("aria-expanded")).toBe("true"); fireEvent.keyDown(link, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false"); expect(document.activeElement).toBe(trigger);
  });

  it("抽屉打开时切到桌面会释放滚动锁，返回窄屏不复活隐藏抽屉", () => {
    desktop = false; document.body.style.overflow = "auto";
    render(<SiteNav />); fireEvent.click(screen.getByRole("button", { name: "打开导航菜单" }));
    expect(screen.getByRole("dialog", { name: "导航菜单" })).toBeTruthy(); expect(document.body.style.overflow).toBe("hidden");
    resize(true); expect(screen.queryByRole("dialog", { name: "导航菜单" })).toBeNull(); expect(document.body.style.overflow).toBe("auto");
    resize(false); expect(screen.queryByRole("dialog", { name: "导航菜单" })).toBeNull();
  });

  it("桌面展开后切窄屏不留下菜单，路由变化与卸载清理旧计时及监听", () => {
    const view = render(<SiteNav />); const { trigger, group } = menu(); fireEvent.click(trigger);
    resize(false); expect(trigger.getAttribute("aria-expanded")).toBe("false");
    resize(true); fireEvent.mouseEnter(group); fireEvent.mouseLeave(group);
    controls.pathname = "/intros"; view.rerender(<SiteNav />); expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger); advance(); expect(trigger.getAttribute("aria-expanded")).toBe("true");
    view.unmount(); expect(mediaListeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
});
