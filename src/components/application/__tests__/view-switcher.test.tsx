// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ApplicationViewMode } from "@/lib/applications-types";
import { renderToStaticMarkup } from "react-dom/server";
import { ApplicationViewSwitcher } from "../application-view-switcher";

afterEach(cleanup);

function InteractiveSwitcher() {
  const [view, setView] = useState<ApplicationViewMode>("kanban");
  return <ApplicationViewSwitcher id="view-test" currentView={view} onViewChange={setView} activeCount={3} upcomingInterviewCount={1} hasUrgentInterview={false} offerCount={1} />;
}

describe("ApplicationViewSwitcher", () => {
  it("方向键循环、Home/End 首尾定位，只有当前项进入 Tab 顺序", () => {
    render(<InteractiveSwitcher />);
    const tabs = screen.getAllByRole("tab");
    tabs[0]!.focus();
    for (const [key, from, to] of [["ArrowRight", 0, 1], ["End", 1, 2], ["ArrowRight", 2, 0], ["ArrowLeft", 0, 2], ["Home", 2, 0]] as const) {
      fireEvent.keyDown(tabs[from]!, { key });
      expect(document.activeElement).toBe(tabs[to]);
      expect(tabs.map(tab => tab.getAttribute("aria-selected"))).toEqual(tabs.map((_, i) => String(i === to)));
      expect(tabs.map(tab => tab.tabIndex)).toEqual(tabs.map((_, i) => i === to ? 0 : -1));
    }
    expect(tabs.map(tab => tab.id)).toEqual(["view-test-kanban", "view-test-calendar", "view-test-funnel"]);
    expect(tabs.every(tab => tab.getAttribute("aria-controls") === "view-test-panel")).toBe(true);
  });
  it("不接管带修饰键的浏览器快捷键或竖向滚动键", () => {
    const onViewChange = vi.fn();
    render(<ApplicationViewSwitcher currentView="kanban" onViewChange={onViewChange} activeCount={0} upcomingInterviewCount={0} hasUrgentInterview={false} offerCount={0} />);
    const tab = screen.getAllByRole("tab")[0]!;
    for (const options of [{ key: "ArrowLeft", altKey: true }, { key: "ArrowRight", ctrlKey: true }, { key: "Home", metaKey: true }, { key: "ArrowDown" }]) {
      expect(fireEvent.keyDown(tab, options)).toBe(true);
    }
    expect(onViewChange).not.toHaveBeenCalled();
  });
  it("renders 3 view tabs with badges and icons", () => {
    const fn = vi.fn();
    const html = renderToStaticMarkup(
      <ApplicationViewSwitcher
        currentView="kanban"
        onViewChange={fn}
        activeCount={8}
        upcomingInterviewCount={3}
        hasUrgentInterview={true}
        offerCount={2}
      />
    );

    expect(html).toContain("看板模式");
    expect(html).toContain("日程日历");
    expect(html).toContain("全周期漏斗");
    expect(html).toContain("8");
    expect(html).toContain(">3</span>");
    expect(html).toContain(">2</span>");
    // 紧急红标
    expect(html).toContain("animate-pulse");
  });

  it("highlights selected calendar tab correctly", () => {
    const fn = vi.fn();
    const html = renderToStaticMarkup(
      <ApplicationViewSwitcher
        currentView="calendar"
        onViewChange={fn}
        activeCount={5}
        upcomingInterviewCount={0}
        hasUrgentInterview={false}
        offerCount={0}
      />
    );

    expect(html).toContain('aria-selected="true"');
  });
});
