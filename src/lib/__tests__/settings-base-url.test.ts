import { describe, expect, it } from "vitest";

import { describePrivateBaseUrl, parseHttpBaseUrl } from "../settings-request";

const warn = (url: string) => describePrivateBaseUrl(new URL(url));

describe("Base URL 内网提示", () => {
  it.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1:8080/v1",
    "http://10.0.0.5/v1",
    "http://172.16.3.9/v1",
    "http://172.31.255.1/v1",
    "http://192.168.1.20:1234/v1",
    "http://169.254.10.10/v1",
    "http://0.0.0.0:8080/v1",
    "http://[::1]:8080/v1",
    "http://[fd00::1]/v1",
    "http://ollama.local/v1",
    "http://gateway.internal/v1",
  ])("指向本机/内网时给出提示：%s", (url) => {
    expect(warn(url)).toContain("本机或内网");
  });

  it.each([
    "https://api.openai.com/v1",
    "https://api.deepseek.com/v1",
    "https://llm.example.com/v1",
    // 边界：172.32 已在 172.16/12 之外；169.253 不是链路本地
    "http://172.32.0.1/v1",
    "http://169.253.0.1/v1",
    "http://11.0.0.1/v1",
  ])("公网地址不提示：%s", (url) => {
    expect(warn(url)).toBeNull();
  });

  it("协议不是 http(s) 时仍被拒绝", () => {
    expect(() => parseHttpBaseUrl("ftp://example.com")).toThrow("HTTP 或 HTTPS");
    expect(() => parseHttpBaseUrl("file:///etc/passwd")).toThrow("HTTP 或 HTTPS");
  });
});
