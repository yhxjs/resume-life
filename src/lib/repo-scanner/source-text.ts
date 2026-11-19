import { StringDecoder } from "node:string_decoder";

/** 预算内的字节可能止于 UTF-8 字符中间；未读完文件时只保留已完整解码的前缀。 */
export function decodeRepoSourcePrefix(bytes: Uint8Array, partial: boolean): string {
  const decoder = new StringDecoder("utf8");
  return partial ? decoder.write(bytes) : decoder.end(bytes);
}

/** 长度仍按 UTF-16 计预算，截取时不把完整码点的代理对拆开。 */
export function sliceRepoSourcePrefix(text: string, maxChars: number): string {
  let end = Math.max(0, Math.min(text.length, maxChars));
  const before = text.charCodeAt(end - 1);
  const after = text.charCodeAt(end);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
  return text.slice(0, end);
}
