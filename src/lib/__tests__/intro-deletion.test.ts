import { describe, expect, it } from "vitest";
import { validateExistingIntro } from "../intro-history";

const version = { kind: "30s", revision: "a".repeat(64), sentences: [{ text: "  a < b && b > c\n尚未上线  ".repeat(500), comment: "点评".repeat(500) }] };
const detail = { id: 7, resume_id: 1, jd: "岗位".repeat(30_000), created_at: "历史时间", resume_title: "原始简历", resume_version_id: 11, resume_version: 2, resume_version_name: "发布版", versions: [version] };

describe("自我介绍删除只读核对", () => {
  it.each([
    detail, { ...detail, versions: [] }, { ...detail, resume_version_id: null, resume_version: null, resume_version_name: null },
    { ...detail, versions: [{ ...version, sentences: [{ text: "原稿" }] }] },
    { ...detail, versions: [{ ...version, sentences: [], read_error: "不是有效 JSON", raw_sentences: "损坏原文 <T> &amp;" }] },
    { ...detail, versions: [version, { ...version, kind: "2min", sentences: Array.from({ length: 61 }, () => ({ text: "文".repeat(801), comment: "注".repeat(301) })) }] },
  ])("接受完整历史、缺版及明确坏原稿，零改写 %#", value => {
    const before = structuredClone(value); expect(() => validateExistingIntro(value, 7)).not.toThrow(); expect(value).toEqual(before);
  });

  it.each([
    null, [], {}, { ...detail, id: 8 }, { ...detail, id: 0 }, { ...detail, resume_id: -1 }, { ...detail, resume_id: Number.MAX_SAFE_INTEGER + 1 },
    { ...detail, created_at: null }, { ...detail, jd: 1 }, { ...detail, resume_title: [] }, { ...detail, resume_version_id: null },
    { ...detail, resume_version: null }, { ...detail, resume_version_name: null }, { ...detail, versions: undefined }, { ...detail, versions: [null] },
    { ...detail, versions: [version, version] },
    ...[{ kind: "legacy" }, { revision: "not-a-revision" }, { sentences: [] }, { sentences: [{ text: " " }] },
      { sentences: [{ text: "原稿", comment: {} }] }, { sentences: [{ text: "完整原稿" }, null] },
      { read_error: "" }, { read_error: "坏原稿", sentences: [] }, { read_error: "坏原稿", raw_sentences: "原稿" },
    ].map(patch => ({ ...detail, versions: [{ ...version, ...patch }] })),
  ])("不完整、串 ID、坏版本或丢句都保持未知 %#", value => {
    expect(() => validateExistingIntro(value, 7)).toThrow("读取响应不完整或记录不符");
  });
});
