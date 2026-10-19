import { describe, expect, it } from "vitest";
import {
  RESUME_TEMPLATES,
  TEMPLATE_KEYS,
  BUILTIN_STYLES,
  normalizeStyle,
  isTemplateKey,
  isTemplateRef,
  resolveStyle,
  customRef,
  type TemplateKey,
  type CustomTemplate,
} from "../templates";

describe("templates library", () => {
  it("defines 16 builtin templates with labels and categories", () => {
    expect(RESUME_TEMPLATES.length).toBe(16);
    expect(TEMPLATE_KEYS.length).toBe(16);

    const expectedKeys: TemplateKey[] = [
      "classic",
      "banner_navy",
      "banner_dark",
      "banner_teal",
      "card_purple",
      "banner_twocol",
      "modern",
      "twocol",
      "tech",
      "minimal",
      "academic",
      "compact",
      "executive",
      "ats",
      "creative",
      "twocol_card",
    ];

    expect(TEMPLATE_KEYS).toEqual(expectedKeys);

    for (const item of RESUME_TEMPLATES) {
      expect(item.key).toBeDefined();
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.desc.length).toBeGreaterThan(0);
      expect(item.tags.length).toBeGreaterThan(0);
      expect(item.previewColor).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("every builtin template has a valid corresponding ResumeStyle", () => {
    for (const key of TEMPLATE_KEYS) {
      const style = BUILTIN_STYLES[key];
      expect(style, `Style for ${key} should exist`).toBeDefined();
      expect(["single", "twocol"]).toContain(style.layout);
      expect(["serif", "sans"]).toContain(style.font);
      expect(["left", "center"]).toContain(style.titleAlign);
      expect(["none", "underline", "leftbar", "band"]).toContain(style.sectionDeco);
      expect(["pill", "line", "list"]).toContain(style.skillStyle);
      if (style.headerStyle) {
        expect(["default", "banner", "card"]).toContain(style.headerStyle);
      }

      expect(style.pageMargin).toBeGreaterThanOrEqual(8);
      expect(style.baseSize).toBeGreaterThanOrEqual(10);
      expect(style.lineHeight).toBeGreaterThanOrEqual(1.3);

      expect(style.accent).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(style.ink).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(style.text).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(style.muted).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(typeof style.contactSeparator === "string" || style.contactSeparator === undefined).toBe(true);
      expect(typeof style.contactGap === "number" || style.contactGap === undefined).toBe(true);
    }
  });

  it("normalizes contactSeparator and contactGap properly", () => {
    const customized = normalizeStyle({
      contactSeparator: "|",
      contactGap: 16,
    });
    expect(customized?.contactSeparator).toBe("|");
    expect(customized?.contactGap).toBe(16);

    const emptySep = normalizeStyle({
      contactSeparator: "",
      contactGap: 0,
    });
    expect(emptySep?.contactSeparator).toBe("");
    expect(emptySep?.contactGap).toBe(0);

    const clamped = normalizeStyle({
      contactGap: 999,
    });
    expect(clamped?.contactGap).toBe(32);
  });

  it("validates template keys accurately", () => {
    expect(isTemplateKey("classic")).toBe(true);
    expect(isTemplateKey("tech")).toBe(true);
    expect(isTemplateKey("twocol_card")).toBe(true);
    expect(isTemplateKey("nonexistent")).toBe(false);
    expect(isTemplateKey(null)).toBe(false);
    expect(isTemplateKey(123)).toBe(false);
  });

  it("validates template references including custom templates", () => {
    expect(isTemplateRef("classic")).toBe(true);
    expect(isTemplateRef("tech")).toBe(true);
    expect(isTemplateRef("custom:12")).toBe(true);
    expect(isTemplateRef(customRef(99))).toBe(true);
    expect(isTemplateRef("custom:invalid")).toBe(false);
    expect(isTemplateRef("unknown")).toBe(false);
  });

  it("resolves styles correctly for builtin and custom templates", () => {
    expect(resolveStyle("tech", [])).toEqual(BUILTIN_STYLES.tech);
    expect(resolveStyle("academic", [])).toEqual(BUILTIN_STYLES.academic);

    const dummyCustom: CustomTemplate = {
      id: 42,
      name: "个性配置",
      style: { ...BUILTIN_STYLES.classic, accent: "#ff0088" },
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    };

    expect(resolveStyle("custom:42", [dummyCustom])).toEqual(dummyCustom.style);
    // 失效回退 classic
    expect(resolveStyle("custom:999", [dummyCustom])).toEqual(BUILTIN_STYLES.classic);
  });

  it("normalizeStyle correctly handles descItemGap", async () => {
    const { normalizeStyle } = await import("../templates");
    const res = normalizeStyle({
      ...BUILTIN_STYLES.classic,
      descItemGap: 6,
    });
    expect(res).not.toBeNull();
    expect(res?.descItemGap).toBe(6);

    // 默认兜底
    const resDefault = normalizeStyle({
      ...BUILTIN_STYLES.classic,
      descItemGap: undefined,
    });
    expect(resDefault?.descItemGap).toBe(2);

    // 钳位范围 [0, 16]
    const resClampedMax = normalizeStyle({
      ...BUILTIN_STYLES.classic,
      descItemGap: 25,
    });
    expect(resClampedMax?.descItemGap).toBe(16);

    const resClampedMin = normalizeStyle({
      ...BUILTIN_STYLES.classic,
      descItemGap: -5,
    });
    expect(resClampedMin?.descItemGap).toBe(0);
  });

  it("normalizes new layout and grid properties correctly", () => {
    const res = normalizeStyle({
      asidePosition: "left",
      asideModules: ["skills", "custom"],
      asideBg: "#f8fafc",
      asideBorder: "none",
      asideBorderColor: "#cccccc",
      asidePadding: 24,
      asideGap: 30,
      headerLayout: "center-avatar",
      contactLayout: "grid2",
      skillCols: 3,
      entryCols: 2,
    });

    expect(res?.asidePosition).toBe("left");
    expect(res?.asideModules).toEqual(["skills", "custom"]);
    expect(res?.asideBg).toBe("#f8fafc");
    expect(res?.asideBorder).toBe("none");
    expect(res?.asideBorderColor).toBe("#cccccc");
    expect(res?.asidePadding).toBe(24);
    expect(res?.asideGap).toBe(30);
    expect(res?.headerLayout).toBe("center-avatar");
    expect(res?.contactLayout).toBe("grid2");
    expect(res?.skillCols).toBe(3);
    expect(res?.entryCols).toBe(2);

    // Fallbacks and clamping
    const fallbackRes = normalizeStyle({
      asidePosition: "invalid",
      asideBorder: "invalid",
      asidePadding: 999,
      asideGap: -50,
      headerLayout: "invalid",
      contactLayout: "invalid",
      skillCols: 10,
      entryCols: 5,
    });

    expect(fallbackRes?.asidePosition).toBe("right");
    expect(fallbackRes?.asideBorder).toBe("auto");
    expect(fallbackRes?.asidePadding).toBe(40);
    expect(fallbackRes?.asideGap).toBe(0);
    expect(fallbackRes?.headerLayout).toBe("right-avatar");
    expect(fallbackRes?.contactLayout).toBe("inline");
    expect(fallbackRes?.skillCols).toBe(1);
    expect(fallbackRes?.entryCols).toBe(1);
  });
});
