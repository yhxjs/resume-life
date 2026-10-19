import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { detectEnvironmentProxies, testProxyEndpoint } from "../proxy-detect";
import type { ProxyConfig, ProxyProtocol } from "../proxy-config";

const servers: Server[] = [];
const sockets = new Set<Socket>();

async function endpoint(
  respond: (data: Buffer, socket: Socket) => void,
  protocol: ProxyProtocol = "http",
): Promise<ProxyConfig> {
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (data) => respond(data, socket));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return { enabled: true, url: `${protocol}://127.0.0.1:${address.port}`, username: "", password: "" };
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("代理环境候选", () => {
  it("发现代理时剥离密码且保留解码用户名", () => {
    const candidates = detectEnvironmentProxies({
      NODE_ENV: "test",
      HTTPS_PROXY: "http://demo%20user:synthetic-password@127.0.0.1:7890",
    });
    expect(candidates).toEqual([{
      url: "http://127.0.0.1:7890", protocol: "http", source: "environment", username: "demo user",
    }]);
    expect(JSON.stringify(candidates)).not.toContain("synthetic-password");
  });

  it("大写环境变量优先，支持小写变量并去除同端点重复候选", () => {
    expect(detectEnvironmentProxies({
      NODE_ENV: "test",
      HTTP_PROXY: "http://LOCALHOST:7890", http_proxy: "http://127.0.0.1:8888",
      https_proxy: "http://localhost:7890/", all_proxy: "socks5://127.0.0.1:1080",
    })).toEqual([
      { url: "http://localhost:7890", protocol: "http", source: "environment" },
      { url: "socks5://127.0.0.1:1080", protocol: "socks5", source: "environment" },
    ]);
  });

  it.each(["socks://127.0.0.1:1080", "socks5h://127.0.0.1:1080"])("将 %s 规范为 SOCKS5", (url) => {
    expect(detectEnvironmentProxies({ NODE_ENV: "test", ALL_PROXY: url })).toEqual([
      { url: "socks5://127.0.0.1:1080", protocol: "socks5", source: "environment" },
    ]);
  });

  it("无协议地址默认为 HTTP，默认端口和显式端口去重", () => {
    expect(detectEnvironmentProxies({ NODE_ENV: "test", HTTP_PROXY: "localhost:80", HTTPS_PROXY: "http://localhost" }))
      .toEqual([{ url: "http://localhost", protocol: "http", source: "environment" }]);
  });

  it.each(["ftp://localhost:21", "http://bad%zz:password@localhost", "http://localhost:70000", " "])
    ("忽略非法代理 %s", (url) => {
      expect(detectEnvironmentProxies({ NODE_ENV: "test", HTTP_PROXY: url })).toEqual([]);
    });

  it("空环境没有候选，不继承运行机器的设置", () => {
    expect(detectEnvironmentProxies({ NODE_ENV: "test" })).toEqual([]);
  });
});

describe("代理端点真实回环握手", () => {
  it.each([200, 502])("HTTP %i 状态表明代理已响应，无需访问外部目标", async (status) => {
    let request = "";
    const config = await endpoint((data, socket) => {
      request += data.toString();
      socket.write(`HTTP/1.1 ${status} Synthetic\r\n\r\n`);
    });
    config.username = "demo";
    config.password = "synthetic-password";
    expect(await testProxyEndpoint(config)).toEqual({ protocol: "http", host: "127.0.0.1", port: Number(new URL(config.url).port) });
    expect(request).toContain("CONNECT 0.0.0.0:0 HTTP/1.1\r\n");
    expect(request).toContain(`Proxy-Authorization: Basic ${Buffer.from("demo:synthetic-password").toString("base64")}\r\n`);
  });

  it.each([
    ["HTTP/1.1 407 Proxy Authentication Required\r\n\r\n", "代理认证失败"],
    ["NOT AN HTTP PROXY\r\n", "代理协议不匹配"],
  ])("拒绝不成功的 HTTP 握手 %s", async (response, message) => {
    const config = await endpoint((_data, socket) => socket.write(response));
    await expect(testProxyEndpoint(config)).rejects.toThrow(message);
  });

  it("SOCKS5 无认证响应可以分成两个数据包", async () => {
    let greeting: Buffer | undefined;
    const config = await endpoint((data, socket) => {
      greeting = data;
      socket.write(Buffer.from([5]));
      setTimeout(() => socket.write(Buffer.from([0])), 10);
    }, "socks5");
    await expect(testProxyEndpoint(config)).resolves.toMatchObject({ protocol: "socks5" });
    expect(greeting).toEqual(Buffer.from([5, 1, 0]));
  });

  it.each([0, 1])("SOCKS5 用户名密码认证结果为 %i", async (status) => {
    const packets: Buffer[] = [];
    const config = await endpoint((data, socket) => {
      packets.push(data);
      socket.write(Buffer.from(packets.length === 1 ? [5, 2] : [1, status]));
    }, "socks5");
    config.username = "demo";
    config.password = "test";
    const result = testProxyEndpoint(config);
    if (status === 0) await expect(result).resolves.toMatchObject({ protocol: "socks5" });
    else await expect(result).rejects.toThrow("代理认证失败");
    expect(packets).toEqual([
      Buffer.from([5, 2, 0, 2]),
      Buffer.concat([Buffer.from([1, 4]), Buffer.from("demo"), Buffer.from([4]), Buffer.from("test")]),
    ]);
  });

  it.each([
    [[4, 0], "代理协议不匹配"],
    [[5, 255], "代理认证失败"],
    [[5, 1], "认证方式不受支持"],
    [[5, 2], "代理需要用户名和密码"],
  ])("拒绝非法或不支持的 SOCKS 握手 %j", async (response, message) => {
    const config = await endpoint((_data, socket) => socket.write(Buffer.from(response)), "socks5");
    await expect(testProxyEndpoint(config)).rejects.toThrow(message);
  });

  it("SOCKS5 凭证字节超长时不发送认证包", async () => {
    const packets: Buffer[] = [];
    const config = await endpoint((data, socket) => {
      packets.push(data);
      socket.write(Buffer.from([5, 2]));
    }, "socks5");
    config.username = "测".repeat(86);
    await expect(testProxyEndpoint(config)).rejects.toThrow("代理用户名或密码过长");
    expect(packets).toHaveLength(1);
  });

  it("对端提前关闭时拒绝，清理连接而非悬挂", async () => {
    const config = await endpoint((_data, socket) => socket.end());
    await expect(testProxyEndpoint(config)).rejects.toThrow(/代理协议不匹配|代理连接/);
  });

  it("握手无响应时超时并关闭自有连接", async () => {
    const config = await endpoint(() => {});
    await expect(testProxyEndpoint(config)).rejects.toThrow("代理握手超时");
  });

  it("拒绝已关闭监听端口的连接", async () => {
    const config = await endpoint(() => {});
    await new Promise<void>((resolve) => servers[0]!.close(() => resolve()));
    await expect(testProxyEndpoint(config)).rejects.toThrow("代理连接被拒绝");
  });
});
