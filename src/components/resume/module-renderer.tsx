"use client";

import type { CustomItem, ModuleData, ProjectItem, WorkItem } from "@/lib/modules";
import {
  BasicEditor,
  ListEditor,
  SkillsEditor,
  SummaryEditor,
  type ChangeOptions,
  type FieldCfg,
  type ItemDraft,
  type Status,
} from "@/components/resume/module-editors";
import { CustomEditor, ProjectsEditor, WorkEditor } from "@/components/resume/projects-editor";
import { StarPolishDialog } from "@/components/resume/star-polish-dialog";

const LIST_FIELDS: Record<"education", FieldCfg[]> = {
  education: [
    { key: "school", label: "学校" },
    { key: "degree", label: "学位", placeholder: "本科 / 硕士 / 博士" },
    { key: "field", label: "专业" },
    { key: "start", label: "开始", placeholder: "2020-09" },
    { key: "end", label: "结束", placeholder: "2024-06" },
    { key: "description", label: "备注（成绩、荣誉、课程等）", textarea: true, richText: true, wide: true },
  ],
};

interface ResumeModuleRendererProps {
  module: ModuleData;
  resumeId: string;
  status: Status;
  onDraftChange: (key: string, content: unknown, opts?: ChangeOptions) => void;
}

export function ResumeModuleRenderer({
  module: m,
  resumeId,
  status,
  onDraftChange,
}: ResumeModuleRendererProps) {
  const content = m.content;
  switch (m.type) {
    case "basic":
      return (
        <BasicEditor
          content={content as Record<string, unknown>}
          onChange={(c, opts) => onDraftChange(m.key, c, opts)}
          status={status}
        />
      );
    case "education": {
      const items = (Array.isArray(content) ? content : []) as ItemDraft[];
      return (
        <ListEditor
          itemName={m.label}
          items={items}
          onChange={(next) => onDraftChange(m.key, next)}
          status={status}
          fields={LIST_FIELDS.education}
        />
      );
    }
    case "work": {
      const items = (Array.isArray(content) ? content : []) as WorkItem[];
      return (
        <WorkEditor
          itemName={m.label}
          items={items}
          onChange={(next) => onDraftChange(m.key, next)}
          status={status}
          resumeId={resumeId}
        />
      );
    }
    case "projects": {
      const items = (Array.isArray(content) ? content : []) as ProjectItem[];
      return (
        <ProjectsEditor
          itemName={m.label}
          items={items}
          onChange={(next) => onDraftChange(m.key, next)}
          status={status}
          resumeId={resumeId}
        />
      );
    }
    case "skills":
      return (
        <SkillsEditor
          content={content as { items: string[] }}
          onChange={(c) => onDraftChange(m.key, c)}
          status={status}
        />
      );
    case "summary":
      return (
        <SummaryEditor
          content={content as { text: string; descriptionItems?: string[]; descriptionStyle?: import("@/lib/modules").DescriptionListStyle }}
          onChange={(c) => onDraftChange(m.key, c)}
          status={status}
          renderActions={({ text, items, descriptionStyle, updateText }) => (
            <StarPolishDialog
              resumeId={resumeId}
              moduleType="summary"
              currentText={text}
              currentItems={items}
              descriptionStyle={descriptionStyle}
              onApply={updateText}
            />
          )}
        />
      );
    case "custom": {
      const items = (Array.isArray(content) ? content : []) as CustomItem[];
      return (
        <CustomEditor
          itemName={m.label}
          items={items}
          onChange={(next) => onDraftChange(m.key, next)}
          status={status}
          resumeId={resumeId}
        />
      );
    }
    default:
      return null;
  }
}
