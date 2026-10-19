import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pagePath = path.join(process.cwd(), "src/app/resumes/[id]/page.tsx");
const editorPath = path.join(process.cwd(), "src/components/resume/resume-editor.tsx");
const controllerPath = path.join(process.cwd(), "src/hooks/use-resume-editor-controller.ts");

describe("简历编辑器职责边界", () => {
  it("路由页只解析动态参数并委托客户端编辑器", () => {
    const source = fs.readFileSync(pagePath, "utf8");
    expect(source).not.toContain("use client");
    expect(source).not.toMatch(/\buse(?:State|Effect|Ref|Callback|Params)\b/u);
    expect(source).toContain("<ResumeEditor key={id} id={id} />");
    expect(source.split(/\r?\n/u).length).toBeLessThanOrEqual(20);
  });

  it("客户端视图与编辑控制器分别存在并通过明确接口协作", () => {
    expect(fs.existsSync(editorPath)).toBe(true);
    expect(fs.existsSync(controllerPath)).toBe(true);

    const editor = fs.readFileSync(editorPath, "utf8");
    const controller = fs.readFileSync(controllerPath, "utf8");
    expect(editor).toContain("useResumeEditorController(id)");
    expect(controller).toContain("export function useResumeEditorController");
  });
});
