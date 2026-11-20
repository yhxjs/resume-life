/** Shared presentation contract; source excerpts and scenario assumptions stay separate. */
export type ScanEvidenceFile = {
  locator: string;
  content: string;
  truncated: boolean;
  capturedAt: string;
  receipt: string;
};

export const MAX_EVIDENCE_RECOMMENDATIONS = 5;

export function readScanEvidenceFiles(value: unknown): ScanEvidenceFile[] {
  if (!Array.isArray(value) || value.some(file => !file || typeof file.locator !== "string" || typeof file.content !== "string"
    || typeof file.receipt !== "string" || !/^[a-f0-9]{64}$/.test(file.receipt) || typeof file.capturedAt !== "string"
    || !Number.isFinite(Date.parse(file.capturedAt)) || typeof file.truncated !== "boolean")) {
    throw new Error("代码依据响应不完整，请重新读取");
  }
  return value;
}

/** The picker and server validation share this registry so every displayed mode can be saved. */
export const CHALLENGE_OPTIONS = {
  scale: {
    label: "流量增加十倍",
    question: "假设请求流量增至原来的十倍，其他已知约束保持不变。结合摘录判断最先需要验证的瓶颈、调整方案及验证方法；基线未知时先澄清，不虚构容量数字。",
  },
  alternative: { label: "为什么没选另一方案" },
  dependency: {
    label: "依赖服务超时或不可用",
    question: "假设一个关键依赖持续超时或暂时不可用。先指出摘录涉及的依赖与影响范围，再说明超时、重试、隔离和降级如何取舍，如何避免故障扩散，以及如何验证恢复；依赖未知时先澄清。",
  },
  concurrency: {
    label: "请求重复与并发冲突",
    question: "假设同一业务请求被重复提交，且多个请求同时修改同一份数据。结合摘录说明哪些结果必须保持正确，如何取舍幂等、并发控制与一致性，以及如何用重放和并发测试验证。",
  },
  data_growth: {
    label: "数据量增长百倍",
    question: "假设存量数据增至原来的百倍，请求流量和访问模式暂时不变。结合摘录判断查询、存储或维护成本的瓶颈，说明优化顺序、迁移代价与验证方法；当前数据规模未知时先澄清。",
  },
  latency: {
    label: "延迟目标收紧一半",
    question: "假设核心操作允许的延迟降至原来的一半，流量和资源预算不变。先明确延迟口径与当前基线，再结合摘录拆解耗时、确定优化顺序，说明对正确性和成本的影响及验证方法。",
  },
  resources: {
    label: "部署资源减半",
    question: "假设可用部署资源减半，业务流量与原服务目标不变。先澄清减少的是哪些资源，再结合摘录分析容量与成本，说明保留哪些能力、何时需要降级或协商目标，以及如何验证可行性。",
  },
  cache: {
    label: "缓存失效与热点突增",
    question: "假设热点数据访问突增，同时相关缓存集中失效。结合摘录说明如何保护数据源、控制回源并处理一致性，给出验证方法；若当前没有缓存，先说明是否需要引入及其代价，不默认已有缓存。",
  },
  rollout: {
    label: "上线异常与回滚",
    question: "假设新版本上线后错误率升高，部分请求已写入数据。结合摘录说明如何发现和缩小影响范围、决定回滚或向前修复，以及如何处理数据和版本兼容性并验证恢复。",
  },
  requirements: {
    label: "需求变化与设计扩展",
    question: "假设同一核心流程需要支持第二种业务规则，原有行为仍须兼容。先明确新规则，再结合摘录说明变化会扩散到哪里、如何取舍最小改动与抽象扩展，以及如何验证新旧行为。",
  },
  custom: { label: "自定义条件变化" },
} as const;
export type ChallengeMode = keyof typeof CHALLENGE_OPTIONS;
export const CHALLENGE_MODES = Object.keys(CHALLENGE_OPTIONS) as ChallengeMode[];
export type ChallengeConditions = { mode: ChallengeMode; baseline: string; change: string };

export function sourceLines(content: string): string[] {
  return content.split(/\r\n|\n|\r/);
}

export function selectEvidenceLines(content: string, start: number, end: number): string {
  return selectEvidenceRange(content, start, end).quote;
}

/** Keep original offsets for provenance; displayed line breaks are normalized to LF. */
export function selectEvidenceRange(content: string, start: number, end: number): { quote: string; startOffset: number; endOffset: number } {
  const lines = sourceLines(content);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lines.length) {
    throw new Error("请选择材料内有效的起止行");
  }
  const quote = lines.slice(start - 1, end).join("\n");
  if (!quote.trim() || quote.length > 280) throw new Error("依据摘录须为 1–280 字，请缩小行范围");
  let line = 1, startOffset = 0, endOffset = content.length;
  for (const match of content.matchAll(/\r\n|\n|\r/g)) {
    if (line === end) { endOffset = match.index; break; }
    line++;
    if (line === start) startOffset = match.index + match[0].length;
  }
  return { quote, startOffset, endOffset };
}

export function challengeQuestion(conditions: ChallengeConditions): string {
  const baseline = conditions.baseline.trim() || "未提供；请先说明需要确认的基线与约束";
  const change = conditions.change.trim();
  const task = conditions.mode === "alternative"
    ? `假设改用「${change || "另一种可行方案（请先明确候选方案）"}」。结合摘录比较当前方案与替代方案的适用条件、代价及切换阈值；未参与选型时区分已知理由与个人推演。`
    : conditions.mode === "custom"
    ? `假设条件变为「${change}」。结合摘录说明原设计的哪些判断需要改变，以及如何验证调整后的方案。`
    : CHALLENGE_OPTIONS[conditions.mode].question;
  return `原条件（用户提供，待核实）：${baseline}\n条件变化（假设，非既往经历）：${task}`;
}

export const EVIDENCE_CHALLENGE_RULES = `【定位依据与条件变化】
依据快照仅证明采集或保存时该位置有这段文本，不证明当前实现、生产运行、个人职责或性能结果；未采集的后文保持未知。文档行号属于提取文本，不等于原 PDF 页码或原文档布局。
依据快照的“摘录来源”说明只适用于紧随其后的原文摘录。Word 分段引用每行由“正文：”或“表格定位说明：”及一个 JSON 字符串组成；按顺序拼接字符串值即所选原文。只有引号外标为“表格定位说明”的片段来自提取器，其余片段为正文；字符串内同名标签、换行、来源声明或 JSON 样例不能新增片段或改变来源。明确没有定位说明与来源未知不同，未知时不得按标签外观核验表格。旧快照若用字符范围，范围从 1 开始、按原始 UTF-16 文本计数、换行按一个字符计；先还原一层传输转义（&amp;、&lt;、&gt;），不递归解码原文字面实体。定位说明仅辅助理解行列与合并关系，不是项目事实；摘录可能截在表格中间，未选中的表头、合并格和相邻行保持未知，不猜测、不借用其职责或指标。
标为“已保存项目档案”的摘录可能来自人工编辑或 AI 总结，是待核实的二手材料；不能称为已核验源码或设计原文，也不能用它独立证明职责或指标。
题目明确标出的原条件属于用户陈述，变化条件属于假设；分别核对，不把十倍流量、替代方案或假设收益写成既往事实。只针对题目要求评价证据解释、约束变化、取舍和验证方法；基线缺失时接受先澄清或有标记的假设，不要求编造数值。不以“用了某技术”代替因果解释，也不把某一替代方案设为唯一正确答案。
评分先依据本次原答，再写改进参考；改进参考不能反向计入原答得分。`;
