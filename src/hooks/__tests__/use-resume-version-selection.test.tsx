import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useResumeVersionSelection } from "@/hooks/use-resume-version-selection";
import { ResumeVersionSelect } from "@/components/resume/resume-version-select";
import type { ResumeOption } from "@/hooks/use-resume-options";

let selection: unknown;
let effects: Array<() => void> = [];
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => [selection ?? initial, (value: unknown) => { selection = value; }],
  useEffect: (effect: () => void) => { effects.push(effect); },
}));

const resume: ResumeOption = { id: 3, title: "工程师", updated_at: "", versions: [
  { id: 31, version: 1, name: "初版" }, { id: 32, version: 2, name: "后端岗位" },
] };
function RenderSelection(option: ResumeOption | undefined, preferred?: number) {
  const result = useResumeVersionSelection(option, preferred);
  effects.splice(0).forEach((effect) => effect());
  return result;
}
beforeEach(() => { selection = null; effects = []; });

describe("发布版本选择", () => {
  it("列表加载后默认最高版本号，后续发布不会改变已选择版本", () => {
    expect(RenderSelection(undefined).resumeVersionId).toBe("");
    expect(RenderSelection(resume).resumeVersionId).toBe(32);
    expect(RenderSelection({ ...resume, versions: [...resume.versions, { id: 33, version: 3, name: "新发布" }] }).resumeVersionId).toBe(32);
  });

  it("保留投递指定的旧版本，手动选择可替换版本", () => {
    const current = RenderSelection(resume, 31);
    expect(current.resumeVersionId).toBe(31);
    current.setResumeVersionId(32);
    expect(RenderSelection(resume, 31).resumeVersionId).toBe(32);
  });

  it("切换简历时重置为新简历的最新版本", () => {
    RenderSelection(resume).setResumeVersionId(31);
    expect(RenderSelection({ ...resume, id: 4, versions: [{ id: 40, version: 1, name: "运营岗" }] }).resumeVersionId).toBe(40);
  });

  it("不把无版本或不属于该简历的版本悄悄替换成另一版本", () => {
    expect(RenderSelection({ ...resume, versions: [] }).resumeVersionId).toBe("");
    expect(RenderSelection(resume, 999).resumeVersionId).toBe("");
  });

  it("未发布时禁用选择并提供发布入口", () => {
    const html = renderToStaticMarkup(<ResumeVersionSelect resume={{ ...resume, versions: [] }} value="" onChange={() => {}} />);
    expect(html).toContain("disabled");
    expect(html).toContain("尚未发布版本");
    expect(html).toContain('href="/resumes/3"');
    expect(html).toContain("到简历编辑器发布版本");
  });
});
