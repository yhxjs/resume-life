import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { listenForFetch } from "../../../tests/support/http-server";

afterEach(() => vi.restoreAllMocks());

it("跳过 fetch 禁止的临时端口，关闭后重新分配，真实请求可读", async () => {
  const server = createServer((_request, response) => response.end("synthetic provider"));
  const originalListening = server.listeners("listening");
  const address = server.address.bind(server);
  vi.spyOn(server, "address").mockImplementationOnce(() => ({ address: "127.0.0.1", family: "IPv4", port: 6665 })).mockImplementation(address);
  const close = vi.spyOn(server, "close");
  const listen = vi.spyOn(server, "listen");
  try {
    await listenForFetch(server);
    const bound = server.address();
    if (!bound || typeof bound === "string") throw new Error("Missing synthetic address");
    expect(bound.address).toBe("127.0.0.1");
    expect(bound.port).toBeGreaterThan(10080);
    expect(listen.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [port] of listen.mock.calls) {
      expect(port).toBeGreaterThanOrEqual(16384);
      expect(port).toBeLessThanOrEqual(65535);
    }
    expect(close.mock.calls.length).toBe(listen.mock.calls.length - 1);
    expect(server.listenerCount("error")).toBe(0);
    expect(server.listeners("listening")).toEqual(originalListening);
    expect(await (await fetch(`http://127.0.0.1:${bound.port}`)).text()).toBe("synthetic provider");
  } finally {
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
});

it("监听错误明确拒绝并移除本次监听器，不无限重试", async () => {
  const server = createServer();
  const originalListening = server.listeners("listening");
  const error = new Error("Synthetic bind failure");
  const listen = vi.spyOn(server, "listen").mockImplementation(() => {
    queueMicrotask(() => server.emit("error", error));
    return server;
  });
  await expect(listenForFetch(server)).rejects.toBe(error);
  expect(listen).toHaveBeenCalledOnce();
  expect(server.listenerCount("error")).toBe(0);
  expect(server.listeners("listening")).toEqual(originalListening);
});

it("连续分配低位端口有重试上限且释放所有监听，不留下空服务", async () => {
  const server = createServer();
  // 此处验证重试/释放次数；真实端口绑定另由上下两个 fetch 用例覆盖。
  vi.spyOn(server, "listen").mockImplementation(() => {
    queueMicrotask(() => server.emit("listening"));
    return server;
  });
  vi.spyOn(server, "address").mockReturnValue({ address: "127.0.0.1", family: "IPv4", port: 6665 });
  const close = vi.spyOn(server, "close").mockImplementation(callback => {
    queueMicrotask(() => callback?.());
    return server;
  });
  await expect(listenForFetch(server)).rejects.toThrow("无法为合成 HTTP 服务分配");
  expect(close).toHaveBeenCalledTimes(32);
  expect(server.listening).toBe(false);
});

it.each(["EADDRINUSE", "EACCES"])("高位端口 %s 时重新分配，保留其他监听器，真实请求可读", async code => {
  const server = createServer((_request, response) => response.end("rebound"));
  const listen = server.listen.bind(server);
  const observer = vi.fn();
  server.on("error", observer);
  const conflict = Object.assign(new Error("unavailable port"), { code });
  const spy = vi.spyOn(server, "listen").mockImplementationOnce(() => {
    queueMicrotask(() => server.emit("error", conflict));
    return server;
  }).mockImplementation(listen);
  try {
    await listenForFetch(server);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(observer).toHaveBeenCalledWith(conflict);
    expect(server.listeners("error")).toEqual([observer]);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing bound address");
    expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe("rebound");
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it.each(["EADDRINUSE", "EACCES"])("端口始终 %s 时 32 次后拒绝，不保留临时监听器", async code => {
  const server = createServer();
  const listening = server.listeners("listening");
  const listen = vi.spyOn(server, "listen").mockImplementation(() => {
    queueMicrotask(() => server.emit("error", Object.assign(new Error("unavailable port"), { code })));
    return server;
  });
  await expect(listenForFetch(server)).rejects.toThrow("无法为合成 HTTP 服务分配");
  expect(listen).toHaveBeenCalledTimes(32);
  expect(server.listenerCount("error")).toBe(0);
  expect(server.listeners("listening")).toEqual(listening);
});
