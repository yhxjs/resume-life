// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApplicationDialog } from "../application-dialog";
import { jsonFetch } from "@/lib/fetcher";
import type { Application } from "@/lib/applications-types";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));

const savedApplication: Partial<Application> = {
  id: 77,
  company: "字节跳动",
  role: "资深前端架构师",
  stage: "applied",
};

beforeEach(() => {
  vi.mocked(jsonFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/interviews") {
      return { items: [{ id: 5, jd: "后端 JD 描述", created_at: "", answered: 2, rounds: 5 }], nextCursor: null } as never;
    }
    if (method === "GET" && url === "/api/interviews/series") {
      return { items: [], nextCursor: null } as never;
    }
    if (method === "GET" && url === "/api/resumes") {
      return [{ id: 3, title: "我的简历", updated_at: "", versions: [{ id: 30, version: 1, name: "v1" }] }] as never;
    }
    if (method === "POST" && url === "/api/applications") return savedApplication as never;
    throw new Error(`unexpected request: ${method} ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog(props: Partial<Parameters<typeof ApplicationDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onSuccess = vi.fn();
  render(<ApplicationDialog onClose={onClose} onSuccess={onSuccess} {...props} />);
  return { onClose, onSuccess };
}


function submit() {
  fireEvent.submit(document.querySelector("form")!);
}

describe("ApplicationDialog 新建/编辑投递卡片", () => {
  it.each([
    ["/api/interviews", "关联单轮模拟面试", "加载更多单轮面试", "interview_id"],
    ["/api/interviews/series", "或 关联进阶多轮面试", "加载更多多轮面试", "interview_series_id"],
  ])("%s 可关联第二页旧记录，后续页失败可重试", async (endpoint, label, loadLabel, field) => {
    const fallback = vi.mocked(jsonFetch).getMockImplementation()!;
    let attempts = 0;
    const candidate = (id: number) => ({ id, jd: `模拟面试${id}`, answered: 0, rounds: 5, rounds_done: 0, rounds_total: 3 });
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (url === endpoint) return {
        items: Array.from({ length: 50 }, (_, i) => candidate(51 - i)), nextCursor: "2",
      } as never;
      if (url === `${endpoint}?cursor=2`) {
        if (++attempts === 1) throw new Error("候选下一页失败");
        return { items: [candidate(1)], nextCursor: null } as never;
      }
      return fallback(url, init);
    });
    const { onSuccess } = renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: loadLabel }));
    expect(await screen.findByText(/候选下一页失败/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: endpoint.endsWith("series") ? "重试加载多轮面试" : "重试加载单轮面试" }));
    await screen.findByRole("option", { name: /#1 · 模拟面试1 / });
    fireEvent.change(screen.getByLabelText(label), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/公司名称/), { target: { value: "公司" } });
    fireEvent.change(screen.getByLabelText(/目标岗位/), { target: { value: "前端" } });
    submit();
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const call = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(call?.[1]?.body))[field]).toBe(1);
  });

  it("编辑时即使已有面试不在首批候选仍保留其选中 ID", async () => {
    renderDialog({ initialData: { id: 7, company: "公司", role: "前端", stage: "interview", interview_id: 1 } as Application });
    expect((screen.getByLabelText("关联单轮模拟面试") as HTMLSelectElement).value).toBe("1");
    await screen.findByRole("option", { name: /#5 · 后端 JD 描述/ });
    expect((screen.getByLabelText("关联单轮模拟面试") as HTMLSelectElement).value).toBe("1");
  });

  it("编辑态渲染既有数据与关闭按钮回调 onClose", () => {
    const { onClose } = renderDialog({
      initialData: { id: 7, company: "阿里", role: "前端", stage: "interested" } as Application,
    });

    expect(screen.getByText("编辑求职投递卡片")).toBeTruthy();
    expect((screen.getByLabelText(/公司名称/) as HTMLInputElement).value).toBe("阿里");
    fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("空表单提交显示校验错误且不发起请求", () => {
    renderDialog();

    submit();

    expect(screen.getByText("公司名称不能为空")).toBeTruthy();
    expect(vi.mocked(jsonFetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("填写公司与岗位后提交，POST 载荷正确并回调 onSuccess", async () => {
    const { onSuccess } = renderDialog();

    fireEvent.change(screen.getByLabelText(/公司名称/), { target: { value: "字节跳动" } });
    fireEvent.change(screen.getByLabelText(/目标岗位/), { target: { value: "资深前端架构师" } });
    submit();

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith(savedApplication);
    });
    const call = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "POST");
    expect(call?.[0]).toBe("/api/applications");
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body).toMatchObject({
      company: "字节跳动",
      role: "资深前端架构师",
      stage: "interested",
      interview_id: null,
    });
    // 已加载面试下拉选项
    expect(await screen.findByRole("option", { name: /#5 · 后端 JD 描述/ })).toBeTruthy();
  });

  it("切换为已拒绝阶段出现终止归因，未填写时拦截提交，填写后载荷携带归因", async () => {
    const { onSuccess } = renderDialog();

    // 状态变化：选择「已拒绝」→ 终止归因 fieldset 出现
    fireEvent.change(screen.getByLabelText("当前阶段"), { target: { value: "rejected" } });
    expect(screen.getByText("已终止 · 记录归因")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/公司名称/), { target: { value: "某公司" } });
    fireEvent.change(screen.getByLabelText(/目标岗位/), { target: { value: "某岗位" } });
    submit();
    expect(screen.getByText("请选择终止阶段并填写终止原因")).toBeTruthy();
    expect(vi.mocked(jsonFetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    fireEvent.change(screen.getByLabelText(/终止阶段/), { target: { value: "technical_interview" } });
    fireEvent.change(screen.getByLabelText(/终止原因/), { target: { value: "技术面未通过" } });
    submit();

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
    const call = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "POST");
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body).toMatchObject({
      stage: "rejected",
      terminal_stage: "technical_interview",
      terminal_reason: "技术面未通过",
    });
  });
});
