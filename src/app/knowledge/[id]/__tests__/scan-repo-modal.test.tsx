/** @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScanRepoModal } from "../scan-repo-modal";
import { emptySummary } from "@/lib/summary";
import { compareProjectSummaries } from "@/lib/project-summary-diff";
import { CUSTOM_CLI_PROFILES_KEY } from "@/lib/custom-cli-storage";

const requests = vi.hoisted(() => ({ jsonFetch: vi.fn(), fetchSse: vi.fn(), confirm: vi.fn() }));

vi.mock("@/lib/fetcher", () => ({ jsonFetch: requests.jsonFetch }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: requests.fetchSse }));
vi.mock("../directory-picker-dialog", () => ({ DirectoryPickerDialog: () => null }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: requests.confirm }));

const firstPath = "D:\\synthetic\\first-project";
const secondPath = "D:\\synthetic\\second-project";
const baseProps = {
  open: true,
  projectId: 1,
  projectName: "演示项目",
  repoPaths: [firstPath],
  onPathsChange: vi.fn(),
  onClose: vi.fn(),
  onSuccess: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  requests.confirm.mockReset().mockResolvedValue(true);
  requests.jsonFetch.mockResolvedValue({
    codex: { available: true },
    claude: { available: false },
    recommended: "codex",
  });
  requests.fetchSse.mockImplementation(() => new Promise(() => {}));
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Relation = { isRelated: boolean | null; reason: string; method: string };
const related: Relation = { isRelated: true, reason: "有共同模块", method: "model" };

function enterCustomCli(command = "node", args = '["D:/tools/sdk client.mjs", "--text"]') {
  fireEvent.click(screen.getByRole("button", { name: /自定义 CLI \/ SDK/ }));
  fireEvent.change(screen.getByLabelText(/可执行程序/), { target: { value: command } });
  fireEvent.change(screen.getByLabelText("命令参数（JSON 数组）"), { target: { value: args } });
}

describe("自定义 CLI / SDK 客户端", () => {
  it("无内置 CLI 时仍能启动自定义命令，预检和扫描携带同一配置", async () => {
    requests.jsonFetch.mockResolvedValueOnce({ codex: { available: false }, claude: { available: false }, recommended: null });
    render(<ScanRepoModal {...baseProps} repoPaths={[firstPath, secondPath]} />);
    await waitFor(() => expect(screen.getAllByText("未检测到")).toHaveLength(2));
    enterCustomCli();
    const preview = screen.getByRole("region", { name: "最终命令预览" });
    expect(preview.querySelector("code")?.textContent).toBe('node "D:/tools/sdk client.mjs" --text\nstdin: {{PROMPT}}');
    expect(preview.textContent).not.toContain(firstPath);
    requests.jsonFetch.mockResolvedValueOnce(related);
    fireEvent.click(screen.getByRole("button", { name: "合并扫描 2 个代码库" }));
    await waitFor(() => expect(requests.fetchSse).toHaveBeenCalledOnce());
    const selection = { preferredCli: "custom", customCli: { command: "node", args: ["D:/tools/sdk client.mjs", "--text"] } };
    expect(JSON.parse(requests.jsonFetch.mock.calls[1]![1].body)).toMatchObject(selection);
    expect(requests.fetchSse.mock.calls[0]![1].body).toMatchObject(selection);
    expect(screen.getByLabelText(/可执行程序/).closest("fieldset")?.disabled).toBe(true);
  });

  it.each(["--text", '["--text", 42]'])("错误参数 %s 在请求前提示，切换内置客户端不携带旧命令", async args => {
    render(<ScanRepoModal {...baseProps} />);
    await waitFor(() => expect(requests.jsonFetch).toHaveBeenCalledOnce());
    enterCustomCli("node", args);
    fireEvent.click(screen.getByRole("button", { name: "开始扫描并提炼" }));
    expect(screen.getByText(/命令参数须为/, { selector: "div" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "最终命令预览" }).querySelector("code")).toBeNull();
    expect(requests.fetchSse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Codex CLI/ }));
    fireEvent.click(screen.getByRole("button", { name: "开始扫描并提炼" }));
    expect(requests.fetchSse.mock.calls[0]![1].body).toEqual({ repoPaths: [firstPath], preferredCli: "codex" });
  });

  it("切换其他客户端再返回时保留新建配置的完整草稿，关闭弹窗才重置", async () => {
    requests.jsonFetch.mockResolvedValue({ codex: { available: true }, claude: { available: true }, recommended: "codex" });
    const view = render(<ScanRepoModal {...baseProps} />);
    await waitFor(() => expect(requests.jsonFetch).toHaveBeenCalledOnce());
    enterCustomCli();
    fireEvent.change(screen.getByLabelText("客户端名称（保存时填写）"), { target: { value: "待保存 SDK" } });

    for (const name of [/智能推荐/, /Codex CLI/, /Claude Code/]) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(screen.queryByLabelText("已保存的客户端")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /自定义 CLI \/ SDK/ }));
      expect((screen.getByLabelText("已保存的客户端") as HTMLSelectElement).value).toBe("");
      expect((screen.getByLabelText("客户端名称（保存时填写）") as HTMLInputElement).value).toBe("待保存 SDK");
      expect((screen.getByLabelText(/可执行程序/) as HTMLInputElement).value).toBe("node");
      expect((screen.getByLabelText("命令参数（JSON 数组）") as HTMLTextAreaElement).value).toBe('["D:/tools/sdk client.mjs", "--text"]');
      expect(screen.getByRole("region", { name: "最终命令预览" }).querySelector("code")?.textContent).toBe('node "D:/tools/sdk client.mjs" --text\nstdin: {{PROMPT}}');
    }
    expect(localStorage.getItem(CUSTOM_CLI_PROFILES_KEY)).toBeNull();

    view.rerender(<ScanRepoModal {...baseProps} open={false} />);
    view.rerender(<ScanRepoModal {...baseProps} />);
    await waitFor(() => expect(requests.jsonFetch).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: /自定义 CLI \/ SDK/ }));
    expect((screen.getByLabelText("已保存的客户端") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("客户端名称（保存时填写）") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/可执行程序/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("命令参数（JSON 数组）") as HTMLTextAreaElement).value).toBe("[]");
  });

  it("保存、切换、更新和删除多客户端配置，重开可复用", async () => {
    requests.jsonFetch.mockResolvedValue({ codex: { available: true }, claude: { available: true }, recommended: "codex" });
    const view = render(<ScanRepoModal {...baseProps} />);
    await waitFor(() => expect(requests.jsonFetch).toHaveBeenCalledOnce());
    enterCustomCli();
    fireEvent.change(screen.getByLabelText("客户端名称（保存时填写）"), { target: { value: "团队 SDK" } });
    fireEvent.click(screen.getByRole("button", { name: "保存客户端配置" }));
    const firstId = (screen.getByLabelText("已保存的客户端") as HTMLSelectElement).value;
    fireEvent.change(screen.getByLabelText("已保存的客户端"), { target: { value: "" } });
    enterCustomCli("python", '["D:/tools/second.py"]');
    fireEvent.change(screen.getByLabelText("客户端名称（保存时填写）"), { target: { value: "第二客户端" } });
    fireEvent.click(screen.getByRole("button", { name: "保存客户端配置" }));
    expect(JSON.parse(localStorage.getItem(CUSTOM_CLI_PROFILES_KEY)!)).toHaveLength(2);
    view.rerender(<ScanRepoModal {...baseProps} open={false} />);
    view.rerender(<ScanRepoModal {...baseProps} />);
    await waitFor(() => expect(requests.jsonFetch).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: /自定义 CLI \/ SDK/ }));
    fireEvent.change(screen.getByLabelText("已保存的客户端"), { target: { value: firstId } });
    expect((screen.getByLabelText(/可执行程序/) as HTMLInputElement).value).toBe("node");
    expect(JSON.parse((screen.getByLabelText("命令参数（JSON 数组）") as HTMLTextAreaElement).value)).toEqual(["D:/tools/sdk client.mjs", "--text"]);
    expect(screen.getByRole("region", { name: "最终命令预览" }).querySelector("code")?.textContent).toBe('node "D:/tools/sdk client.mjs" --text\nstdin: {{PROMPT}}');
    fireEvent.change(screen.getByLabelText(/可执行程序/), { target: { value: "updated-client" } });
    fireEvent.change(screen.getByLabelText("客户端名称（保存时填写）"), { target: { value: "更新后的 SDK" } });
    for (const name of [/智能推荐/, /Codex CLI/, /Claude Code/]) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(screen.queryByLabelText("已保存的客户端")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /自定义 CLI \/ SDK/ }));
      expect((screen.getByLabelText("已保存的客户端") as HTMLSelectElement).value).toBe(firstId);
      expect((screen.getByLabelText("客户端名称（保存时填写）") as HTMLInputElement).value).toBe("更新后的 SDK");
      expect((screen.getByLabelText(/可执行程序/) as HTMLInputElement).value).toBe("updated-client");
      expect(JSON.parse((screen.getByLabelText("命令参数（JSON 数组）") as HTMLTextAreaElement).value)).toEqual(["D:/tools/sdk client.mjs", "--text"]);
      expect(screen.getByRole("region", { name: "最终命令预览" }).querySelector("code")?.textContent).toBe('updated-client "D:/tools/sdk client.mjs" --text\nstdin: {{PROMPT}}');
      expect(screen.getByRole("button", { name: "更新客户端配置" })).toBeTruthy();
    }
    expect(JSON.parse(localStorage.getItem(CUSTOM_CLI_PROFILES_KEY)!)[0]).toMatchObject({ id: firstId, name: "团队 SDK", command: "node" });
    fireEvent.click(screen.getByRole("button", { name: "更新客户端配置" }));
    const saved = JSON.parse(localStorage.getItem(CUSTOM_CLI_PROFILES_KEY)!);
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ id: firstId, name: "更新后的 SDK", command: "updated-client" });
    fireEvent.click(screen.getByRole("button", { name: "移除已保存客户端" }));
    expect(JSON.parse(localStorage.getItem(CUSTOM_CLI_PROFILES_KEY)!)).toMatchObject([{ name: "第二客户端", command: "python" }]);
  });

  it("存储失败明确提示，仍可直接使用当前命令", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("存储权限被关闭"); });
    render(<ScanRepoModal {...baseProps} />);
    await waitFor(() => expect(requests.jsonFetch).toHaveBeenCalledOnce());
    enterCustomCli();
    fireEvent.change(screen.getByLabelText("客户端名称（保存时填写）"), { target: { value: "SDK" } });
    fireEvent.click(screen.getByRole("button", { name: "保存客户端配置" }));
    expect(screen.getByRole("alert").textContent).toContain("存储权限被关闭");
    fireEvent.click(screen.getByRole("button", { name: "开始扫描并提炼" }));
    expect(requests.fetchSse.mock.calls[0]![1].body.preferredCli).toBe("custom");
  });
});

async function startPrecheck() {
  const view = render(<ScanRepoModal {...baseProps} repoPaths={[firstPath, secondPath]} />);
  await waitFor(() => expect(requests.jsonFetch).toHaveBeenCalledTimes(1));
  const request = deferred<Relation>();
  requests.jsonFetch.mockReturnValueOnce(request.promise);
  fireEvent.click(screen.getByRole("button", { name: "合并扫描 2 个代码库" }));
  await waitFor(() => expect(requests.jsonFetch).toHaveBeenCalledTimes(2));
  return { ...view, request };
}

describe("ScanRepoModal 初始化边界", () => {
  it.each(["Codex CLI", "智能推荐 (Auto)"])("晚到的环境检测不能改写用户选择的 %s", async (engine) => {
    const detected = deferred<{ codex: { available: boolean }; claude: { available: boolean }; recommended: "claude" }>();
    requests.jsonFetch.mockReturnValueOnce(detected.promise);
    render(<ScanRepoModal {...baseProps} />);
    await waitFor(() => expect(requests.jsonFetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(engine.replace(/[()]/g, "\\$&")) }));
    await act(async () => { detected.resolve({ codex: { available: true }, claude: { available: true }, recommended: "claude" }); });
    const preview = screen.getByRole("region", { name: "最终命令预览" }).querySelector("code")?.textContent;
    expect(preview).toContain(engine === "Codex CLI" ? "codex exec --skip-git-repo-check" : 'claude -p --output-format text --tools ""');
    expect(preview).toContain("stdin: {{PROMPT}}");
    fireEvent.click(screen.getByRole("button", { name: "开始扫描并提炼" }));
    expect(requests.fetchSse.mock.calls[0]![1].body.preferredCli).toBe(engine === "Codex CLI" ? "codex" : "auto");
  });

  it("关闭／项目切换会取消检测，重开不沿用旧可用性或未提交路径", async () => {
    const { rerender, unmount } = render(<ScanRepoModal {...baseProps} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Codex CLI/ }).querySelector('[title="已安装"]')).not.toBeNull());
    const firstSignal = requests.jsonFetch.mock.calls[0]![1]?.signal;
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "D:\\synthetic\\unsubmitted" } });
    fireEvent.click(screen.getByRole("button", { name: /Codex CLI/ }));
    rerender(<ScanRepoModal {...baseProps} open={false} />);
    expect(firstSignal?.aborted).toBe(true);

    const second = deferred<unknown>();
    requests.jsonFetch.mockReturnValueOnce(second.promise);
    rerender(<ScanRepoModal {...baseProps} />);
    await waitFor(() => expect(requests.jsonFetch).toHaveBeenCalledTimes(2));
    const secondSignal = requests.jsonFetch.mock.calls[1]![1]?.signal;
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
    expect(screen.getAllByText("检测中...")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Codex CLI/ }).querySelector('[title="已安装"]')).toBeNull();
    rerender(<ScanRepoModal {...baseProps} projectId={2} repoPaths={[secondPath]} />);
    expect(secondSignal?.aborted).toBe(true);
    await act(async () => { second.resolve({ codex: { available: false }, claude: { available: true }, recommended: "claude" }); });
    expect(screen.getByRole("button", { name: /Claude Code/ }).querySelector('[title="已安装"]')).toBeNull();
    expect(screen.getByText(secondPath)).toBeTruthy();
    expect(screen.queryByText(firstPath)).toBeNull();
    const currentSignal = requests.jsonFetch.mock.calls[2]![1]?.signal;
    unmount();
    expect(currentSignal?.aborted).toBe(true);
  });

  it("重开时使用最新外部路径，普通 props 更新不会重新探测或覆盖本地草稿", async () => {
    const { rerender } = render(<ScanRepoModal {...baseProps} />);
    await waitFor(() => expect(requests.jsonFetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "清空全部" }));
    expect(screen.queryByText(firstPath)).toBeNull();

    rerender(<ScanRepoModal {...baseProps} repoPaths={[secondPath]} />);
    await act(async () => { await Promise.resolve(); });
    expect(requests.jsonFetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(secondPath)).toBeNull();

    rerender(<ScanRepoModal {...baseProps} open={false} repoPaths={[secondPath]} />);
    rerender(<ScanRepoModal {...baseProps} repoPaths={[secondPath]} />);
    await waitFor(() => expect(screen.getByText(secondPath)).toBeDefined());
    expect(requests.jsonFetch).toHaveBeenCalledTimes(2);
  });

  it("父组件替换路径数组不取消正在进行的扫描，卸载仍会取消请求", async () => {
    const { rerender, unmount } = render(<ScanRepoModal {...baseProps} />);
    await waitFor(() => expect(requests.jsonFetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "开始扫描并提炼" }));
    await waitFor(() => expect(requests.fetchSse).toHaveBeenCalledTimes(1));
    const signal = (requests.fetchSse.mock.calls[0]![1] as { signal: AbortSignal }).signal;

    rerender(<ScanRepoModal {...baseProps} repoPaths={[firstPath]} />);
    await act(async () => { await Promise.resolve(); });
    expect(signal.aborted).toBe(false);
    expect(requests.jsonFetch).toHaveBeenCalledTimes(1);

    unmount();
    expect(signal.aborted).toBe(true);
  });
});

describe("扫描预检取消和降级", () => {
  it("从加载遮罩中取消预检，保留路径并明确反馈取消状态", async () => {
    const { request } = await startPrecheck();
    const overlay = screen.getByRole("status");
    const cancel = screen.getByRole("button", { name: "取消" });
    expect(overlay.contains(cancel)).toBe(true);
    fireEvent.click(cancel);
    expect(screen.getByRole("status").textContent).toContain("操作已被用户取消");
    expect(screen.getByText(firstPath)).toBeTruthy();
    expect(screen.getByText(secondPath)).toBeTruthy();
    expect((screen.getByRole("button", { name: "合并扫描 2 个代码库" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { request.resolve(related); });
    expect(requests.fetchSse).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"])("取消后预检 %s 都不能启动扫描", async (outcome) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { request } = await startPrecheck();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await act(async () => {
      if (outcome === "resolve") request.resolve(related);
      else request.reject(new Error("预检失败"));
    });
    expect(requests.fetchSse).not.toHaveBeenCalled();
    expect(requests.confirm).not.toHaveBeenCalled();
    expect(requests.jsonFetch.mock.calls[1]![1].signal.aborted).toBe(true);
  });

  it.each(["resolve", "reject"])("卸载后预检 %s 都不能启动扫描", async (outcome) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { request, unmount } = await startPrecheck();
    unmount();
    await act(async () => {
      if (outcome === "resolve") request.resolve(related);
      else request.reject(new Error("预检失败"));
    });
    expect(requests.fetchSse).not.toHaveBeenCalled();
    expect(requests.confirm).not.toHaveBeenCalled();
    expect(requests.jsonFetch.mock.calls[1]![1].signal.aborted).toBe(true);
  });

  it("旧预检晚到不会启动扫描或解除新操作的等待状态", async () => {
    const { request } = await startPrecheck();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    const next = deferred<Relation>();
    requests.jsonFetch.mockReturnValueOnce(next.promise);
    fireEvent.click(screen.getByRole("button", { name: "合并扫描 2 个代码库" }));
    await act(async () => { request.resolve(related); });
    expect(requests.fetchSse).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "AI 关联性研判中…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { next.resolve(related); });
    expect(requests.fetchSse).toHaveBeenCalledTimes(1);
    expect(requests.fetchSse.mock.calls[0]![1].signal).toBe(requests.jsonFetch.mock.calls[2]![1].signal);
  });

  it("预检期间外部关闭后重开，旧响应不能使弹窗一直繁忙", async () => {
    const { request, rerender } = await startPrecheck();
    rerender(<ScanRepoModal {...baseProps} open={false} repoPaths={[firstPath, secondPath]} />);
    rerender(<ScanRepoModal {...baseProps} repoPaths={[firstPath, secondPath]} />);
    await act(async () => { request.resolve(related); });
    expect(requests.fetchSse).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "合并扫描 2 个代码库" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("取消后忽略旧扫描回调及已排队的成功回调", async () => {
    render(<ScanRepoModal {...baseProps} />);
    await waitFor(() => expect(requests.jsonFetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "开始扫描并提炼" }));
    const options = requests.fetchSse.mock.calls[0]![1];
    vi.useFakeTimers();
    const summary = { ...emptySummary(), overview: "合成总结" };
    act(() => { options.onDone({ summary, comparison: compareProjectSummaries(emptySummary(), summary, {}), materialChanges: [], materialFingerprint: "a".repeat(64), revisionId: 0 }); });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    act(() => {
      options.onDelta("旧扫描不应回填");
      options.onError(new Error("旧扫描错误"));
      vi.advanceTimersByTime(400);
    });
    expect(baseProps.onSuccess).not.toHaveBeenCalled();
    expect(screen.queryByText("旧扫描错误")).toBeNull();
    expect(screen.queryByText("旧扫描不应回填")).toBeNull();
  });

  it("等待用户确认期间取消后，晚到的确认不能恢复扫描", async () => {
    const confirmation = deferred<boolean>();
    requests.confirm.mockReturnValueOnce(confirmation.promise);
    const { request } = await startPrecheck();
    await act(async () => { request.resolve({ isRelated: false, reason: "工程不同", method: "heuristic" }); });
    expect(requests.confirm).toHaveBeenCalledTimes(1);
    expect(requests.confirm.mock.calls[0]![0].signal).toBe(requests.jsonFetch.mock.calls[1]![1].signal);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await act(async () => { confirmation.resolve(true); });
    expect(requests.fetchSse).not.toHaveBeenCalled();
  });

  it.each([false, true])("未知关联明确提示并按用户选择 %s 继续", async (continueScan) => {
    requests.confirm.mockResolvedValueOnce(continueScan);
    const { request } = await startPrecheck();
    await act(async () => { request.resolve({ isRelated: null, method: "heuristic", reason: "无法确认关联，使用启发式降级" }); });
    expect(requests.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: "代码库关联性暂时无法确认", message: expect.stringContaining("启发式"),
    }));
    expect(requests.fetchSse).toHaveBeenCalledTimes(continueScan ? 1 : 0);
  });

  it("预检请求失败时需用户明确同意才继续", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    requests.confirm.mockResolvedValueOnce(false);
    const { request } = await startPrecheck();
    await act(async () => { request.reject(new Error("模拟网络故障")); });
    expect(requests.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: "代码库关联性暂时无法确认", message: expect.stringContaining("未能完成"),
    }));
    expect(requests.fetchSse).not.toHaveBeenCalled();
  });
});
