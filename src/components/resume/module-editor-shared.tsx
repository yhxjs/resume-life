"use client";

import { inputCls, textareaCls, labelCls, textErr, textInfo, textOk } from "@/lib/ui";
import { RichTextEditor } from "@/components/resume/rich-text-editor";

export type Status = "idle" | "editing" | "saving" | "saved" | "err";
export type ChangeOptions = { immediate?: boolean };

const STATUS_TEXT: Record<Status, string> = {
  idle: "",
  editing: "编辑中…",
  saving: "保存中…",
  saved: "已保存",
  err: "保存失败，将自动重试",
};

/** 自动保存状态行：idle 不显示，saving/saved/err 常规反馈 */
export function SaveBar({ status }: { status: Status }) {
  if (status === "idle") return null;
  return (
    <p
      className={`mt-4 text-sm ${
        status === "err" ? textErr : status === "saved" ? textOk : textInfo
      }`}
      role="status"
    >
      {STATUS_TEXT[status]}
    </p>
  );
}

export function Field({
  fieldKey,
  label,
  value,
  onChange,
  onFocus,
  textarea,
  richText,
  placeholder,
  wide,
}: {
  fieldKey?: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onFocus?: () => void;
  textarea?: boolean;
  richText?: boolean;
  placeholder?: string;
  wide?: boolean;
}) {
  return (
    <div data-edit-field={fieldKey} className={`block ${wide ? "sm:col-span-2" : ""}`}>
      <span className={labelCls}>{label}</span>
      {richText ? (
        <div className="mt-1">
          <RichTextEditor
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            ariaLabel={label}
          />
        </div>
      ) : textarea ? (
        <textarea
          aria-label={label}
          onFocus={onFocus}
          className={`${textareaCls} mt-1`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      ) : (
        <input
          aria-label={label}
          onFocus={onFocus}
          className={`${inputCls} mt-1`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      )}
    </div>
  );
}

export type ItemDraft = Record<string, string>;
export type FieldCfg = {
  key: string;
  label: string;
  textarea?: boolean;
  richText?: boolean;
  wide?: boolean;
  placeholder?: string;
};

export type ItemActionsCtx = {
  item: ItemDraft;
  /** 就地修改当前条目的部分字段（如摘取写入 description） */
  updateItem: (patch: Partial<ItemDraft>) => void;
};

