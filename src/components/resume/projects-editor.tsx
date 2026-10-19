"use client";

import { useState } from "react";
import type {
  ProjectItem,
  WorkItem,
  CustomItem,
  EntrySubItem,
  DescriptionListStyle,
} from "@/lib/modules";
import type { Status, ChangeOptions } from "@/components/resume/module-editors";
import { SaveBar } from "@/components/resume/module-editors";
import { StarPolishDialog } from "@/components/resume/star-polish-dialog";
import { stripDraftHeaders, isHeaderLine } from "@/lib/polish";
import { ExtractDialog, type ExtractPayload } from "@/components/resume/extract-dialog";
import { RichTextEditor } from "@/components/resume/rich-text-editor";
import { GripIcon, ProjectSubItems } from "@/components/resume/project-sub-items";
import { genEntryId } from "@/components/resume/project-entry-id";
import { splitRichTextToLines } from "@/lib/rich-text";
import { btnGhost, inputCls, labelCls } from "@/lib/ui";

function parseTextToLines(text: string): string[] {
  return splitRichTextToLines(text);
}

export interface CommonExperienceItem {
  id: string;
  start?: string;
  end?: string;
  description: string;
  subItems?: EntrySubItem[];
  descriptionItems?: string[];
  descriptionStyle?: DescriptionListStyle;
  [key: string]: unknown;
}

interface ExperienceEditorConfig<T extends CommonExperienceItem> {
  itemTypeLabel: string;
  primaryField1: {
    key: keyof T & string;
    label: string;
    placeholder: string;
  };
  primaryField2: {
    key: keyof T & string;
    label: string;
    placeholder: string;
  };
  presetSubLabels: string[];
  subItemHelpText: string;
  defaultSubLabel: string;
  descriptionSectionTitle: string;
  descItemPlaceholder: string;
  moduleType?: "work" | "projects";
  getPolishContext?: (item: T) => Record<string, string | undefined>;
  createBlankItem: () => T;
}

interface GenericExperienceEditorProps<T extends CommonExperienceItem> {
  itemName: string;
  items: T[];
  onChange: (items: T[], opts?: ChangeOptions) => void;
  status: Status;
  resumeId?: string;
  config: ExperienceEditorConfig<T>;
  onProofingFieldFocus?: (index: number, key: string) => void;
}

function GenericExperienceEditor<T extends CommonExperienceItem>({
  itemName,
  items,
  onChange,
  status,
  resumeId,
  config,
  onProofingFieldFocus,
}: GenericExperienceEditorProps<T>) {
  // 顶层卡片拖拽状态
  const [armedIndex, setArmedIndex] = useState<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  // 描述行拖拽状态
  const [armedDesc, setArmedDesc] = useState<{ itemIdx: number; descIdx: number } | null>(null);
  const [dragDesc, setDragDesc] = useState<{ itemIdx: number; descIdx: number } | null>(null);

  const [announcement, setAnnouncement] = useState("");

  function updateItem(itemIndex: number, patch: Partial<CommonExperienceItem>) {
    const next = items.map((p, i) => {
      if (i !== itemIndex) return p;
      const updated = { ...p, ...patch };
      if (patch.descriptionItems !== undefined && patch.description === undefined) {
        updated.description = patch.descriptionItems.join("\n");
      } else if (patch.description !== undefined && patch.descriptionItems === undefined) {
        updated.descriptionItems = parseTextToLines(patch.description as string);
      }
      return updated;
    });
    onChange(next);
  }

  function addItem() {
    onChange([...items, config.createBlankItem()], { immediate: true });
  }

  function removeItem(itemIndex: number) {
    onChange(items.filter((_, i) => i !== itemIndex), { immediate: true });
  }

  function reorderItem(from: number, to: number) {
    if (from === to) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    onChange(next, { immediate: true });
  }

  function moveItem(index: number, delta: -1 | 1) {
    const to = index + delta;
    if (to < 0 || to >= items.length) return;
    reorderItem(index, to);
    setAnnouncement(`第 ${index + 1} 个${config.itemTypeLabel}已移动到第 ${to + 1} 位`);
  }

  function addDescriptionItem(itemIndex: number) {
    const current = items[itemIndex]!;
    const descriptionItems = [...(current.descriptionItems ?? []), ""];
    updateItem(itemIndex, { descriptionItems });
  }

  function updateDescriptionItem(itemIndex: number, descIndex: number, value: string) {
    const current = items[itemIndex]!;
    const descriptionItems = (current.descriptionItems ?? []).map((d, i) =>
      i === descIndex ? value : d
    );
    updateItem(itemIndex, { descriptionItems });
  }

  function removeDescriptionItem(itemIndex: number, descIndex: number) {
    const current = items[itemIndex]!;
    const descriptionItems = (current.descriptionItems ?? []).filter((_, i) => i !== descIndex);
    updateItem(itemIndex, { descriptionItems });
  }

  function reorderDescriptionItem(itemIndex: number, from: number, to: number) {
    if (from === to) return;
    const current = items[itemIndex]!;
    const descriptionItems = [...(current.descriptionItems ?? [])];
    const [moved] = descriptionItems.splice(from, 1);
    if (moved === undefined) return;
    descriptionItems.splice(to, 0, moved);
    updateItem(itemIndex, { descriptionItems });
  }

  function moveDescriptionItem(itemIndex: number, descIndex: number, delta: -1 | 1) {
    const current = items[itemIndex]!;
    const list = current.descriptionItems ?? [];
    const to = descIndex + delta;
    if (to < 0 || to >= list.length) return;
    reorderDescriptionItem(itemIndex, descIndex, to);
    setAnnouncement(`描述条目已移到第 ${to + 1} 位`);
  }

  function handleApplyBulkDescription(
    itemIndex: number,
    rawText: string,
    newItems?: string[],
    mode: "replace" | "append" = "replace"
  ) {
    const current = items[itemIndex];
    const polishCtx = current && config.getPolishContext ? config.getPolishContext(current) : undefined;
    const cleanText = stripDraftHeaders(rawText, polishCtx);
    const cleanedNewItems = newItems?.filter((l) => !isHeaderLine(l, polishCtx));
    const lines =
      cleanedNewItems && cleanedNewItems.length > 0
        ? cleanedNewItems.map((l) => l.trim()).filter(Boolean)
        : parseTextToLines(cleanText);
    const validLines = lines.length > 0 ? lines : [cleanText.trim()];

    let nextDescItems: string[];
    if (mode === "append") {
      const existing = (current?.descriptionItems ?? []).filter((d) => d.trim().length > 0);
      nextDescItems = existing.concat(validLines);
      if (nextDescItems.length === 0) nextDescItems = [""];
    } else {
      nextDescItems = validLines;
    }

    updateItem(itemIndex, {
      descriptionItems: nextDescItems,
      description: nextDescItems.join("\n"),
    });
  }

  function handleApplyExtract(itemIndex: number, payload: ExtractPayload) {
    const current = items[itemIndex]!;
    const nextSubItems = [...(current.subItems ?? [])];

    if (payload.techStack) {
      const techIdx = nextSubItems.findIndex((s) => s.label === "技术栈");
      if (techIdx >= 0) {
        nextSubItems[techIdx] = { ...nextSubItems[techIdx]!, value: payload.techStack };
      } else {
        nextSubItems.push({ id: genEntryId("sub"), label: "技术栈", value: payload.techStack });
      }
    }

    if (payload.brief) {
      const briefIdx = nextSubItems.findIndex((s) => s.label === "");
      if (briefIdx >= 0) {
        nextSubItems[briefIdx] = { ...nextSubItems[briefIdx]!, value: payload.brief };
      } else {
        nextSubItems.push({ id: genEntryId("sub"), label: "", value: payload.brief });
      }
    }

    const newDescItems = payload.achievements ?? [];
    let nextDescItems: string[];
    if (payload.mode === "replace") {
      nextDescItems = newDescItems.length > 0 ? newDescItems : (current.descriptionItems ?? [""]);
    } else {
      const existing = (current.descriptionItems ?? []).filter((d) => d.trim().length > 0);
      nextDescItems = existing.concat(newDescItems);
      if (nextDescItems.length === 0) nextDescItems = [""];
    }

    updateItem(itemIndex, {
      subItems: nextSubItems,
      descriptionItems: nextDescItems,
      description: nextDescItems.join("\n"),
    });
  }

  return (
    <div className="space-y-6">
      {items.length === 0 && (
        <p className="text-sm text-muted">
          暂无{config.itemTypeLabel}，点击下方按钮添加一个{itemName}。
        </p>
      )}

      {items.map((entry, itemIndex) => {
        const descList =
          entry.descriptionItems && entry.descriptionItems.length > 0
            ? entry.descriptionItems
            : entry.description
              ? parseTextToLines(entry.description)
              : [""];
        const descStyle: DescriptionListStyle = entry.descriptionStyle ?? "unordered";

        return (
          <div
            key={entry.id ?? itemIndex}
            draggable={armedIndex === itemIndex}
            onDragStart={(e) => {
              setDragIndex(itemIndex);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", `${config.moduleType}:${itemIndex}`);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setArmedIndex(null);
            }}
            onDragOver={(e) => {
              if (dragIndex === null || dragIndex === itemIndex) return;
              e.preventDefault();
              reorderItem(dragIndex, itemIndex);
              setDragIndex(itemIndex);
            }}
            onDrop={(e) => e.preventDefault()}
            data-edit-card-index={itemIndex}
            className={`rounded-2xl border border-line bg-card p-5 shadow-card-subtle transition-all ${
              dragIndex === itemIndex ? "opacity-40 scale-[0.99]" : "hover:border-line-strong"
            }`}
          >
            {/* 经历卡片头部排序与标号 */}
            <div className="mb-4 flex items-center justify-between border-b border-line pb-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  title={`拖动调整${config.itemTypeLabel}顺序`}
                  aria-label={`拖动调整第 ${itemIndex + 1} 个${config.itemTypeLabel}的顺序`}
                  className="cursor-grab text-muted transition-colors hover:text-primary active:cursor-grabbing p-1 -ml-1 rounded hover:bg-surface"
                  onMouseDown={() => setArmedIndex(itemIndex)}
                  onMouseUp={() => setArmedIndex(null)}
                >
                  <GripIcon />
                </button>
                <span className="font-mono text-xs font-semibold text-faint">
                  #{itemIndex + 1}
                </span>
                <button
                  type="button"
                  title={`上移${config.itemTypeLabel}`}
                  aria-label={`将第 ${itemIndex + 1} 个${config.itemTypeLabel}上移`}
                  disabled={itemIndex === 0}
                  onClick={() => moveItem(itemIndex, -1)}
                  className="rounded p-1 text-muted transition-colors hover:bg-surface hover:text-primary disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  title={`下移${config.itemTypeLabel}`}
                  aria-label={`将第 ${itemIndex + 1} 个${config.itemTypeLabel}下移`}
                  disabled={itemIndex === items.length - 1}
                  onClick={() => moveItem(itemIndex, 1)}
                  className="rounded p-1 text-muted transition-colors hover:bg-surface hover:text-primary disabled:opacity-30"
                >
                  ↓
                </button>
              </div>
              <span className="text-[11px] text-faint font-medium">卡片整体可拖拽重排</span>
            </div>

            {/* 核心基本字段 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <label className="block">
                <span className={labelCls}>{config.primaryField1.label}</span>
                <input
                  className={`${inputCls} mt-1`}
                  onFocus={() => onProofingFieldFocus?.(itemIndex, config.primaryField1.key)}
                  value={(entry[config.primaryField1.key] as string) ?? ""}
                  onChange={(e) =>
                    updateItem(itemIndex, {
                      [config.primaryField1.key]: e.target.value,
                    })
                  }
                  placeholder={config.primaryField1.placeholder}
                />
              </label>

              <label className="block">
                <span className={labelCls}>{config.primaryField2.label}</span>
                <input
                  className={`${inputCls} mt-1`}
                  onFocus={() => onProofingFieldFocus?.(itemIndex, config.primaryField2.key)}
                  value={(entry[config.primaryField2.key] as string) ?? ""}
                  onChange={(e) =>
                    updateItem(itemIndex, {
                      [config.primaryField2.key]: e.target.value,
                    })
                  }
                  placeholder={config.primaryField2.placeholder}
                />
              </label>

              <label className="block">
                <span className={labelCls}>开始时间</span>
                <input
                  className={`${inputCls} mt-1`}
                  onFocus={() => onProofingFieldFocus?.(itemIndex, "start")}
                  value={entry.start ?? ""}
                  onChange={(e) =>
                    updateItem(itemIndex, { start: e.target.value })
                  }
                  placeholder="例如：2023-03"
                />
              </label>

              <label className="block">
                <span className={labelCls}>结束时间</span>
                <input
                  className={`${inputCls} mt-1`}
                  onFocus={() => onProofingFieldFocus?.(itemIndex, "end")}
                  value={entry.end ?? ""}
                  onChange={(e) =>
                    updateItem(itemIndex, { end: e.target.value })
                  }
                  placeholder="例如：2024-06 或 至今"
                />
              </label>
            </div>

            {/* 自定义副项 */}
            <ProjectSubItems
              item={entry}
              itemIndex={itemIndex}
              onChange={(patch) => updateItem(itemIndex, patch)}
              onAnnouncement={setAnnouncement}
              presetLabels={config.presetSubLabels}
              helpText={config.subItemHelpText}
              defaultSubLabel={config.defaultSubLabel}
            />

            {/* 描述与成果管理区 */}
            <div className="mt-5 rounded-xl border border-line/80 bg-surface/40 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-ink">
                    {config.descriptionSectionTitle}
                  </span>
                  <span className="text-[11px] text-muted">支持分行拖拽排版</span>
                </div>

                {/* 有序 / 无序列表风格切换分段器 */}
                <div className="inline-flex rounded-lg border border-line bg-card p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() =>
                      updateItem(itemIndex, {
                        descriptionStyle: "unordered",
                      })
                    }
                    className={`rounded-md px-2.5 py-1 font-medium transition-all ${
                      descStyle === "unordered"
                        ? "bg-primary text-on-primary shadow-2xs font-semibold"
                        : "text-muted hover:text-ink"
                    }`}
                  >
                    • 无序列表
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      updateItem(itemIndex, {
                        descriptionStyle: "ordered",
                      })
                    }
                    className={`rounded-md px-2.5 py-1 font-medium transition-all ${
                      descStyle === "ordered"
                        ? "bg-primary text-on-primary shadow-2xs font-semibold"
                        : "text-muted hover:text-ink"
                    }`}
                  >
                    1. 有序列表
                  </button>
                </div>
              </div>

              <div className="space-y-2.5">
                {descList.map((desc, descIndex) => {
                  const isDraggingThisDesc =
                    dragDesc?.itemIdx === itemIndex && dragDesc?.descIdx === descIndex;
                  const isArmedThisDesc =
                    armedDesc?.itemIdx === itemIndex && armedDesc?.descIdx === descIndex;

                  return (
                    <div
                      key={descIndex}
                      draggable={isArmedThisDesc}
                      onDragStart={(e) => {
                        e.stopPropagation();
                        setDragDesc({ itemIdx: itemIndex, descIdx: descIndex });
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", `desc:${itemIndex}:${descIndex}`);
                      }}
                      onDragEnd={() => {
                        setDragDesc(null);
                        setArmedDesc(null);
                      }}
                      onDragOver={(e) => {
                        if (!dragDesc || dragDesc.itemIdx !== itemIndex) return;
                        if (dragDesc.descIdx === descIndex) return;
                        e.preventDefault();
                        e.stopPropagation();
                        reorderDescriptionItem(itemIndex, dragDesc.descIdx, descIndex);
                        setDragDesc({ itemIdx: itemIndex, descIdx: descIndex });
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      className={`flex items-start gap-2 rounded-lg border border-line bg-card p-2.5 shadow-2xs transition-all ${
                        isDraggingThisDesc ? "opacity-30 scale-[0.99]" : "hover:border-line-strong"
                      }`}
                    >
                      <div className="flex flex-col items-center gap-0.5 pt-1 shrink-0">
                        <button
                          type="button"
                          title="拖拽调序"
                          className="cursor-grab text-muted transition-colors hover:text-primary active:cursor-grabbing p-0.5 rounded hover:bg-surface"
                          onMouseDown={() =>
                            setArmedDesc({ itemIdx: itemIndex, descIdx: descIndex })
                          }
                          onMouseUp={() => setArmedDesc(null)}
                        >
                          <GripIcon />
                        </button>
                        <span className="font-mono text-xs font-bold text-primary">
                          {descStyle === "ordered" ? `${descIndex + 1}.` : "•"}
                        </span>
                      </div>

                      <div className="flex flex-col gap-1 shrink-0 pt-0.5">
                        <button
                          type="button"
                          title="上移此行"
                          disabled={descIndex === 0}
                          onClick={() => moveDescriptionItem(itemIndex, descIndex, -1)}
                          className="rounded p-0.5 text-xs text-muted hover:bg-surface hover:text-primary disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          title="下移此行"
                          disabled={descIndex === descList.length - 1}
                          onClick={() => moveDescriptionItem(itemIndex, descIndex, 1)}
                          className="rounded p-0.5 text-xs text-muted hover:bg-surface hover:text-primary disabled:opacity-30"
                        >
                          ↓
                        </button>
                      </div>

                      <div className="flex-1 min-w-0">
                        <RichTextEditor
                          value={desc}
                          onChange={(val) =>
                            updateDescriptionItem(itemIndex, descIndex, val)
                          }
                          placeholder={config.descItemPlaceholder}
                          minHeightClass="min-h-[72px]"
                          ariaLabel={`${config.itemTypeLabel}描述第 ${descIndex + 1} 行`}
                        />
                      </div>

                      <button
                        type="button"
                        onClick={() => removeDescriptionItem(itemIndex, descIndex)}
                        title="删除该行"
                        className="text-xs text-muted hover:text-danger p-1 rounded transition-colors shrink-0 mt-0.5"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="mt-2.5 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => addDescriptionItem(itemIndex)}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  + 添加一行描述
                </button>
                <span className="text-[11px] text-faint">每行支持独立上下拖动调序</span>
              </div>
            </div>

            {/* 条目底部操作：AI 润色、知识库摘取、删除本条 */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3.5">
              <div className="flex flex-wrap items-center gap-2">
                {resumeId && config.moduleType && config.getPolishContext && (
                  <>
                    <StarPolishDialog
                      resumeId={resumeId}
                      moduleType={config.moduleType}
                      context={config.getPolishContext(entry)}
                      currentText={entry.description || descList.join("\n")}
                      currentItems={descList}
                      descriptionStyle={descStyle}
                      onApply={(newText, newItems, mode) =>
                        handleApplyBulkDescription(itemIndex, newText, newItems, mode)
                      }
                    />
                    <ExtractDialog
                      current={entry.description || descList.join("\n")}
                      currentName={(entry[config.primaryField1.key] as string) || ""}
                      currentSubItems={entry.subItems}
                      currentDescriptionItems={descList}
                      onApply={(payload) => handleApplyExtract(itemIndex, payload)}
                    />
                  </>
                )}
              </div>

              <button
                type="button"
                className="text-xs font-medium text-danger hover:underline transition-colors"
                onClick={() => removeItem(itemIndex)}
              >
                删除本条{config.itemTypeLabel}
              </button>
            </div>
          </div>
        );
      })}

      <button type="button" className={btnGhost} onClick={addItem}>
        + 添加{itemName}
      </button>

      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>

      <SaveBar status={status} />
    </div>
  );
}

// 导出 ProjectsEditor 专用包装组件
export interface ProjectsEditorProps {
  itemName: string;
  items: ProjectItem[];
  onChange: (items: ProjectItem[], opts?: ChangeOptions) => void;
  status: Status;
  resumeId?: string;
  onProofingFieldFocus?: (index: number, key: string) => void;
}

const PROJECTS_CONFIG: ExperienceEditorConfig<ProjectItem> = {
  itemTypeLabel: "项目经历",
  primaryField1: {
    key: "name",
    label: "项目名称",
    placeholder: "例如：实时数据同步平台 / 企业级微前端方案",
  },
  primaryField2: {
    key: "role",
    label: "担任角色",
    placeholder: "例如：技术负责人 / 核心开发",
  },
  presetSubLabels: ["技术栈", "项目链接", "团队规模", "核心贡献"],
  subItemHelpText: "如技术栈、链接、成果指标",
  defaultSubLabel: "技术栈",
  descriptionSectionTitle: "项目描述与成果（多行独立排序）",
  descItemPlaceholder: "工作要点与成果（建议包含技术动作 + 业务影响/量化指标）...",
  moduleType: "projects",
  getPolishContext: (item) => ({ name: item.name, role: item.role }),
  createBlankItem: () => ({
    id: genEntryId("it"),
    name: "",
    role: "",
    start: "",
    end: "",
    description: "",
    subItems: [{ id: genEntryId("sub"), label: "技术栈", value: "" }],
    descriptionItems: [""],
    descriptionStyle: "unordered",
  }),
};

export function ProjectsEditor(props: ProjectsEditorProps) {
  return <GenericExperienceEditor<ProjectItem> {...props} config={PROJECTS_CONFIG} />;
}

// 导出 WorkEditor 专用包装组件
export interface WorkEditorProps {
  itemName: string;
  items: WorkItem[];
  onChange: (items: WorkItem[], opts?: ChangeOptions) => void;
  status: Status;
  resumeId?: string;
  onProofingFieldFocus?: (index: number, key: string) => void;
}

const WORK_CONFIG: ExperienceEditorConfig<WorkItem> = {
  itemTypeLabel: "工作经历",
  primaryField1: {
    key: "company",
    label: "公司名称",
    placeholder: "例如：阿里巴巴 / 腾讯科技 / 字节跳动",
  },
  primaryField2: {
    key: "title",
    label: "职位头衔",
    placeholder: "例如：高级前端工程师 / 全栈技术专家",
  },
  presetSubLabels: ["所属部门", "技术栈", "团队规模", "核心贡献"],
  subItemHelpText: "如所属部门、技术栈、团队规模",
  defaultSubLabel: "所属部门",
  descriptionSectionTitle: "工作内容与成果（多行独立排序）",
  descItemPlaceholder: "工作内容与核心产出（建议按动作 + 结果量化展开）...",
  moduleType: "work",
  getPolishContext: (item) => ({ company: item.company, title: item.title }),
  createBlankItem: () => ({
    id: genEntryId("it"),
    company: "",
    title: "",
    start: "",
    end: "",
    description: "",
    subItems: [{ id: genEntryId("sub"), label: "所属部门", value: "" }],
    descriptionItems: [""],
    descriptionStyle: "unordered",
  }),
};

export function WorkEditor(props: WorkEditorProps) {
  return <GenericExperienceEditor<WorkItem> {...props} config={WORK_CONFIG} />;
}

// 导出 CustomEditor 自定义模块通用条目包装组件
export interface CustomEditorProps {
  itemName: string;
  items: CustomItem[];
  onChange: (items: CustomItem[], opts?: ChangeOptions) => void;
  status: Status;
  resumeId?: string;
}

const CUSTOM_CONFIG: ExperienceEditorConfig<CustomItem> = {
  itemTypeLabel: "条目",
  primaryField1: {
    key: "title",
    label: "主要名称",
    placeholder: "例如：证书/奖项/作品/专利/活动名称",
  },
  primaryField2: {
    key: "subTitle",
    label: "补充说明/机构/身份",
    placeholder: "例如：颁发单位 / 级别 / 角色 / 第一作者",
  },
  presetSubLabels: ["类别", "编号", "级别", "链接"],
  subItemHelpText: "自由添加副项键值标签（如编号、成绩、排名等），可自由拖动排序",
  defaultSubLabel: "类别",
  descriptionSectionTitle: "详细描述与要点（多行独立排序）",
  descItemPlaceholder: "详细说明（支持富文本、加粗、颜色、链接）...",
  createBlankItem: () => ({
    id: genEntryId("it"),
    title: "",
    subTitle: "",
    start: "",
    end: "",
    description: "",
    subItems: [],
    descriptionItems: [""],
    descriptionStyle: "unordered",
  }),
};

export function CustomEditor(props: CustomEditorProps) {
  return <GenericExperienceEditor<CustomItem> {...props} config={CUSTOM_CONFIG} />;
}
