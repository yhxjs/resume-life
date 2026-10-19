/** 模型地址不承载凭证；保存、探测和实际调用共用同一输入约束。 */
export function parseHttpBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Base URL 必须是有效的 HTTP 或 HTTPS 地址"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL 必须使用 HTTP 或 HTTPS 协议");
  }
  if (url.username || url.password) {
    throw new Error("Base URL 不能包含账号密码，请使用独立凭证字段");
  }
  if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "[::1]" &&
      !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(url.hostname)) {
    throw new Error("非本机模型服务必须使用 HTTPS");
  }
  return url;
}

