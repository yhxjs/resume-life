/** MCP 返回的是有界资料摘要；截断时保留记录结构、ID 与并发校验字段。 */
export const MCP_DETAIL_BUDGET = 32_000;
export const MCP_LIST_BUDGET = 24_000;

function shorten(value: unknown, textLimit: number, arrayLimit: number): unknown {
  if (typeof value === "string") {
    return value.length > textLimit ? `${value.slice(0, textLimit)}\n[内容已截断]` : value;
  }
  if (Array.isArray(value)) return value.slice(0, arrayLimit).map(item => shorten(item, textLimit, arrayLimit));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shorten(item, textLimit, arrayLimit)]));
  }
  return value;
}

export function boundMcpOutput<T extends object>(value: T, budget = MCP_DETAIL_BUDGET, options: { preserveArrays?: boolean } = {}): T & { truncated?: true } {
  if (JSON.stringify(value).length <= budget) return value;
  // 先保留记录与状态，只缩短文字；最后才裁剪允许省略的集合。
  const limits = [2_000, 800, 300, 64].map(textLimit => [textLimit, Infinity] as const);
  if (!options.preserveArrays) limits.push(...[[2_000, 20], [800, 10], [300, 5], [64, 2]] as const);
  for (const [textLimit, arrayLimit] of limits) {
    const result = { ...shorten(value, textLimit, arrayLimit) as T, truncated: true as const };
    if (JSON.stringify(result).length <= budget) return result;
  }
  throw new Error("资料结构超过 MCP 响应上限，请在应用中查看原始记录");
}
