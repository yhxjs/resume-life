import { resolveStyle } from "@/lib/templates";
import { describe, expect, it } from "vitest";
import { invalidDomainColumn } from "../backup-domain";
import { normalizeContent } from "../modules";
import { DEFAULT_STYLE, normalizeStyle } from "../templates";

describe("基本信息持久化与备份契约", () => {
  const content = normalizeContent("basic", { name: "合成人物", gender: "女", age: "30", fieldOrder: ["phone", "age"] });
  it("接受应用生成的新字段，并在发布及投递快照中使用相同校验", () => {
    expect(invalidDomainColumn("resume_modules", { type: "basic", content: JSON.stringify(content) })).toBeUndefined();
    const snapshot = { title: "合成简历", template: "classic", style_overrides: {}, modules: [
      { key: "basic", type: "basic", label: "基本信息", sort: 0, content },
    ] };
    expect(invalidDomainColumn("resume_versions", { snapshot: JSON.stringify({ ...snapshot, resolved_style: resolveStyle("classic", []) }) })).toBeUndefined();
    expect(invalidDomainColumn("applications", { submitted_resume: JSON.stringify({ id: 1, ...snapshot }), submitted_at: "2026-10-14T00:00:00Z", submitted_jd: "" })).toBeUndefined();
  });
  it.each([{ gender: null }, { age: 30 }, { fieldOrder: [null] }, { fieldOrder: "phone" }, { fieldOrder: ["unknown"] }])("拒绝非法新字段 %j", (change) => {
    expect(invalidDomainColumn("resume_modules", { type: "basic", content: JSON.stringify({ ...content, ...change }) })).toBe("content");
  });
  it("接受完整的新样式，并拒绝非法联系方式间距", () => {
    const style = normalizeStyle({ ...DEFAULT_STYLE, contactSeparator: " / ", contactGap: 16 })!;
    expect(invalidDomainColumn("resume_templates", { style: JSON.stringify(style) })).toBeUndefined();
    for (const change of [{ contactSeparator: null }, { contactGap: "16" }, { contactGap: 33 }]) {
      expect(invalidDomainColumn("resume_templates", { style: JSON.stringify({ ...style, ...change }) })).toBe("style");
    }
  });
});
