/** 对齐默认 SQLite LIKE：检索字面量子串，只忽略 ASCII 大小写。 */
export function matchesSqliteLikeSubstring(value: string, keyword: string): boolean {
  const fold = (text: string) => text.replace(/[A-Z]/g, char => char.toLowerCase());
  // LIKE 在 NUL 处结束正文/模式；模式若被截断，就没有末尾的 %。
  const textEnd = value.indexOf("\0");
  const patternEnd = keyword.indexOf("\0");
  const text = fold(textEnd < 0 ? value : value.slice(0, textEnd));
  return patternEnd < 0 ? text.includes(fold(keyword)) : text.endsWith(fold(keyword.slice(0, patternEnd)));
}
