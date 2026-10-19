/**
 * 分层 Escape 协议：内层浮层（如下拉框）展开时登记自己，模态的焦点陷阱在捕获阶段
 * 发现已有内层消费者就放行，让内层先处理 Escape。
 *
 * 没有这层协调时，模态会在 document 捕获阶段 stopImmediatePropagation 掉 Escape，
 * 导致「模态里按下拉框的 Escape」直接关掉整个模态、丢掉用户已填内容。
 */
const openLayers = new Set<symbol>();

/** 登记一个内层 Escape 消费者；返回注销函数，供 effect cleanup 调用 */
export function registerEscapeLayer(): () => void {
  const token = Symbol("escape-layer");
  openLayers.add(token);
  return () => { openLayers.delete(token); };
}

/** 当前是否有内层消费者在等待 Escape */
export function hasOpenEscapeLayer(): boolean {
  return openLayers.size > 0;
}
