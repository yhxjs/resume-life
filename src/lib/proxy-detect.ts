import { execFile } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { promisify } from "node:util";
import { connect as tlsConnect } from "node:tls";
import {
  normalizeProxyConfig,
  parseProxyUrl,
  proxyUrlPort,
  type ProxyCandidate,
  type ProxyConfig,
  type ProxyProtocol,
} from "./proxy-config";

const execFileAsync = promisify(execFile);
const WINDOWS_PROXY_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const COMMON_PROXY_PORTS = [1080, 10808, 7890, 7891, 8080, 8888, 10809] as const;
const HTTP_DISCOVERY_PORTS = new Set<number>([7890, 7891, 8080, 8888, 10809]);
const SOCKET_TIMEOUT_MS = 500;
const HANDSHAKE_TIMEOUT_MS = 1000;

function protocolForUrl(value: URL): ProxyProtocol {
  return value.protocol.slice(0, -1).toLowerCase() as ProxyProtocol;
}

function hostWithoutBrackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/gu, "");
}

function destroySocket(socket: Socket | undefined): void {
  if (!socket) return;
  // A timeout removes the temporary read listener; absorb a late RST while
  // the socket is being torn down so discovery never turns into an uncaught
  // EventEmitter error.
  socket.once("error", () => undefined);
  socket.destroy();
}

function canonicalCandidate(raw: string, source: ProxyCandidate["source"]): ProxyCandidate | null {
  let value = raw.trim();
  if (!value) return null;
  // Common proxy environment values use socks:// or socks5h://. Both mean
  // SOCKS5 for the model request dispatcher.
  value = value.replace(/^socks5h:\/\//iu, "socks5://").replace(/^socks:\/\//iu, "socks5://");
  if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(value)) value = `http://${value}`;

  try {
    const parsed = parseProxyUrl(value);
    const protocol = protocolForUrl(parsed);
    const username = parsed.username ? decodeURIComponentSafe(parsed.username) : "";
    const url = normalizeProxyConfig({ enabled: true, url: value }).url;
    return { url, protocol, source, ...(username ? { username } : {}) };
  } catch {
    return null;
  }
}

function decodeURIComponentSafe(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function getEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const exact = env[name];
  if (exact) return exact;
  const lower = env[name.toLowerCase()];
  return lower || undefined;
}

/** Discover configured HTTP(S)/SOCKS5 proxy variables without returning passwords. */
export function detectEnvironmentProxies(env: NodeJS.ProcessEnv = process.env): ProxyCandidate[] {
  const candidates: ProxyCandidate[] = [];
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    const value = getEnvironmentValue(env, name);
    const candidate = value ? canonicalCandidate(value, "environment") : null;
    if (candidate) candidates.push(candidate);
  }
  return dedupeCandidates(candidates);
}

function registryValue(output: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = output.match(new RegExp(`^\\s*${escaped}\\s+REG_\\S+\\s+(.+?)\\s*$`, "imu"));
  return match?.[1]?.trim();
}

async function readRegistryValue(name: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("reg.exe", ["query", WINDOWS_PROXY_KEY, "/v", name], {
      windowsHide: true,
      maxBuffer: 32 * 1024,
    });
    return registryValue(String(result.stdout), name);
  } catch {
    return undefined;
  }
}

/** Read the current user's Windows Internet Settings proxy configuration. */
export async function readWindowsProxyCandidates(): Promise<ProxyCandidate[]> {
  if (process.platform !== "win32") return [];
  const enabled = await readRegistryValue("ProxyEnable");
  if (!enabled || !/^0x0*1$/iu.test(enabled) && enabled !== "1") return [];
  const server = await readRegistryValue("ProxyServer");
  if (!server) return [];

  const candidates: ProxyCandidate[] = [];
  const entries = server.includes(";") ? server.split(";") : [["http", server].join("=")];
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const kind = separator >= 0 ? entry.slice(0, separator).trim().toLowerCase() : "http";
    const value = separator >= 0 ? entry.slice(separator + 1).trim() : entry.trim();
    if (!value || /^pac$/iu.test(kind) || /\.pac(?:$|[?#])/iu.test(value)) continue;
    const protocol = kind === "socks" || kind === "socks5" || kind === "socks5h"
      ? "socks5"
      : kind === "https" ? "https" : "http";
    const candidate = canonicalCandidate(/^[a-z][a-z\d+.-]*:\/\//iu.test(value) ? value : `${protocol}://${value}`, "windows");
    if (candidate) candidates.push(candidate);
  }
  return dedupeCandidates(candidates);
}

function socketConnect(host: string, port: number, secure: boolean): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = secure
      ? tlsConnect({ host, port, servername: host.includes(":") ? undefined : host, rejectUnauthorized: false })
      : createConnection({ host, port });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.removeListener("timeout", onTimeout);
      socket.removeListener("error", onError);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const onError = (error: Error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ECONNREFUSED") finish(new Error("代理连接被拒绝"));
      else if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH") finish(new Error("代理连接超时"));
      else finish(error);
    };
    const onTimeout = () => finish(new Error("代理连接超时"));
    socket.once("error", onError);
    socket.setTimeout(SOCKET_TIMEOUT_MS, onTimeout);
    if (secure) {
      socket.once("secureConnect", () => finish());
    } else {
      socket.once("connect", () => finish());
    }
  });
}

function readPacket(socket: Socket, timeoutMs: number, minimumBytes = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => finish(new Error("代理握手超时")), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("end", onEnd);
      socket.removeListener("close", onClose);
    };
    const finish = (error?: Error) => {
      cleanup();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
      size += chunk.length;
      // A proxy status line and a SOCKS method response are both tiny. Do not
      // retain an unexpected banner indefinitely during a discovery probe.
      if ((minimumBytes > 0 && size >= minimumBytes) || size >= 1024 || /\r?\n/u.test(Buffer.concat(chunks).toString("latin1"))) finish();
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish();
    const onClose = () => { if (size === 0) finish(new Error("代理连接已关闭")); };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.once("close", onClose);
  });
}

function httpStatus(data: Buffer | undefined): number | undefined {
  if (!data?.length) return undefined;
  const match = data.toString("latin1").match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/iu);
  return match?.[1] ? Number(match[1]) : undefined;
}

async function probeLoopback(host: string, port: number): Promise<ProxyCandidate[]> {
  const candidates: ProxyCandidate[] = [];
  const formattedHost = formatHost(host);
  let socket: Socket | undefined;

  // A mixed proxy port can accept both handshakes. Probe each protocol on a
  // fresh connection so the UI can offer both usable URL forms.
  try {
    socket = await socketConnect(host, port, false);
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    const response = await readPacket(socket, HANDSHAKE_TIMEOUT_MS, 2).catch(() => undefined);
    if (response?.[0] === 0x05) {
      candidates.push({
        url: `socks5://${formattedHost}:${port}`,
        protocol: "socks5",
        source: "localhost",
      });
    }
  } catch {
    // The HTTP probe below still gets a chance when the SOCKS handshake fails.
  } finally {
    destroySocket(socket);
    socket = undefined;
  }

  if (HTTP_DISCOVERY_PORTS.has(port)) {
    try {
      socket = await socketConnect(host, port, false);
      socket.write(`CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\nProxy-Connection: Keep-Alive\r\n\r\n`);
      const response = await readPacket(socket, HANDSHAKE_TIMEOUT_MS).catch(() => undefined);
      if (httpStatus(response) !== undefined) {
        candidates.push({
          url: `http://${formattedHost}:${port}`,
          protocol: "http",
          source: "localhost",
        });
      }
    } catch {
      // Closed or non-HTTP ports are ignored during discovery.
    } finally {
      destroySocket(socket);
      socket = undefined;
    }
  }

  // Clash-style mixed ports commonly expose HTTP and SOCKS5 on 7890/7891.
  // Some builds only answer the SOCKS greeting, so retain the HTTP form as a
  // selectable candidate for the user to verify with the test action.
  if (candidates.some((candidate) => candidate.protocol === "socks5") &&
      !candidates.some((candidate) => candidate.protocol === "http") &&
      HTTP_DISCOVERY_PORTS.has(port)) {
    candidates.unshift({
      url: `http://${formattedHost}:${port}`,
      protocol: "http",
      source: "localhost",
    });
  }
  return candidates;
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

async function detectLoopbackProxies(): Promise<ProxyCandidate[]> {
  const checks = ["127.0.0.1", "::1"].flatMap((host) =>
    COMMON_PROXY_PORTS.map((port) => probeLoopback(host, port)));
  const results = await Promise.all(checks);
  return dedupeCandidates(results.flat()).sort((left, right) => {
    const portDifference = proxyUrlPort(parseProxyUrl(left.url)) - proxyUrlPort(parseProxyUrl(right.url));
    if (portDifference !== 0) return portDifference;
    return left.protocol === right.protocol ? 0 : left.protocol === "http" ? -1 : 1;
  });
}

function candidateKey(candidate: ProxyCandidate): string {
  try {
    const parsed = parseProxyUrl(candidate.url);
    return [candidate.protocol, hostWithoutBrackets(parsed.hostname).toLowerCase(), proxyUrlPort(parsed), candidate.username || ""].join("|");
  } catch {
    return `${candidate.protocol}|${candidate.url}|${candidate.username || ""}`;
  }
}

function dedupeCandidates(candidates: ProxyCandidate[]): ProxyCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidateKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Discover environment, Windows and loopback proxy candidates in that order. */
export async function detectProxyCandidates(): Promise<ProxyCandidate[]> {
  const [environment, windows, localhost] = await Promise.all([
    Promise.resolve(detectEnvironmentProxies()),
    readWindowsProxyCandidates(),
    detectLoopbackProxies(),
  ]);
  return dedupeCandidates([...environment, ...windows, ...localhost]);
}

function proxyAuthHeader(config: ProxyConfig): string {
  if (!config.username && !config.password) return "";
  return `Proxy-Authorization: Basic ${Buffer.from(`${config.username}:${config.password}`, "utf8").toString("base64")}\r\n`;
}

async function testHttpProxy(config: ProxyConfig, parsed: URL): Promise<void> {
  let socket: Socket | undefined;
  try {
    socket = await socketConnect(hostWithoutBrackets(parsed.hostname), proxyUrlPort(parsed), parsed.protocol === "https:");
    const request = `CONNECT 0.0.0.0:0 HTTP/1.1\r\nHost: 0.0.0.0:0\r\nProxy-Connection: Keep-Alive\r\n${proxyAuthHeader(config)}\r\n`;
    socket.write(request);
    const response = await readPacket(socket, HANDSHAKE_TIMEOUT_MS);
    const status = httpStatus(response);
    if (status === undefined) throw new Error("代理协议不匹配：未收到 HTTP 状态行");
    if (status === 407) throw new Error("代理认证失败，请检查用户名和密码");
  } catch (error) {
    if (error instanceof Error && /代理(协议不匹配|认证失败|连接被拒绝|连接超时|握手超时)/u.test(error.message)) throw error;
    throw new Error(error instanceof Error ? `代理连接失败：${error.message}` : "代理连接失败");
  } finally {
    destroySocket(socket);
  }
}

async function testSocksProxy(config: ProxyConfig, parsed: URL): Promise<void> {
  let socket: Socket | undefined;
  try {
    socket = await socketConnect(hostWithoutBrackets(parsed.hostname), proxyUrlPort(parsed), false);
    const hasCredentials = Boolean(config.username || config.password);
    socket.write(Buffer.from(hasCredentials ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
    const greeting = await readPacket(socket, HANDSHAKE_TIMEOUT_MS, 2);
    if (greeting[0] !== 0x05) throw new Error("代理协议不匹配：目标不是 SOCKS5 代理");
    const method = greeting[1];
    if (method === 0xff || method === undefined) throw new Error("代理认证失败：SOCKS5 不接受提供的认证方式");
    if (method === 0x02) {
      if (!hasCredentials) throw new Error("代理需要用户名和密码");
      const username = Buffer.from(config.username, "utf8");
      const password = Buffer.from(config.password, "utf8");
      if (username.length > 255 || password.length > 255) throw new Error("代理用户名或密码过长");
      socket.write(Buffer.concat([Buffer.from([0x01, username.length]), username, Buffer.from([password.length]), password]));
      const auth = await readPacket(socket, HANDSHAKE_TIMEOUT_MS, 2);
      if (auth[0] !== 0x01 || auth[1] !== 0x00) throw new Error("代理认证失败，请检查用户名和密码");
    } else if (method !== 0x00) {
      throw new Error("代理认证失败：SOCKS5 认证方式不受支持");
    }
  } catch (error) {
    if (error instanceof Error && /代理(协议不匹配|认证失败|需要用户名|用户名或密码过长|连接被拒绝|连接超时|握手超时)/u.test(error.message)) throw error;
    throw new Error(error instanceof Error ? `代理连接失败：${error.message}` : "代理连接失败");
  } finally {
    destroySocket(socket);
  }
}

/** Test proxy connectivity and handshake without connecting to an external host. */
export async function testProxyEndpoint(config: ProxyConfig): Promise<{ protocol: ProxyProtocol; host: string; port: number }> {
  const normalized = normalizeProxyConfig({ ...config, enabled: true });
  const parsed = parseProxyUrl(normalized.url);
  const protocol = protocolForUrl(parsed);
  if (protocol === "socks5") await testSocksProxy(normalized, parsed);
  else await testHttpProxy(normalized, parsed);
  return { protocol, host: hostWithoutBrackets(parsed.hostname), port: proxyUrlPort(parsed) };
}
