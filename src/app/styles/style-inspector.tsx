import type { TemplateLibraryController } from "@/hooks/use-template-library";
import { InlineError } from "@/components/common/inline-error";
import { BUILTIN_STYLES, RESUME_TEMPLATES } from "@/lib/templates";
import { btnGhost, btnPrimary, cardCls, inputCls, textareaShortCls } from "@/lib/ui";
import { StyleFieldGroups } from "./style-field-groups";
import { LoadingOverlay } from "@/components/common/loading-overlay";

type StyleInspectorProps = {
  controller: TemplateLibraryController;
  className: string;
};

export function StyleInspector({ controller, className }: StyleInspectorProps) {
  const {
    customs, draft, draftName, setDraftName, editingId,
    aiPrompt, setAiPrompt, aiLoading, saving, aiNote, loadError, reloadCustoms,
    commit, set, loadStyle, aiGenerate, saveNew, saveChanges, removeCustom,
  } = controller;

  return (
    <div className={`space-y-5 ${className}`}>
      <section className={`${cardCls} p-4`}>
        <h2 className="text-sm font-bold">从模板开始</h2>
        <p className="mt-1 text-xs text-faint">点击任意模板载入下方检查器，在此基础上调整。</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {RESUME_TEMPLATES.map((template) => (
            <button
              key={template.key}
              onClick={() => loadStyle({
                id: null,
                name: template.label,
                style: BUILTIN_STYLES[template.key],
              })}
              title={template.desc}
              className="rounded-full border border-line px-3 py-1 text-xs font-medium text-muted transition-colors hover:bg-surface hover:text-ink"
            >
              {template.label}
            </button>
          ))}
        </div>
        {customs.length > 0 && (
          <div className="mt-3 border-t border-line pt-2">
            <p className="text-xs font-medium text-muted">我的模板</p>
            <div className="mt-1">
              {customs.map((template) => (
                <div
                  key={template.id}
                  className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface"
                >
                  <button
                    className="truncate text-left text-sm text-ink"
                    onClick={() => loadStyle(template)}
                  >
                    {template.name}
                    {template.corrupted && <span className="ml-1.5 text-xs text-danger">· 已损坏，点击修复</span>}
                    {editingId === template.id && (
                      <span className="ml-1.5 text-xs text-primary">· 编辑中</span>
                    )}
                  </button>
                  <button
                    className="shrink-0 text-xs text-danger hover:underline"
                    onClick={() => removeCustom(template)}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {loadError && (
          <div className="mt-3 border-t border-line pt-2">
            <InlineError message={`我的模板加载失败：${loadError}`} onRetry={reloadCustoms} />
          </div>
        )}
      </section>

      <section className={`relative ${cardCls} p-4`}>
        <LoadingOverlay
          show={aiLoading}
          message="AI 正在设计专属排版风格…"
          description="正在根据描述推演字阶、行高、强调色与网格参数，请稍候…"
        />
        <h2 className="text-sm font-bold">AI 生成样式</h2>
        <textarea
          className={`${textareaShortCls} mt-3`}
          maxLength={500}
          placeholder="例：稳重的金融行业风格，深蓝强调色，宋体，小节居中带下划线，技能一行排开"
          value={aiPrompt}
          onChange={(event) => setAiPrompt(event.target.value)}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-xs text-faint">{aiNote || "生成结果只应用到检查器，确认满意后另存。"}</span>
          <button className={btnPrimary} disabled={!aiPrompt.trim() || aiLoading || saving} onClick={aiGenerate}>
            {aiLoading ? "生成中…" : "AI 生成"}
          </button>
        </div>
      </section>

      <StyleFieldGroups style={draft} onSet={set} onCommit={commit} />

      <section className={`${cardCls} p-4`}>
        <h2 className="text-sm font-bold">保存</h2>
        <label className="mt-3 block">
          <span className="text-xs font-medium text-muted">模板名称</span>
          <input
            className={`${inputCls} mt-1`}
            value={draftName}
            maxLength={30}
            placeholder="例：稳重金融风"
            onChange={(event) => setDraftName(event.target.value)}
          />
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          {editingId !== null && (
            <button className={btnPrimary} onClick={saveChanges} disabled={saving || aiLoading}>
              保存修改
            </button>
          )}
          <button className={editingId !== null ? btnGhost : btnPrimary} onClick={saveNew} disabled={saving || aiLoading}>
            另存为新模板
          </button>
        </div>
        {saving && <p role="status" className="mt-2 text-xs text-faint">正在保存模板…</p>}
        <p className="mt-2 text-xs text-faint">
          {editingId !== null
            ? "「保存修改」会更新这个模板，使用它的简历会同步更新。"
            : "保存后会出现在简历编辑页与打印页的模板下拉中。"}
        </p>
      </section>
    </div>
  );
}
