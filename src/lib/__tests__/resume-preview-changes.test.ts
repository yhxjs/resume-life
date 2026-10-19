import { resolveStyle } from "@/lib/templates";
import { describe, expect, it } from "vitest";
import type { ResumeSnapshot } from "../resume-version-types";
import { previewChanges } from "../resume-preview-changes";

const work = (entries: { id: string; company: string; description?: string; descriptionItems?: string[] }[]) =>
  ({ key: "work", type: "work" as const, label: "工作经历", sort: 0, content: entries });
const summary = { key: "summary", type: "summary" as const, label: "自我评价", sort: 1, content: { text: "稳定内容" } };
const snapshot = (modules: ResumeSnapshot["modules"]): ResumeSnapshot =>
  ({ resolved_style: resolveStyle("classic", []), title: "简历", template: "classic", style_overrides: {}, modules });

describe("真实预览变化定位", () => {
  it("条目或模块重排时标记所在区域，插入新条目不误标未变条目", () => {
    const before = snapshot([work([{ id: "a", company: "甲" }, { id: "b", company: "乙" }]), summary]);
    const reordered = snapshot([summary, work([{ id: "b", company: "乙" }, { id: "a", company: "甲" }])]);
    const changes = previewChanges(before, reordered);
    expect(changes.before).toContainEqual({ moduleKey: "work", status: "changed" });
    expect(changes.after).toContainEqual({ moduleKey: "work", status: "changed" });
    expect(changes.before).toContainEqual({ moduleKey: "summary", status: "changed" });
    expect(changes.after).toContainEqual({ moduleKey: "summary", status: "changed" });

    const inserted = previewChanges(before, snapshot([work([{ id: "a", company: "甲" }, { id: "c", company: "丙" }, { id: "b", company: "乙" }]), summary]));
    expect(inserted.before).toEqual([]);
    expect(inserted.after).toEqual([{ moduleKey: "work", entryIndex: 1, status: "added" }]);
  });

  it("描述条目未变时，隐藏正文变化不误标预览", () => {
    const before = snapshot([work([{ id: "a", company: "甲", description: "原正文", descriptionItems: ["实际展示内容"] }])]);
    const after = snapshot([work([{ id: "a", company: "甲", description: "修改的正文", descriptionItems: ["实际展示内容"] }])]);
    expect(previewChanges(before, after)).toEqual({ before: [], after: [] });
  });
});
