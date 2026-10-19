import type { ModuleData } from "@/lib/modules";

export type ResumeDocument = { resume: { title: string; titleRevision?: string; styleRevision?: string; dataGeneration?: string | null }; modules: ModuleData[]; addedKey?: string };
export type Draft = { title?: string; baseTitleRevision?: string; modules?: Record<string, unknown>; baseRevisions?: Record<string, string> };
export type Storage = { read: () => string; write: (value: string) => void };

export function hasDraft(draft: Draft): boolean {
  return draft.title !== undefined || Object.keys(draft.modules ?? {}).length > 0;
}

export function readDraft(storage: Storage): { draft: Draft; storageError: boolean } {
  const draft: Draft = {};
  try {
    const raw = storage.read();
    if (raw) {
      const saved = JSON.parse(raw) as Draft;
      if (saved && typeof saved === "object") {
        if (typeof saved.title === "string") draft.title = saved.title;
        if (typeof saved.baseTitleRevision === "string" && /^[0-9a-f]{64}$/.test(saved.baseTitleRevision)) {
          draft.baseTitleRevision = saved.baseTitleRevision;
        }
        if (saved.modules && typeof saved.modules === "object" && !Array.isArray(saved.modules)) {
          draft.modules = saved.modules;
        }
        if (saved.baseRevisions && typeof saved.baseRevisions === "object" && !Array.isArray(saved.baseRevisions)) {
          draft.baseRevisions = Object.fromEntries(Object.entries(saved.baseRevisions)
            .filter((entry) => typeof entry[1] === "string" && /^[0-9a-f]{64}$/.test(entry[1])));
        }
      }
    }
  } catch {
    return { draft, storageError: true };
  }
  return { draft, storageError: false };
}

export function persistDraft(storage: Storage, draft: Draft): boolean {
  try {
    storage.write(hasDraft(draft) ? JSON.stringify(draft) : "");
    return true;
  } catch {
    return false;
  }
}

export function mergeDraft<T extends ResumeDocument>(document: T, draft: Draft): T {
  return {
    ...document,
    resume: { ...document.resume, title: draft.title ?? document.resume.title },
    modules: document.modules.map((module) => Object.hasOwn(draft.modules ?? {}, module.key)
      ? { ...module, content: draft.modules![module.key] } : module),
  };
}
