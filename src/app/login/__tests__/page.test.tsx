// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LoginPage from "../page";
import { jsonFetch } from "@/lib/fetcher";
import { safeLoginReturnPath } from "@/lib/login-return-path";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/login-return-path", () => ({ safeLoginReturnPath: vi.fn(() => "/") }));

beforeEach(() => { vi.mocked(jsonFetch).mockReset(); vi.mocked(safeLoginReturnPath).mockClear(); });
afterEach(cleanup);
const writes = () => vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST");

async function open(initialized = true, allowReinit = false) {
  vi.mocked(jsonFetch).mockResolvedValueOnce({ initialized, allowReinit });
  const view = render(<LoginPage />);
  await screen.findByLabelText("用户名");
  fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "synthetic-user" } });
  fireEvent.change(screen.getByLabelText("密码", { exact: true }), { target: { value: "synthetic-password-123" } });
  if (!initialized || allowReinit) fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "synthetic-password-123" } });
  return view;
}

it.each([{ initialized: true, allowReinit: false }, { initialized: false, allowReinit: false }, { initialized: true, allowReinit: true }])(
  "凭证提交 $initialized/$allowReinit 同事件互斥，等待中不混入新字段，拒绝后保留草稿可主动重试",
  async ({ initialized, allowReinit }) => {
    await open(initialized, allowReinit);
    const pending = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockReturnValue(pending.promise);
    const form = screen.getByTestId("login-form");
    act(() => { for (let i = 0; i < 3; i++) fireEvent.submit(form); });
    expect(writes()).toHaveLength(1);
    const [, request] = writes()[0]!;
    expect(JSON.parse(request!.body as string)).toEqual({ username: "synthetic-user", password: "synthetic-password-123" });
    expect((screen.getByLabelText("用户名") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("密码", { exact: true }) as HTMLInputElement).disabled).toBe(true);
    if (!initialized || allowReinit) expect((screen.getByLabelText("确认密码") as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "不得混入的用户" } });
    expect((screen.getByLabelText("用户名") as HTMLInputElement).value).toBe("synthetic-user");
    expect(request!.signal?.aborted).toBe(false);
    await act(async () => { pending.reject(new Error("凭证被拒绝")); await pending.promise.catch(() => {}); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("凭证被拒绝"));
    expect(document.activeElement).toBe(screen.getByRole("alert"));
    expect((screen.getByLabelText("用户名") as HTMLInputElement).value).toBe("synthetic-user");
    expect((screen.getByLabelText("密码", { exact: true }) as HTMLInputElement).value).toBe("synthetic-password-123");
    expect((screen.getByLabelText("用户名") as HTMLInputElement).disabled).toBe(false);
    expect(safeLoginReturnPath).not.toHaveBeenCalled();
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("第二次明确拒绝"));
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("第二次明确拒绝"));
    expect(writes()).toHaveLength(2);
  },
);

it.each(["success", "failure"])("离页中止等待，忽略取消的迟到 %s 不计算旧回跳地址", async outcome => {
  const view = await open();
  const pending = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
  fireEvent.submit(screen.getByTestId("login-form"));
  const signal = writes()[0]![1]!.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    if (outcome === "success") pending.resolve({ ok: true });
    else pending.reject(new Error("旧请求失败"));
    await pending.promise.catch(() => {});
  });
  expect(safeLoginReturnPath).not.toHaveBeenCalled();
});

it.each([null, {}, { initialized: "false", allowReinit: false }, { initialized: true, allowReinit: "false" }])("损坏状态 %j 不误开凭证表单，只读重试后恢复", async status => {
  vi.mocked(jsonFetch).mockResolvedValueOnce(status);
  render(<LoginPage />);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("登录状态响应不完整"));
  expect(screen.queryByLabelText("用户名")).toBeNull();
  vi.mocked(jsonFetch).mockResolvedValueOnce({ initialized: true, allowReinit: false });
  fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
  await screen.findByLabelText("用户名");
  expect(writes()).toHaveLength(0);
});

it("状态连接失败可只读重试，同事件重试仅一次，卸载中止读取", async () => {
  vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("本次连接失败"));
  const view = render(<LoginPage />);
  await screen.findByRole("alert");
  const pending = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
  const retry = screen.getByRole("button", { name: "重新连接" });
  act(() => { fireEvent.click(retry); fireEvent.click(retry); });
  expect(jsonFetch).toHaveBeenCalledTimes(2);
  const signal = vi.mocked(jsonFetch).mock.calls[1]![1]!.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => { pending.resolve({ initialized: true, allowReinit: false }); await pending.promise; });
  expect(writes()).toHaveLength(0);
});

it("初始化密码不一致不发送写入并显示可读错误", async () => {
  await open(false);
  fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "different-password" } });
  fireEvent.submit(screen.getByTestId("login-form"));
  expect(screen.getByRole("alert").textContent).toContain("两次输入的密码不一致");
  expect(writes()).toHaveLength(0);
});

it.each([{}, { ok: false }, { ok: "true" }])("残缺登录确认 %j 不计算回跳地址，保留凭证并显示恢复提示", async receipt => {
  await open();
  vi.mocked(jsonFetch).mockResolvedValueOnce(receipt);
  fireEvent.submit(screen.getByTestId("login-form"));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("登录确认响应不完整"));
  expect(safeLoginReturnPath).not.toHaveBeenCalled();
  expect((screen.getByLabelText("用户名") as HTMLInputElement).value).toBe("synthetic-user");
  expect((screen.getByLabelText("密码", { exact: true }) as HTMLInputElement).value).toBe("synthetic-password-123");
  expect(writes()).toHaveLength(1);
});
