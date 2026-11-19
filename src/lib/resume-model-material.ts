import { isModuleKey } from "./modules";
import { ResumeContextError } from "./resume-errors";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: Record<string, unknown>, fields: readonly string[]) =>
  fields.every(field => !Object.hasOwn(value, field) || typeof value[field] === "string");
const textList = (value: Record<string, unknown>, field: string) =>
  !Object.hasOwn(value, field) || (Array.isArray(value[field]) && value[field].every(item => typeof item === "string"));

/** 模型正文不能使用编辑器的容错空值；缺省字段兼容旧快照，不清洗或补写原材料。 */
export function assertResumeModelModules(modules: unknown): void {
  if (!Array.isArray(modules)) throw new ResumeContextError();
  for (const resumeModule of modules) {
    if (!record(resumeModule) || !isModuleKey(resumeModule.type)) throw new ResumeContextError();
    // 身份与排版均不进入职业材料，不因它们损坏阻断生成。
    if (resumeModule.type === "basic") continue;
    if (typeof resumeModule.key !== "string" || typeof resumeModule.label !== "string") throw new ResumeContextError();
    const content = resumeModule.content;
    let valid: boolean;
    if (resumeModule.type === "skills") {
      valid = record(content) && textList(content, "items");
    } else if (resumeModule.type === "summary") {
      valid = record(content) && strings(content, ["text"]) && textList(content, "descriptionItems");
    } else {
      const fields = resumeModule.type === "education" ? ["school", "degree", "field"] :
        resumeModule.type === "work" ? ["company", "title"] : resumeModule.type === "projects" ? ["name", "role"] : ["title", "subTitle"];
      valid = Array.isArray(content) && content.every(entry => record(entry) &&
        strings(entry, [...fields, "start", "end", "description"]) && textList(entry, "descriptionItems") &&
        (!Object.hasOwn(entry, "subItems") || (Array.isArray(entry.subItems) && entry.subItems.every(sub =>
          record(sub) && strings(sub, ["label", "value"])))));
    }
    if (!valid) throw new ResumeContextError();
  }
}
