import { describe, expect, it } from "vitest";
import {
  resolveStyle,
  sanitizeStyleOverrides,
  type ResumeStyleOverrides,
} from "../templates";

describe("templates overrides", () => {
  it("sanitizes invalid or out-of-bound style overrides safely", () => {
    expect(sanitizeStyleOverrides(null)).toEqual({});
    expect(sanitizeStyleOverrides(undefined)).toEqual({});
    expect(sanitizeStyleOverrides([])).toEqual({});
    expect(sanitizeStyleOverrides("string")).toEqual({});

    const outOfBounds = {
      pageMargin: 100, // max is 25
      sectionGapBefore: 1, // min is 4
      sectionGapAfter: 50, // max is 16
      entryGap: 2, // min is 4
      descItemGap: -5, // min is 0
      lineHeight: 3.5, // max is 2.0
      baseSize: 20, // max is 14
      unknownProp: "test",
    };

    const sanitized = sanitizeStyleOverrides(outOfBounds);
    expect(sanitized.pageMargin).toBe(25);
    expect(sanitized.sectionGapBefore).toBe(4);
    expect(sanitized.sectionGapAfter).toBe(16);
    expect(sanitized.entryGap).toBe(4);
    expect(sanitized.descItemGap).toBe(0);
    expect(sanitized.lineHeight).toBe(2.0);
    expect(sanitized.baseSize).toBe(14);
    expect((sanitized as Record<string, unknown>).unknownProp).toBeUndefined();
  });

  it("merges valid overrides onto the resolved base style", () => {
    const baseClassic = resolveStyle("classic", []);
    const overrides: ResumeStyleOverrides = {
      sectionGapBefore: 8,
      entryGap: 6,
      lineHeight: 1.35,
      pageMargin: 10,
    };

    const customized = resolveStyle("classic", [], overrides);
    expect(customized.sectionGapBefore).toBe(8);
    expect(customized.entryGap).toBe(6);
    expect(customized.lineHeight).toBe(1.35);
    expect(customized.pageMargin).toBe(10);
    // 未覆盖的属性保持 base 原样
    expect(customized.accent).toBe(baseClassic.accent);
    expect(customized.nameSize).toBe(baseClassic.nameSize);
  });

  it("ignores empty or null overrides cleanly", () => {
    const baseClassic = resolveStyle("classic", []);
    expect(resolveStyle("classic", [], null)).toEqual(baseClassic);
    expect(resolveStyle("classic", [], {})).toEqual(baseClassic);
  });

  it("sanitizes non-spacing style fields (colors, enums) as overrides", () => {
    const sanitized = sanitizeStyleOverrides({
      accent: "#FF0000",
      layout: "twocol",
      headerStyle: "banner",
      font: "sans-serif", // 非法枚举 → 回退默认
      entrySubAccent: false,
    });
    expect(sanitized.accent).toBe("#ff0000");
    expect(sanitized.layout).toBe("twocol");
    expect(sanitized.headerStyle).toBe("banner");
    expect(sanitized.font).toBe("sans");
    expect(sanitized.entrySubAccent).toBe(false);
    // 未给出的字段不进入 overrides
    expect((sanitized as Record<string, unknown>).pageMargin).toBeUndefined();
    expect((sanitized as Record<string, unknown>).nameSize).toBeUndefined();
  });

  it("falls back invalid values to the given base instead of the global default", () => {
    const base = resolveStyle("classic", []);
    const sanitized = sanitizeStyleOverrides({ accent: "not-a-color", baseSize: 99 }, base);
    expect(sanitized.accent).toBe(base.accent);
    expect(sanitized.baseSize).toBe(14);
  });

  it("stacks full style overrides (colors/fonts) onto custom templates", () => {
    const baseClassic = resolveStyle("classic", []);
    const customized = resolveStyle("classic", [], {
      accent: "#123456",
      font: "sans",
      sectionDeco: "band",
    });
    expect(customized.accent).toBe("#123456");
    expect(customized.font).toBe("sans");
    expect(customized.sectionDeco).toBe("band");
    // 未覆盖的属性保持 base 原样
    expect(customized.text).toBe(baseClassic.text);
    expect(customized.skillStyle).toBe(baseClassic.skillStyle);
  });

  it("handles contactSeparator and contactGap overrides correctly", () => {
    const sanitized = sanitizeStyleOverrides({
      contactSeparator: "|",
      contactGap: 14,
    });
    expect(sanitized.contactSeparator).toBe("|");
    expect(sanitized.contactGap).toBe(14);

    const emptySanitized = sanitizeStyleOverrides({
      contactSeparator: "",
      contactGap: 0,
    });
    expect(emptySanitized.contactSeparator).toBe("");
    expect(emptySanitized.contactGap).toBe(0);

    const merged = resolveStyle("classic", [], {
      contactSeparator: "",
      contactGap: 12,
    });
    expect(merged.contactSeparator).toBe("");
    expect(merged.contactGap).toBe(12);
  });
});
