/** 新生成框架使用固定标记，内容可本地化；旧的明确标记仍可读取。 */
export const RESUME_PLACEHOLDER_RULES = "填写框架统一使用 [TBD: 待补内容]；TBD 和括号不翻译，冒号后的待补内容按目标语言书写，不把编辑说明写成候选人的经历。";

const label = String.raw`(?:TBD|TODO|To\s+(?:add|confirm|fill)|Missing|Pending\s+(?:information|confirmation)|待(?:补充|補充)|À\s+compléter|Ergänzen|要追記)`;
const content = String.raw`(?:${label}[^\S\r\n]*[:：][^\S\r\n]*[^\s\[\]【】][^\[\]【】\r\n]*|待补充|待補充)`;

/** 校验和导出共用，避免可展示的框架被当作完整经历导出。 */
export const RESUME_BRACKETED_PLACEHOLDER_PATTERN = String.raw`(?:\[${content}\]|【${content}】)`;
// 裸标记仅兼容完整短词；说明必须留在闭合括号内，不能把后续经历句也视为框架。
const wholePlaceholder = new RegExp(String.raw`^(?:${RESUME_BRACKETED_PLACEHOLDER_PATTERN}|待补充|待補充)[.!?。！？]?$`, "iu");

export function isResumePlaceholder(text: string): boolean {
  return wholePlaceholder.test(text);
}
