import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApplicationViewSwitcher } from "../application-view-switcher";

describe("ApplicationViewSwitcher", () => {
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
    expect(html).toContain("3场");
    expect(html).toContain("2 Offer");
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
