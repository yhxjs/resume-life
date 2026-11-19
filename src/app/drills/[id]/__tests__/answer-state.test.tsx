// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Page from "../page";
import { jsonFetch } from "@/lib/fetcher";

const navigation = vi.hoisted(() => ({ id: "1", push: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: navigation.id }), useRouter: () => ({ push: navigation.push }) }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/components/notebook", () => ({ NotebookStarButton: () => null }));

function drill(id = 1) {
  return {
    id, source: "bank", project_id: null, direction: `方向${id}`, jd: "", interview_id: null,
    focus: "", created_at: "2026-10-28", project_name: null,
    questions: [1, 2].map((idx) => ({
      id: id * 10 + idx, idx, question: `练习${id}问题${idx}`, answer: "", comment: "", reference: "",
      scores: null, answered_at: "", kind: "tech", notebook_id: null,
    })),
  };
}

function graded(data = drill(), answer = "提交原答") {
  return { ...data, questions: data.questions.map((q, index) => index ? q : {
    ...q, answer, comment: `点评_${answer}`, reference: `参考_${answer}`, answered_at: "2026-10-28",
  }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => { cleanup(); vi.resetAllMocks(); navigation.id = "1"; });

describe("专项练习的草稿与评分归属", () => {
  it("切题保留各题草稿，不把第一题草稿带入第二题", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(drill());
    render(<Page />);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "第一题草稿 <T> &amp;\n尚未上线" } });
    fireEvent.click(screen.getByRole("button", { name: "第 2 题" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "第二题草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "第 1 题" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("第一题草稿 <T> &amp;\n尚未上线");
    fireEvent.click(screen.getByRole("button", { name: "第 2 题" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("第二题草稿");
    expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it("第一题的晚到评分不清除第二题草稿，返回后评分仍只对应第一题原答", async () => {
    const pending = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(drill()).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(graded());
    render(<Page />);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "提交原答" } });
    fireEvent.click(screen.getByRole("button", { name: "提交作答并获取批阅" }));
    fireEvent.click(screen.getByRole("button", { name: "第 2 题" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "第二题的新草稿" } });
    await act(async () => { pending.resolve({}); });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("第二题的新草稿");
    expect(screen.queryByText("点评_提交原答")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "第 1 题（已答）" }));
    expect(screen.getByText("提交原答", { exact: true })).toBeTruthy();
    expect(screen.getByText("点评_提交原答", { exact: true })).toBeTruthy();
    expect(jsonFetch).toHaveBeenNthCalledWith(2, "/api/drills/1/questions/11", expect.objectContaining({ body: JSON.stringify({ answer: "提交原答" }) }));
  });

  it("评分等待中继续键入后保留新稿，重新提交才显示新稿评分", async () => {
    const pending = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(drill()).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(graded())
      .mockResolvedValueOnce({}).mockResolvedValueOnce(graded(drill(), "更新后的真实原答"));
    render(<Page />);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "提交原答" } });
    fireEvent.click(screen.getByRole("button", { name: "提交作答并获取批阅" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "更新后的真实原答" } });
    await act(async () => { pending.resolve({}); });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("更新后的真实原答");
    expect(screen.queryByText("点评_提交原答")).toBeNull();
    expect(screen.queryByRole("region", { name: "本题回答参考" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存并重新打分" }));
    expect(await screen.findByText("点评_更新后的真实原答", { exact: true })).toBeTruthy();
    expect(jsonFetch).toHaveBeenNthCalledWith(4, "/api/drills/1/questions/11", expect.objectContaining({ body: JSON.stringify({ answer: "更新后的真实原答" }) }));
  });

  it("失败只归属提交题目，其他题可继续编辑，返回原题保留失败草稿", async () => {
    const pending = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(drill()).mockReturnValueOnce(pending.promise);
    render(<Page />);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "第一题失败草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "提交作答并获取批阅" }));
    fireEvent.click(screen.getByRole("button", { name: "第 2 题" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "第二题草稿" } });
    await act(async () => { pending.reject(new Error("第一题评分失败")); });
    expect(screen.queryByText("第一题评分失败")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "第 1 题" }));
    expect(screen.getByText("第一题评分失败")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("第一题失败草稿");
  });

  it("切换练习集立即隔离旧题与在途评分，旧请求完成不重读或覆盖新练习", async () => {
    const scoring = deferred<unknown>();
    const loading = deferred<ReturnType<typeof drill>>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(drill()).mockReturnValueOnce(scoring.promise).mockReturnValueOnce(loading.promise);
    const { rerender } = render(<Page />);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "旧练习原答" } });
    fireEvent.click(screen.getByRole("button", { name: "提交作答并获取批阅" }));
    navigation.id = "2";
    rerender(<Page />);
    expect(screen.queryByText("练习1问题1")).toBeNull();
    await act(async () => { loading.resolve(drill(2)); });
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "新练习草稿" } });
    await act(async () => { scoring.resolve({}); });
    expect(screen.getByText("练习2问题1")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("新练习草稿");
    expect(jsonFetch).toHaveBeenCalledTimes(3);
  });

  it("取消重答只丢弃当前题草稿，恢复该题已保存原答与参考", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(graded());
    render(<Page />);
    await screen.findByRole("textbox");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "第二题草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "第 1 题（已答）" }));
    fireEvent.click(screen.getByRole("button", { name: "重答本题 ↺" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "未提交重答" } });
    fireEvent.click(screen.getByRole("button", { name: "第 2 题" }));
    fireEvent.click(screen.getByRole("button", { name: "第 1 题（已答）" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("未提交重答");
    expect(screen.queryByText("点评_提交原答")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消重答" }));
    expect(screen.getByText("提交原答", { exact: true })).toBeTruthy();
    expect(screen.getByText("点评_提交原答", { exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "第 2 题" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("第二题草稿");
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledOnce());
  });

  it("评分已保存但回读失败时仅重试 GET，保留等待期间的新草稿", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(drill()).mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("读取暂时失败")).mockRejectedValueOnce(new Error("仍未恢复"))
      .mockResolvedValueOnce(graded());
    render(<Page />);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "提交原答" } });
    fireEvent.click(screen.getByRole("button", { name: "提交作答并获取批阅" }));
    expect((await screen.findByRole("alert")).textContent).toContain("评分已保存");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "重新读取已保存评分" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("仍未恢复"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "尚未提交的新稿" } });
    fireEvent.click(screen.getByRole("button", { name: "重新读取已保存评分" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("尚未提交的新稿");
    expect(screen.queryByText("点评_提交原答")).toBeNull();
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(jsonFetch).toHaveBeenNthCalledWith(4, "/api/drills/1");
    expect(jsonFetch).toHaveBeenNthCalledWith(5, "/api/drills/1");
  });

  it("快速连点只提交一次，改动后再恢复原文也保留为未提交草稿", async () => {
    const pending = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(drill()).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(graded());
    render(<Page />);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "提交原答" } });
    const submit = screen.getByRole("button", { name: "提交作答并获取批阅" });
    act(() => { submit.click(); submit.click(); });
    expect(jsonFetch).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "中间稿" } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "提交原答" } });
    await act(async () => { pending.resolve({}); });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("提交原答");
    expect(screen.queryByRole("region", { name: "本题回答参考" })).toBeNull();
  });
});
