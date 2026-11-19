import { beforeEach, describe, expect, it, vi } from "vitest";

const { chat } = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm")>()),
  chat,
}));

import { POST } from "@/app/api/import/parse/route";
import { stripRichText } from "@/lib/rich-text";

function upload(text: string, extractOnly = false, filename = "resume.txt") {
  const form = new FormData();
  form.append("file", new File([text], filename, { type: "text/plain" }));
  if (extractOnly) form.append("extractOnly", "true");
  return new Request("http://localhost/api/import/parse", { method: "POST", body: form });
}

describe("文件导入恢复", () => {
  beforeEach(() => { chat.mockReset(); });

  it.each(["work", "projects", "custom"])("%s 的双正文不一致时整份拒绝，原文可供修正后重试", async key => {
    const qualification = "本人仅参与文档核对，未承担架构设计。";
    const achievement = "团队完成接口改造，测试环境响应时间由200ms降至120ms。";
    const source = `${qualification}\n${achievement}`;
    chat.mockResolvedValueOnce(JSON.stringify({ [key]: [{ description: qualification, descriptionItems: [achievement] }] }));
    const response = await POST(upload(source));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("正文与分条内容不一致"), extractedText: source });
    chat.mockResolvedValueOnce(JSON.stringify({ [key]: [{ description: "", descriptionItems: [qualification, achievement] }] }));
    const retry = await POST(upload(source));
    expect(retry.status).toBe(200);
    const { modules } = await retry.json();
    expect(modules[key][0].descriptionItems.map(stripRichText)).toEqual([qualification, achievement]);
    expect(stripRichText(modules[key][0].description)).toBe(source);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: "否定限定", description: "本人未主导上线", items: ["本人主导上线"] },
    { label: "字面量空格", description: "使用 Array<T>", items: ["使用 Array< T >"] },
    { label: "顺序", description: "首先测试\n之后上线", items: ["之后上线", "首先测试"] },
  ])("双正文的$label差异不能作为同一份正文接受", async ({ description, items }) => {
    chat.mockResolvedValue(JSON.stringify({ work: [{ description, descriptionItems: items }] }));
    const response = await POST(upload(description));
    expect(response.status).toBe(502);
    const failed = await response.json();
    expect(failed.modules).toBeUndefined();
    expect(failed.extractedText).toBe(description);
  });

  it.each(["work", "projects", "custom"])("%s 保留一致双正文及单一正文来源，允许换行编码与首尾空白差异", async key => {
    const items = ["• 维护 Array<T>、&amp; 文档；未上线。", "团队完成接口改造。"];
    for (const entry of [
      { description: items.join("\n"), descriptionItems: items },
      { description: ` \r\n${items.join("\r\n")}\t `, descriptionItems: items },
      { description: "", descriptionItems: items },
      { description: items.join("\n"), descriptionItems: [] },
      { description: items.join("\n") },
    ]) {
      chat.mockResolvedValue(JSON.stringify({ [key]: [entry] }));
      const response = await POST(upload(items.join("\n")));
      expect(response.status).toBe(200);
      const { modules } = await response.json();
      expect(stripRichText(modules[key][0].description)).toBe(items.join("\n"));
    }
  });

  it("导入提示的经历示例使用空数组，不诱发全空条目", async () => {
    chat.mockResolvedValue(JSON.stringify({ basic: { name: "合成人物" } }));
    const response = await POST(upload("姓名：合成人物"));
    expect(response.status).toBe(200);
    const systemPrompt = chat.mock.calls[0]![1][0]!.content as string;
    for (const field of ["education", "work", "projects", "custom"]) {
      expect(systemPrompt).toContain(`"${field}": []`);
    }
    expect(systemPrompt).toContain("不要为展示字段结构复制空条目");
    expect(systemPrompt).toContain("所有层级只返回上方结构列出的字段，不添加其他键");
    expect(systemPrompt).toContain("“[无法辨认]”是 OCR 不确定标记");
    expect(systemPrompt).toContain("不依据上下文补写缺失姓名、联系方式、日期、数字或成果");
    expect(systemPrompt).not.toContain('"school": "", "degree": ""');
    expect(systemPrompt).not.toContain('"title": "",\n    "subTitle": ""');
  });

  it.each([
    ["围栏", (json: string) => ["```json", json, "```"].join("\n")],
    ["前置说明", (json: string) => `以下为初稿：\n${json}`],
    ["后置说明", (json: string) => `${json}\n上述草稿仍需修订。`],
    ["追加截断内容", (json: string) => `${json}\n{"correction":`],
  ] as const)("%s 的模型回复不截取为导入草稿，保留完整原文且可重试", async (_label, wrap) => {
    const source = "合成人物\n使用 Array<T>、&amp;，尚未上线。";
    const output = JSON.stringify({ basic: { name: "合成人物" }, summary: { text: "使用 Array<T>、&amp;，尚未上线。" } });
    chat.mockResolvedValueOnce(wrap(output));
    const response = await POST(upload(source));
    expect(response.status).toBe(502);
    const failed = await response.json();
    expect(failed.extractedText).toBe(source);
    expect(failed.modules).toBeUndefined();
    expect(chat.mock.calls[0]![2]).toMatchObject({ requireJson: "strict" });
    chat.mockResolvedValueOnce(` \n${output}\t `);
    const retry = await POST(upload(source));
    expect(retry.status).toBe(200);
    const { modules } = await retry.json();
    expect(modules.basic.name).toBe("合成人物");
    expect(stripRichText(modules.summary.text)).toBe("使用 Array<T>、&amp;，尚未上线。");
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it.each(["education", "work", "projects", "custom"])("%s 只有换行空白正文仍不算有效经历", async (key) => {
    chat.mockResolvedValue(JSON.stringify({ basic: { name: "合成人物" }, [key]: [{ description: "\r\n\t " }] }));
    const response = await POST(upload("完整原文"));
    expect(response.status).toBe(502);
    expect((await response.json()).extractedText).toBe("完整原文");
  });

  it.each(["education", "work", "projects", "custom", "summary"])("%s 的生成正文进入富文本前保留技术标签、实体和反斜杠", async (key) => {
    const text = String.raw`使用 Array<T>、<template>、<strong>标签</strong> 与 &amp;，维护 C:\new\resume`;
    const content = key === "summary" ? { text } : [{ description: text }];
    chat.mockResolvedValue(JSON.stringify({ [key]: content }));
    const response = await POST(upload(text));
    expect(response.status).toBe(200);
    const { modules } = await response.json();
    const stored = key === "summary" ? modules.summary.text : modules[key][0].description;
    expect(stripRichText(stored)).toBe(text);
    expect(stored).not.toContain("<template>");
  });

  it("模型不得返回系统生成的经历及副项 ID，保留原文供重试", async () => {
    chat.mockResolvedValue(JSON.stringify({ work: [
      { id: "model-id", company: "甲公司", descriptionItems: ["甲任务"], subItems: [
        { id: "model-sub", label: "技术栈", value: "TypeScript" },
        { id: "model-sub", label: "团队", value: "甲团队" },
      ] },
      { id: "model-id", company: "乙公司", descriptionItems: ["乙任务"] },
    ] }));
    const response = await POST(upload("甲公司甲任务，乙公司乙任务"));
    expect(response.status).toBe(502);
    expect((await response.json()).extractedText).toBe("甲公司甲任务，乙公司乙任务");
  });

  it.each(["education", "projects", "custom"])("%s 的经历 ID 同样不采用模型提供的重复值", async (key) => {
    const entries = ["第一事项", "第二事项"].map((description) => ({ id: "model-id", description }));
    chat.mockResolvedValue(JSON.stringify({ [key]: entries }));
    const response = await POST(upload("第一事项，第二事项"));
    expect(response.status).toBe(502);
    expect((await response.json()).extractedText).toBe("第一事项，第二事项");
  });

  it("先提取原文，不配置或调用模型也能保留手工草稿", async () => {
    const response = await POST(upload("合成姓名\n项目经历：开发测试工具", true));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ extractedText: "合成姓名\n项目经历：开发测试工具" });
    expect(chat).not.toHaveBeenCalled();
  });

  it("原文超出输入预算时不调用模型，返回完整提取文本供恢复", async () => {
    const source = "简历内容".repeat(16000) + "原文末尾";
    chat.mockRejectedValue(new Error("模拟上游不可用"));
    const response = await POST(upload(source));
    expect(response.status).toBe(413);
    expect((await response.json()).extractedText === source).toBe(true);
    expect(chat).not.toHaveBeenCalled();
  });

  it("预算允许时完整传入超过旧 6 万字截点的简历尾部", async () => {
    const source = "文".repeat(60_000) + "\n末尾项目：独立测试工具";
    chat.mockResolvedValue('{"projects":[{"name":"独立测试工具"}]}');
    const response = await POST(upload(source));
    expect(response.status).toBe(200);
    expect(chat.mock.calls[0]![1][1].content).toContain(source);
    expect((await response.json()).modules.projects[0].name).toBe("独立测试工具");
  });

  it("原文较短但标签转义后超限时同样保留原文，不返回半份草稿", async () => {
    const source = "<&>".repeat(6000);
    const response = await POST(upload(source));
    expect(response.status).toBe(413);
    expect((await response.json()).extractedText).toBe(source);
    expect(chat).not.toHaveBeenCalled();
  });

  it.each(["not json", "null", "[]", "{}", '{"title":"空草稿"}', '{"work":[{}]}'])("模型输出 %s 时保留原文并返回可恢复错误", async (raw) => {
    chat.mockResolvedValue(raw);
    const response = await POST(upload("完整的合成原文"));
    expect(response.status).toBe(502);
    expect((await response.json()).extractedText).toBe("完整的合成原文");
  });

  it.each([
    ["work", '{"work":[{}]}'],
    ["projects", '{"projects":[{}]}'],
    ["education", '{"education":[{}]}'],
    ["skills", '{"skills":{}}'],
    ["summary", '{"summary":{}}'],
    ["basic", '{"basic":{}}'],
  ])("模型只回了一个空的 %s 模块时不算有内容（归一化后的枚举字段不作数）", async (_type, raw) => {
    // normalizeContent 会补齐 id、descriptionItems 与 descriptionStyle: "unordered"
    // 等机器字段；"unordered" 是真值字符串，曾被 hasContent 当成用户内容，
    // 于是空草稿被当成功返回 200，用户拿不到保留原文的恢复路径。
    chat.mockResolvedValue(raw);
    const response = await POST(upload("完整的合成原文"));
    expect(response.status).toBe(502);
    expect((await response.json()).extractedText).toBe("完整的合成原文");
  });

  it("有真实内容时照常返回草稿（机器字段豁免不误伤正常解析）", async () => {
    chat.mockResolvedValue('{"work":[{"company":"合成公司"}]}');
    const response = await POST(upload("简历原文"));
    expect(response.status).toBe(200);
    expect((await response.json()).modules.work[0].company).toBe("合成公司");
  });

  it.each(["id", "fieldOrder", "descriptionStyle", "debug"]) ("拒绝提示契约外顶层字段 %s 并完整交回原文", async (key) => {
    const source = "合成人物\n保留整份原文用于重新解析。";
    chat.mockResolvedValue(JSON.stringify({ basic: { name: "合成人物" }, [key]: "未声明内容" }));
    const response = await POST(upload(source));
    expect(response.status).toBe(502);
    const result = await response.json();
    expect(result.error).toContain("未声明字段");
    expect(result.extractedText).toBe(source);
    expect(result.modules).toBeUndefined();
  });

  it.each([
    ["basic", { name: "合成人物", phone: 13800138000 }],
    ["basic", { name: "合成人物", age: 25 }],
    ["basic", { name: "合成人物", email: null }],
    ["education", "学校名称"],
    ["education", [{ school: "合成大学" }, null]],
    ["education", [{ school: "合成大学", start: 2020 }]],
    ["work", { company: "对象不能替代经历数组" }],
    ["work", [{ company: "合成公司" }, 42]],
    ["work", [{ company: "合成公司", description: ["数组不能替代正文"] }]],
    ["work", [{ company: "合成公司", descriptionItems: ["有效事项", null] }]],
    ["work", [{ company: "合成公司", subItems: [{ label: "技术栈", value: 42 }] }]],
    ["projects", [{ name: "合成项目" }, []]],
    ["projects", [{ name: "合成项目", subItems: [null] }]],
    ["projects", [{ name: "合成项目", descriptionItems: "文本不能替代数组" }]],
    ["skills", { items: ["TypeScript", 42] }],
    ["skills", { items: "TypeScript" }],
    ["summary", { text: true }],
    ["summary", { text: "有效自评", descriptionItems: ["有效要点", {}] }],
    ["custom", [{ title: "证书", description: null }]],
    ["custom", [{ title: "证书" }, false]],
    ["projects", null],
  ])("已有有效姓名仍拒绝 %s 中的无效结构 %j，完整交回原文", async (key, value) => {
    const source = "合成人物\n原文包含多个模块，后半份也要完整保留。";
    chat.mockResolvedValue(JSON.stringify({ basic: { name: "合成人物" }, [key as string]: value }));
    const response = await POST(upload(source));
    expect(response.status).toBe(502);
    const result = await response.json();
    expect(result.error).toContain("结构无效");
    expect(result.extractedText).toBe(source);
    expect(result.modules).toBeUndefined();
  });

  it.each(["education", "work", "projects", "custom"])("已有姓名仍拒绝 %s 混入空条目，不交付部分草稿", async (key) => {
    chat.mockResolvedValue(JSON.stringify({ basic: { name: "合成人物" }, [key]: [{}] }));
    const response = await POST(upload("完整原文"));
    expect(response.status).toBe(502);
    const result = await response.json();
    expect(result.error).toContain("空条目");
    expect(result.extractedText).toBe("完整原文");
    expect(result.modules).toBeUndefined();
  });

  it.each([
    ["skills", { items: ["TypeScript", "   "] }],
    ["skills", { items: ["TypeScript", "\u200b\u2060"] }],
    ...["work", "projects", "custom"].flatMap<[string, unknown]>((key) => [
      [key, [{ descriptionItems: ["有效事项", " "] }]],
      [key, [{ descriptionItems: ["有效事项", "\u200b\u2060"] }]],
      [key, [{ description: "有效正文", subItems: [{}] }]],
      [key, [{ description: "有效正文", subItems: [{ label: "技术栈" }] }]],
      [key, [{ description: "有效正文", subItems: [{ value: "TypeScript" }] }]],
      [key, [{ description: "有效正文", subItems: [{ label: "技术栈", value: " " }] }]],
      [key, [{ description: "有效正文", subItems: [{ label: " ", value: "TypeScript" }] }]],
      [key, [{ description: "有效正文", subItems: [{ label: "\u200b", value: "TypeScript" }] }]],
      [key, [{ description: "有效正文", subItems: [{ label: "技术栈", value: "\u200b" }] }]],
    ]),
  ])("拒绝 %s 的空正文分条、技能或残缺副项，整份保留原文", async (key, value) => {
    const source = "完整原文，不能只交付有效姓名。";
    chat.mockResolvedValue(JSON.stringify({ basic: { name: "合成人物" }, [key as string]: value }));
    const response = await POST(upload(source));
    expect(response.status).toBe(502);
    const result = await response.json();
    expect(result.error).toMatch(/空条目|不可见或无效文本/);
    expect(result.extractedText).toBe(source);
    expect(result.modules).toBeUndefined();
  });

  it.each([
    ["basic", { name: "\u200b\u2060" }],
    ["summary", { text: "\u200b\u2060" }],
    ["skills", { items: ["!!!"] }],
    ["work", [{ company: "合成公司", subItems: [{ label: "技术栈", value: "\u200b" }] }]],
  ])("拒绝 %s 中的不可见或纯标点文本，保留完整原文", async (key, value) => {
    const source = "完整原文，供用户核对和重试。";
    chat.mockResolvedValue(JSON.stringify({ basic: { name: "合成人物" }, [key as string]: value }));
    const response = await POST(upload(source));
    expect(response.status).toBe(502);
    expect((await response.json()).extractedText).toBe(source);
  });

  it("稀疏但类型正确的模块可导入，明确空模块不补造经历", async () => {
    chat.mockResolvedValue(JSON.stringify({ basic: { name: "合成人物", phone: "", age: "" },
      education: [], work: [], projects: [], skills: { items: [] }, summary: { text: "" } }));
    const response = await POST(upload("合成人物"));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.modules.basic).toMatchObject({ name: "合成人物", phone: "", age: "" });
    for (const key of ["education", "work", "projects", "custom"]) expect(result.modules[key]).toEqual([]);
    expect(result.modules.skills).toEqual({ items: [] });
    expect(result.modules.summary.text).toBe("");
  });

  it("保留各模块合法文本、完整事项与列表顺序，不做数值转换", async () => {
    const items = ["使用 TypeScript 完成接口联调；未统计优化比例。", "参与验收，项目尚未上线。"];
    const subItem = { label: " 技术栈 ", value: "TypeScript  & SQL" };
    chat.mockResolvedValue(JSON.stringify({
      basic: { name: "合成人物", phone: "+86 138-0013-8000", age: "25", birthday: "2001年", links: "https://example.com?a=1&b=2" },
      education: [{ school: "合成大学", start: "2019年9月", end: "2023.06" }],
      work: [{ company: "合成公司", descriptionItems: items }],
      projects: [{ name: "合成项目", descriptionItems: items, subItems: [subItem] }],
      skills: { items: ["TypeScript", "SQL"] }, summary: { text: "参与接口开发，尚未负责架构设计。" },
    }));
    const response = await POST(upload("完整的合成原文"));
    expect(response.status).toBe(200);
    const { modules } = await response.json();
    expect(modules.basic).toMatchObject({ phone: "+86 138-0013-8000", age: "25", birthday: "2001年", links: "https://example.com?a=1&b=2" });
    expect(modules.education[0]).toMatchObject({ start: "2019年9月", end: "2023.06" });
    expect(modules.work[0].descriptionItems).toEqual(items);
    expect(modules.projects[0].descriptionItems).toEqual(items);
    expect(modules.projects[0].subItems[0]).toMatchObject(subItem);
    expect(modules.skills.items).toEqual(["TypeScript", "SQL"]);
    expect(modules.summary.text).toBe("参与接口开发，尚未负责架构设计。");
  });

  it("文件提取本身失败时不调用模型且不伪造原文", async () => {
    const response = await POST(upload("无效文件", true, "resume.unsupported"));
    expect(response.status).toBe(400);
    expect((await response.json()).extractedText).toBeUndefined();
    expect(chat).not.toHaveBeenCalled();
  });

  it("正常解析保留结构化草稿，并把请求取消信号传递给模型", async () => {
    chat.mockResolvedValue(JSON.stringify({ title: "合成简历", basic: { name: "合成人物" } }));
    const request = upload("简历原文");
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ title: "合成简历", modules: { basic: { name: "合成人物" } } });
    expect(chat.mock.calls[0]![2]).toMatchObject({ signal: request.signal });
  });

  it("富文本转义后超过创建请求上限时拒绝草稿并完整保留原文", async () => {
    const source = "原始简历仍可恢复";
    chat.mockResolvedValue(JSON.stringify({ summary: { text: "<".repeat(140_000) } }));
    const response = await POST(upload(source));
    expect(response.status).toBe(502);
    const result = await response.json();
    expect(result.error).toContain("超过简历创建请求上限");
    expect(result.extractedText).toBe(source);
    expect(result.modules).toBeUndefined();
  });

  it("系统示例的空经历不包含会被服务端拒绝的空副项", async () => {
    chat.mockResolvedValue(JSON.stringify({ basic: { name: "合成人物" }, work: [], projects: [] }));
    const response = await POST(upload("简历原文"));
    expect(response.status).toBe(200);
    const system = chat.mock.calls[0]![1][0]!.content as string;
    expect(system).not.toContain('"subItems": []');
    expect(system).toContain("work 每项包含 company、title、start、end、subItems、description、descriptionItems");
    expect(system).toContain("projects 每项包含 name、role、start、end、subItems、description、descriptionItems");
    expect(system).toContain("没有该属性时用 []，不添加空副项");
  });

  it("导入标题不超过提示词上限，非法或超限时回退为默认标题", async () => {
    const maxTitle = "字".repeat(20);
    chat.mockResolvedValueOnce(JSON.stringify({ title: maxTitle, basic: { name: "合成人物" } }));
    const boundaryResponse = await POST(upload("简历原文"));
    expect(boundaryResponse.status).toBe(200);
    expect((await boundaryResponse.json()).title).toBe(maxTitle);

    chat.mockResolvedValueOnce(JSON.stringify({ title: `${maxTitle}字`, basic: { name: "合成人物" } }));
    const overLimitResponse = await POST(upload("简历原文"));
    expect(overLimitResponse.status).toBe(200);
    expect((await overLimitResponse.json()).title).toBe("导入的简历");

    chat.mockResolvedValueOnce(JSON.stringify({ title: { text: "异常标题" }, basic: { name: "合成人物" } }));
    const invalidResponse = await POST(upload("简历原文"));
    expect(invalidResponse.status).toBe(200);
    expect((await invalidResponse.json()).title).toBe("导入的简历");
  });

  it.each([
    ["空白", " \r\n\t "],
    ["零宽字符", "\u200b\u200d\u2060"],
    ["控制字符", "\u0000\u0007\u001b"],
    ["孤立组合符", "\u0301\u0308"],
    ["字母填充符", "\u115f\u1160\u3164\uffa0"],
    ["不可见标记", "\u034f\u061c\u202e\ufe0f"],
    ["纯标点", "…！？---（）"],
  ])("导入标题只有%s时回退且保留有效正文", async (_label, title) => {
    chat.mockResolvedValue(JSON.stringify({ title, basic: { name: "合成人物" } }));
    const response = await POST(upload("姓名：合成人物"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      title: "导入的简历",
      modules: { basic: { name: "合成人物" } },
    });
  });

  it.each([
    "  前端开发简历  ",
    "履歴書 résumé 이력서",
    "C++ / C# / .NET",
    "e\u0301 简历",
    "क्\u200dष 简历",
    "👩‍💻",
    "≠≤∞",
    "\u200b开发\u200d简历\u2060",
  ])("有内容的导入标题仅去除首尾空白，保留原文 %s", async (title) => {
    chat.mockResolvedValue(JSON.stringify({ title, basic: { name: "合成人物" } }));
    const response = await POST(upload("姓名：合成人物"));
    expect(response.status).toBe(200);
    expect((await response.json()).title).toBe(title.trim());
  });

  it("支持解析多行工作内容与项目描述（descriptionItems与换行拆分）", async () => {
    chat.mockResolvedValue(
      JSON.stringify({
        title: "高级工程师简历",
        work: [
          {
            company: "示例科技",
            title: "全栈开发",
            description: "负责业务架构设计\n完成性能优化降低首屏50%",
            descriptionItems: ["负责业务架构设计", "完成性能优化降低首屏50%"],
          },
        ],
        projects: [
          {
            name: "大型中台项目",
            role: "核心成员",
            descriptionItems: ["搭建微前端基座", "实现全链路埋点方案"],
          },
        ],
      })
    );
    const request = upload("简历原文");
    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.modules.work[0].descriptionItems).toEqual([
      "负责业务架构设计",
      "完成性能优化降低首屏50%",
    ]);
    expect(data.modules.projects[0].descriptionItems).toEqual([
      "搭建微前端基座",
      "实现全链路埋点方案",
    ]);
  });

  it("支持解析工作和项目经历中的技术栈等自定义副项(subItems)", async () => {
    chat.mockResolvedValue(
      JSON.stringify({
        title: "后端开发简历",
        work: [
          {
            company: "某某互联网公司",
            title: "Java资深开发",
            subItems: [
              {
                label: "技术栈",
                value: "Spring Boot、Dubbo、MySQL、MyBatis-Plus、Kafka、Redis、XXL-JOB、WebSocket",
              },
            ],
            descriptionItems: ["主导核心中台重构", "优化高并发消息消费链路"],
          },
        ],
        projects: [
          {
            name: "分布式任务调度系统",
            role: "架构师",
            subItems: [
              {
                label: "技术栈",
                value: "Spring Cloud, Kafka, Redis",
              },
            ],
            descriptionItems: ["支撑百万级定时调度任务", "可用性达到99.99%"],
          },
        ],
      })
    );
    const request = upload("简历原文");
    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.modules.work[0].subItems).toHaveLength(1);
    expect(data.modules.work[0].subItems[0].label).toBe("技术栈");
    expect(data.modules.work[0].subItems[0].value).toBe(
      "Spring Boot、Dubbo、MySQL、MyBatis-Plus、Kafka、Redis、XXL-JOB、WebSocket"
    );
    expect(data.modules.projects[0].subItems).toHaveLength(1);
    expect(data.modules.projects[0].subItems[0].label).toBe("技术栈");
    expect(data.modules.projects[0].subItems[0].value).toBe("Spring Cloud, Kafka, Redis");
  });

  it("保持完整事项的语意连贯性，避免将同一任务的上下文按句号机械拆分", async () => {
    const singleTaskText =
      "主导订单接入系统重构，基于模板方法统一校验与建单流程。引入分布式锁防止重复提交，并配套异步队列与补偿机制。";
    chat.mockResolvedValue(
      JSON.stringify({
        title: "后端开发简历",
        work: [
          {
            company: "某某科技公司",
            title: "资深开发",
            descriptionItems: [singleTaskText],
          },
        ],
      })
    );
    const request = upload("简历原文");
    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.modules.work[0].descriptionItems).toHaveLength(1);
    expect(data.modules.work[0].descriptionItems[0]).toBe(singleTaskText);
  });
});
