// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { McpConnectionPanel } from "../mcp-connection-panel";
import type { McpConnectionReport } from "@/lib/mcp-connection-types";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), copy: vi.fn() }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: mocks.fetch }));
const report: McpConnectionReport = {
  node: "v24.21.0", nodePath: "C:/Node/node.exe", projectRoot: "C:/project", dataDirectory: "C:/data", repositoryRoots: [],
  presets: ["readonly", "preparation", "collaboration", "training", "authoring"].map(name => ({ name: name as McpConnectionReport["presets"][number]["name"], label: name, description: "描述" })),
  checks: [{ id: "ocr", label: "本地 OCR", state: "warning", detail: "未找到", repair: "npm run setup:ocr" }], canGenerate: true, status: null,
};
const generated = { preset: "readonly", format: "json", text: "CONFIG_JSON", toolCount: 1, writeEnabled: false, firstCallAvailable: true };
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (value: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
beforeEach(() => {
  mocks.fetch.mockReset(); mocks.copy.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: mocks.copy }, configurable: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function ready() {
  mocks.fetch.mockResolvedValueOnce(report);
  render(<McpConnectionPanel />);
  await screen.findByLabelText("权限预设");
}

it("renders all five presets, local repair steps, generates selected format and copies exact text", async () => {
  await ready();
  expect(screen.getByText(/外部 Host 连接状态：未验证/)).toBeTruthy();
  expect(screen.getAllByRole("option")).toHaveLength(7);
  expect(screen.getByText(/建议：npm run setup:ocr/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("权限预设"), { target: { value: "authoring" } });
  fireEvent.change(screen.getByLabelText("配置格式"), { target: { value: "codex" } });
  mocks.fetch.mockResolvedValueOnce({ ...generated, preset: "authoring", format: "codex", text: "CONFIG_TOML" });
  fireEvent.click(screen.getByRole("button", { name: "生成 MCP 配置" }));
  await screen.findByDisplayValue("CONFIG_TOML");
  expect(mocks.fetch.mock.calls[1]?.[1]).toMatchObject({ method: "POST", body: '{"preset":"authoring","format":"codex"}' });
  fireEvent.click(screen.getByRole("button", { name: "复制 MCP 配置" }));
  await screen.findByRole("status");
  expect(mocks.copy).toHaveBeenCalledWith("CONFIG_TOML");
});

it("shows job, resource and cache counts without calling an external Host", async () => {
  mocks.fetch.mockResolvedValueOnce({ ...report, status: { databaseVersion: 14, operationLogCount: 3, drafts: { total: 0, available: 0, expired: 0 }, generationRequests: { pending: 0, interrupted: 0, succeeded: 0, failed: 0 },
    jobs: { running: 2, waiting: 1, interrupted: 3, succeeded: 4, failed: 1, cancelled: 0, invalidated: 0 }, leases: [{ resource: "render", active: 2 }], cache: { totalBytes: 1024 * 1024, maxBytes: 100 * 1024 * 1024, ttlHours: 24 } } });
  render(<McpConnectionPanel />);
  expect((await screen.findByRole("status")).textContent).toContain("运行中 2，其中等待资源 1");
  expect(screen.getByText(/临时缓存：1.0 \/ 100.0 MiB/)).toBeTruthy();
  expect(screen.getByText(/正在占用：渲染 2/)).toBeTruthy();
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

it("diagnostic and generation failures can be retried; failed copy retains manually selectable text", async () => {
  mocks.fetch.mockRejectedValueOnce(new Error("network"));
  render(<McpConnectionPanel />); await screen.findByRole("alert");
  mocks.fetch.mockResolvedValueOnce(report); fireEvent.click(screen.getByRole("button", { name: "刷新诊断" }));
  await screen.findByLabelText("权限预设");
  mocks.fetch.mockRejectedValueOnce(new Error("fail")); fireEvent.click(screen.getByRole("button", { name: "生成 MCP 配置" }));
  await screen.findByRole("alert");
  mocks.fetch.mockResolvedValueOnce(generated); fireEvent.click(screen.getByRole("button", { name: "生成 MCP 配置" }));
  await screen.findByDisplayValue("CONFIG_JSON"); mocks.copy.mockRejectedValueOnce(new Error("denied"));
  fireEvent.click(screen.getByRole("button", { name: "复制 MCP 配置" }));
  expect((await screen.findByRole("alert")).textContent).toContain("手动复制");
  expect(screen.getByDisplayValue("CONFIG_JSON")).toBeTruthy();
});

it("changing preset cancels pending work and late results cannot overwrite the current configuration", async () => {
  await ready(); const old = deferred<typeof generated>(); mocks.fetch.mockReturnValueOnce(old.promise);
  fireEvent.click(screen.getByRole("button", { name: "生成 MCP 配置" }));
  const signal = mocks.fetch.mock.calls[1]?.[1].signal as AbortSignal;
  fireEvent.change(screen.getByLabelText("权限预设"), { target: { value: "training" } });
  expect(signal.aborted).toBe(true);
  mocks.fetch.mockResolvedValueOnce({ ...generated, text: "NEW" }); fireEvent.click(screen.getByRole("button", { name: "生成 MCP 配置" }));
  await screen.findByDisplayValue("NEW");
  await act(async () => { old.resolve(generated); });
  expect(screen.queryByDisplayValue("CONFIG_JSON")).toBeNull(); expect(screen.getByDisplayValue("NEW")).toBeTruthy();
});

it("refresh invalidates copied configuration and ignores a late clipboard success", async () => {
  await ready(); mocks.fetch.mockResolvedValueOnce(generated); fireEvent.click(screen.getByRole("button", { name: "生成 MCP 配置" }));
  await screen.findByDisplayValue("CONFIG_JSON"); const old = deferred<void>(); mocks.copy.mockReturnValueOnce(old.promise);
  fireEvent.click(screen.getByRole("button", { name: "复制 MCP 配置" }));
  mocks.fetch.mockResolvedValueOnce(report); fireEvent.click(screen.getByRole("button", { name: "刷新诊断" }));
  await screen.findByLabelText("权限预设"); await act(async () => { old.resolve(); });
  expect(screen.queryByRole("status")).toBeNull(); expect(screen.queryByDisplayValue("CONFIG_JSON")).toBeNull();
});

it("unmount cancels diagnostics and generation; remount owns its own state", async () => {
  const first = deferred<McpConnectionReport>(); mocks.fetch.mockReturnValueOnce(first.promise);
  const old = render(<McpConnectionPanel />); await waitFor(() => expect(mocks.fetch).toHaveBeenCalled()); const signal = mocks.fetch.mock.calls[0]?.[1].signal as AbortSignal;
  old.unmount(); expect(signal.aborted).toBe(true);
  await ready(); await act(async () => { first.reject(new Error("old failure")); });
  expect(screen.queryByRole("alert")).toBeNull();
  const generation = deferred<typeof generated>(); mocks.fetch.mockReturnValueOnce(generation.promise);
  fireEvent.click(screen.getByRole("button", { name: "生成 MCP 配置" }));
  const secondSignal = mocks.fetch.mock.calls.at(-1)?.[1].signal as AbortSignal;
  cleanup(); expect(secondSignal.aborted).toBe(true); await act(async () => { generation.resolve(generated); });
});

it("blocks generation when required diagnostics fail and warns for empty effective permissions", async () => {
  mocks.fetch.mockResolvedValueOnce({ ...report, canGenerate: false }); render(<McpConnectionPanel />);
  expect((await screen.findByRole("button", { name: "生成 MCP 配置" }) as HTMLButtonElement).disabled).toBe(true);
  mocks.fetch.mockResolvedValueOnce(report); fireEvent.click(screen.getByRole("button", { name: "刷新诊断" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "生成 MCP 配置" }) as HTMLButtonElement).disabled).toBe(false));
  mocks.fetch.mockResolvedValueOnce({ ...generated, toolCount: 0, firstCallAvailable: false });
  fireEvent.click(screen.getByRole("button", { name: "生成 MCP 配置" }));
  await screen.findByText(/当前白名单交集为空/); expect(screen.getByText(/当前白名单未开放/)).toBeTruthy();
});
