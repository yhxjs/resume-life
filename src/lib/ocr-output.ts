/** 识别结果须包含文字或数字；仅检查，不改写 OCR 原文。 */
export function hasOcrText(text: string): boolean {
  // 部分默认不可见填充符属于 Unicode 字母，须先排除再检查类别。
  return /[\p{L}\p{N}]/u.test(text.replace(/\p{Default_Ignorable_Code_Point}/gu, ""));
}
