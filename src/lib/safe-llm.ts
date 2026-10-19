import { checkModelInput, MAX_MODEL_IMAGES, ModelInputBudgetError } from "./llm-input-budget";
import {
  chat,
  chatStream,
  type ChatMessage,
  type ChatStreamOptions,
  type LlmTask,
} from "./llm";
import {
  buildCurrentDateRule,
  formatCurrentDate,
  UNTRUSTED_DATA_SYSTEM_RULES,
  wrapUntrustedData,
} from "./prompt-safety";
import type { LlmSource } from "./llm-source";
import { assertDataGeneration } from "./data-generation";
import { currentRequestId } from "./server-errors";

export * from "./llm-source";
export { buildCurrentDateRule, formatCurrentDate, UNTRUSTED_DATA_SYSTEM_RULES };

export type PromptPart =
  | { trust: "trusted"; text: string }
  | { trust: "untrusted"; tag: string; text: string };

export type SafeMessage = {
  role: "user" | "assistant";
  parts: readonly PromptPart[];
};

/** 来源必填：类型系统强制每个调用点声明自己是哪里产生的 */
export type ChatOptions = Omit<ChatStreamOptions, "source"> & { source: LlmSource };

function withUntrustedDataRules(system: string, now: Date = new Date()): string {
  const dateRule = buildCurrentDateRule(now);
  const systemWithoutDuplicateRules = system
    .replaceAll(UNTRUSTED_DATA_SYSTEM_RULES, "")
    .replace(/当前日期：\d{4}-\d{2}-\d{2}[^\n]*\n?/g, "")
    .trimEnd();
  const globalRules = `${dateRule}\n${UNTRUSTED_DATA_SYSTEM_RULES}`;
  return systemWithoutDuplicateRules
    ? `${systemWithoutDuplicateRules}\n${globalRules}`
    : globalRules;
}

function assembleMessages(system: string, messages: readonly SafeMessage[]): ChatMessage[] {
  const assembled: ChatMessage[] = [
    { role: "system", content: withUntrustedDataRules(system) },
    ...messages.map((message) => {
      if (message.role !== "user" && message.role !== "assistant") {
        throw new Error("安全模型消息角色无效");
      }
      return {
        role: message.role,
        content: message.parts
          .map((part) =>
            part.trust === "trusted" ? part.text : wrapUntrustedData(part.tag, part.text)
          )
          .join(""),
      };
    }),
  ];

  return checkModelInput(assembled);
}

export function checkSafeModelInput(
  system: string,
  messages: readonly SafeMessage[],
): ChatMessage[] {
  return assembleMessages(system, messages);
}

export async function safeChat(
  task: LlmTask,
  source: LlmSource,
  system: string,
  messages: readonly SafeMessage[],
  opts?: Omit<ChatOptions, "source">,
): Promise<string> {
  try {
    return await chat(task, checkSafeModelInput(system, messages), { ...opts, requestId: opts?.requestId ?? currentRequestId(), source });
  } finally {
    assertDataGeneration();
  }
}

export async function safeChatStream(
  task: LlmTask,
  source: LlmSource,
  system: string,
  messages: readonly SafeMessage[],
  onDelta?: (delta: string) => void,
  opts?: Omit<ChatOptions, "source">,
): Promise<string> {
  try {
    return await chatStream(task, checkSafeModelInput(system, messages), (delta) => {
      assertDataGeneration();
      onDelta?.(delta);
    }, { ...opts, requestId: opts?.requestId ?? currentRequestId(), source });
  } finally {
    assertDataGeneration();
  }
}

export type SafeVisionImage = {
  pageNumber: number;
  dataUrl: string;
};

export async function safeVisionChat(
  task: LlmTask,
  source: LlmSource,
  system: string,
  images: readonly SafeVisionImage[],
  opts?: Omit<ChatOptions, "source">,
): Promise<string> {
  try {
    if (images.length > MAX_MODEL_IMAGES) {
      throw new ModelInputBudgetError(`单次视觉模型请求最多包含 ${MAX_MODEL_IMAGES} 张图片`);
    }
    if (images.some((image) => !Number.isSafeInteger(image.pageNumber) || image.pageNumber < 1)) {
      throw new ModelInputBudgetError("视觉模型图片页码无效");
    }
    const userParts: ChatMessage["content"] = [
      { type: "text", text: `请完整识别以下扫描版文档（共 ${images.length} 页）中的所有文字：\n` },
    ];
    for (const img of images) {
      userParts.push({ type: "text", text: `\n[Page ${img.pageNumber}]\n` });
      userParts.push({ type: "image_url", image_url: { url: img.dataUrl, detail: "high" } });
    }
    const messages: ChatMessage[] = [
      { role: "system", content: withUntrustedDataRules(system) },
      { role: "user", content: userParts },
    ];
    return await chat(task, checkModelInput(messages), { ...opts, requestId: opts?.requestId ?? currentRequestId(), source });
  } finally {
    assertDataGeneration();
  }
}
