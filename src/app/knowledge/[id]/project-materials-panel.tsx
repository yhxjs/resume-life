"use client";

import { useState } from "react";
import Link from "next/link";
import type { Material } from "./use-project-detail";
import { btnGhost, btnPrimary, inputCls, textareaCls, textErr } from "@/lib/ui";
import { DirectoryPickerDialog } from "./directory-picker-dialog";

type ProjectMaterialsPanelProps = {
  materials: Material[];
  materialsTotal?: number;
  error: string;
  matTitle: string;
  matContent: string;
  file: File | null;
  uploading: boolean;
  editingId: number | null;
  editTitle: string;
  editContent: string;
  editRevision: string;
  loadingEdit: boolean;
  editError: string;
  savingEdit: boolean;
  expanded: number | null;
  setMatTitle: (value: string) => void;
  setMatContent: (value: string) => void;
  setFile: (value: File | null) => void;
  setEditingId: (value: number | null) => void;
  setEditTitle: (value: string) => void;
  setEditContent: (value: string) => void;
  setExpanded: (value: number | null) => void;
  addPaste: () => void;
  addFile: () => void;
  removeMaterial: (id: number, title: string) => void;
  startEdit: (material: Material) => void;
  retryEdit: () => void;
  saveEdit: (id: number) => void;
  toggleMaterialExpanded?: (material: Material) => void;
  loadMoreMaterials?: () => void;
  loadingMoreMaterials?: boolean;
  materialsNextCursor?: string | null;
  // 方式三：扫描本地仓库与目录记录
  projectId: number;
  repoPaths: string[];
  onAddRepoPath: (path: string) => boolean | void;
  onRemoveRepoPath: (index: number) => void;
  onClearRepoPaths: () => void;
  onOpenScanModal: () => void;
};

export function ProjectMaterialsPanel({
  materials, materialsTotal, error, matTitle, matContent, file, uploading, editingId, editTitle, editContent, editRevision, loadingEdit, editError, savingEdit, expanded,
  setMatTitle, setMatContent, setFile, setEditingId, setEditTitle, setEditContent, setExpanded,
  addPaste, addFile, removeMaterial, startEdit, retryEdit, saveEdit, toggleMaterialExpanded = (material) => setExpanded(expanded === material.id ? null : material.id), loadMoreMaterials, materialsNextCursor, loadingMoreMaterials = false,
  projectId, repoPaths, onAddRepoPath, onRemoveRepoPath, onClearRepoPaths, onOpenScanModal,
}: ProjectMaterialsPanelProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [inputRepoPath, setInputRepoPath] = useState("");
  const [localPathError, setLocalPathError] = useState("");

  function handleAddLocalPath() {
    const trimmed = inputRepoPath.trim();
    if (!trimmed) return;
    if (repoPaths.includes(trimmed)) {
      setLocalPathError("该路径已在选中的目录列表中");
      return;
    }
    onAddRepoPath(trimmed);
    setInputRepoPath("");
    setLocalPathError("");
  }

  return (
    <div className="space-y-5 lg:col-span-5">
      <div className="rounded-2xl border border-line bg-card p-5 shadow-card-subtle space-y-4">
        <div className="flex items-center justify-between border-b border-line pb-2.5">
          <div className="flex items-center gap-2"><span className="h-[9px] w-[9px] rounded-[1px] bg-primary" /><h3 className="font-serif text-sm font-bold text-ink">导入架构材料</h3></div>
          <span className="text-[11px] text-faint">支持文档 / 文本 / 本地代码库</span>
        </div>
        <div className="space-y-2">
          <span className="text-xs font-bold text-muted">方式一：粘贴文字材料</span>
          <label htmlFor="project-material-title" className="sr-only">材料标题</label>
          <input id="project-material-title" className={inputCls} value={matTitle} onChange={(event) => setMatTitle(event.target.value)} placeholder="材料标题（如：分布式网关设计方案）" />
          <textarea aria-label="粘贴材料正文" className={`${textareaCls} font-sans text-xs`} value={matContent} onChange={(event) => setMatContent(event.target.value)} placeholder="粘贴架构方案、接口说明、大促复盘笔记或 PRD 重点…" />
          <button type="button" className={btnGhost} onClick={addPaste} disabled={uploading || !matContent.trim()}>{uploading ? "导入中…" : "+ 导入粘贴材料"}</button>
        </div>
        <div className="space-y-2 border-t border-line/60 pt-3">
          <span className="text-xs font-bold text-muted">方式二：直接上传文档</span>
          <label htmlFor="project-material-file" className="sr-only">上传材料文件</label>
          <input id="project-material-file" type="file" accept=".pdf,.docx,.txt,.md,.markdown" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className="block w-full text-xs text-muted file:mr-2.5 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-on-primary hover:file:bg-primary-hover cursor-pointer" />
          <button type="button" className={btnGhost} onClick={addFile} disabled={uploading || !file}>{uploading ? "解析上传中…" : "上传并解析文件"}</button>
        </div>

        {/* 方式三：扫描本地仓库 */}
        <div className="space-y-2.5 border-t border-line/60 pt-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-muted">方式三：扫描本地代码仓库</span>
            <button
              type="button"
              onClick={() => {
                setLocalPathError("");
                setPickerOpen(true);
              }}
              className="text-xs text-primary font-medium hover:underline flex items-center gap-1 cursor-pointer"
            >
              <span>📁</span>
              <span>浏览目录</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="project-repo-path" className="sr-only">本地工程路径</label>
            <input
              id="project-repo-path"
              className={inputCls}
              placeholder="输入本地工程路径，按回车或点击添加"
              value={inputRepoPath}
              onChange={(e) => {
                setInputRepoPath(e.target.value);
                if (localPathError) setLocalPathError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddLocalPath();
                }
              }}
            />
            <button
              type="button"
              className={`${btnGhost} shrink-0`}
              disabled={!inputRepoPath.trim()}
              onClick={handleAddLocalPath}
            >
              + 添加
            </button>
          </div>

          {localPathError && (
            <p className="text-[11px] text-accent">{localPathError}</p>
          )}

          {repoPaths.length > 0 ? (
            <div className="space-y-1.5 pt-0.5">
              <div className="flex items-center justify-between text-[11px] text-muted">
                <span>已记录代码库目录（{repoPaths.length} 个）：</span>
                <button
                  type="button"
                  onClick={onClearRepoPaths}
                  className="text-faint hover:text-accent transition-colors"
                >
                  清空
                </button>
              </div>
              <div className="max-h-28 overflow-y-auto space-y-1.5 pr-0.5">
                {repoPaths.map((p, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-lg border border-line bg-surface-2 text-[11px] font-mono group"
                  >
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      <span className="h-3.5 w-3.5 rounded-full bg-primary/10 text-primary text-[9px] flex items-center justify-center shrink-0">
                        {idx + 1}
                      </span>
                      <span className="truncate text-ink" title={p}>
                        {p}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemoveRepoPath(idx)}
                      className="text-faint hover:text-accent p-0.5 text-xs transition-colors shrink-0"
                      title="移除此路径"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-[11px] text-faint py-0.5">
              尚未记录代码目录。支持选择或输入多个工程（如前端、后端或微服务）。
            </p>
          )}

          <button
            type="button"
            className={`${btnGhost} w-full flex items-center justify-center gap-1.5 font-medium`}
            onClick={onOpenScanModal}
          >
            <span>📂</span>
            <span>
              {repoPaths.length > 0
                ? `扫描选中的 ${repoPaths.length} 个代码库并提炼`
                : "打开代码仓库扫描工作台"}
            </span>
          </button>
        </div>

        {error && <p className={`text-xs ${textErr}`}>{error}</p>}
      </div>

      <DirectoryPickerDialog
        open={pickerOpen}
        projectId={projectId}
        initialPath={inputRepoPath.trim() || (repoPaths.length > 0 ? repoPaths[repoPaths.length - 1] : undefined)}
        onClose={() => setPickerOpen(false)}
        onSelect={(selectedPath) => {
          onAddRepoPath(selectedPath);
          setLocalPathError("");
        }}
      />

      <div className="rounded-2xl border border-line bg-card p-5 shadow-card-subtle space-y-3">
        <div className="flex items-center justify-between border-b border-line pb-2.5"><h3 className="font-serif text-sm font-bold text-ink">已沉淀技术文档 ({materialsTotal ?? materials.length})</h3></div>
        {materials.length === 0 ? <p className="text-xs text-faint py-2">暂无材料，请在上栏导入你的第一篇技术设计文档。</p> : (
          <div className="space-y-2.5 max-h-80 overflow-y-auto">
            {materials.map((material) => (
              <div key={material.id} className="rounded-xl border border-line/80 bg-surface/30 p-3 text-xs transition-all hover:bg-card hover:border-primary/40">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1"><div className="font-bold text-ink line-clamp-1">{material.title || "未命名文档"}</div><div className="mt-0.5 text-[10px] text-faint font-mono">{material.source === "file" ? `文件: ${material.filename}` : "纯文本"} · {material.content_length ?? material.content?.length ?? 0} 字</div></div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button type="button" onClick={() => toggleMaterialExpanded(material)} className="text-primary hover:underline px-1 py-0.5">{expanded === material.id ? "收起" : "原文"}</button>
                    <button type="button" onClick={() => startEdit(material)} className="text-muted hover:text-ink px-1 py-0.5">编辑</button>
                    <button type="button" onClick={() => removeMaterial(material.id, material.title)} className="text-danger hover:underline px-1 py-0.5">删除</button>
                  </div>
                </div>
                {editingId === material.id && <div className="mt-2.5 space-y-2 border-t border-line/60 pt-2.5">
                  <label htmlFor={`project-material-edit-title-${material.id}`} className="sr-only">编辑材料标题</label>
                  {loadingEdit && <p role="status" className="text-muted">正在加载材料正文…</p>}
                  {editError && <div role="alert" className={textErr}>{editError}<button type="button" className={`${btnGhost} ml-2`} onClick={retryEdit}>重试加载</button></div>}
                  <input id={`project-material-edit-title-${material.id}`} className={inputCls} value={editTitle} disabled={loadingEdit || !!editError || savingEdit} onChange={(event) => setEditTitle(event.target.value)} />
                  <textarea aria-label={`编辑「${material.title}」材料正文`} className={`${textareaCls} font-mono text-xs`} value={editContent} disabled={loadingEdit || !!editError || savingEdit} onChange={(event) => setEditContent(event.target.value)} />
                  <div className="flex justify-end gap-2"><button type="button" className={btnGhost} onClick={() => setEditingId(null)}>取消</button><button type="button" className={btnPrimary} onClick={() => saveEdit(material.id)} disabled={savingEdit || loadingEdit || !!editError || !editRevision}>{savingEdit ? "保存中…" : "保存"}</button></div>
                </div>}
                {expanded === material.id && editingId !== material.id && <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2.5 font-mono text-[11px] text-ink leading-relaxed border border-line">{material.content ?? "正在加载…"}</pre>}
              </div>
            ))}
            {materialsNextCursor && loadMoreMaterials && <button type="button" className={`${btnGhost} w-full`} onClick={loadMoreMaterials} disabled={loadingMoreMaterials} aria-busy={loadingMoreMaterials}>{loadingMoreMaterials ? "加载材料中…" : "加载更多材料"}</button>}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-primary/25 bg-primary-soft/40 p-5 shadow-card-subtle space-y-2.5">
        <div className="flex items-center justify-between"><h3 className="font-serif text-sm font-bold text-primary">🎯 转换为实战深挖考题</h3><span className="rounded bg-primary-soft px-2 py-0.5 text-[10px] font-bold text-primary">项目深挖</span></div>
        <p className="text-xs text-muted leading-relaxed">沉淀的技术架构与难点是最佳的面试谈资，点击即可前往「专项题目练习」直接生成 5 道该项目的深度考题。</p>
        <Link href="/drills" className="inline-flex w-full items-center justify-center rounded-xl bg-primary py-2.5 text-xs font-bold text-white shadow-xs hover:bg-primary-hover transition-colors">前往题目练习深挖答辩 →</Link>
      </div>
    </div>
  );
}
