"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTypewriter } from "@/hooks/use-typewriter";
import { fetchSse } from "@/lib/fetch-sse";
import { jsonFetch } from "@/lib/fetcher";
import { apiFetch } from "@/lib/api-fetch";
import { normalizeSummary, type ProjectSummary } from "@/lib/summary";
import { errorMessage } from "@/lib/error-message";
import { adoptSummaryChanges, compareProjectSummaries, type SummaryChange, type SummaryUnitKey } from "@/lib/project-summary-diff";
import type { MaterialChange } from "@/lib/project-summary-history";

export type Material = {
  id: number;
  title: string;
  source: string;
  filename: string;
  content?: string;
  content_length?: number;
  revision?: string;
  created_at: string;
};

export type ProjectDetail = {
  id: number;
  name: string;
  summary: ProjectSummary;
  summary_updated_at: string;
  summary_revision_id?: number;
  summary_corrupt?: boolean;
  materials: Material[];
  materials_next_cursor?: string | null;
  materials_total?: number;
};

function normalizeProjectDetail(value: ProjectDetail): ProjectDetail {
  return { ...value, summary: normalizeSummary(value.summary) };
}

export type SummaryStatus = {
  kind: "ok" | "err" | "info" | "warn";
  text: string;
};

export type SummaryProposal = {
  summary: ProjectSummary;
  comparison: SummaryChange[];
  materialChanges: MaterialChange[];
  materialFingerprint: string;
  revisionId: number;
  source: "ai" | "repo";
};

export function useProjectDetail(id: string) {
  const [data, setData] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState("");
  const [matTitle, setMatTitle] = useState("");
  const [matContent, setMatContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [editingId, setEditingIdState] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editRevision, setEditRevision] = useState("");
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [editError, setEditError] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const editSessionRef = useRef(0);
  const savingEditRef = useRef(false);
  const [savingSummary, setSavingSummary] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [summaryDraft, setSummaryDraft] = useState<ProjectSummary | null>(null);
  const [pendingDraft, setPendingDraft] = useState(false);
  const [proposal, setProposal] = useState<SummaryProposal | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<SummaryUnitKey[]>([]);
  const [summarizing, setSummarizing] = useState(false);
  const [sumStatus, setSumStatus] = useState<SummaryStatus | null>(null);
  const typewriter = useTypewriter();
  const summarizeAbortRef = useRef<AbortController | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const loadGenerationRef = useRef(0);
  const activeProjectRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  const [loadingMoreMaterials, setLoadingMoreMaterials] = useState(false);
  let displayedSummary = summaryDraft;
  if (summaryDraft && proposal) {
    const adopted = adoptSummaryChanges(summaryDraft, proposal.summary, {}, selectedKeys).summary;
    displayedSummary = selectedKeys.some((key) => key.startsWith("achievement:"))
      ? adopted
      : { ...adopted, achievements: summaryDraft.achievements };
  }

  const load = useCallback(async (cursor?: string, append = false) => {
    // 旧项目写入完成后也可能调用捕获旧 id 的 load，不能让它抢占新项目世代。
    if (activeProjectRef.current !== id) return;
    const generation = append ? loadGenerationRef.current : ++loadGenerationRef.current;
    if (!append) {
      loadingMoreRef.current = false;
      setLoadingMoreMaterials(false);
    }
    const next = await jsonFetch<ProjectDetail>(`/api/projects/${id}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (generation !== loadGenerationRef.current) return;
    const normalized = normalizeProjectDetail(next);
    setData((current) => {
      if (!append) return normalized;
      if (!current || current.id !== normalized.id || current.materials_next_cursor !== cursor) return current;
      const known = new Set(current.materials.map((material) => material.id));
      const additions = normalized.materials.filter((material) => {
        if (known.has(material.id)) return false;
        known.add(material.id);
        return true;
      });
      return { ...normalized, materials: [...current.materials, ...additions] };
    });
  }, [id]);

  function loadMoreMaterials() {
    if (!data?.materials_next_cursor || String(data.id) !== id || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMoreMaterials(true);
    const generation = loadGenerationRef.current;
    void load(data.materials_next_cursor, true)
      .catch((reason) => { if (generation === loadGenerationRef.current) setError(errorMessage(reason)); })
      .finally(() => {
        if (generation !== loadGenerationRef.current) return;
        loadingMoreRef.current = false;
        setLoadingMoreMaterials(false);
      });
  }

  const loadMaterial = useCallback(async (materialId: number) => {
    const material = await jsonFetch<Material>(`/api/projects/${id}/materials/${materialId}`);
    setData((current) => current ? { ...current, materials: current.materials.map((item) => item.id === materialId ? { ...item, ...material } : item) } : current);
    return material;
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    const loadGeneration = loadGenerationRef;
    const activeProject = activeProjectRef;
    activeProject.current = id;
    const generation = ++loadGeneration.current;
    loadingMoreRef.current = false;
    const editSession = editSessionRef;
    jsonFetch<ProjectDetail>(`/api/projects/${id}`)
      .then((next) => {
        if (cancelled || generation !== loadGenerationRef.current) return;
        setLoadingMoreMaterials(false);
        const normalized = normalizeProjectDetail(next);
        setData(normalized);
        setSummaryDraft(normalized.summary);
      })
      .catch((reason) => {
        if (!cancelled && generation === loadGenerationRef.current) {
          setLoadingMoreMaterials(false);
          setError(errorMessage(reason));
        }
      });
    return () => {
      cancelled = true;
      activeProject.current = null;
      loadGeneration.current++;
      editSession.current++;
      summarizeAbortRef.current?.abort();
    };
  }, [id, loadAttempt]);

  async function uploadMaterial(request: () => Promise<Response>): Promise<boolean> {
    setError("");
    setUploading(true);
    try {
      const response = await request();
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      await load();
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setUploading(false);
    }
  }

  async function addPaste() {
    if (!matContent.trim()) {
      setError("粘贴的材料内容不能为空");
      return;
    }
    const submittedTitle = matTitle;
    const submittedContent = matContent;
    const saved = await uploadMaterial(() => apiFetch(`/api/projects/${id}/materials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: submittedTitle.trim(), content: submittedContent }),
    }));
    if (saved) {
      setMatTitle((current) => current === submittedTitle ? "" : current);
      setMatContent((current) => current === submittedContent ? "" : current);
    }
  }

  async function addFile() {
    if (!file) {
      setError("请先选择文件（PDF / Word / txt / md）");
      return;
    }
    const submittedFile = file;
    const form = new FormData();
    form.append("file", submittedFile);
    const saved = await uploadMaterial(() => apiFetch(`/api/projects/${id}/materials`, { method: "POST", body: form }));
    if (saved) setFile((current) => current === submittedFile ? null : current);
  }

  async function removeMaterial(mid: number, title: string) {
    const { confirmDialog, alertDialog } = await import("@/components/common/confirm-dialog");
    if (!(await confirmDialog({ title: "删除材料", message: `确定删除材料「${title}」？`, danger: true }))) return;
    try {
      await jsonFetch(`/api/projects/${id}/materials/${mid}`, { method: "DELETE" });
      await load();
    } catch (reason) {
      await alertDialog({ title: "删除失败", message: errorMessage(reason) });
    }
  }

  function setEditingId(value: number | null) {
    editSessionRef.current++;
    setEditingIdState(value);
    setLoadingEdit(false);
    setEditError("");
  }

  function startEdit(material: Material) {
    const session = ++editSessionRef.current;
    const initialContent = material.content ?? "";
    setEditingIdState(material.id);
    setEditTitle(material.title);
    setEditContent(initialContent);
    setEditRevision(material.revision ?? "");
    setEditError("");
    setLoadingEdit(!material.revision);
    if (!material.revision) {
      void loadMaterial(material.id).then((loaded) => {
        if (session !== editSessionRef.current) return;
        // 标题、正文与修订号采用同一详情基线，并保留当前会话已修改的字段。
        setEditTitle((current) => current === material.title ? loaded.title : current);
        setEditContent((current) => current === initialContent ? loaded.content ?? "" : current);
        setEditRevision(loaded.revision ?? "");
      }).catch((reason) => {
        if (session === editSessionRef.current) setEditError(errorMessage(reason));
      }).finally(() => {
        if (session === editSessionRef.current) setLoadingEdit(false);
      });
    }
  }

  function retryEdit() {
    const material = data?.materials.find((item) => item.id === editingId);
    if (material) startEdit(material);
  }

  async function toggleMaterialExpanded(material: Material) {
    if (expanded === material.id) {
      setExpanded(null);
      return;
    }
    setExpanded(material.id);
    if (!material.revision || !material.content) {
      try { await loadMaterial(material.id); } catch (reason) { setError(errorMessage(reason)); }
    }
  }

  async function saveEdit(mid: number) {
    if (savingEditRef.current || loadingEdit || editError || !editRevision || editingId !== mid) return;
    const session = editSessionRef.current;
    savingEditRef.current = true;
    setSavingEdit(true);
    try {
      await jsonFetch(`/api/projects/${id}/materials/${mid}`, {
        method: "PATCH",
        body: JSON.stringify({ title: editTitle.trim(), content: editContent, expectedRevision: editRevision }),
      });
      if (session === editSessionRef.current) setEditingId(null);
      await load();
    } catch (reason) {
      const { alertDialog } = await import("@/components/common/confirm-dialog");
      if (session === editSessionRef.current) await alertDialog({ title: "保存失败", message: errorMessage(reason) });
    } finally {
      savingEditRef.current = false;
      setSavingEdit(false);
    }
  }

  async function summarize(mode: "full" | "resume-only" = "full") {
    summarizeAbortRef.current?.abort();
    const controller = new AbortController();
    summarizeAbortRef.current = controller;
    setSumStatus({
      kind: "info",
      text: mode === "resume-only" ? "正在提炼简历三要素…" : "总结流式生成中…",
    });
    setSummarizing(true);
    typewriter.reset();
    try {
      const url =
        mode === "resume-only"
          ? `/api/projects/${id}/summarize?mode=resume-only`
          : `/api/projects/${id}/summarize`;
      await fetchSse<Partial<SummaryProposal>>(url, {
        signal: controller.signal,
        onDelta: (delta) => typewriter.appendDelta(delta),
        onDone: (result) => {
          typewriter.flush();
          if (result.summary) {
            const generated = normalizeSummary(result.summary);
            applyDraft({
              summary: generated,
              comparison: result.comparison ?? compareProjectSummaries(data?.summary ?? generated, generated, {}),
              materialChanges: result.materialChanges ?? [],
              materialFingerprint: result.materialFingerprint ?? "",
              revisionId: result.revisionId ?? data?.summary_revision_id ?? 0,
              source: "ai",
            });
            setSumStatus({
              kind: "warn",
              text:
                mode === "resume-only"
                  ? "AI 简历三要素草稿已生成，确认前不会写入项目档案"
                  : "AI 总结草稿已生成，确认前不会写入项目档案",
            });
          }
        },
        onError: (reason) => {
          typewriter.reset();
          setSumStatus({ kind: "err", text: `生成失败：${reason.message}` });
        },
      });
    } catch (reason) {
      if (!controller.signal.aborted) {
        typewriter.reset();
        setSumStatus({ kind: "err", text: `生成失败：${errorMessage(reason)}` });
      }
    } finally {
      if (summarizeAbortRef.current === controller) {
        summarizeAbortRef.current = null;
        setSummarizing(false);
      }
    }
  }

  function discardDraft() {
    if (!data) return;
    setSummaryDraft(data.summary);
    setPendingDraft(false);
    setProposal(null);
    setSelectedKeys([]);
    setSumStatus(null);
  }

  function updateSummaryField<K extends keyof ProjectSummary>(key: K, value: ProjectSummary[K]) {
    setSummaryDraft((current) => (current ? { ...current, [key]: value } : current));
    setSelectedKeys((current) => current.filter((item) => item !== key));
  }

  function updateAchievementItem(index: number, val: string) {
    setSelectedKeys((current) => current.filter((key) => key !== `achievement:${index}`));
    setSummaryDraft((current) => {
      if (!current) return current;
      const list = [...(displayedSummary?.achievements ?? current.achievements)];
      list[index] = val;
      return { ...current, achievements: list };
    });
  }

  function addAchievementItem() {
    setSelectedKeys((current) => current.filter((key) => !key.startsWith("achievement:")));
    setSummaryDraft((current) => {
      if (!current) return current;
      return { ...current, achievements: [...(displayedSummary?.achievements ?? current.achievements), ""] };
    });
  }

  function removeAchievementItem(index: number) {
    setSelectedKeys((current) => current.filter((key) => !key.startsWith("achievement:")));
    setSummaryDraft((current) => {
      if (!current) return current;
      const list = (displayedSummary?.achievements ?? current.achievements).filter((_, i) => i !== index);
      return { ...current, achievements: list };
    });
  }

  async function saveSummary() {
    if (!summaryDraft || savingSummary) return;
    const submittedSummary = summaryDraft;
    const savedSummary = proposal
      ? adoptSummaryChanges(summaryDraft, proposal.summary, {}, selectedKeys).summary
      : summaryDraft;
    setSavingSummary(true);
    try {
      await jsonFetch(`/api/projects/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: savedSummary,
          expectedRevisionId: proposal?.revisionId ?? data?.summary_revision_id,
          ...(proposal ? { proposal: { generated: proposal.summary, acceptedKeys: selectedKeys, source: proposal.source, materialFingerprint: proposal.materialFingerprint } } : {}),
        }),
      });
      const wasPending = pendingDraft;
      setSummaryDraft((current) => current === submittedSummary ? savedSummary : current);
      setPendingDraft(false);
      setProposal(null);
      setSelectedKeys([]);
      setSumStatus({ kind: "ok", text: wasPending ? "草稿已确认，总结已写入项目档案" : "总结已保存" });
      await load();
    } catch (reason) {
      setSumStatus({ kind: "err", text: `保存失败：${errorMessage(reason)}` });
    } finally {
      setSavingSummary(false);
    }
  }

  function applyDraft(next: SummaryProposal, message?: string) {
    const initial = !data?.summary_updated_at;
    setProposal(next);
    setSelectedKeys(initial ? next.comparison.map((change) => change.key) : []);
    setPendingDraft(true);
    if (message) setSumStatus({ kind: "warn", text: message });
  }

  function toggleAdoption(key: SummaryUnitKey) {
    setSelectedKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }

  return {
    data,
    error,
    retryLoad: () => { setError(""); setLoadAttempt((attempt) => attempt + 1); },
    material: {
      matTitle,
      matContent,
      file,
      uploading,
      editingId,
      editTitle,
      editContent,
      loadingEdit,
      editError,
      savingEdit,
      savingSummary,
      expanded,
      setMatTitle,
      setMatContent,
      setFile,
      setEditingId,
      setEditTitle,
      setEditContent,
      editRevision,
      setExpanded,
      toggleMaterialExpanded,
      addPaste,
      addFile,
      removeMaterial,
      startEdit,
      retryEdit,
      saveEdit,
      loadMoreMaterials,
      loadingMoreMaterials,
      materialsNextCursor: data?.materials_next_cursor,
    },
    summary: {
      summaryDraft: displayedSummary,
      pendingDraft,
      proposal,
      selectedKeys,
      canConfirmDraft: selectedKeys.length > 0 || JSON.stringify(summaryDraft) !== JSON.stringify(data?.summary),
      summarizing,
      savingSummary,
      sumStatus,
      typewriter,
      summarize,
      discardDraft,
      updateSummaryField,
      updateAchievementItem,
      addAchievementItem,
      removeAchievementItem,
      saveSummary,
      applyDraft,
      toggleAdoption,
    },
  };
}
