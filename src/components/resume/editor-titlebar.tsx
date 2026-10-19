"use client";

function UndoIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13" />
    </svg>
  );
}

interface ResumeEditorTitlebarProps {
  title: string;
  onTitleChange: (newTitle: string) => void;
  onSaveTitle: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

export function ResumeEditorTitlebar({
  title,
  onTitleChange,
  onSaveTitle,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: ResumeEditorTitlebarProps) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2 sm:gap-3">
      <input
        data-resume-title-input
        aria-label="简历标题"
        className="-ml-2 sm:-ml-3 min-w-0 flex-1 rounded-lg border border-transparent px-2.5 sm:px-3 py-1.5 font-serif text-lg sm:text-[22px] font-bold outline-none transition-colors hover:border-line focus:border-primary focus:ring-4 focus:ring-primary/10"
        value={title}
        placeholder="未命名简历"
        onChange={(e) => onTitleChange(e.target.value)}
        onBlur={onSaveTitle}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), onSaveTitle())}
      />
      <div className="flex shrink-0 items-center gap-1.5" role="toolbar" aria-label="编辑历史">
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          title="撤销 (Ctrl+Z / ⌘Z)"
          className="inline-flex h-9 w-9 min-h-[36px] min-w-[36px] items-center justify-center rounded-lg border border-line bg-card text-ink transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-30 cursor-pointer"
          aria-label="撤销"
        >
          <UndoIcon />
        </button>
        <button
          type="button"
          onClick={onRedo}
          disabled={!canRedo}
          title="重做 (Ctrl+Y / ⌘⇧Z)"
          className="inline-flex h-9 w-9 min-h-[36px] min-w-[36px] items-center justify-center rounded-lg border border-line bg-card text-ink transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-30 cursor-pointer"
          aria-label="重做"
        >
          <RedoIcon />
        </button>
      </div>
    </div>
  );
}
