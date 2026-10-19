// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "../settings/page";

const SETTINGS = {
  base_url: "https://gateway.example/v1",
  api_key: "sk-masked",
  api_format: "openai_chat",
  model_parse: "initial-parser",
  model_summary: "initial-summary",
  model_question: "initial-question",
  model_evaluate: "initial-evaluator",
  max_output_tokens: "8192",
  ocr_mode: "auto",
  proxy_enabled: false,
  proxy_url: "http://127.0.0.1:7890",
  proxy_username: "initial-user",
  proxy_password: "masked-password",
};

const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const originalScrollIntoView = Element.prototype.scrollIntoView;
let failures: Map<string, string>;
let saveWarning: string | null;
let statsRequests: number;

function requestBody(path: string) {
  const request = fetchMock.mock.calls.find(([url, init]) => String(url) === path &&
    (init?.method === "POST" || init?.method === "PUT"));
  expect(request).toBeTruthy();
  return JSON.parse(String(request?.[1]?.body));
}

beforeEach(() => {
  failures = new Map();
  saveWarning = null;
  statsRequests = 0;
  fetchMock.mockReset().mockImplementation(async (url, init) => {
    const path = String(url).split("?")[0]!;
    const failure = failures.get(path);
    if (failure) return Response.json({ error: failure }, { status: 503 });
    if (path === "/api/settings") {
      if (init?.method === "PUT") return Response.json({
        ...JSON.parse(String(init.body)), api_key: "sk-saved-mask", proxy_password: "saved-mask", baseUrlWarning: saveWarning,
      });
      return Response.json(SETTINGS);
    }
    if (path === "/api/settings/llm-usage") return Response.json({ calls: 7 });
    if (path === "/api/backup/stats") {
      statsRequests += 1;
      return Response.json({ ok: true, stats: {
        resumes: statsRequests === 1 ? 3 : 5, projects: 2, interviews: 1, drills: 4,
        bank_entries: 10, notebook_entries: 6, intros: 5, templates: 2,
        totalRecords: 33, hasAiConfig: true, dbVersion: 1,
      } });
    }
    if (path === "/api/settings/models") return Response.json({ ok: true, models: ["candidate-parser", "candidate-summary"] });
    if (path === "/api/settings/test") return Response.json({ ok: true, reply: "连接正常" });
    if (path === "/api/settings/proxy/detect") return Response.json({ ok: true, candidates: [
      { url: "socks5://127.0.0.1:10808", protocol: "socks5", source: "environment", username: "candidate-user" },
    ] });
    if (path === "/api/settings/proxy/test") return Response.json({ ok: true, protocol: "socks5", host: "127.0.0.1", port: 10808 });
    throw new Error(`未预期的请求：${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("设置页配置与连接行为", () => {
  it("连接测试期间锁定按钮，重复点击只发一个请求，完成后可重试", async () => {
    const original = fetchMock.getMockImplementation()!;
    const releases: (() => void)[] = [];
    fetchMock.mockImplementation((url, init) => String(url) === "/api/settings/test"
      ? new Promise((resolve) => { releases.push(() => resolve(Response.json({ ok: true, reply: "ok" }))); })
      : original(url, init));
    render(<SettingsPage />);
    const button = await screen.findByRole("button", { name: "测试连接" });
    try {
      fireEvent.click(button);
      fireEvent.click(button);
      expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/settings/test")).toHaveLength(1);
      expect((button as HTMLButtonElement).disabled).toBe(true);
    } finally {
      await act(async () => { releases.forEach((release) => release()); });
    }
    const ready = await screen.findByRole("button", { name: "测试连接" });
    expect((ready as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(ready);
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/settings/test")).toHaveLength(2);
    await act(async () => { releases.forEach((release) => release()); });
  });

  it("离开设置页时取消仍在途的模型连接测试", async () => {
    const original = fetchMock.getMockImplementation()!;
    let signal: AbortSignal | null | undefined;
    let release: (() => void) | undefined;
    fetchMock.mockImplementation((url, init) => String(url) === "/api/settings/test"
      ? new Promise((resolve, reject) => {
        signal = init?.signal;
        release = () => resolve(Response.json({ ok: true, reply: "ok" }));
        signal?.addEventListener("abort", () => reject(signal!.reason), { once: true });
      })
      : original(url, init));
    const view = render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "测试连接" }));
    view.unmount();
    try {
      expect(signal?.aborted).toBe(true);
    } finally {
      await act(async () => { release?.(); });
    }
  });

  it("编辑协议、凭证、任务模型和 OCR 后保存原始字段，回填脱敏结果并刷新备份统计", async () => {
    saveWarning = "地址已规范化";
    render(<SettingsPage />);
    await screen.findByText("简历 3 份");
    expect(screen.getByText(/本月调用 7 次/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Anthropic Messages/ }));
    fireEvent.change(screen.getByPlaceholderText("https://api.anthropic.com/v1"), { target: { value: "https://claude.example/v1" } });
    fireEvent.change(screen.getByPlaceholderText("sk-…"), { target: { value: "new-api-key" } });
    const parserField = screen.getAllByRole("combobox")[0]!;
    fireEvent.change(parserField, { target: { value: "edited-parser" } });
    fireEvent.blur(parserField);
    fireEvent.click(screen.getByRole("button", { name: "一键设置" }));
    fireEvent.click(screen.getByRole("button", { name: /纯本地离线 OCR/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    expect(await screen.findByText("已保存。地址已规范化")).toBeTruthy();
    expect(requestBody("/api/settings")).toEqual({
      ...SETTINGS, api_format: "anthropic_messages", base_url: "https://claude.example/v1",
      api_key: "new-api-key", model_parse: "edited-parser", model_summary: "edited-parser",
      model_question: "edited-parser", model_evaluate: "edited-parser", ocr_mode: "local",
    });
    expect((screen.getByPlaceholderText("sk-…") as HTMLInputElement).value).toBe("sk-saved-mask");
    expect(await screen.findByText("简历 5 份")).toBeTruthy();
    expect(statsRequests).toBe(2);
  });

  it("模型列表和连接测试使用当前未保存的配置，候选选择和连接反馈仍可用", async () => {
    render(<SettingsPage />);
    await screen.findByRole("button", { name: "获取模型列表" });
    fireEvent.change(screen.getByPlaceholderText("sk-…"), { target: { value: "unsaved-api-key" } });
    fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
    expect(await screen.findByText("已获取 2 个模型，可在下方输入框直接选择")).toBeTruthy();
    expect(requestBody("/api/settings/models")).toEqual({
      base_url: SETTINGS.base_url, api_key: "unsaved-api-key", api_format: SETTINGS.api_format,
      proxy_enabled: false, proxy_url: SETTINGS.proxy_url,
      proxy_username: SETTINGS.proxy_username, proxy_password: SETTINGS.proxy_password,
    });

    const parser = screen.getAllByRole("combobox")[0]!;
    fireEvent.click(screen.getAllByRole("button", { name: "展开全部候选" })[0]!);
    fireEvent.click(screen.getByRole("option", { name: "candidate-parser" }));
    expect((parser as HTMLInputElement).value).toBe("");
    expect(screen.getByText("candidate-parser")).toBeTruthy();

    // 重新打开下拉：当前已选模型带 ✔；输入过滤时打勾保持在已选项上
    fireEvent.click(screen.getAllByRole("button", { name: "展开全部候选" })[0]!);
    expect(screen.getByRole("option", { name: "candidate-parser", selected: true })).toBeTruthy();
    fireEvent.change(parser, { target: { value: "cand" } });
    expect(screen.getByRole("option", { name: "candidate-parser", selected: true })).toBeTruthy();
    expect(screen.getByRole("option", { name: "candidate-summary", selected: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("连接成功，模型回复：连接正常")).toBeTruthy();
    expect(requestBody("/api/settings/test")).toEqual({
      ...requestBody("/api/settings/models"), model: "candidate-parser",
    });
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/settings" && init?.method === "PUT")).toBe(false);
  });

  it("代理候选填入用户名并清空旧密码，测试后保存启用与关闭使用同一配置", async () => {
    render(<SettingsPage />);
    await screen.findByRole("button", { name: "嗅探本机代理" });
    fireEvent.click(screen.getByRole("button", { name: "嗅探本机代理" }));
    expect(await screen.findByText("发现 1 个代理候选")).toBeTruthy();
    expect(screen.getByText("环境变量")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "使用" }));
    expect(screen.getByText("候选已填入，请按需补充认证信息后测试")).toBeTruthy();
    expect((screen.getByLabelText("用户名（可选）") as HTMLInputElement).value).toBe("candidate-user");
    const password = screen.getByLabelText("密码（可选，保存后脱敏）");
    expect((password as HTMLInputElement).value).toBe("");
    fireEvent.change(password, { target: { value: "candidate-password" } });
    fireEvent.click(screen.getByRole("button", { name: "测试代理" }));
    expect(await screen.findByText("代理可用：socks5://127.0.0.1:10808")).toBeTruthy();
    expect(requestBody("/api/settings/proxy/test")).toEqual({
      proxy_enabled: true, proxy_url: "socks5://127.0.0.1:10808",
      proxy_username: "candidate-user", proxy_password: "candidate-password",
    });

    fireEvent.click(screen.getByRole("button", { name: "保存并启用" }));
    await screen.findByText("已启用");
    expect(requestBody("/api/settings")).toEqual({
      ...SETTINGS, ...requestBody("/api/settings/proxy/test"),
    });
    fireEvent.click(screen.getByRole("button", { name: "关闭代理" }));
    await screen.findByText("未启用");
    const saves = fetchMock.mock.calls.filter(([url, init]) => url === "/api/settings" && init?.method === "PUT");
    expect(JSON.parse(String(saves[1]?.[1]?.body))).toEqual({
      ...SETTINGS, proxy_url: "socks5://127.0.0.1:10808", proxy_username: "candidate-user",
      api_key: "sk-saved-mask", proxy_password: "saved-mask", proxy_enabled: false,
    });
    await waitFor(() => expect(statsRequests).toBe(3));
  });

  it.each([
    ["获取模型列表", "/api/settings/models", "获取模型失败：上游暂不可用"],
    ["测试连接", "/api/settings/test", "测试失败：上游暂不可用"],
    ["嗅探本机代理", "/api/settings/proxy/detect", "嗅探失败：上游暂不可用"],
    ["测试代理", "/api/settings/proxy/test", "代理测试失败：上游暂不可用"],
    ["保存配置", "/api/settings", "保存失败：上游暂不可用"],
  ])("%s 失败后保留输入并恢复操作按钮", async (buttonName, path, feedback) => {
    render(<SettingsPage />);
    await screen.findByRole("button", { name: buttonName });
    fireEvent.change(screen.getByPlaceholderText("sk-…"), { target: { value: "keep-unsaved-key" } });
    failures.set(path, "上游暂不可用");
    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    expect(await screen.findByText(feedback)).toBeTruthy();
    expect((screen.getByPlaceholderText("sk-…") as HTMLInputElement).value).toBe("keep-unsaved-key");
    expect((screen.getByRole("button", { name: buttonName }) as HTMLButtonElement).disabled).toBe(false);
    expect(statsRequests).toBe(1);
  });

  it("设置加载失败不显示可写配置，重试成功后恢复表单且用量失败静默降级", async () => {
    failures.set("/api/settings", "设置暂不可用");
    failures.set("/api/settings/llm-usage", "计数暂不可用");
    render(<SettingsPage />);
    expect((await screen.findByRole("alert")).textContent).toContain("加载设置失败：设置暂不可用");
    expect(screen.queryByPlaceholderText("sk-…")).toBeNull();
    expect(screen.queryByRole("button", { name: "保存配置" })).toBeNull();
    failures.delete("/api/settings");
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    await screen.findByRole("button", { name: "保存配置" });
    expect(screen.getByText("查看 AI 调用的 token 计量、来源追踪与缓存命中率")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("支持在任务级模型分工配置中修改最大输出 token 限制并保存", async () => {
    render(<SettingsPage />);
    await screen.findByRole("button", { name: "保存配置" });
    const tokenInput = screen.getByLabelText("最大输出 Token 限制") as HTMLInputElement;
    expect(tokenInput.value).toBe("8192");
    fireEvent.change(tokenInput, { target: { value: "16384" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByText("已保存")).toBeTruthy();
    expect(requestBody("/api/settings")).toMatchObject({ max_output_tokens: "16384" });
  });
});
