import type { ModuleData } from "./modules";

type ColumnSection = { moduleKey: string; moduleType: ModuleData["type"]; kind?: string };

const MODULE_KINDS: Record<ModuleData["type"], string> = {
  basic: "contact", education: "entries", work: "entries", projects: "entries",
  skills: "skills", summary: "text", custom: "entries",
};

/** 网页与 DOCX 共用模块分流；空列表沿用自动规则，非空但无匹配则侧栏为空。 */
export function splitResumeColumns<T extends ColumnSection>(sections: readonly T[], asideModules?: readonly string[]): { main: T[]; aside: T[] } {
  const selected = asideModules?.length ? new Set(asideModules) : null;
  const main: T[] = [];
  const aside: T[] = [];
  for (const section of sections) {
    const kind = section.kind ?? MODULE_KINDS[section.moduleType];
    const isAside = selected
      ? selected.has(section.moduleKey) || selected.has(section.moduleType) || selected.has(kind)
      : kind !== "entries";
    (isAside ? aside : main).push(section);
  }
  return { main, aside };
}
