import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, { value: registry.query });
  return { ...original, execFile };
});
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let enabled = "0x1", server = "localhost:7890";

beforeEach(() => {
  vi.resetModules(); registry.query.mockReset();
  enabled = "0x1"; server = "localhost:7890";
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  registry.query.mockImplementation(async (_file: string, args: string[]) => ({
    stdout: `HKEY_CURRENT_USER\\Synthetic\r\n    ${args.at(-1)}    ${args.at(-1) === "ProxyEnable" ? "REG_DWORD" : "REG_SZ"}    ${args.at(-1) === "ProxyEnable" ? enabled : server}\r\n`,
    stderr: "",
  }));
});
afterEach(() => { Object.defineProperty(process, "platform", platform); vi.resetModules(); });
const candidates = async () => (await import("../proxy-detect")).readWindowsProxyCandidates();

describe("Windows 只读注册表代理发现", () => {
  it("非 Windows 不读取注册表", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    expect(await candidates()).toEqual([]);
    expect(registry.query).not.toHaveBeenCalled();
  });
  it.each(["0x0", "0", "0x2", "invalid", ""])("禁用或无效的 ProxyEnable %s 不查询服务器", async value => {
    enabled = value;
    expect(await candidates()).toEqual([]);
    expect(registry.query).toHaveBeenCalledTimes(1);
  });
  it.each(["1", "0x1", "0X0001"])("启用值 %s 使用固定只读参数与隐藏窗口", async value => {
    enabled = value;
    expect(await candidates()).toEqual([{ url: "http://localhost:7890", protocol: "http", source: "windows" }]);
    expect(registry.query).toHaveBeenNthCalledWith(1, "reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyEnable"], { windowsHide: true, maxBuffer: 32768 });
  });
  it("协议列表转换 SOCKS、排除 PAC、剥离密码并去重", async () => {
    server = "http=demo%20user:synthetic-password@LOCALHOST:7890;https=localhost:8443;socks=localhost:1080;socks5h=localhost:1080;pac=http://localhost/config.pac;http=http://localhost/a.pac?x=1";
    const result = await candidates();
    expect(result).toEqual([
      { url: "http://localhost:7890", protocol: "http", source: "windows", username: "demo user" },
      { url: "https://localhost:8443", protocol: "https", source: "windows" },
      { url: "socks5://localhost:1080", protocol: "socks5", source: "windows" },
    ]);
    expect(JSON.stringify(result)).not.toContain("synthetic-password");
  });
  it.each(["", "http=;socks=;", "http=localhost:70000", "http=ftp://localhost:21", "http=http://bad%zz:pw@localhost"])("无效或空 ProxyServer %s 不产生候选", async value => {
    server = value;
    expect(await candidates()).toEqual([]);
  });
  it("已有协议 URL 保持协议并规范 IPv6", async () => {
    server = "socks5h://[::1]:1080";
    expect(await candidates()).toEqual([{ url: "socks5://[::1]:1080", protocol: "socks5", source: "windows" }]);
  });
  it("单个带协议键的配置保持协议，URL 凭证中的等号不作协议分隔", async () => {
    server = "https=localhost:8443";
    expect(await candidates()).toEqual([{ url: "https://localhost:8443", protocol: "https", source: "windows" }]);
    server = "http://user%3Dname:synthetic-password@localhost:7890";
    expect(await candidates()).toEqual([{ url: "http://localhost:7890", protocol: "http", source: "windows", username: "user=name" }]);
  });
  it("注册表缺失与执行错误返回空候选", async () => {
    registry.query.mockRejectedValueOnce(new Error("Synthetic missing registry key"));
    expect(await candidates()).toEqual([]);
    registry.query.mockResolvedValueOnce({ stdout: "ProxyEnable REG_DWORD 0x1", stderr: "" });
    registry.query.mockRejectedValueOnce(new Error("Synthetic access failure"));
    expect(await candidates()).toEqual([]);
  });
});
