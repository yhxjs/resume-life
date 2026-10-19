import { SectionTitle } from "@/components/common/ui-bits";
import { Combobox } from "@/components/common/combobox";
import { badgePrimary, btnGhost, inputCls, labelCls } from "@/lib/ui";
import { API_FORMAT_OPTIONS, OCR_MODE_OPTIONS, type OcrMode } from "@/lib/settings-constants";
import type { Settings, SettingsFieldSetter } from "./settings-form-types";

type ModelFieldKey = "model_parse" | "model_summary" | "model_question" | "model_evaluate";

const MODEL_FIELDS: { key: ModelFieldKey; label: string; hint: string }[] = [
  { key: "model_parse", label: "解析模型", hint: "简历 / 材料的结构化解析，建议用便宜快速的模型" },
  { key: "model_summary", label: "总结模型", hint: "项目材料总结，建议用能力较强的模型" },
  { key: "model_question", label: "出题模型", hint: "面试题与模拟面试出题" },
  { key: "model_evaluate", label: "评分模型", hint: "作答评分、动态追问与总结报告，建议用能力较强的模型" },
];

export function ModelSettingsSection({
  settings,
  models,
  fetchingModels,
  onChange,
  onFetchModels,
}: {
  settings: Settings;
  models: string[];
  fetchingModels: boolean;
  onChange: SettingsFieldSetter;
  onFetchModels: () => void;
}) {
  const currentFormatOption =
    API_FORMAT_OPTIONS.find((opt) => opt.key === settings.api_format) ||
    API_FORMAT_OPTIONS[0]!;

  /** 一键把其余任务模型统一成解析模型 */
  function applyParseToAll() {
    onChange("model_summary", settings.model_parse);
    onChange("model_question", settings.model_parse);
    onChange("model_evaluate", settings.model_parse);
  }

  return (
    <>
      <div className="rounded-2xl border border-line bg-card p-6 shadow-card-subtle space-y-5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-serif font-bold text-ink block">AI 服务接入凭证</span>
          <span className={badgePrimary}>协议适配器</span>
        </div>

        {/* 上游格式（API 协议）选择 */}
        <div className="space-y-2">
          <label className={labelCls}>上游协议格式（API 规范）</label>
          <div className="grid gap-2.5 sm:grid-cols-3">
            {API_FORMAT_OPTIONS.map((opt) => {
              const active = settings.api_format === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => onChange("api_format", opt.key)}
                  className={`relative rounded-xl border p-3 text-left transition-all flex flex-col justify-between ${
                    active
                      ? "border-primary bg-primary-soft/45 ring-2 ring-primary/20 shadow-sm"
                      : "border-line bg-surface/50 text-muted hover:border-line/80 hover:bg-surface"
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="text-[10px] font-medium text-primary px-1.5 py-0.5 rounded bg-primary/10">
                        {opt.badge}
                      </span>
                      {active && (
                        <span className="text-primary font-bold text-xs">✓</span>
                      )}
                    </div>
                    <div className="text-xs font-bold text-ink leading-tight">
                      {opt.label}
                    </div>
                    <div className="font-mono text-[10px] text-faint mt-1">
                      {opt.endpointPath}
                    </div>
                  </div>
                  <div className="mt-2 text-[11px] text-faint leading-relaxed line-clamp-2">
                    {opt.desc}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Base URL */}
        <label className="block">
          <div className="flex items-baseline justify-between">
            <span className={labelCls}>Base URL（服务接入端点）</span>
            <span className="text-[11px] text-faint">
              自动附加 <code className="font-mono text-ink">{currentFormatOption.endpointPath}</code>
            </span>
          </div>
          <input
            className={`${inputCls} mt-1 font-mono text-xs`}
            value={settings.base_url}
            onChange={(e) => onChange("base_url", e.target.value)}
            placeholder={currentFormatOption.defaultBaseUrl}
          />
          <span className="mt-1 block text-[11px] text-faint leading-relaxed">
            通常填写基础地址（如 <span className="font-mono">{currentFormatOption.defaultBaseUrl}</span>），系统将自动拼接对应端点；若 URL 中已包含对应路径，系统会自动去重规范化。
          </span>
        </label>

        {/* API Key */}
        <label className="block">
          <span className={labelCls}>API Key（保存后脱敏显示，重填可覆盖更新）</span>
          <input
            className={`${inputCls} mt-1 font-mono text-xs`}
            type="password"
            value={settings.api_key}
            onChange={(e) => onChange("api_key", e.target.value)}
            placeholder="sk-…"
          />
        </label>
      </div>

      {/* 任务级模型分工配置 */}
      <div className="rounded-2xl border border-line bg-card p-6 shadow-card-subtle space-y-4">
        <SectionTitle
          right={
            <div className="flex items-center gap-2">
              <button
                className={btnGhost}
                onClick={applyParseToAll}
                disabled={!settings.model_parse}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4 shrink-0"
                  aria-hidden
                >
                  <path d="m4.5 19.5 8.5-8.5" />
                  <path d="M17.5 3.5v4" />
                  <path d="M15.5 5.5h4" />
                  <path d="M7 4v3" />
                  <path d="M5.5 5.5h3" />
                </svg>
                一键设置
              </button>
              <button className={btnGhost} onClick={onFetchModels} disabled={fetchingModels}>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4 shrink-0"
                  aria-hidden
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="m7 10 5 5 5-5" />
                  <path d="M12 15V3" />
                </svg>
                {fetchingModels ? "获取中…" : "获取模型列表"}
              </button>
            </div>
          }
        >
          任务级模型分工配置
        </SectionTitle>
        <p className="text-xs text-muted leading-relaxed">
          支持为不同任务指派不同模型。点击输入框右侧的下拉按钮查看全部模型，重新输入后自动匹配；留空时自动回退至第一个配置的模型。
        </p>
        <div className="grid gap-4 sm:grid-cols-2 pt-2">
          {MODEL_FIELDS.map((f) => (
            <label key={f.key} className="block">
              <span className={labelCls}>{f.label}</span>
              <div className="mt-1">
                <Combobox
                  value={settings[f.key]}
                  onChange={(v) => onChange(f.key, v)}
                  options={models}
                  placeholder={`模型名，如 ${currentFormatOption.sampleModel}`}
                />
              </div>
              <span className="mt-1 block text-[11px] leading-relaxed text-faint">{f.hint}</span>
            </label>
          ))}
        </div>

        {/* 最大输出 Token 限制 */}
        <div className="border-t border-line/60 pt-4">
          <label className="block max-w-sm">
            <span className={labelCls}>最大输出 Token 限制</span>
            <input
              type="number"
              aria-label="最大输出 Token 限制"
              className={`${inputCls} mt-1 font-mono text-xs`}
              value={settings.max_output_tokens}
              onChange={(e) => onChange("max_output_tokens", e.target.value)}
              placeholder="8192"
              min={256}
              max={128000}
              step={256}
            />
            <span className="mt-1 block text-[11px] leading-relaxed text-faint">
              单次任务调用的最大输出 token 上限，默认为 8192。若长文生成、深度润色或带推理过程的模型触发截断报错，可在此调大。
            </span>
          </label>
        </div>
      </div>
    </>
  );
}

export function OcrSettingsSection({ value, onChange }: {
  value: OcrMode;
  onChange: (value: OcrMode) => void;
}) {
  return (
    <div className="rounded-2xl border border-line bg-card p-6 shadow-card-subtle space-y-4">
      <div className="flex items-center justify-between">
        <SectionTitle>扫描版 PDF OCR 识别</SectionTitle>
        <span className="text-[10px] text-faint">最多处理前 5 页</span>
      </div>
      <p className="text-xs text-muted leading-relaxed">
        当上传的 PDF 为图片扫描件或无可选中文本的打印件时，自动触发 OCR 提取文本。
      </p>
      <div className="grid gap-2.5 sm:grid-cols-2 pt-1">
        {OCR_MODE_OPTIONS.map((opt) => {
          const active = (value || "auto") === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => onChange(opt.key)}
              className={`relative rounded-xl border p-3.5 text-left transition-all flex flex-col justify-between ${
                active
                  ? "border-primary bg-primary-soft/45 ring-2 ring-primary/20 shadow-sm"
                  : "border-line bg-surface/50 text-muted hover:border-line/80 hover:bg-surface"
              }`}
            >
              <div>
                <div className="flex items-center justify-between gap-1 mb-1">
                  <span className="text-[10px] font-medium text-primary px-1.5 py-0.5 rounded bg-primary/10">
                    {opt.badge}
                  </span>
                  {active && (
                    <span className="text-primary font-bold text-xs">✓</span>
                  )}
                </div>
                <div className="text-xs font-bold text-ink leading-tight">
                  {opt.label}
                </div>
              </div>
              <div className="mt-2 text-[11px] text-faint leading-relaxed">
                {opt.desc}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
