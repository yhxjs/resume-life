import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transports = vi.hoisted(() => ({ http: vi.fn(), socks: vi.fn() }));
vi.mock("undici", () => ({
  ProxyAgent: class {
    constructor(options: unknown) { return transports.http(options); }
  },
}));
vi.mock("fetch-socks", () => ({ socksDispatcher: transports.socks }));

import { closeProxyDispatcher, getProxyDispatcher } from "../proxy-dispatcher";

beforeEach(() => {
  vi.clearAllMocks();
  transports.http.mockImplementation(() => ({ close: vi.fn().mockResolvedValue(undefined) }));
  transports.socks.mockImplementation(() => ({ close: vi.fn().mockResolvedValue(undefined) }));
});
afterEach(() => closeProxyDispatcher());

describe("代理连接缓存与认证切换", () => {
  it.each(["http", "socks5"])("%s：认证字段中的竖线不能导致复用另一组凭证", protocol => {
    const base = { enabled: true, url: `${protocol}://proxy.example:8080` };
    const firstConfig = { ...base, username: "synthetic|user", password: "secret" };
    const secondConfig = { ...base, username: "synthetic", password: "user|secret" };
    const first = getProxyDispatcher(firstConfig)!;
    expect(getProxyDispatcher(firstConfig)).toBe(first);

    const second = getProxyDispatcher(secondConfig)!;
    expect(second).not.toBe(first);
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).not.toHaveBeenCalled();
    expect(getProxyDispatcher(secondConfig)).toBe(second);

    if (protocol === "http") {
      expect(transports.http.mock.calls).toEqual([
        [{ uri: base.url, token: `Basic ${Buffer.from("synthetic|user:secret").toString("base64")}` }],
        [{ uri: base.url, token: `Basic ${Buffer.from("synthetic:user|secret").toString("base64")}` }],
      ]);
      expect(transports.socks).not.toHaveBeenCalled();
    } else {
      expect(transports.socks.mock.calls).toEqual([
        [{ type: 5, host: "proxy.example", port: 8080, userId: firstConfig.username, password: firstConfig.password }],
        [{ type: 5, host: "proxy.example", port: 8080, userId: secondConfig.username, password: secondConfig.password }],
      ]);
      expect(transports.http).not.toHaveBeenCalled();
    }
  });

  it("等价的规范化地址和凭证复用同一连接池", () => {
    const first = getProxyDispatcher({ enabled: true, url: "HTTP://synthetic:secret@PROXY.EXAMPLE:80/", username: "", password: "" });
    const second = getProxyDispatcher({ enabled: true, url: "http://proxy.example", username: "synthetic", password: "secret" });
    expect(second).toBe(first);
    expect(transports.http).toHaveBeenCalledOnce();
    expect(first!.close).not.toHaveBeenCalled();
  });

  it("禁用代理后关闭旧池，重新启用建立新池", () => {
    const config = { enabled: true, url: "http://proxy.example", username: "synthetic", password: "secret" };
    const first = getProxyDispatcher(config)!;
    expect(getProxyDispatcher({ ...config, enabled: false })).toBeUndefined();
    expect(first.close).toHaveBeenCalledOnce();
    expect(getProxyDispatcher(config)).not.toBe(first);
    expect(transports.http).toHaveBeenCalledTimes(2);
  });
});
