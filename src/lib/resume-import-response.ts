import { defaultContent, isModuleKey, isValidModuleContentInput, MODULE_KEYS, normalizeContent } from "@/lib/modules";

export type ImportedResumeDraft = { title: string; modules: Record<string, unknown> };
export type ImportedResumeOcr = { engine: "vision" | "local"; pageCount: number; sourceType?: "pdf" | "image" };

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const strings = (value: Record<string, unknown>, keys: readonly string[]) => keys.every((key) => typeof value[key] === "string");
const textList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

function uniqueIds(value: unknown): value is Record<string, unknown>[] {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  return value.every((entry) => {
    if (!record(entry) || typeof entry.id !== "string" || !entry.id.trim() || seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

/** 校验服务端已补齐的导入草稿；不修补坏响应、不重新生成 ID 或转义正文。 */
export function readImportedResumeDraft(value: unknown): ImportedResumeDraft | null {
  if (!record(value) || typeof value.title !== "string" || !value.title.trim() || !record(value.modules)) return null;
  const modules = value.modules;
  for (const key of MODULE_KEYS) {
    const content = modules[key];
    if (!isValidModuleContentInput(key, content)) return null;
    if (key === "basic") {
      if (!record(content) || !strings(content, ["name", "phone", "email", "location", "birthday", "links"])) return null;
    } else if (key === "skills") {
      if (!record(content) || !textList(content.items)) return null;
    } else if (key === "summary") {
      if (!record(content) || typeof content.text !== "string" || !textList(content.descriptionItems)) return null;
    } else {
      if (!uniqueIds(content)) return null;
      const fields = key === "education" ? ["school", "degree", "field", "start", "end", "description"]
        : key === "work" ? ["company", "title", "start", "end", "description"]
        : key === "projects" ? ["name", "role", "start", "end", "description"]
        : ["title", "subTitle", "start", "end", "description"];
      for (const entry of content) {
        if (!strings(entry, fields)) return null;
        if (key !== "education" && (!textList(entry.descriptionItems) || !uniqueIds(entry.subItems) ||
          !entry.subItems.every((subItem) => strings(subItem, ["label", "value"])))) return null;
      }
    }
  }
  return { title: value.title, modules };
}

export function readImportedResumeOcr(value: unknown): ImportedResumeOcr | null {
  if (!record(value) || (value.engine !== "vision" && value.engine !== "local") ||
    typeof value.pageCount !== "number" || !Number.isSafeInteger(value.pageCount) || value.pageCount < 1 ||
    (value.sourceType !== undefined && value.sourceType !== "pdf" && value.sourceType !== "image")) return null;
  return { engine: value.engine, pageCount: value.pageCount, ...(value.sourceType ? { sourceType: value.sourceType } : {}) };
}

/** 核对本次创建响应指向的存档；不凭标题或列表中的同文记录认领本次写入。 */
export function assertImportedResumeSaved(value: unknown, id: number, snapshot: ImportedResumeDraft): void {
  const invalid = () => new Error("保存回读与本次导入草稿不符，请人工核对简历列表");
  if (!record(value) || !record(value.resume) || value.resume.id !== id || value.resume.title !== snapshot.title ||
    !Array.isArray(value.modules) || !Array.isArray(value.warnings) || value.warnings.length ||
    !Array.isArray(value.corruptedKeys) || value.corruptedKeys.length) throw invalid();
  const modules: Record<string, unknown> = {};
  const keys = new Set<string>();
  for (const row of value.modules) {
    if (!record(row) || !isModuleKey(row.type) || typeof row.key !== "string" || !row.key.trim() ||
      keys.has(row.key) || Object.hasOwn(modules, row.type)) throw invalid();
    keys.add(row.key);
    modules[row.type] = row.content;
  }
  // 创建接口仅在有内容时插入自定义模块。
  if (!Object.hasOwn(modules, "custom")) modules.custom = defaultContent("custom");
  const saved = readImportedResumeDraft({ title: value.resume.title, modules });
  if (!saved || MODULE_KEYS.some(key => JSON.stringify(normalizeContent(key, saved.modules[key])) !==
    JSON.stringify(normalizeContent(key, snapshot.modules[key])))) throw invalid();
}
