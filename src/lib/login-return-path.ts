/** 登录回跳只接受规范化后仍属于当前站点的路径。 */
export function safeLoginReturnPath(next: string, origin: string): string {
  if (!next.startsWith("/") || /[\\\x00-\x20]|%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|20)/i.test(next)) return "/";
  try {
    const target = new URL(next, origin);
    return target.origin === new URL(origin).origin
      ? `${target.pathname}${target.search}${target.hash}`
      : "/";
  } catch {
    return "/";
  }
}
