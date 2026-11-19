/** Canonical key for case/width/spacing-insensitive text comparison; source text is never rewritten. */
export function textComparisonKey(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

/** Ignore question layout and terminal punctuation without rewriting the source or language shaping. */
export function questionComparisonKey(question: string): string {
  // Ignore optional layout characters before folding whitespace. Keep ZWJ/ZWNJ and variation selectors.
  return textComparisonKey(question.replace(/[\u00ad\u200b\u2060\ufeff]/gu, ""))
    // Treat whitespace between terminal punctuation marks as formatting too.
    .replace(/[?!.,。！？…；;：:，、\s]+$/gu, "")
    .trim();
}

/** Require content beyond punctuation, controls and combining marks; inspect without rewriting source text. */
export function hasQuestionContent(question: string): boolean {
  // Some default-ignorable fillers are classified as letters, so categories alone are insufficient.
  return /[\p{L}\p{N}\p{S}]/u.test(question.replace(/\p{Default_Ignorable_Code_Point}/gu, ""));
}
