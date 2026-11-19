/** 自我介绍工坊的领域类型与 AI 输出规整（见 CONTEXT.md「自我介绍工坊」） */

export const INTRO_KINDS = ["30s", "2min"] as const;
export type IntroKind = (typeof INTRO_KINDS)[number];

export type IntroSentence = {
  /** 一句完整的话 */
  text: string;
  /** 逐句点评；句子被编辑后置空，待重新点评 */
  comment: string;
};

export type IntroVersionData = {
  kind: IntroKind;
  sentences: IntroSentence[];
};

export const INTRO_KIND_LABELS: Record<IntroKind, string> = {
  "30s": "30 秒版",
  "2min": "2 分钟版",
};

export function isIntroKind(value: unknown): value is IntroKind {
  return typeof value === "string" && (INTRO_KINDS as readonly string[]).includes(value);
}

export const INTRO_MAX_SENTENCES = 60;
export const INTRO_MAX_TEXT_CHARS = 800;
export const INTRO_MAX_COMMENT_CHARS = 300;

/** AI 生成稿采用独立篇幅上限；较宽的编辑/存档上限继续供手动内容使用。 */
export const INTRO_GENERATED_LIMITS: Record<IntroKind, {
  maxSentences: number;
  maxTextCharsPerSentence: number;
  totalTextChars: number;
  totalCommentChars: number;
}> = {
  "30s": { maxSentences: 10, maxTextCharsPerSentence: 200, totalTextChars: 280, totalCommentChars: 1_200 },
  "2min": { maxSentences: 20, maxTextCharsPerSentence: 250, totalTextChars: 1_000, totalCommentChars: 2_400 },
};

/** 新生成点评较短；手动编辑与存档仍使用 INTRO_MAX_COMMENT_CHARS。 */
export const INTRO_GENERATED_COMMENT_MAX_CHARS = 150;

function hasIntroContent(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value.replace(/\p{Default_Ignorable_Code_Point}/gu, ""));
}

function hasSentenceEndingPunctuation(value: string): boolean {
  const withoutClosingMarks = value.trimEnd().replace(/["'”’」』）》】〕〉]+$/u, "").trimEnd();
  return /[.!?。！？…]+$/u.test(withoutClosingMarks);
}

/** 历史读取只核对结构，不套新生成的篇幅上限；异常整版保留，不过滤句子。 */
export function readStoredIntroSentences(serialized: string): { sentences: IntroSentence[]; error: string | null } {
  let raw: unknown;
  try { raw = JSON.parse(serialized); }
  catch { return { sentences: [], error: "句子数据不是有效 JSON" }; }
  if (!Array.isArray(raw) || raw.length === 0) return { sentences: [], error: "句子数据不是非空列表" };
  const sentences: IntroSentence[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.text !== "string" || !item.text.trim()) {
      return { sentences: [], error: `第 ${index + 1} 项不是有效正文，未过滤或改写原稿` };
    }
    if (item.comment !== undefined && typeof item.comment !== "string") {
      return { sentences: [], error: `第 ${index + 1} 项点评不是文本，未改写原稿` };
    }
    sentences.push({ text: item.text, comment: item.comment ?? "" });
  }
  return { sentences, error: null };
}

/** 校验用户保存内容：任何无效或超限句子都拒绝整组保存，合法正文原样保留。 */
export function validateIntroSentences(raw: unknown): { sentences: IntroSentence[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "至少需要一句有效内容" };
  if (raw.length > INTRO_MAX_SENTENCES) return { error: `每版最多 ${INTRO_MAX_SENTENCES} 句` };
  const sentences: IntroSentence[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { error: "句子格式无效" };
    }
    const { text, comment } = item as Record<string, unknown>;
    if (typeof text !== "string" || !text.trim()) return { error: "每句正文必须是非空文本" };
    if (text.length > INTRO_MAX_TEXT_CHARS) return { error: `每句最多 ${INTRO_MAX_TEXT_CHARS} 字` };
    if (comment !== undefined && typeof comment !== "string") return { error: "点评必须是文本" };
    if (typeof comment === "string" && comment.length > INTRO_MAX_COMMENT_CHARS) {
      return { error: `每句点评最多 ${INTRO_MAX_COMMENT_CHARS} 字` };
    }
    sentences.push({ text, comment: comment ?? "" });
  }
  return { sentences };
}

/** 清洗 AI 句子数组：丢弃空句、截断超长文本；全部无效返回 null */
export function normalizeSentences(raw: unknown): IntroSentence[] | null {
  if (!Array.isArray(raw)) return null;
  const out: IntroSentence[] = [];
  for (const item of raw.slice(0, INTRO_MAX_SENTENCES)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim().slice(0, INTRO_MAX_TEXT_CHARS) : "";
    if (!text) continue;
    const comment = typeof o.comment === "string" ? o.comment.trim().slice(0, INTRO_MAX_COMMENT_CHARS) : "";
    out.push({ text, comment });
  }
  return out.length > 0 ? out : null;
}

/** 清洗 AI 生成的多版本结果：两版必须齐全且各自至少有一句有效内容，否则返回 null */
export function normalizeIntroVersions(raw: unknown): IntroVersionData[] | null {
  if (!raw || typeof raw !== "object") return null;
  const versions = (raw as Record<string, unknown>).versions;
  if (!Array.isArray(versions)) return null;
  const result: IntroVersionData[] = [];
  for (const kind of INTRO_KINDS) {
    const found = versions.find(
      (v) => v && typeof v === "object" && (v as Record<string, unknown>).kind === kind
    );
    if (!found) return null;
    const sentences = normalizeSentences((found as Record<string, unknown>).sentences);
    if (!sentences) return null;
    result.push({ kind, sentences });
  }
  return result;
}

/** 新生成版本必须恰好覆盖请求范围，每句含有效正文与点评，不丢句或截断。 */
export function validateGeneratedIntroVersions(raw: unknown, kinds: readonly IntroKind[] = INTRO_KINDS): IntroVersionData[] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || kinds.length === 0) return null;
  const source = raw as Record<string, unknown>;
  if (Object.keys(source).some((key) => key !== "versions")) return null;
  const versions = source.versions;
  if (!Array.isArray(versions) || versions.length !== kinds.length) return null;
  const result = new Map<IntroKind, IntroVersionData>();
  for (const version of versions) {
    if (!version || typeof version !== "object" || Array.isArray(version)) return null;
    const versionRecord = version as Record<string, unknown>;
    if (Object.keys(versionRecord).some((key) => key !== "kind" && key !== "sentences")) return null;
    const { kind, sentences } = versionRecord;
    if (!isIntroKind(kind) || !kinds.includes(kind) || result.has(kind)) return null;
    if (!Array.isArray(sentences) || sentences.some((sentence) => !sentence || typeof sentence !== "object" || Array.isArray(sentence) ||
      Object.keys(sentence).some((key) => key !== "text" && key !== "comment"))) return null;
    const validated = validateIntroSentences(sentences);
    if ("error" in validated || validated.sentences.some((sentence) =>
      !hasIntroContent(sentence.text) || !hasIntroContent(sentence.comment))) return null;
    const limits = INTRO_GENERATED_LIMITS[kind];
    if (validated.sentences.length > limits.maxSentences ||
        validated.sentences.some((sentence) => !hasSentenceEndingPunctuation(sentence.text) ||
          introWordCount([sentence]) > limits.maxTextCharsPerSentence ||
          sentence.comment.trim().length > INTRO_GENERATED_COMMENT_MAX_CHARS) ||
        introWordCount(validated.sentences) > limits.totalTextChars ||
        validated.sentences.reduce((total, sentence) => total + sentence.comment.trim().length, 0) > limits.totalCommentChars) return null;
    result.set(kind, { kind, sentences: validated.sentences.map((sentence) => ({
      text: sentence.text.trim(), comment: sentence.comment.trim(),
    })) });
  }
  return kinds.map((kind) => result.get(kind)!);
}

/** 清洗 AI 逐句点评结果（comments 数组按输入顺序对齐）：返回定长数组，缺失/多余的句子置空 */
export function normalizeIntroComments(raw: unknown, count: number): string[] | null {
  if (!raw || typeof raw !== "object") return null;
  const comments = (raw as Record<string, unknown>).comments;
  if (!Array.isArray(comments)) return null;
  const cleaned = comments.filter((c): c is string => typeof c === "string");
  if (cleaned.length === 0) return null;
  return Array.from({ length: count }, (_, i) => (cleaned[i] ?? "").trim().slice(0, INTRO_MAX_COMMENT_CHARS));
}

/** 新点评必须逐句完整对应，不丢项、补空或截掉句尾限定。 */
export function validateGeneratedIntroComments(raw: unknown, count: number): string[] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
    !Number.isInteger(count) || count < 1 || count > INTRO_MAX_SENTENCES) return null;
  const source = raw as Record<string, unknown>;
  if (Object.keys(source).some((key) => key !== "comments")) return null;
  const comments = source.comments;
  if (!Array.isArray(comments) || comments.length !== count || comments.some((comment) =>
    typeof comment !== "string" || !hasIntroContent(comment) || comment.length > INTRO_GENERATED_COMMENT_MAX_CHARS,
  )) return null;
  return comments.map((comment: string) => comment.trim());
}

/** 全文字数（去空白），用于核对时长 */
export function introWordCount(sentences: IntroSentence[]): number {
  return sentences.reduce((n, s) => n + s.text.replace(/\s/g, "").length, 0);
}

/** 按约 4 字/秒的中文语速把字数换算成朗读时长标签 */
export function introDurationLabel(charCount: number): string {
  const sec = Math.round(charCount / 4);
  if (sec < 60) return `约 ${sec} 秒`;
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  return r === 0 ? `约 ${m} 分钟` : `约 ${m} 分 ${r} 秒`;
}
