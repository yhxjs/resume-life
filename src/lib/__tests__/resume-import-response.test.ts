import { describe, expect, it } from "vitest";
import { MODULE_KEYS } from "../modules";
import { normalizeImportedModule } from "../resume-import";
import { assertImportedResumeSaved, readImportedResumeDraft, readImportedResumeOcr } from "../resume-import-response";

function fixture(): Record<string, unknown> {
  return { title: "完整草稿", modules: Object.fromEntries(MODULE_KEYS.map((key) => [key, normalizeImportedModule(key,
    key === "basic" ? { name: "合成人物" } : key === "work" ? [
      { company: "甲公司", descriptionItems: ["Array<T> &amp;"], subItems: [{ label: "技术栈", value: "Map<K, V>" }] },
      { company: "乙公司", description: "未上线" },
    ] : undefined)])) };
}

describe("导入响应协议", () => {
  function savedFixture() {
    const snapshot = readImportedResumeDraft(fixture())!;
    const saved = { resume: { id: 42, title: snapshot.title }, warnings: [] as string[], corruptedKeys: [] as string[],
      modules: MODULE_KEYS.filter(key => key !== "custom").map(key => ({ key, type: key, content: snapshot.modules[key] })) };
    return { snapshot, saved };
  }

  it("创建回读接受未插入的空自定义模块，保留正文原值且不修改快照", () => {
    const { snapshot, saved } = savedFixture();
    const before = JSON.stringify({ snapshot, saved });
    expect(() => assertImportedResumeSaved(saved, 42, snapshot)).not.toThrow();
    expect(JSON.stringify({ snapshot, saved })).toBe(before);
  });

  it.each(["id", "title", "missing", "duplicate", "content", "warnings", "corrupted", "custom"])("创建回读拒绝 %s 异常，不靠补默认值掩盖坏存档", (mode) => {
    const { snapshot, saved } = savedFixture();
    if (mode === "id") saved.resume.id = 43;
    if (mode === "title") saved.resume.title = "另一份简历";
    if (mode === "missing") saved.modules.pop();
    if (mode === "duplicate") saved.modules.push(saved.modules[0]!);
    if (mode === "content") saved.modules.find(row => row.type === "skills")!.content = { items: "坏列表" };
    if (mode === "warnings") saved.warnings.push("正文读取错误");
    if (mode === "corrupted") saved.corruptedKeys.push("work");
    if (mode === "custom") snapshot.modules.custom = [{ id: "c1", title: "应保存的证书", description: "" }];
    expect(() => assertImportedResumeSaved(saved, 42, snapshot)).toThrow("保存回读与本次导入草稿不符");
  });

  it("保留已经转义的正文和原有 ID，不再次清洗或修补", () => {
    const draft = fixture();
    const before = JSON.stringify(draft);
    const read = readImportedResumeDraft(draft);
    expect(read).toEqual(draft);
    expect(read?.modules).toBe(draft.modules);
    expect(JSON.stringify(draft)).toBe(before);
  });

  it.each([
    [[], null], [[], []], [["title"], 42], [["title"], " "], [["modules"], []],
    [["modules", "basic"], undefined], [["modules", "skills", "items"], ["有效", null]],
    [["modules", "summary", "text"], null], [["modules", "summary", "descriptionItems"], undefined],
    [["modules", "work", 0, "id"], ""], [["modules", "work", 0, "description"], undefined],
    [["modules", "work", 0, "descriptionItems"], ["有效", 42]],
    [["modules", "work", 0, "subItems", 0, "id"], ""],
    [["modules", "work", 0, "subItems", 0, "value"], null],
    [["modules", "education"], [{ id: "e1", school: "缺失必需字段" }]],
  ] satisfies [ (string | number)[], unknown ][])("拒绝坏字段 %j = %j", (path, value) => {
    const draft = fixture();
    if (!path.length) return expect(readImportedResumeDraft(value)).toBeNull();
    let target: Record<string | number, unknown> = draft;
    for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, unknown>;
    target[path.at(-1)!] = value;
    expect(readImportedResumeDraft(draft)).toBeNull();
  });

  it("重复经历或副项 ID 不能进入编辑器", () => {
    const draft = fixture();
    const modules = draft.modules as Record<string, unknown>;
    const work = modules.work as { id: string; subItems: { id: string; label: string; value: string }[] }[];
    work[1]!.id = work[0]!.id;
    expect(readImportedResumeDraft(draft)).toBeNull();
    work[1]!.id = "独立条目";
    work[0]!.subItems.push({ ...work[0]!.subItems[0]! });
    expect(readImportedResumeDraft(draft)).toBeNull();
  });

  it.each([null, [], { engine: "other", pageCount: 1 }, { engine: "local", pageCount: 0 },
    { engine: "vision", pageCount: "1" }, { engine: "local", pageCount: 1.5 },
    { engine: "local", pageCount: 1, sourceType: "other" }])("拒绝错误 OCR 信息 %j", (value) => {
    expect(readImportedResumeOcr(value)).toBeNull();
  });

  it.each([{ engine: "local", pageCount: 2 }, { engine: "vision", pageCount: 1, sourceType: "image" }])("接受 OCR 信息 %j", (value) => {
    expect(readImportedResumeOcr(value)).toEqual(value);
  });
});
