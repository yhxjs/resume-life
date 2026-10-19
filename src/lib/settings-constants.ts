export type ApiFormat = "openai_chat" | "anthropic_messages" | "openai_responses";

export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** 只接受完整的正整数文本或安全正整数，拒绝 parseInt 的数字前缀兼容行为。 */
export function parseMaxOutputTokens(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^[1-9]\d*$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolveMaxOutputTokens(value: unknown): number {
  return parseMaxOutputTokens(value) ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

export const API_FORMAT_OPTIONS: {
  key: ApiFormat;
  label: string;
  badge: string;
  desc: string;
  defaultBaseUrl: string;
  sampleModel: string;
  endpointPath: string;
}[] = [
  {
    key: "openai_chat",
    label: "OpenAI Chat Completions",
    badge: "默认兼容",
    desc: "标准 /chat/completions 规范，适用于 DeepSeek、OpenAI、OneAPI、NewAPI、Ollama 等几乎所有兼容网关",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    sampleModel: "deepseek-chat",
    endpointPath: "/chat/completions",
  },
  {
    key: "anthropic_messages",
    label: "Anthropic Messages (原生)",
    badge: "原生 Claude",
    desc: "原生 /messages 规范，支持独立 system prompt 与原生流式，适用于 Claude 官方及原生代理",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    sampleModel: "claude-3-5-sonnet-20241022",
    endpointPath: "/messages",
  },
  {
    key: "openai_responses",
    label: "OpenAI Responses API",
    badge: "新版规范",
    desc: "OpenAI /responses 规范，使用 input 与 max_output_tokens 结构，适用于支持新版 Responses API 的网关",
    defaultBaseUrl: "https://api.openai.com/v1",
    sampleModel: "gpt-4o",
    endpointPath: "/responses",
  },
];

export const VALID_API_FORMATS = new Set<ApiFormat>([
  "openai_chat",
  "anthropic_messages",
  "openai_responses",
]);

export type OcrMode = "auto" | "vision" | "local" | "off";

export const OCR_MODE_OPTIONS: {
  key: OcrMode;
  label: string;
  badge: string;
  desc: string;
}[] = [
  {
    key: "auto",
    label: "智能双轨（推荐）",
    badge: "自动回退",
    desc: "扫描件优先尝试视觉大模型识别，若不可用或失败则自动无缝降级为本地离线 OCR",
  },
  {
    key: "vision",
    label: "多模态视觉模型",
    badge: "大模型",
    desc: "仅使用视觉模型（如 GPT-4o、Claude 3.5、Qwen-VL 等）对扫描件进行高精度多模态识别",
  },
  {
    key: "local",
    label: "纯本地离线 OCR",
    badge: "隐私离线",
    desc: "完全在本机离线运行（基于 Tesseract.js），图片不上云，保护简历隐私",
  },
  {
    key: "off",
    label: "关闭 OCR 识别",
    badge: "仅文字版",
    desc: "仅允许可选中文本的文字版 PDF，遇到图片扫描件直接提示用户",
  },
];

export const VALID_OCR_MODES = new Set<OcrMode>([
  "auto",
  "vision",
  "local",
  "off",
]);

