import { resolveStyle } from "@/lib/templates";
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import JSZip from "jszip";
import { createPortfolioZip, generatePortfolioJs } from "../portfolio-generator";
import type { SafePortfolioData } from "../portfolio-anonymize";
import { DEFAULT_ANONYMIZE_CONFIG } from "../resume-anonymize";

const data: SafePortfolioData = {
  siteTitle: "主题测试", siteSubtitle: "", accentColor: "#2563eb", themeMode: "auto",
  candidateName: "候选人", candidateTitle: "", anonymizeConfig: DEFAULT_ANONYMIZE_CONFIG,
  resumeSnapshot: { resolved_style: resolveStyle("classic", []), title: "简历", template: "classic", style_overrides: {}, modules: [] }, projects: [],
};

beforeEach(() => localStorage.clear());

describe("作品集初始主题与持久化", () => {
  it.each([
    ["light", true, undefined, "light"],
    ["dark", false, undefined, "dark"],
    ["auto", true, undefined, "dark"],
    ["auto", false, undefined, "light"],
    ["light", false, "dark", "dark"],
    ["dark", true, "invalid", "dark"],
  ] as const)("配置 %s、系统深色 %s、保存值 %s 应显示 %s", async (themeMode, systemDark, saved, expected) => {
    const zip = await JSZip.loadAsync(await createPortfolioZip({ ...data, themeMode }));
    const document = new DOMParser().parseFromString(await zip.file("index.html")!.async("string"), "text/html");
    if (saved) localStorage.setItem("portfolio-theme", saved);
    runInNewContext(await zip.file("assets/app.js")!.async("string"), {
      document, localStorage, window: { matchMedia: (query: string) => ({ matches: query.includes("reduced-motion") || systemDark }), addEventListener() {}, innerHeight: 800, scrollY: 0 },
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe(expected);
    document.dispatchEvent(new Event("DOMContentLoaded"));
    document.getElementById("theme-toggle")!.click();
    const toggled = expected === "dark" ? "light" : "dark";
    expect(document.documentElement.getAttribute("data-theme")).toBe(toggled);
    expect(localStorage.getItem("portfolio-theme")).toBe(toggled);
  });

  it("存储不可用时仍使用指定主题", () => {
    const document = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
    runInNewContext(generatePortfolioJs("light"), { document, window: { matchMedia: () => ({ matches: true }), addEventListener() {}, innerHeight: 800, scrollY: 0 } });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
