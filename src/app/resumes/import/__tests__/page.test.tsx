// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { jsonFetch } from "@/lib/fetcher";
import { apiFetch } from "@/lib/api-fetch";
import { MODULE_KEYS, normalizeContent } from "@/lib/modules";
import { normalizeImportedModule } from "@/lib/resume-import";
import { escapePlainTextToRichHtml } from "@/lib/rich-text";
import ImportPage from "../page";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/fetcher", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/lib/api-fetch", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/api-fetch")>(), apiFetch: vi.fn() }));

afterEach(() => { cleanup(); sessionStorage.clear(); vi.resetAllMocks(); });

function savedSubmittedDraft() {
  const request = vi.mocked(jsonFetch).mock.calls.find(([url, init]) => url === "/api/resumes" && init?.method === "POST")![1]!;
  const snapshot = JSON.parse(request.body as string);
  return { resume: { id: 42, title: snapshot.title }, warnings: [], corruptedKeys: [],
    modules: MODULE_KEYS.map(key => ({ key, type: key, content: normalizeContent(key, snapshot.modules[key]) })) };
}

describe("导入自定义内容的校对与确认", () => {
  it("explicit PDF image mode reuses successful OCR text after a structure-generation failure",async()=>{
    let attempts=0;
    vi.mocked(jsonFetch).mockImplementation(async url=>{
      if(url==="/api/settings/configured") return {configured:true};
      if(attempts++===0) throw new Error("synthetic parse failure");
      return validDraft();
    });
    const pending=Promise.withResolvers<Response>();
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise);
    const {container}=render(<ImportPage/>);
    fireEvent.click(screen.getByRole("tab",{name:/上传文件/}));
    fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[new File(["pdf"],"source.pdf")]}});
    fireEvent.click(screen.getByRole("checkbox",{name:"按页面图片识别 PDF"}));
    const parse=screen.getByRole("button",{name:"开始智能解析 →"});
    act(()=>{fireEvent.click(parse);fireEvent.click(parse);});
    expect(apiFetch).toHaveBeenCalledOnce();
    expect((vi.mocked(apiFetch).mock.calls[0]![1]!.body as FormData).get("pdfMode")).toBe("image");
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    await act(async()=>pending.resolve(new Response(JSON.stringify({extractedText:"OCR complete source",ocr:{engine:"vision",pageCount:1,sourceType:"pdf"}}))));
    await screen.findByText("synthetic parse failure");
    fireEvent.click(screen.getByRole("button",{name:"开始智能解析 →"}));
    await screen.findByRole("heading",{name:"确认解析草稿"});
    expect(apiFetch).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("导入原文").textContent).toBe("OCR complete source");
    expect(JSON.parse(vi.mocked(jsonFetch).mock.calls.filter(([url])=>url==="/api/import/parse")[1]![1]!.body as string)).toEqual({text:"OCR complete source"});
  });

  it("explicit PDF image mode retains prior source when re-extraction fails and replaces it only after success",async()=>{
    vi.mocked(jsonFetch).mockImplementation(async url=>url==="/api/settings/configured"?{configured:true}:validDraft());
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({extractedText:"ORIGINAL source"})))
      .mockResolvedValueOnce(new Response(JSON.stringify({error:"OCR is disabled"}),{status:400}))
      .mockResolvedValueOnce(new Response(JSON.stringify({extractedText:"NEW image source",ocr:{engine:"local",pageCount:1,sourceType:"pdf"}})));
    const {container}=render(<ImportPage/>);
    fireEvent.click(screen.getByRole("tab",{name:/上传文件/}));
    fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[new File(["pdf"],"source.pdf")]}});
    fireEvent.click(screen.getByRole("button",{name:"开始智能解析 →"}));
    fireEvent.click(await screen.findByRole("button",{name:"返回重新解析"}));
    fireEvent.click(screen.getByRole("checkbox",{name:"按页面图片识别 PDF"}));
    fireEvent.click(screen.getByRole("button",{name:"开始智能解析 →"}));
    await screen.findByText("OCR is disabled");
    expect((screen.getByRole("textbox",{name:"已保留的原文，可直接修改"}) as HTMLTextAreaElement).value).toBe("ORIGINAL source");
    expect(vi.mocked(jsonFetch).mock.calls.filter(([url])=>url==="/api/import/parse")).toHaveLength(1);
    expect((vi.mocked(apiFetch).mock.calls[1]![1]!.body as FormData).get("pdfMode")).toBe("image");
    fireEvent.click(screen.getByRole("button",{name:"开始智能解析 →"}));
    await screen.findByRole("heading",{name:"确认解析草稿"});
    expect(screen.getByLabelText("导入原文").textContent).toBe("NEW image source");
    expect(apiFetch).toHaveBeenCalledTimes(3);
  });

  it("explicit PDF image mode resets when a different file is selected",async()=>{
    vi.mocked(jsonFetch).mockImplementation(async url=>url==="/api/settings/configured"?{configured:true}:validDraft());
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({extractedText:"TXT source"})));
    const {container}=render(<ImportPage/>);
    fireEvent.click(screen.getByRole("tab",{name:/上传文件/}));
    const input=container.querySelector('input[type="file"]')!;
    fireEvent.change(input,{target:{files:[new File(["pdf"],"source.pdf")]}});
    fireEvent.click(screen.getByRole("checkbox",{name:"按页面图片识别 PDF"}));
    fireEvent.change(input,{target:{files:[new File(["txt"],"source.txt")]}});
    expect(screen.queryByRole("checkbox",{name:"按页面图片识别 PDF"})).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"开始智能解析 →"}));
    await screen.findByRole("heading",{name:"确认解析草稿"});
    expect((vi.mocked(apiFetch).mock.calls[0]![1]!.body as FormData).get("pdfMode")).toBeNull();
  });

  it("刷新式重新挂载恢复标题与完整原文，不自动重新解析", async () => {
    vi.mocked(jsonFetch).mockImplementation(async (url) => url === "/api/settings/configured" ? { configured: true } : validDraft());
    const previous = render(<ImportPage />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "完整原文 Array<T> &amp;，未上线。" } });
    fireEvent.click(screen.getByRole("button", { name: "开始智能解析 →" }));
    const title = await screen.findByRole("textbox", { name: "简历标题" });
    fireEvent.change(title, { target: { value: "修改后的草稿标题" } });
    previous.unmount();
    render(<ImportPage />);
    await screen.findByRole("textbox", { name: "简历标题" });
    expect((screen.getByRole("textbox", { name: "简历标题" }) as HTMLInputElement).value).toBe("修改后的草稿标题");
    expect(screen.getByLabelText("导入原文").textContent).toBe("完整原文 Array<T> &amp;，未上线。");
    expect(vi.mocked(jsonFetch).mock.calls.filter(([url]) => url === "/api/import/parse")).toHaveLength(1);
  });
  function validDraft() {
    return { title: "合成简历", modules: Object.fromEntries(MODULE_KEYS.map((key) => [key,
      normalizeImportedModule(key, key === "basic" ? { name: "合成人物" } : undefined)])) };
  }

  it("确认导入同一事件双击只创建一次，等待期间锁定标题和编辑内容", async () => {
    const pending = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockImplementation(async (url) => {
      if (url === "/api/settings/configured") return { configured: true };
      if (url === "/api/import/parse") return validDraft();
      return pending.promise;
    });
    render(<ImportPage />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "原文" } });
    fireEvent.click(screen.getByRole("button", { name: "开始智能解析 →" }));
    const confirm = await screen.findByRole("button", { name: "确认导入" });
    const title = screen.getByRole("textbox", { name: "简历标题" });
    act(() => { fireEvent.click(confirm); fireEvent.click(confirm); });
    expect(vi.mocked(jsonFetch).mock.calls.filter(([url]) => url === "/api/resumes")).toHaveLength(1);
    fireEvent.change(title, { target: { value: "保存时迟到的改稿" } });
    expect((title as HTMLInputElement).value).toBe("合成简历");
    expect(screen.getByRole("group", { name: "导入草稿编辑区" }).hasAttribute("inert")).toBe(true);
  });

  it("创建完成坏 ID 不跳转，保留草稿并只读核对，不能直接再次创建", async () => {
    let creates = 0;
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (url === "/api/settings/configured") return { configured: true };
      if (url === "/api/import/parse") return validDraft();
      if (url === "/api/resumes" && init?.method === "POST") { creates++; return { id: "坏编号" }; }
      if (url === "/api/resumes") return [];
      throw new Error(`unexpected url: ${url}`);
    });
    render(<ImportPage />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "原文" } });
    fireEvent.click(screen.getByRole("button", { name: "开始智能解析 →" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认导入" }));
    await screen.findByRole("region", { name: "导入结果核对" });
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
    expect(creates).toBe(1);
    expect((screen.getByRole("textbox", { name: "简历标题" }) as HTMLInputElement).value).toBe("合成简历");
  });

  it("确认创建后离页取消本地等待，迟到成功不能跳转", async () => {
    const pending = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockImplementation(async (url) => {
      if (url === "/api/settings/configured") return { configured: true };
      if (url === "/api/import/parse") return validDraft();
      return pending.promise;
    });
    const { unmount } = render(<ImportPage />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "原文" } });
    fireEvent.click(screen.getByRole("button", { name: "开始智能解析 →" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认导入" }));
    const signal = vi.mocked(jsonFetch).mock.calls.find(([url]) => url === "/api/resumes")![1]!.signal;
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { pending.resolve({ id: 42 }); });
    expect(push).not.toHaveBeenCalled();
  });

  it("同一事件连续开始解析只提交一次", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => { resolve = done; });
    vi.mocked(jsonFetch).mockImplementation(async (url) => url === "/api/settings/configured" ? { configured: true } : pending);
    render(<ImportPage />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "原文" } });
    const button = screen.getByRole("button", { name: "开始智能解析 →" });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(vi.mocked(jsonFetch).mock.calls.filter(([url]) => url === "/api/import/parse")).toHaveLength(1);
    await act(async () => { resolve(validDraft()); });
    expect(screen.getByRole("heading", { name: "确认解析草稿" })).toBeTruthy();
  });

  it("文件失败后的已修改原文用于重试，不重新提取旧文件", async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ extractedText: "旧文件全文" })));
    let attempts = 0;
    vi.mocked(jsonFetch).mockImplementation(async (url) => {
      if (url === "/api/settings/configured") return { configured: true };
      if (attempts++ === 0) throw new Error("合成解析失败");
      return validDraft();
    });
    const { container } = render(<ImportPage />);
    fireEvent.click(screen.getByRole("tab", { name: /上传文件/ }));
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(["文件"], "resume.txt")] } });
    fireEvent.click(screen.getByRole("button", { name: "开始智能解析 →" }));
    const recovered = await screen.findByRole("textbox", { name: "已保留的原文，可直接修改" });
    fireEvent.change(recovered, { target: { value: "修改后的完整原文，保留末尾条件" } });
    fireEvent.click(screen.getByRole("tab", { name: /上传文件/ }));
    expect((screen.getByRole("textbox", { name: "已保留的原文，可直接修改" }) as HTMLTextAreaElement).value).toBe("修改后的完整原文，保留末尾条件");
    fireEvent.click(screen.getByRole("button", { name: "开始智能解析 →" }));
    await screen.findByRole("heading", { name: "确认解析草稿" });
    const parses = vi.mocked(jsonFetch).mock.calls.filter(([url]) => url === "/api/import/parse");
    expect(JSON.parse(parses[1]![1]!.body as string)).toEqual({ text: "修改后的完整原文，保留末尾条件" });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("导入原文").textContent).toBe("修改后的完整原文，保留末尾条件");
  });

  it("文件提取完成前离页，迟到响应不再启动 AI 解析", async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(apiFetch).mockImplementation(() => new Promise((done) => { resolve = done; }));
    vi.mocked(jsonFetch).mockResolvedValue({ configured: true });
    const { container, unmount } = render(<ImportPage />);
    fireEvent.click(screen.getByRole("tab", { name: /上传文件/ }));
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(["文件"], "resume.txt")] } });
    fireEvent.click(screen.getByRole("button", { name: "开始智能解析 →" }));
    const signal = vi.mocked(apiFetch).mock.calls[0]![1]!.signal!;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { resolve(new Response(JSON.stringify({ extractedText: "迟到的文件原文" }))); });
    expect(vi.mocked(jsonFetch).mock.calls.filter(([url]) => url === "/api/import/parse")).toHaveLength(0);
  });

  it("异常解析响应保留全文并允许修正后重试，主动清空不能回退到旧原稿", async () => {
    let attempts = 0;
    vi.mocked(jsonFetch).mockImplementation(async (url) => {
      if (url === "/api/settings/configured") return { configured: true };
      return attempts++ === 0 ? { title: "缺失模块的草稿", modules: {} } : validDraft();
    });
    render(<ImportPage />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "完整原文及末尾限定" } });
    fireEvent.click(screen.getByRole("button", { name: "开始智能解析 →" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("heading", { name: "确认解析草稿" })).toBeNull();
    const recovered = screen.getByRole("textbox", { name: "已保留的原文，可直接修改" });
    expect((recovered as HTMLTextAreaElement).value).toBe("完整原文及末尾限定");
    fireEvent.change(recovered, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "开始智能解析 →" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "手工整理并继续导入" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(recovered, { target: { value: "已修改并保留末尾限定" } });
    fireEvent.click(screen.getByRole("button", { name: "开始智能解析 →" }));
    await screen.findByRole("heading", { name: "确认解析草稿" });
    const parses = vi.mocked(jsonFetch).mock.calls.filter(([url]) => url === "/api/import/parse");
    expect(JSON.parse(parses[1]![1]!.body as string).text).toBe("已修改并保留末尾限定");
    expect(screen.getByLabelText("导入原文").textContent).toBe("已修改并保留末尾限定");
  });

  it("修改主原文会作废旧恢复稿，解析等待时迟到的编辑事件不能改稿", async () => {
    let resolve!: (value: unknown) => void;
    let attempts = 0;
    vi.mocked(jsonFetch).mockImplementation(async (url) => {
      if (url === "/api/settings/configured") return { configured: true };
      if (attempts++ === 0) throw new Error("合成失败");
      return new Promise((done) => { resolve = done; });
    });
    render(<ImportPage />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "旧原文" } });
    fireEvent.click(screen.getByRole("button", { name: "开始智能解析 →" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "已保留的原文，可直接修改" }), { target: { value: "旧恢复稿" } });
    const source = screen.getByRole("textbox", { name: "简历原文" });
    fireEvent.change(source, { target: { value: "新的主原文" } });
    expect(screen.queryByRole("textbox", { name: "已保留的原文，可直接修改" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "开始智能解析 →" }));
    fireEvent.change(source, { target: { value: "迟到的输入" } });
    expect((source as HTMLTextAreaElement).value).toBe("新的主原文");
    const parses = vi.mocked(jsonFetch).mock.calls.filter(([url]) => url === "/api/import/parse");
    expect(JSON.parse(parses[1]![1]!.body as string).text).toBe("新的主原文");
    await act(async () => { resolve(validDraft()); });
    expect(screen.getByLabelText("导入原文").textContent).toBe("新的主原文");
  });

  it("各正文显示原始技术文本，校对编辑后的富文本直接提交，不再次转义", async () => {
    const text = String.raw`使用 Array<T>、<template>、<strong>标签</strong>、&amp; 与 C:\new\resume`;
    const raw: Record<string, unknown> = {
      basic: { name: "合成人物" },
      education: [{ school: "合成大学", description: text }],
      work: [{ company: "合成公司", descriptionItems: [text] }],
      projects: [{ name: "合成项目", descriptionItems: [text] }],
      custom: [{ title: "合成作品", descriptionItems: [text] }],
      summary: { text }, skills: { items: [text] },
    };
    const modules = Object.fromEntries(MODULE_KEYS.map((key) => [key, normalizeImportedModule(key, raw[key])]));
    vi.mocked(jsonFetch).mockImplementation(async (url) => {
      if (url === "/api/settings/configured") return { configured: true };
      if (url === "/api/import/parse") return { title: "合成简历", modules };
      if (url === "/api/resumes") return { id: 42 };
      if (String(url).includes("/api/resumes/requests/")) return { request_id: String(url).split("/").at(-1), status: "succeeded", id: 42 };
      if (url === "/api/resumes/42") return savedSubmittedDraft();
      throw new Error(`unexpected url: ${url}`);
    });
    render(<ImportPage />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "开始智能解析 →" }));
    await screen.findByDisplayValue("合成大学");
    const labels = ["备注", "工作经历描述第 1 行", "项目经历描述第 1 行", "条目描述第 1 行", "自我评价第 1 行"];
    for (const name of labels) {
      const editor = screen.getByRole("textbox", { name });
      expect(editor.textContent).toBe(text);
      expect(editor.querySelector("template, strong")).toBeNull();
    }
    const education = screen.getByRole("textbox", { name: "备注" });
    const edited = `<strong>已核对</strong>${escapePlainTextToRichHtml(text)}`;
    education.innerHTML = edited;
    fireEvent.input(education);
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/resumes/42"));
    const request = vi.mocked(jsonFetch).mock.calls.find(([url]) => url === "/api/resumes")![1]!;
    const submitted = JSON.parse(request.body as string);
    expect(submitted.modules.education[0].description).toBe(edited);
    for (const key of ["work", "projects", "custom", "summary", "skills"]) expect(submitted.modules[key]).toEqual(modules[key]);
  });

  it("展示证书与奖项，编辑后连同其他条目确认提交，日期聚焦可定位原文", async () => {
    const custom = normalizeContent("custom", [
      { title: "合成证书", subTitle: "颁发机构", start: "2025年6月", descriptionItems: ["原文证书说明"] },
      { title: "合成团队奖项", descriptionItems: ["个人负责联调"] },
    ]);
    const modules = Object.fromEntries(MODULE_KEYS.map((key) => [key, key === "custom" ? custom : normalizeContent(key, undefined)]));
    vi.mocked(jsonFetch).mockImplementation(async (url) => {
      if (url === "/api/settings/configured") return { configured: true };
      if (url === "/api/import/parse") return { title: "合成简历", modules };
      if (url === "/api/resumes") return { id: 42 };
      if (String(url).includes("/api/resumes/requests/")) return { request_id: String(url).split("/").at(-1), status: "succeeded", id: 42 };
      if (url === "/api/resumes/42") return savedSubmittedDraft();
      throw new Error(`unexpected url: ${url}`);
    });
    render(<ImportPage />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "2025年6月 合成证书；合成团队奖项" } });
    fireEvent.click(screen.getByRole("button", { name: "开始智能解析 →" }));
    const title = await screen.findByDisplayValue("合成证书");
    expect(screen.getByDisplayValue("合成团队奖项")).toBeTruthy();
    fireEvent.focus(screen.getByDisplayValue("2025年6月"));
    expect(screen.getByRole("status", { name: "原文定位状态" }).textContent).toContain("第 1 / 1 处");
    fireEvent.change(title, { target: { value: "已核对的合成证书" } });
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/resumes/42"));
    const request = vi.mocked(jsonFetch).mock.calls.find(([url]) => url === "/api/resumes")![1]!;
    const submitted = JSON.parse(request.body as string);
    expect(submitted.modules.custom).toEqual([{ ...custom[0], title: "已核对的合成证书" }, custom[1]]);
  });
});
