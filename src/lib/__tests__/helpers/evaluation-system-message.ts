import { expect } from "vitest";

/** 对照样本可跨午夜；只忽略生成日期值，仍核对角色、唯一日期行及其余提示正文。 */
export function withoutEvaluationDate(message: { role: string; content: string }) {
  expect(message.role).toBe("system");
  const datePrefix = /^当前日期：\d{4}-\d{2}-\d{2}。/gm;
  expect(message.content.match(datePrefix), "系统提示必须恰有一个生成日期行").toHaveLength(1);
  return { ...message, content: message.content.replace(datePrefix, "当前日期：<调用当日>。") };
}
