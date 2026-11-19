import { describe, expect, it } from "vitest";
import { evaluationArtifactIdentity } from "../../../evals/artifact-identity";

describe("评测报告的可移植文件身份", () => {
  it.each(["summary", "con", "prn", "aux", "nul", ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)])("保留名 %s 在写文件前拒绝，不尝试访问设备路径", id => {
    expect(evaluationArtifactIdentity(id)).toBeNull();
    expect(evaluationArtifactIdentity(id.toUpperCase(), true)).toBeNull();
  });

  it.each(["../escape", "sample.json", "a//b", "a\\b", "with space", "-leading", "trailing-"])("不接受文件路径或非法 ID %j", id => {
    expect(evaluationArtifactIdentity(id, true)).toBeNull();
  });

  it("文本层级和大小写仅用于显示，同一输出路径使用同一比较键", () => {
    expect(evaluationArtifactIdentity("Intro/Create", true)).toEqual({ fileId: "Intro-Create", key: "intro-create" });
    expect(evaluationArtifactIdentity("intro-create", true)).toEqual({ fileId: "intro-create", key: "intro-create" });
    expect(evaluationArtifactIdentity("Intro-Create")).toBeNull();
    expect(evaluationArtifactIdentity("intro/create")).toBeNull();
  });

  it.each(["summary-extra", "contribution", "com10", "group/con"])("保留正常名称 %s，不按片段误拒绝", id => {
    expect(evaluationArtifactIdentity(id, true)).toEqual({ fileId: id.replaceAll("/", "-"), key: id.replaceAll("/", "-") });
  });
});
