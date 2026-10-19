import type { ChatMessage } from "./llm-adapter";

// 以 UTF-16 字符数提供可预测的应用预算；它不等同于供应商的 token 上下文窗口。
export const MAX_MODEL_FIELD_CHARS = 12_000;
export const MAX_MODEL_INPUT_CHARS = 64_000;
export const MAX_MODEL_IMAGES = 5;
export const MAX_MODEL_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_MODEL_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;

export class ModelInputBudgetError extends Error {}

export function checkModelField(value: string, label: string) {
  if (value.length > MAX_MODEL_FIELD_CHARS) {
    throw new ModelInputBudgetError(`${label}不得超过 ${MAX_MODEL_FIELD_CHARS} 字符，请缩短后重试`);
  }
}

function getDataUrlBytes(url: string): number {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]*={0,2})$/iu.exec(url);
  if (!match || !match[1] || match[1].length % 4 !== 0 || /=/.test(match[1].slice(0, -2))) {
    throw new ModelInputBudgetError("视觉模型图片必须是有效的 base64 data URL");
  }
  const payload = match[1];
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return (payload.length / 4) * 3 - padding;
}

function getContentBudget(content: ChatMessage["content"]): { chars: number; images: number; imageBytes: number } {
  if (typeof content === "string") return { chars: content.length, images: 0, imageBytes: 0 };
  return content.reduce((total, part) => {
    if (part.type === "text") return { ...total, chars: total.chars + part.text.length };
    const imageBytes = getDataUrlBytes(part.image_url.url);
    if (imageBytes > MAX_MODEL_IMAGE_BYTES) {
      throw new ModelInputBudgetError(`单张视觉模型图片不得超过 ${MAX_MODEL_IMAGE_BYTES} 字节`);
    }
    return {
      chars: total.chars,
      images: total.images + 1,
      imageBytes: total.imageBytes + imageBytes,
    };
  }, { chars: 0, images: 0, imageBytes: 0 });
}

/** 检查实际外发的全部消息，系统提示、历史和简历均计入，不修改或截断输入。 */
export function checkModelInput(messages: ChatMessage[], fields: Record<string, string> = {}): ChatMessage[] {
  for (const [label, value] of Object.entries(fields)) checkModelField(value, label);
  const budget = messages.reduce((total, message) => {
    const current = getContentBudget(message.content);
    return {
      chars: total.chars + current.chars,
      images: total.images + current.images,
      imageBytes: total.imageBytes + current.imageBytes,
    };
  }, { chars: 0, images: 0, imageBytes: 0 });
  if (budget.chars > MAX_MODEL_INPUT_CHARS) {
    throw new ModelInputBudgetError(`完整模型输入超过 ${MAX_MODEL_INPUT_CHARS} 字符，请缩短简历、岗位要求或历史内容后重试`);
  }
  if (budget.images > MAX_MODEL_IMAGES) {
    throw new ModelInputBudgetError(`单次视觉模型请求最多包含 ${MAX_MODEL_IMAGES} 张图片`);
  }
  if (budget.imageBytes > MAX_MODEL_IMAGE_TOTAL_BYTES) {
    throw new ModelInputBudgetError(`视觉模型图片总大小不得超过 ${MAX_MODEL_IMAGE_TOTAL_BYTES} 字节`);
  }
  return messages;
}
