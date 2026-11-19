"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTypewriter } from "@/hooks/use-typewriter";
import { fetchSse } from "@/lib/fetch-sse";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { apiFetch } from "@/lib/api-fetch";
import { normalizeSummary, type ProjectSummary } from "@/lib/summary";
import { errorMessage } from "@/lib/error-message";
import { adoptSummaryChanges, compareProjectSummaries, type SummaryUnitKey } from "@/lib/project-summary-diff";
import { readProjectSummaryProposal, type ProjectSummaryProposal } from "@/lib/project-summary-proposal";
import { matchesProjectSummary, readProjectSummarySaveConfirmation, readProjectSummarySavedDetail, type ProjectSummarySaveConfirmation } from "@/lib/project-summary-save";
import { readProjectMaterialSaveConfirmation, readProjectMaterialSavedDetail, type ProjectMaterialSaveRecovery } from "@/lib/project-material-save";
import { useProjectMaterialImport } from "./use-project-material-import";

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

export type SummaryProposal = ProjectSummaryProposal & { source: "ai" | "repo" };
export type MaterialDeletionState = { phase: "confirming" | "deleting" | "checking" | "unknown" | "idle"; message: string };
type MaterialDeletionCommand = { controller: AbortController; retry?: () => Promise<void> };
const SAVE_UNCERTAIN_MESSAGE = "保存结果尚未确认，原稿已保留，请核对保存状态";

export function useProjectDetail(id: string) {
  const [data, setData] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState("");
  const [matTitle, setMatTitleState] = useState("");
  const [matContent, setMatContentState] = useState("");
  const [file, setFileState] = useState<File | null>(null);
  const materialInputRef = useRef<{ title: string; content: string; file: File | null }>({ title: "", content: "", file: null });
  function setMatTitle(value: string) { materialInputRef.current.title = value; setMatTitleState(value); }
  function setMatContent(value: string) { materialInputRef.current.content = value; setMatContentState(value); }
  function setFile(value: File | null) { materialInputRef.current.file = value; setFileState(value); }
  const [materialRefreshError, setMaterialRefreshError] = useState("");
  const [refreshingMaterials, setRefreshingMaterials] = useState(false);
  const materialRefreshRef = useRef<object | null>(null);
  const materialRefreshMessageRef = useRef("材料已更新");
  const [editingId, setEditingIdState] = useState<number | null>(null);
  const editingIdRef = useRef<number | null>(null);
  const [editingMaterial, setEditingMaterial] = useState<{ projectId: string; material: Material } | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editRevision, setEditRevision] = useState("");
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [editError, setEditError] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const editSessionRef = useRef(0);
  const materialRequestsRef = useRef(new Map<number, { version: object; request: object }>());
  const savingEditRef = useRef(false);
  const editDraftRevisionRef = useRef(0);
  const editSaveControllerRef = useRef<AbortController | null>(null);
  const editSaveCheckRef = useRef<(() => Promise<void>) | null>(null);
  const [editSaveRecovery, setEditSaveRecovery] = useState<ProjectMaterialSaveRecovery | null>(null);
  const materialDeletionRef = useRef<MaterialDeletionCommand | null>(null);
  const deletedMaterialIdsRef = useRef(new Set<number>());
  const [materialDeletion, setMaterialDeletion] = useState<MaterialDeletionState | null>(null);
  const [savingSummary, setSavingSummary] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [refreshingSummary, setRefreshingSummary] = useState(false);
  const summaryRefreshRef = useRef<object | null>(null);
  const savingSummaryRef = useRef(false);
  const summarySaveControllerRef = useRef<AbortController | null>(null);
  const summarySaveCheckRef = useRef<(() => Promise<void>) | null>(null);
  const [saveRecovery, setSaveRecovery] = useState<{ checking: boolean; retry: boolean; message: string } | null>(null);
  const draftRevisionRef = useRef(0);
  const summaryGenerationRef = useRef(0);
  const editedSummaryFieldsRef = useRef(new Set<keyof ProjectSummary>());
  const [expanded, setExpandedState] = useState<number | null>(null);
  const expandedSessionRef = useRef(0);
  const [summaryDraft, setSummaryDraft] = useState<ProjectSummary | null>(null);
  // 材料分页和后台刷新可更新data，但不能替仍保留的编辑正文换用新版本。
  const summaryBaseRef = useRef({ revisionId: 0 });
  const [pendingDraft, setPendingDraft] = useState(false);
  const [proposal, setProposal] = useState<SummaryProposal | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<SummaryUnitKey[]>([]);
  const [summarizing, setSummarizing] = useState(false);
  const [sumStatus, setSumStatus] = useState<SummaryStatus | null>(null);
  const typewriter = useTypewriter();
  const summarizeAbortRef = useRef<AbortController | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const loadGenerationRef = useRef(0);
  const projectSessionRef = useRef(0);
  const activeProjectRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  const [loadingMoreMaterials, setLoadingMoreMaterials] = useState(false);
  let displayedSummary = summaryDraft;
  let reviewProposal = proposal;
  if (summaryDraft && proposal) {
    const adopted = adoptSummaryChanges(summaryDraft, proposal.summary, {}, selectedKeys).summary;
    displayedSummary = selectedKeys.some((key) => key.startsWith("achievement:"))
      ? adopted
      : { ...adopted, achievements: summaryDraft.achievements };
    // 手动改动后按当前草稿重新比对，避免差异面板仍用压缩前的成果索引。
    const originalChanges = new Map(proposal.comparison.map((change) => [change.key, change]));
    reviewProposal = {
      ...proposal,
      comparison: compareProjectSummaries(summaryDraft, proposal.summary, {}).map((change) => {
        const original = originalChanges.get(change.key);
        return {
          ...change,
          status: original?.previous === change.previous ? original.status : change.previous ? "conflict" : change.status,
        };
      }),
    };
  }

  const load = useCallback(async (cursor?: string, append = false) => {
    // 旧项目写入完成后也可能调用捕获旧 id 的 load，不能让它抢占新项目世代。
    if (activeProjectRef.current !== id) return;
    const generation = append ? loadGenerationRef.current : ++loadGenerationRef.current;
    if (!append) {
      // 完整刷新只返回材料元数据，同时收起旧预览，避免失效的详情一直显示加载中。
      expandedSessionRef.current++;
      setExpandedState(null);
      loadingMoreRef.current = false;
      setLoadingMoreMaterials(false);
    }
    const next = await jsonFetch<ProjectDetail>(`/api/projects/${id}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (generation !== loadGenerationRef.current) return;
    const filteredMaterials = next.materials.filter(material => !deletedMaterialIdsRef.current.has(material.id));
    const normalized = normalizeProjectDetail({ ...next, materials: filteredMaterials,
      ...(next.materials_total !== undefined ? { materials_total: Math.max(0, next.materials_total - (next.materials.length - filteredMaterials.length)) } : {}) });
    setData((current) => {
      // 保存核对独立于材料读取；晚到的旧快照可更新材料，但不能回退已确认的档案。
      const refreshed = current?.id === normalized.id && (current.summary_revision_id ?? 0) > (normalized.summary_revision_id ?? 0)
        ? { ...normalized, summary: current.summary, summary_revision_id: current.summary_revision_id,
          summary_updated_at: current.summary_updated_at, summary_corrupt: current.summary_corrupt }
        : normalized;
      if (!append) return refreshed;
      if (!current || current.id !== refreshed.id || current.materials_next_cursor !== cursor) return current;
      const known = new Set(current.materials.map((material) => material.id));
      const additions = refreshed.materials.filter((material) => {
        if (known.has(material.id)) return false;
        known.add(material.id);
        return true;
      });
      return { ...refreshed, materials: [...current.materials, ...additions] };
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

  const loadMaterial = useCallback(async (materialId: number, belongsToSession: () => boolean, purpose: "edit" | "preview") => {
    if (activeProjectRef.current !== id || deletedMaterialIdsRef.current.has(materialId) || !belongsToSession()) return;
    const session = projectSessionRef.current;
    const generation = loadGenerationRef.current;
    const request = {};
    const version = materialRequestsRef.current.get(materialId)?.version ?? {};
    materialRequestsRef.current.set(materialId, { version, request });
    const isCurrent = () => activeProjectRef.current === id && projectSessionRef.current === session &&
      materialRequestsRef.current.get(materialId)?.version === version && belongsToSession();
    try {
      const material = await jsonFetch<Material>(`/api/projects/${id}/materials/${materialId}`);
      if (!isCurrent()) return;
      // 编辑正文可保留自己的版本基线；共享缓存只接收本轮列表中最新发出的详情。
      setData((current) => isCurrent() && generation === loadGenerationRef.current &&
        materialRequestsRef.current.get(materialId)?.request === request && current && String(current.id) === id
        ? { ...current, materials: current.materials.map((item) => item.id === materialId ? { ...item, ...material } : item) }
        : current);
      return { material, isCurrent };
    } catch (reason) {
      if (isCurrent() && (purpose === "edit" || materialRequestsRef.current.get(materialId)?.request === request)) throw reason;
    }
  }, [id]);

  async function refreshMaterials(message = materialRefreshMessageRef.current, force = false) {
    if (activeProjectRef.current !== id || (!force && materialRefreshRef.current)) return;
    const request = {};
    const session = projectSessionRef.current;
    const isCurrent = () => activeProjectRef.current === id && projectSessionRef.current === session && materialRefreshRef.current === request;
    const generation = loadGenerationRef.current + 1;
    materialRefreshRef.current = request;
    materialRefreshMessageRef.current = message;
    setRefreshingMaterials(true);
    try {
      await load();
      if (isCurrent() && generation === loadGenerationRef.current) setMaterialRefreshError("");
    } catch (reason) {
      if (isCurrent() && generation === loadGenerationRef.current) setMaterialRefreshError(`${message}，列表刷新失败：${errorMessage(reason)}`);
    } finally {
      if (isCurrent()) {
        materialRefreshRef.current = null;
        setRefreshingMaterials(false);
      }
    }
  }

  useEffect(() => {
    let cancelled = false;
    const loadGeneration = loadGenerationRef;
    const activeProject = activeProjectRef;
    activeProject.current = id;
    const generation = ++loadGeneration.current;
    loadingMoreRef.current = false;
    const editSession = editSessionRef;
    const projectSession = projectSessionRef;
    const summarizeAbort = summarizeAbortRef;
    const summarySaveController = summarySaveControllerRef;
    const editSaveController = editSaveControllerRef;
    const materialRequests = materialRequestsRef.current;
    const materialDeletionCommand = materialDeletionRef;
    const deletedMaterials = deletedMaterialIdsRef.current;
    const currentEditor = editingIdRef;
    jsonFetch<ProjectDetail>(`/api/projects/${id}`)
      .then((next) => {
        if (cancelled || generation !== loadGenerationRef.current) return;
        setLoadingMoreMaterials(false);
        const normalized = normalizeProjectDetail(next);
        setData(normalized);
        summaryBaseRef.current = { revisionId: normalized.summary_revision_id ?? 0 };
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
      projectSession.current++;
      editSession.current++;
      materialRequests.clear();
      summarizeAbort.current?.abort();
      summarizeAbort.current = null;
      summarySaveController.current?.abort();
      summarySaveController.current = null;
      summarySaveCheckRef.current = null;
      editSaveController.current?.abort();
      editSaveController.current = null;
      editSaveCheckRef.current = null;
      materialDeletionCommand.current?.controller.abort();
      materialDeletionCommand.current = null;
      deletedMaterials.clear();
      currentEditor.current = null;
    };
  }, [id, loadAttempt]);

  const materialImport = useProjectMaterialImport(id,
    () => activeProjectRef.current === id && String(data?.id) === id,
    () => refreshMaterials("材料已导入", true), setError);

  async function addPaste() {
    const { title: submittedTitle, content: submittedContent } = materialInputRef.current;
    if (!submittedContent.trim()) {
      setError("粘贴的材料内容不能为空");
      return;
    }
    const saved = await materialImport.submitImport((signal) => apiFetch(`/api/projects/${id}/materials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: submittedTitle.trim(), content: submittedContent }),
      signal,
    }), { title: submittedTitle.trim() || submittedContent.trim().slice(0, 20), source: "paste", filename: "" });
    if (saved) {
      if (materialInputRef.current.title === submittedTitle) setMatTitle("");
      if (materialInputRef.current.content === submittedContent) setMatContent("");
    }
  }

  async function addFile() {
    const submittedFile = materialInputRef.current.file;
    if (!submittedFile) {
      setError("请先选择文件（PDF / Word / txt / md）");
      return;
    }
    const form = new FormData();
    form.append("file", submittedFile);
    const saved = await materialImport.submitImport((signal) => apiFetch(`/api/projects/${id}/materials`, { method: "POST", body: form, signal }),
      { title: submittedFile.name, source: "file", filename: submittedFile.name });
    if (saved && materialInputRef.current.file === submittedFile) setFile(null);
  }

  async function removeMaterial(mid: number, title: string) {
    if (activeProjectRef.current !== id || String(data?.id) !== id || materialDeletionRef.current ||
        savingEditRef.current || editSaveCheckRef.current || deletedMaterialIdsRef.current.has(mid)) return;
    const session = projectSessionRef.current;
    const command: MaterialDeletionCommand = { controller: new AbortController() };
    const isCurrent = () => activeProjectRef.current === id && projectSessionRef.current === session &&
      materialDeletionRef.current === command && !command.controller.signal.aborted;
    const endpoint = `/api/projects/${id}/materials/${mid}`;
    materialDeletionRef.current = command;
    setMaterialDeletion({ phase: "confirming", message: `等待确认删除材料「${title}」` });
    function release(message?: string) {
      materialDeletionRef.current = null;
      setMaterialDeletion(message ? { phase: "idle", message } : null);
    }
    async function complete() {
      deletedMaterialIdsRef.current.add(mid);
      materialRequestsRef.current.delete(mid);
      setData((current) => {
        if (!current || String(current.id) !== id) return current;
        const present = current.materials.some(item => item.id === mid);
        return { ...current, materials: current.materials.filter(item => item.id !== mid),
          ...(present && current.materials_total !== undefined ? { materials_total: Math.max(0, current.materials_total - 1) } : {}) };
      });
      // 记录已不存在，删除等待时重开的同材料编辑器也不能继续保存。
      if (editingIdRef.current === mid) setEditingId(null);
      setExpandedState((current) => current === mid ? null : current);
      await refreshMaterials("材料已删除", true);
      if (isCurrent()) release();
    }
    let checking = false;
    async function check() {
      if (!isCurrent() || checking) return;
      checking = true;
      setMaterialDeletion({ phase: "checking", message: `正在只读核对材料「${title}」的删除状态…` });
      try {
        const value = await jsonFetch<unknown>(endpoint, { cache: "no-store", signal: command.controller.signal });
        if (!isCurrent()) return;
        readProjectMaterialSavedDetail(value, mid);
        release(`材料「${title}」目前仍存在，上次请求仍可能稍后完成，请核对后再决定是否删除。`);
      } catch (reason) {
        if (!isCurrent()) return;
        if (reason instanceof HttpError && reason.status === 404) await complete();
        else setMaterialDeletion({ phase: "unknown", message: `材料「${title}」的删除结果尚未确认：${errorMessage(reason)}。请重新读取删除状态。` });
      } finally {
        checking = false;
      }
    }
    const { confirmDialog } = await import("@/components/common/confirm-dialog");
    if (!isCurrent()) return;
    if (!(await confirmDialog({ title: "删除材料", message: `确定删除材料「${title}」？`, danger: true, signal: command.controller.signal }))) {
      if (isCurrent()) release();
      return;
    }
    if (!isCurrent()) return;
    setMaterialDeletion({ phase: "deleting", message: `正在删除材料「${title}」…` });
    try {
      const value = await jsonFetch<unknown>(endpoint, { method: "DELETE", signal: command.controller.signal });
      if (!isCurrent()) return;
      if (!value || typeof value !== "object" || Array.isArray(value) || (value as { ok?: unknown }).ok !== true) throw new Error("删除响应不完整");
      await complete();
    } catch (reason) {
      if (!isCurrent()) return;
      if (reason instanceof HttpError && reason.status === 404) await complete();
      else if (reason instanceof HttpError && reason.status >= 400 && reason.status < 500 && reason.status !== 408) release(`删除失败：${errorMessage(reason)}`);
      else {
        command.retry = check;
        await check();
      }
    }
  }

  function setEditingId(value: number | null) {
    editSessionRef.current++;
    editingIdRef.current = value;
    setEditingIdState(value);
    if (value === null) setEditingMaterial(null);
    setLoadingEdit(false);
    setEditError("");
  }

  function startEdit(material: Material) {
    if (activeProjectRef.current !== id || String(data?.id) !== id || deletedMaterialIdsRef.current.has(material.id)) return;
    const session = ++editSessionRef.current;
    const initialContent = material.content ?? "";
    setEditingIdState(material.id);
    editingIdRef.current = material.id;
    setEditingMaterial({ projectId: id, material });
    setEditTitle(material.title);
    setEditContent(initialContent);
    setEditRevision(material.revision ?? "");
    setEditError("");
    setLoadingEdit(!material.revision);
    if (!material.revision) {
      void loadMaterial(material.id, () => session === editSessionRef.current, "edit").then((result) => {
        if (session !== editSessionRef.current) return;
        if (!result?.isCurrent()) {
          setEditError("材料已更新，请重新加载后再编辑");
          return;
        }
        const loaded = result.material;
        setEditingMaterial({ projectId: id, material: loaded });
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
    const material = data?.materials.find((item) => item.id === editingId) ??
      (editingMaterial?.projectId === id && editingMaterial.material.id === editingId ? editingMaterial.material : undefined);
    if (material) startEdit(material);
  }

  async function toggleMaterialExpanded(material: Material) {
    if (activeProjectRef.current !== id || String(data?.id) !== id || deletedMaterialIdsRef.current.has(material.id)) return;
    if (expanded === material.id) {
      setExpanded(null);
      return;
    }
    setExpanded(material.id);
    const session = expandedSessionRef.current;
    const generation = loadGenerationRef.current;
    if (!material.revision || !material.content) {
      try { await loadMaterial(material.id, () => session === expandedSessionRef.current && generation === loadGenerationRef.current, "preview"); }
      catch (reason) { setError(errorMessage(reason)); }
    }
  }

  function setExpanded(value: number | null) {
    expandedSessionRef.current++;
    setExpandedState(value);
  }

  async function saveEdit(mid: number) {
    if (savingEditRef.current || editSaveCheckRef.current || materialDeletionRef.current || deletedMaterialIdsRef.current.has(mid) ||
        loadingEdit || editError || !editRevision || editingId !== mid || activeProjectRef.current !== id) return;
    const session = editSessionRef.current;
    const projectSession = projectSessionRef.current;
    const draftRevision = editDraftRevisionRef.current;
    const controller = new AbortController();
    editSaveControllerRef.current = controller;
    const isCurrent = () => activeProjectRef.current === id && projectSessionRef.current === projectSession && !controller.signal.aborted;
    const submittedTitle = editTitle.trim();
    const submittedContent = editContent;
    const endpoint = `/api/projects/${id}/materials/${mid}`;
    savingEditRef.current = true;
    setSavingEdit(true);
    setEditSaveRecovery(null);
    function cacheMaterial(material: Partial<Material>) {
      materialRequestsRef.current.delete(mid);
      setData(current => current && String(current.id) === id ? { ...current, materials: current.materials.map(item => item.id === mid
        ? { ...item, ...material } : item) } : current);
    }
    async function confirm(revision: string, recovered = false) {
      const material = { title: submittedTitle, content: submittedContent, content_length: Array.from(submittedContent).length, revision };
      cacheMaterial(material);
      if (session === editSessionRef.current) {
        if (draftRevision === editDraftRevisionRef.current) setEditingId(null);
        else {
          // 核对等待期间的新编辑继续沿本次已确认的版本保存，其他编辑会话保留各自基准。
          setEditRevision(revision);
          setEditingMaterial(current => current?.projectId === id && current.material.id === mid
            ? { ...current, material: { ...current.material, ...material } } : current);
        }
      }
      await refreshMaterials(recovered ? "已核对材料包含本次提交内容" : "材料已保存", true);
    }
    let checking = false;
    async function check() {
      if (!isCurrent() || checking || editSaveCheckRef.current !== check) return;
      checking = true;
      materialRequestsRef.current.delete(mid);
      setEditSaveRecovery({ checking: true, retry: true, message: `正在只读核对材料「${submittedTitle}」的保存状态，不会自动重复保存。` });
      try {
        const value = await jsonFetch<unknown>(endpoint, { cache: "no-store", signal: controller.signal });
        if (!isCurrent()) return;
        const material = readProjectMaterialSavedDetail(value, mid);
        if (material.title === submittedTitle && material.content === submittedContent) {
          await confirm(material.revision, true);
          if (!isCurrent()) return;
          setEditSaveRecovery(null);
        } else {
          cacheMaterial({ ...material, content_length: Array.from(material.content).length });
          setEditSaveRecovery({ checking: false, retry: false, message: `材料「${submittedTitle}」的存档与本次提交不同，原稿及原版本已保留。上次请求仍可能稍后完成，请核对原文后再决定是否保存。` });
        }
        editSaveCheckRef.current = null;
      } catch (reason) {
        if (!isCurrent()) return;
        if (reason instanceof HttpError && reason.status === 404) {
          editSaveCheckRef.current = null;
          setEditSaveRecovery({ checking: false, retry: false, message: `材料「${submittedTitle}」已不存在，原稿已保留，请复制需要的内容后取消编辑。` });
        } else setEditSaveRecovery({ checking: false, retry: true, message: `材料「${submittedTitle}」保存结果尚未确认：${errorMessage(reason)}。请重新读取材料保存状态。` });
      } finally {
        checking = false;
      }
    }
    try {
      const value = await jsonFetch<unknown>(endpoint, {
        method: "PATCH", signal: controller.signal,
        body: JSON.stringify({ title: submittedTitle, content: submittedContent, expectedRevision: editRevision }),
      });
      if (!isCurrent()) return;
      await confirm(readProjectMaterialSaveConfirmation(value));
    } catch (reason) {
      if (!isCurrent()) return;
      if (reason instanceof HttpError && reason.status >= 400 && reason.status < 500 && reason.status !== 408) {
        const { alertDialog } = await import("@/components/common/confirm-dialog");
        if (isCurrent() && session === editSessionRef.current) await alertDialog({ title: "保存失败", message: errorMessage(reason) });
      } else {
        editSaveCheckRef.current = check;
        await check();
      }
    } finally {
      savingEditRef.current = false;
      if (isCurrent()) setSavingEdit(false);
    }
  }

  async function summarize(mode: "full" | "resume-only" = "full") {
    if (activeProjectRef.current !== id || String(data?.id) !== id) return;
    summaryGenerationRef.current++;
    summarizeAbortRef.current?.abort();
    const controller = new AbortController();
    summarizeAbortRef.current = controller;
    const session = projectSessionRef.current;
    const isCurrent = () => projectSessionRef.current === session && activeProjectRef.current === id &&
      summarizeAbortRef.current === controller && !controller.signal.aborted;
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
      await fetchSse<unknown>(url, {
        signal: controller.signal,
        onDelta: (delta) => { if (isCurrent()) typewriter.appendDelta(delta); },
        onDone: (result) => {
          if (!isCurrent()) return;
          const received = readProjectSummaryProposal(result);
          typewriter.flush();
          applyDraft({ ...received, source: "ai" });
          setSumStatus({
            kind: "warn",
            text: mode === "resume-only"
              ? "AI 简历三要素草稿已生成，确认前不会写入项目档案"
              : "AI 总结草稿已生成，确认前不会写入项目档案",
          });
        },
        onError: (reason) => {
          if (!isCurrent()) return;
          typewriter.reset();
          setSumStatus({ kind: "err", text: `生成失败：${reason.message}` });
        },
      });
    } catch (reason) {
      if (isCurrent()) {
        typewriter.reset();
        setSumStatus({ kind: "err", text: `生成失败：${errorMessage(reason)}` });
      }
    } finally {
      if (isCurrent()) {
        summarizeAbortRef.current = null;
        setSummarizing(false);
      }
    }
  }

  function discardDraft() {
    if (!data) return;
    draftRevisionRef.current++;
    summaryBaseRef.current = { revisionId: data.summary_revision_id ?? 0 };
    setSummaryDraft(data.summary);
    setPendingDraft(false);
    setProposal(null);
    setSelectedKeys([]);
    setSumStatus(null);
  }

  function updateSummaryField<K extends keyof ProjectSummary>(key: K, value: ProjectSummary[K]) {
    draftRevisionRef.current++;
    editedSummaryFieldsRef.current.add(key);
    setSummaryDraft((current) => (current ? { ...current, [key]: value } : current));
    setSelectedKeys((current) => current.filter((item) => item !== key));
  }

  function updateAchievementItem(index: number, val: string) {
    draftRevisionRef.current++;
    editedSummaryFieldsRef.current.add("achievements");
    // 可见列表已合并采纳项且可能因删除而移位，编辑后整体成为手动草稿，不能再按旧索引重复采纳。
    setSelectedKeys((current) => current.filter((key) => !key.startsWith("achievement:")));
    setSummaryDraft((current) => {
      if (!current) return current;
      const list = [...(displayedSummary?.achievements ?? current.achievements)];
      list[index] = val;
      return { ...current, achievements: list };
    });
  }

  function addAchievementItem() {
    draftRevisionRef.current++;
    editedSummaryFieldsRef.current.add("achievements");
    setSelectedKeys((current) => current.filter((key) => !key.startsWith("achievement:")));
    setSummaryDraft((current) => {
      if (!current) return current;
      return { ...current, achievements: [...(displayedSummary?.achievements ?? current.achievements), ""] };
    });
  }

  function removeAchievementItem(index: number) {
    draftRevisionRef.current++;
    editedSummaryFieldsRef.current.add("achievements");
    setSelectedKeys((current) => current.filter((key) => !key.startsWith("achievement:")));
    setSummaryDraft((current) => {
      if (!current) return current;
      const list = (displayedSummary?.achievements ?? current.achievements).filter((_, i) => i !== index);
      return { ...current, achievements: list };
    });
  }

  async function refreshSummary(force = false) {
    if (activeProjectRef.current !== id || (!force && summaryRefreshRef.current)) return;
    const request = {};
    summaryRefreshRef.current = request;
    const generation = loadGenerationRef.current + 1;
    setRefreshingSummary(true);
    try {
      await load();
      if (summaryRefreshRef.current === request && generation === loadGenerationRef.current) setRefreshError("");
    } catch (reason) {
      if (summaryRefreshRef.current === request && generation === loadGenerationRef.current) setRefreshError(errorMessage(reason));
    } finally {
      if (summaryRefreshRef.current === request) {
        summaryRefreshRef.current = null;
        setRefreshingSummary(false);
      }
    }
  }

  async function saveSummary() {
    if (!summaryDraft || savingSummaryRef.current || summarySaveCheckRef.current || activeProjectRef.current !== id || String(data?.id) !== id) return;
    const submittedBase = summaryBaseRef.current;
    if (proposal && proposal.revisionId !== submittedBase.revisionId) {
      setSumStatus({ kind: "err", text: "保存失败：AI 草稿与本地编辑的档案版本不一致，请刷新页面核对后重新生成" });
      return;
    }
    const session = projectSessionRef.current;
    const controller = new AbortController();
    summarySaveControllerRef.current = controller;
    const isCurrent = () => projectSessionRef.current === session && activeProjectRef.current === id && !controller.signal.aborted;
    savingSummaryRef.current = true;
    const draftRevision = draftRevisionRef.current;
    const generation = summaryGenerationRef.current;
    const submittedSummary = summaryDraft;
    const savedSummary = proposal
      ? adoptSummaryChanges(summaryDraft, proposal.summary, {}, selectedKeys).summary
      : summaryDraft;
    const expectedSummary = normalizeSummary(savedSummary);
    setSavingSummary(true);
    setSaveRecovery(null);
    setRefreshError("");
    function confirm(confirmed: ProjectSummarySaveConfirmation, recovered = false) {
      const confirmedSummary = confirmed.summary;
      const confirmedRevision = confirmed.revisionId;
      // 本次确认可推进其后继续编辑的基准；等待期间显式放弃／切换基准的正文不能被推进。
      if (summaryBaseRef.current === submittedBase && typeof confirmedRevision === "number" &&
          Number.isSafeInteger(confirmedRevision) && confirmedRevision >= 1) {
        summaryBaseRef.current = { revisionId: confirmedRevision };
        // 同一份提案在等待时继续编辑，可沿本次已确认的正文继续保存；新生成的提案保留自己的依据。
        if (proposal && draftRevision !== draftRevisionRef.current) {
          setProposal(current => current === proposal ? { ...current, revisionId: confirmedRevision } : current);
        }
      }
      // 写入确认先更新本地基底；后续 GET 失败也不能退回旧版本或把成功写入当成失败。
      setData((current) => {
        if (!current || String(current.id) !== id || typeof confirmedRevision !== "number" ||
            !Number.isSafeInteger(confirmedRevision) || confirmedRevision < 1 || (current.summary_revision_id ?? 0) > confirmedRevision) return current;
        return {
          ...current,
          summary: confirmedSummary,
          summary_revision_id: confirmedRevision,
          ...(confirmed.summary_updated_at !== undefined ? { summary_updated_at: confirmed.summary_updated_at } : {}),
        };
      });
      // 保存只确认提交时的草稿；等待期间的新草稿、编辑和采纳选择仍待用户确认。
      if (draftRevision === draftRevisionRef.current) {
        setSummaryDraft((current) => current === submittedSummary ? confirmedSummary : current);
        setPendingDraft(false);
        setProposal(null);
        setSelectedKeys([]);
        if (generation === summaryGenerationRef.current) {
          setSumStatus({ kind: "ok", text: recovered ? "已核对项目档案包含本次提交的总结内容" : pendingDraft ? "草稿已确认，总结已写入项目档案" : "总结已保存" });
        }
      } else if (recovered && generation === summaryGenerationRef.current) {
        setSumStatus(current => current?.text === SAVE_UNCERTAIN_MESSAGE
          ? { kind: "warn", text: "已核对本次提交的总结内容，后续编辑仍待保存" }
          : current);
      }
    }
    let checking = false;
    async function check() {
      if (!isCurrent() || checking || summarySaveCheckRef.current !== check) return;
      checking = true;
      setSaveRecovery({ checking: true, retry: true, message: "保存结果尚未确认，正在只读核对项目档案；原稿已保留，不会自动重复保存。" });
      try {
        const value = await jsonFetch<unknown>(`/api/projects/${id}`, { cache: "no-store", signal: controller.signal });
        if (!isCurrent()) return;
        const detail = readProjectSummarySavedDetail(value, id);
        if (detail.revisionId > submittedBase.revisionId && matchesProjectSummary(detail.summary, expectedSummary)) {
          confirm(detail, true);
          setSaveRecovery(null);
        } else {
          // 保留原编辑基准；再次显式保存仍受 expectedRevisionId 事务检查，不能重复追加同一次保存。
          setData(current => current && String(current.id) === id && (current.summary_revision_id ?? 0) <= detail.revisionId
            ? { ...current, summary: detail.summary, summary_revision_id: detail.revisionId,
              ...(detail.summary_updated_at !== undefined ? { summary_updated_at: detail.summary_updated_at } : {}) }
            : current);
          setSaveRecovery({ checking: false, retry: false, message: "当前读取的档案尚不能确认本次提交，原稿及原版本已保留。上次请求仍可能稍后完成，请核对总结历史后再决定是否保存。" });
        }
        summarySaveCheckRef.current = null;
      } catch (reason) {
        if (isCurrent()) setSaveRecovery({ checking: false, retry: true, message: `保存结果尚未确认：${errorMessage(reason)}。原稿和采纳选择已保留，请重新读取保存状态。` });
      } finally {
        checking = false;
      }
    }
    try {
      const value = await jsonFetch<unknown>(`/api/projects/${id}`, {
        method: "PATCH", signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: savedSummary,
          expectedRevisionId: submittedBase.revisionId,
          ...(proposal ? { proposal: { generated: proposal.summary, acceptedKeys: selectedKeys, source: proposal.source, materialFingerprint: proposal.materialFingerprint } } : {}),
        }),
      });
      if (!isCurrent()) return;
      confirm(readProjectSummarySaveConfirmation(value, expectedSummary, submittedBase.revisionId));
      await refreshSummary(true);
    } catch (reason) {
      if (!isCurrent()) return;
      if (reason instanceof HttpError && reason.status >= 400 && reason.status < 500 && reason.status !== 408) {
        if (draftRevision === draftRevisionRef.current && generation === summaryGenerationRef.current) {
          setSumStatus({ kind: "err", text: `保存失败：${errorMessage(reason)}` });
        }
      } else {
        if (draftRevision === draftRevisionRef.current && generation === summaryGenerationRef.current) {
          setSumStatus({ kind: "err", text: SAVE_UNCERTAIN_MESSAGE });
        }
        summarySaveCheckRef.current = check;
        await check();
      }
    } finally {
      if (isCurrent()) {
        savingSummaryRef.current = false;
        setSavingSummary(false);
      }
    }
  }

  function applyDraft(next: SummaryProposal, message?: string) {
    if (activeProjectRef.current !== id || String(data?.id) !== id) return;
    draftRevisionRef.current++;
    const initial = !data?.summary_updated_at;
    setProposal(next);
    // 晚到回调也读取实时编辑记录；显式清空属于编辑，成果按整份列表保护，避免索引错位。
    setSelectedKeys(initial ? next.comparison.filter(({ key }) => {
      const field = key.startsWith("achievement:") ? "achievements" : key as keyof ProjectSummary;
      return !editedSummaryFieldsRef.current.has(field);
    }).map((change) => change.key) : []);
    setPendingDraft(true);
    if (message) setSumStatus({ kind: "warn", text: message });
  }

  function toggleAdoption(key: SummaryUnitKey) {
    draftRevisionRef.current++;
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
      uploading: materialImport.uploading,
      importRecovery: materialImport.importRecovery,
      importLocked: materialImport.importLocked,
      rereadImport: materialImport.rereadImport,
      allowImportRetry: materialImport.allowImportRetry,
      materialRefreshError,
      refreshingMaterials,
      refreshMaterials: () => refreshMaterials(),
      editingId,
      editingMaterial: editingMaterial?.projectId === id ? editingMaterial.material : null,
      editTitle,
      editContent,
      loadingEdit,
      editError,
      savingEdit,
      editSaveRecovery,
      retryEditSaveCheck: () => editSaveCheckRef.current?.(),
      materialDeletion,
      materialDeleting: materialDeletion !== null && materialDeletion.phase !== "idle",
      retryMaterialDeletion: () => materialDeletionRef.current?.retry?.(),
      savingSummary,
      expanded,
      setMatTitle,
      setMatContent,
      setFile,
      setEditingId,
      setEditTitle: (value: string) => { editDraftRevisionRef.current++; setEditTitle(value); },
      setEditContent: (value: string) => { editDraftRevisionRef.current++; setEditContent(value); },
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
      proposal: reviewProposal,
      selectedKeys,
      canConfirmDraft: selectedKeys.length > 0 || JSON.stringify(summaryDraft) !== JSON.stringify(data?.summary),
      summarizing,
      savingSummary,
      saveRecovery,
      retrySaveCheck: () => summarySaveCheckRef.current?.(),
      sumStatus,
      refreshError,
      refreshingSummary,
      refreshSummary: () => refreshSummary(),
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
