import type { ResumeSnapshot } from "./resume-version-types";
import { compareResumeVersions } from "./resume-version-diff";

export type PreviewChange = {
  moduleKey: string;
  entryIndex?: number;
  status: "added" | "removed" | "changed";
};

function entryIds(content: unknown): Map<string, number> {
  if (!Array.isArray(content)) return new Map();
  return new Map(content.map((item, index) => [String(item?.id ?? index), index]));
}

/** 给真实预览定位变化；条目以稳定 ID 匹配，索引只用于定位当前纸张中的节点。 */
export function previewChanges(before: ResumeSnapshot | null, after: ResumeSnapshot): { before: PreviewChange[]; after: PreviewChange[] } {
  const left: PreviewChange[] = [];
  const right: PreviewChange[] = [];
  const changedRows = compareResumeVersions(before, after).filter((row) => row.status !== "unchanged");
  const oldModules = new Map(before?.modules.map((module) => [module.key, module]) ?? []);
  const newModules = new Map(after.modules.map((module) => [module.key, module]));

  for (const key of new Set([...oldModules.keys(), ...newModules.keys()])) {
    const oldModule = oldModules.get(key);
    const newModule = newModules.get(key);
    if (!oldModule) { right.push({ moduleKey: key, status: "added" }); continue; }
    if (!newModule) { left.push({ moduleKey: key, status: "removed" }); continue; }

    const markModule = () => {
      if (!left.some((change) => change.moduleKey === key && change.entryIndex === undefined)) left.push({ moduleKey: key, status: "changed" });
      if (!right.some((change) => change.moduleKey === key && change.entryIndex === undefined)) right.push({ moduleKey: key, status: "changed" });
    };
    if (oldModule.type !== newModule.type || oldModule.label !== newModule.label ||
      Array.isArray(oldModule.content) !== Array.isArray(newModule.content)) {
      markModule();
      continue;
    }
    if (!Array.isArray(oldModule.content) || !Array.isArray(newModule.content)) {
      if (changedRows.some((row) => row.key.startsWith(`module/${key}/`))) markModule();
      continue;
    }

    const oldEntries = entryIds(oldModule.content);
    const newEntries = entryIds(newModule.content);
    for (const id of new Set([...oldEntries.keys(), ...newEntries.keys()])) {
      const oldIndex = oldEntries.get(id);
      const newIndex = newEntries.get(id);
      if (oldIndex === undefined) right.push({ moduleKey: key, entryIndex: newIndex, status: "added" });
      else if (newIndex === undefined) left.push({ moduleKey: key, entryIndex: oldIndex, status: "removed" });
      else if (changedRows.some((row) => row.key.startsWith(`module/${key}/content/${id}/`))) {
        left.push({ moduleKey: key, entryIndex: oldIndex, status: "changed" });
        right.push({ moduleKey: key, entryIndex: newIndex, status: "changed" });
      }
    }
    const commonOld = [...oldEntries.keys()].filter((id) => newEntries.has(id));
    const commonNew = [...newEntries.keys()].filter((id) => oldEntries.has(id));
    if (commonOld.join("\0") !== commonNew.join("\0")) markModule();
  }

  const oldOrder = before?.modules.map((item) => item.key).filter((key) => newModules.has(key)) ?? [];
  const newOrder = after.modules.map((item) => item.key).filter((key) => oldModules.has(key));
  if (oldOrder.join("\0") !== newOrder.join("\0")) {
    for (const key of oldOrder) {
      if (oldOrder.indexOf(key) === newOrder.indexOf(key)) continue;
      if (!left.some((change) => change.moduleKey === key && change.entryIndex === undefined)) left.push({ moduleKey: key, status: "changed" });
      if (!right.some((change) => change.moduleKey === key && change.entryIndex === undefined)) right.push({ moduleKey: key, status: "changed" });
    }
  }

  return { before: left, after: right };
}
