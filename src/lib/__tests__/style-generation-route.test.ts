import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STYLE, type ResumeStyle } from "../templates";

const { safeChat } = vi.hoisted(() => ({ safeChat: vi.fn() }));

vi.mock("@/lib/safe-llm", () => ({
  safeChat,
  LLM_FEATURES: { styleGenerate: "样式 AI 调优" },
}));

import { POST } from "@/app/api/styles/generate/route";

function request(prompt = "测试风格") {
  return new Request("http://localhost/api/styles/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
}

describe("AI 样式生成接口", () => {
  beforeEach(() => safeChat.mockReset());

  const readable = { ...DEFAULT_STYLE, accent: "#555555", ink: "#111111", text: "#333333", muted: "#555555", sectionColor: "#555555" };
  it.each([
    { layout: "single", skillStyle: "line" },
    { layout: "single", skillStyle: "list" },
    { layout: "twocol", asideBg: "#eeeeee", skillStyle: "line" },
    { layout: "twocol", asideBg: "#eeeeee", skillStyle: "list" },
  ] satisfies Partial<ResumeStyle>[])("强调色只用于装饰时保留浅色，不按文字对比度误拒绝 %j", async patch => {
    const generated = { ...readable, ...patch, accent: "#dddddd", titleRule: "accent", entrySubAccent: false };
    safeChat.mockResolvedValueOnce(JSON.stringify(generated));
    const response = await POST(request("正文深灰，技能用普通文字，经历副标题不用强调色；姓名下方只用浅灰装饰线。"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ style: generated });
    expect(safeChat).toHaveBeenCalledOnce();
  });

  it.each([
    { layout: "single", skillStyle: "line", entrySubAccent: true },
    { layout: "single", skillStyle: "pill", entrySubAccent: false },
    { layout: "twocol", asideBg: "#eeeeee", skillStyle: "list", entrySubAccent: true },
    { layout: "twocol", asideBg: "#eeeeee", skillStyle: "pill", entrySubAccent: false },
  ] satisfies Partial<ResumeStyle>[])("强调色实际用于文字时仍拒绝浅色，调深后允许显式重试 %j", async patch => {
    const invalid = { ...readable, ...patch, accent: "#dddddd" };
    safeChat.mockResolvedValueOnce(JSON.stringify(invalid));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("结构校验未通过");
    const corrected = { ...invalid, accent: "#555555" };
    safeChat.mockResolvedValueOnce(JSON.stringify(corrected));
    const retried = await POST(request());
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ style: corrected });
    expect(safeChat).toHaveBeenCalledTimes(2);
  });

  it.each<Partial<ResumeStyle>>([
    { layout: "twocol", asideBg: "#eeeeee", sectionColor: "#767676", sectionDeco: "none" },
    { layout: "twocol", asideBg: "#eeeeee", sectionColor: "#767676", sectionDeco: "underline" },
    { layout: "twocol", asideBg: "#eeeeee", sectionColor: "#767676", sectionDeco: "leftbar" },
    { layout: "single", skillStyle: "pill", accent: "#767676" },
    { layout: "twocol", skillStyle: "pill", accent: "#7c3aed", asideBg: "#eeeeee" },
  ])("按实际侧栏标题与技能标签背景拒绝低对比组合 %j，并允许修正重试", async patch => {
    const invalid = { ...readable, ...patch };
    safeChat.mockResolvedValueOnce(JSON.stringify(invalid));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("结构校验未通过");
    safeChat.mockResolvedValueOnce(JSON.stringify({ ...invalid, accent: "#555555", sectionColor: "#555555" }));
    expect((await POST(request())).status).toBe(200);
  });

  it.each<Partial<ResumeStyle>>([
    { layout: "single", asideBg: "#111111" },
    { layout: "twocol", asideBg: "#eeeeee", sectionColor: "#767676", sectionDeco: "band", sectionDecoColor: "#555555" },
    { layout: "single", sectionColor: "#ffffff", sectionDeco: "band", sectionDecoColor: "#555555" },
    { layout: "single", skillStyle: "line", accent: "#767676" },
    { layout: "single", skillStyle: "list", accent: "#767676" },
  ])("实际文字可读时不按未使用的背景或标题色误拒绝 %j", async patch => {
    safeChat.mockResolvedValueOnce(JSON.stringify({ ...readable, ...patch }));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await response.json()).style).toMatchObject(patch);
  });

  it.each([
    ["围栏", (json: string) => ["```json", json, "```"].join("\n")],
    ["前置说明", (json: string) => `以下为初稿：\n${json}`],
    ["后置说明", (json: string) => `${json}\n上述配色仍需修订。`],
    ["追加截断内容", (json: string) => `${json}\n{"correction":`],
  ] as const)("%s 的模型回复不截取后返回，纯 JSON 可显式重试", async (_label, wrap) => {
    const style = { ...DEFAULT_STYLE, accent: "#7c3aed" };
    safeChat.mockResolvedValueOnce(wrap(JSON.stringify(style)));
    expect((await POST(request())).status).toBe(502);
    expect(safeChat.mock.calls[0]!.at(-1)).toMatchObject({ requireJson: "strict" });
    safeChat.mockResolvedValueOnce(` \n${JSON.stringify(style)}\t `);
    const retried = await POST(request());
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ style });
    expect(safeChat).toHaveBeenCalledTimes(2);
  });

  it("不把蓝色默认值写进模型提示词，避免模型照抄默认样式", async () => {
    safeChat.mockResolvedValue(JSON.stringify({ ...DEFAULT_STYLE, accent: "#7c3aed" }));

    const response = await POST(request());

    expect(response.status).toBe(200);
    const systemPrompt = safeChat.mock.calls[0]?.[2] as string;
    expect(systemPrompt).not.toContain("#2563eb");
    expect(systemPrompt).not.toContain('"headerBg": "#');
    for (const field of ["asideBorderColor", "asidePadding", "asideGap", "asideModules", "contactSeparator", "contactGap"]) {
      expect(systemPrompt).toContain(field);
    }
    expect(systemPrompt).toContain("最多 8 个字符，长度按 JavaScript 字符串长度计算");
    expect(systemPrompt).toContain("模块类型会将该类型的全部模块实例放入侧栏");
    expect(systemPrompt).toContain("不编造模块 ID");
    expect(systemPrompt).toContain("正文、次要文字和标题对其实际背景至少满足 4.5:1 对比度");
    expect(systemPrompt).toContain("按合成后的底色检查对比度");
    expect(systemPrompt).toContain("非 band 小节标题用 sectionColor");
    expect(systemPrompt).toContain("不增加其他键");
  });

  it.each([
    ["空对象", "{}"],
    ["缺少字段", JSON.stringify({ ...DEFAULT_STYLE, accent: undefined })],
    ["非法颜色", JSON.stringify({ ...DEFAULT_STYLE, accent: "blue" })],
    ["正文对比度不足", JSON.stringify({ ...DEFAULT_STYLE, text: "#ffffff" })],
    ["彩色页眉对比度不足", JSON.stringify({ ...DEFAULT_STYLE, headerStyle: "banner", headerBg: "#ffffff" })],
    ["色带标题对比度不足", JSON.stringify({ ...DEFAULT_STYLE, sectionDeco: "band", sectionDecoColor: "#ffffff" })],
    ["侧栏文字对比度不足", JSON.stringify({ ...DEFAULT_STYLE, layout: "twocol", asideBg: "#111111" })],
    ["越界数值", JSON.stringify({ ...DEFAULT_STYLE, pageMargin: 99 })],
    ["额外字段", JSON.stringify({ ...DEFAULT_STYLE, accent: "#7c3aed", customCss: ".resume { color: red }" })],
  ])("模型返回%s时拒绝静默回退默认值", async (_label, raw) => {
    safeChat.mockResolvedValue(raw);

    const response = await POST(request());

    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("AI 生成的样式参数异常");
  });

  it("完整且合法的样式参数仍能正常返回", async () => {
    safeChat.mockResolvedValue(JSON.stringify({ ...DEFAULT_STYLE, accent: "#7c3aed" }));

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect((await response.json()).style).toMatchObject({ accent: "#7c3aed" });
  });

  it.each([
    ["asidePosition", "center"],
    ["asidePosition", null],
    ["asideBg", "transparent"],
    ["asideBg", "#fff"],
    ["asideBorder", "dashed"],
    ["asideBorderColor", "gray"],
    ["asidePadding", 41],
    ["asideGap", -1],
    ["headerLayout", "center"],
    ["contactLayout", "grid3"],
    ["skillCols", "2"],
    ["skillCols", 4],
    ["entryCols", 1.5],
    ["contactSeparator", false],
    ["contactSeparator", "123456789"],
    ["contactGap", "8"],
    ["contactGap", 33],
    ["asideModules", "skills"],
    ["asideModules", ["skills", 1]],
    ["asideModules", ["skills", " "]],
    ["asideModules", Array(7).fill("skills")],
  ])("拒绝非法可选参数 %s=%j，不用默认值冒充生成结果", async (key, value) => {
    safeChat.mockResolvedValue(JSON.stringify({ ...DEFAULT_STYLE, accent: "#7c3aed", [key as string]: value }));

    const response = await POST(request());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: expect.stringContaining("结构校验未通过") });
  });

  it("合法的可选布局参数完整保留，包括零间距和空列表", async () => {
    const generated = {
      ...DEFAULT_STYLE,
      accent: "#1d4ed8",
      layout: "twocol",
      asidePosition: "left",
      asideModules: [],
      asideBg: "#f8fafc",
      asideBorder: "both",
      asideBorderColor: "#aabbcc",
      asidePadding: 0,
      asideGap: 40,
      headerLayout: "center-avatar",
      contactLayout: "grid2",
      contactSeparator: "",
      contactGap: 0,
      skillCols: 3,
      entryCols: 2,
    };
    safeChat.mockResolvedValue(JSON.stringify(generated));

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ style: generated });
  });

  it("可选布局参数仍可省略，按既有规则提供默认值", async () => {
    const generated = { ...DEFAULT_STYLE, accent: "#7c3aed" };
    delete generated.asidePosition;
    delete generated.headerLayout;
    delete generated.skillCols;
    safeChat.mockResolvedValue(JSON.stringify(generated));

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect((await response.json()).style).toMatchObject({
      accent: "#7c3aed", asidePosition: "right", headerLayout: "right-avatar", skillCols: 1,
    });
  });

  it("默认样式的技能标签未达到生成对比度要求时仍拒绝，不回退制造成功", async () => {
    safeChat.mockResolvedValue(JSON.stringify(DEFAULT_STYLE));

    const response = await POST(request());

    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("结构校验未通过");
  });
});
