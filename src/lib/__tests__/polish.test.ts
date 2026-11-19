import { describe, expect, it } from "vitest";
import {
  buildPolishMessages,
  buildPolishPrompt,
  isHeaderLine,
  normalizePolishResult,
  POLISH_OUTPUT_LIMITS,
  splitDraftToItems,
  stripDraftHeaders,
  validateGeneratedPolishResult,
} from "@/lib/polish";

describe("润色提示中的输出示例符合本次生产协议", () => {
  const cases = (["work", "projects", "summary"] as const).flatMap(moduleType =>
    (["star", "quantify", "summary", "condense"] as const).flatMap(mode =>
      [0, 1].map(sourceCount => ({ moduleType, mode, sourceCount }))));

  it.each(cases)("$moduleType/$mode，来源数 $sourceCount", ({ moduleType, mode, sourceCount }) => {
    const context = { name: "项目名称不等于经历", title: "目标头衔不等于能力" };
    const input = {
      text: sourceCount ? "只参与测试，尚未上线。" : " ",
      sourceParagraphs: ["", " "],
      moduleType, mode, context,
    };
    const { system } = buildPolishMessages(input);
    expect(system).toBe(buildPolishPrompt(input).system);
    const example = JSON.parse(system.match(/\n(\{\n[\s\S]*\n\})/)![1]!);
    expect(validateGeneratedPolishResult(example, context, { sourceCount, moduleType, mode })).not.toBeNull();
    expect(example.draft).toBe(example.draftItems.map((item: { text: string }) => `• ${item.text}`).join("\n"));
    if (moduleType === "summary" || mode === "summary") expect(example.star).toBeNull();
    if (sourceCount === 0) {
      expect(example.draftItems).toHaveLength(1);
      expect(example.draftItems[0].sourceIndices).toEqual([]);
      expect(example.draft).toContain("待补充");
      expect(example.highlights).toEqual([]);
    }
    for (const value of Object.values(context)) expect(system).not.toContain(value);
  });
});

describe("polish 工具函数与清洗逻辑", () => {
  it("分条正文作为唯一版本，并在清洗后保持全文、条目与来源对齐", () => {
    const result = normalizePolishResult({
      draft: "• 旧版内容，不应继续展示",
      draftItems: [
        { text: "公司：示例公司", sourceIndices: [1] },
        { text: "• 参与接口开发\r\n并完成联调", sourceIndices: [2] },
        { text: "优化缓存", sourceIndices: [1, 2] },
      ],
    }, { company: "示例公司" });
    expect(result?.draft).toBe("• 参与接口开发\n并完成联调\n• 优化缓存");
    expect(result?.draftItems).toEqual(["参与接口开发\n并完成联调", "优化缓存"]);
    expect(result?.draftItemDetails).toEqual([
      { text: "参与接口开发\n并完成联调", sourceIndices: [2] },
      { text: "优化缓存", sourceIndices: [1, 2] },
    ]);
  });

  it("来源索引只接收范围内的整数，去重排序且不强制转换异常值", () => {
    const result = normalizePolishResult({
      draft: "• 正文",
      draftItems: [
        { text: "有效映射", sourceIndices: [2, 1, 2, 3, 0, -1, 1.5, true, "1", [1], null] },
        { text: "异常映射", sourceIndices: [true, "1", [1], null, 3] },
        { text: "旧版字段", source_indices: [2, 1, 2] },
        { text: "显式为空", sourceIndices: [], source_indices: [1] },
        { text: "类型错误", sourceIndices: "1", source_indices: [1] },
        { text: "没有映射" },
      ],
    }, undefined, { sourceCount: 2 });
    expect(result?.draftItemDetails?.map((item) => item.sourceIndices)).toEqual([
      [1, 2], [], [1, 2], [], [], undefined,
    ]);
  });

  it("没有原文时不接受模型声明的来源", () => {
    const result = normalizePolishResult({
      draft: "待补充真实经历",
      draftItems: [{ text: "待补充真实经历", sourceIndices: [1] }],
    }, undefined, { sourceCount: 0 });
    expect(result?.draftItemDetails?.[0]?.sourceIndices).toEqual([]);
  });

  it("正文同时提及公司与岗位时不会被当成标题丢弃", () => {
    const text = "负责锐捷网络 C软件工程师岗位的协议开发";
    const result = normalizePolishResult({ draft: `• ${text}`, draftItems: [text] }, {
      company: "锐捷网络", title: "C软件工程师",
    });
    expect(result?.draftItems).toEqual([text]);
    expect(result?.draft).toBe(`• ${text}`);
  });

  it("buildPolishPrompt 包含禁止输出抬头标题的严格指令", () => {
    const prompt = buildPolishPrompt({
      text: "负责开发工作",
      moduleType: "work",
      mode: "star",
      context: { company: "锐捷网络", title: "C软件工程师" },
    });
    expect(prompt.system).toContain("严禁输出抬头标题");
    expect(prompt.system).toContain("draftItems 一律为对象数组，是正文条目的权威来源");
    expect(prompt.system).toContain("若两者不一致，以 draftItems 为准并在输出前修正 draft");
    expect(prompt.system).toContain("智能精简合并与动态合理条目数");
    expect(prompt.system).toContain("聚合同类项");
    expect(prompt.system).toContain('"quantifiedTips": []');
    expect(prompt.system).toContain('"highlights": []');
    expect(prompt.user).toContain("严禁在 draft 中输出公司/职位/项目标题抬头行");
    expect(prompt.user).toContain("所属公司/组织：锐捷网络");
  });

  it("buildPolishPrompt 为 condense 选择精简模式", () => {
    const prompt = buildPolishPrompt({
      text: "1. 负责开发某接口\n2. 优化了缓存\n3. 参加日常需求评审",
      moduleType: "projects",
      mode: "condense",
      context: { name: "电商交易中台" },
    });
    expect(prompt.user).toContain("【润色模式】：condense");
    expect(prompt.user).not.toContain("【润色模式】：quantify");
  });

  it("自我评价二次精简保留 condense，不被模块默认 summary 模式覆盖", () => {
    const source = "参与接口校验，2026 年测试覆盖 12 个场景，尚未上线。";
    const prompt = buildPolishPrompt({ text: source, moduleType: "summary", mode: "condense" });
    expect(prompt.user).toContain("【模块类型】：自我评价");
    expect(prompt.user).toContain("【润色模式】：condense");
    expect(prompt.user).not.toContain("【润色模式】：summary");
    expect(prompt.user).toContain("删重、合并与缩短");
    expect(prompt.user).toContain("star 设为 null，quantifiedTips 设为 []");
    expect(prompt.user).toContain(source);
  });

  it("仅提供一个来源段落时仍传入原文而不是空白框架", () => {
    const prompt = buildPolishPrompt({ text: "", sourceParagraphs: ["参与接口开发"], moduleType: "work", mode: "star" });
    expect(prompt.user).toContain("[来源段落 1]：\n参与接口开发");
    expect(prompt.user).not.toContain("暂无原文");
  });

  it("buildPolishPrompt 为自我评价选择专属模式，不要求补齐 STAR 或量化建议", () => {
    const prompt = buildPolishPrompt({
      text: "具备多年全栈经验，熟悉前端与服务端开发",
      moduleType: "summary",
      mode: "summary",
      targetRole: "资深全栈工程师",
    });

    // 验证自我评价使用专属模式与空值契约；事实保留效果需模型评估。
    expect(prompt.system).toContain("自我评价真实场景撰写逻辑");
    expect(prompt.system).toContain("严禁输出 \"[请填入真实数据...]\" 这类量化占位符");
    expect(prompt.system).toContain("拒绝假大空套话");

    // 验证 user 提示词
    expect(prompt.user).toContain("【模块类型】：自我评价");
    expect(prompt.user).toContain("star 设为 null，quantifiedTips 设为 []");
    expect(prompt.user).toContain("求职目标岗位/偏向：资深全栈工程师");
  });

  it("isHeaderLine 能准确识别各类抬头标题", () => {
    const context = { company: "锐捷网络", title: "C软件工程师" };

    // 匹配上下文的组合标题
    expect(isHeaderLine("锐捷网络 | C软件工程师", context)).toBe(true);
    expect(isHeaderLine("锐捷网络 · C软件工程师", context)).toBe(true);
    expect(isHeaderLine("锐捷网络 - C软件工程师", context)).toBe(true);
    expect(isHeaderLine("【锐捷网络】C软件工程师", context)).toBe(true);

    // 显式字段标签
    expect(isHeaderLine("公司：锐捷网络 职位：C软件工程师", context)).toBe(true);
    expect(isHeaderLine("所属公司：锐捷网络", context)).toBe(true);

    // Markdown 标题语法
    expect(isHeaderLine("### 锐捷网络 | C软件工程师", context)).toBe(true);
    expect(isHeaderLine("# 工作经历", context)).toBe(true);
    expect(isHeaderLine("【工作经历】", context)).toBe(true);

    // 日期行
    expect(isHeaderLine("2023.07 - 至今", context)).toBe(true);

    // 真实正文不应被误判为标题
    expect(
      isHeaderLine(
        "• 承担控制面三层域工作包开发，依托标准协议栈完成核心模块设计",
        context
      )
    ).toBe(false);
    expect(
      isHeaderLine(
        "主导微服务架构/容器化平台搭建，将部署效率提升 [请填入真实数据，例如：提升30%]",
        context
      )
    ).toBe(false);
    expect(
      isHeaderLine(
        "负责在锐捷网络期间的核心路由模块开发，性能优化显著",
        context
      )
    ).toBe(false);
  });

  it.each([
    { text: "熟悉 CI/CD 流程", context: undefined },
    { text: "支持 HTTP/2 与 HTTP/3", context: undefined },
    { text: "C/C++ 接口联调", context: undefined },
    { text: "熟悉 Java | Go", context: undefined },
    { text: "<strong>熟悉 CI/CD 流程</strong>", context: undefined },
    { text: "在锐捷网络担任C软件工程师期间参与接口联调", context: { company: "锐捷网络", title: "C软件工程师" } },
    { text: "锐捷网络的接口仍处于联调阶段", context: { company: "锐捷网络", title: "C软件工程师" } },
    { text: "在实时数据同步平台仅参与联调，无技术负责人职责", context: { name: "实时数据同步平台", role: "技术负责人" } },
    { text: "2023.07 接手接口维护，至今尚未上线", context: undefined },
  ])("抬头判断保留实际正文：$text", ({ text, context }) => {
    expect(isHeaderLine(text, context)).toBe(false);
    expect(stripDraftHeaders(`${text}\n负责补充接口文档`, context)).toBe(`${text}\n负责补充接口文档`);
  });

  it.each([
    "锐捷网络", "C软件工程师", "锐捷网络 | C软件工程师", "锐捷网络/C软件工程师",
    "<strong>锐捷网络</strong> · C软件工程师", "【锐捷网络】C 软件工程师",
    "2023.07 - 至今", "2020年09月—2024年06月", "2023/07 至今",
  ])("有明确依据的抬头仍清理：%s", (text) => {
    expect(isHeaderLine(text, { company: "锐捷网络", title: "C软件工程师" })).toBe(true);
  });

  it.each([
    "项目：只参与接口校验，尚未上线。",
    "角色：在指导下验证接口，未负责架构。",
    "时间：仅测试两周，结果未统计。",
    "公司：锐捷网络，仅在测试环境参与验证。",
    "职位：C软件工程师，未承担团队管理。",
    "项目名称：订单系统，尚未上线。",
    "担任角色：后端开发，仅维护文档。",
    "起止时间：2023.07 - 至今，期间只参与测试。",
    "项目：C软件工程师",
    "公司：未提供的组织",
    "公司：锐捷网络 职位：C软件工程师；仅参与验证",
    "公司：锐捷网络 职位：",
    "时间：",
  ])("字段标签不能单独作为删除正文的依据：%s", (text) => {
    const context = { company: "锐捷网络", title: "C软件工程师", name: "订单系统", role: "后端开发" };
    expect(isHeaderLine(text, context)).toBe(false);
    expect(stripDraftHeaders(`${text}\n参与接口文档核对`, context)).toBe(`${text}\n参与接口文档核对`);
  });

  it.each([
    "公司：锐捷网络 职位：C软件工程师",
    "所属公司/组织：锐捷网络 | 职位头衔：C 软件工程师",
    "项目名称：订单系统 / 担任角色：后端开发",
    "项目：订单系统 · 角色：后端开发",
    "公司名称：锐捷网络，岗位：C软件工程师",
    "起止时间：2023.07 - 至今",
    "时间:2020年09月—2024年06月",
    "公司：锐捷网络 职位：C软件工程师 起止时间：2023.07 - 至今",
    "<strong>公司：锐捷网络</strong> | 职位：C软件工程师",
    "项目 ：订单系统 / 角色 ：后端开发",
  ])("标签值与对应身份或日期完全一致时仍清理：%s", (text) => {
    expect(isHeaderLine(text, { company: "锐捷网络", title: "C软件工程师", name: "订单系统", role: "后端开发" })).toBe(true);
  });

  it("缺少上下文时保留字段内容，只清理明确日期跨度", () => {
    expect(isHeaderLine("公司：未知组织")).toBe(false);
    expect(isHeaderLine("项目：仅参与测试")).toBe(false);
    expect(isHeaderLine("起止时间：2023.07 - 至今")).toBe(true);
  });

  it.each([
    "# 仅参与接口校验，尚未上线。",
    "## 角色：在指导下验证接口，未负责架构。",
    "### 锐捷网络期间参与测试，未承担管理。",
    "#### 2023.07 接手接口维护，至今尚未上线。",
    "##### 测试两周，结果未统计。",
    "###### 参与文档核对。",
    "# 未知组织 | 未知岗位",
    "# 职位：C软件工程师（仅测试职责）",
  ])("Markdown 格式不能单独作为删除正文的依据：%s", (text) => {
    const context = { company: "锐捷网络", title: "C软件工程师" };
    expect(isHeaderLine(text, context, "plain-text")).toBe(false);
    expect(isHeaderLine(`<strong>${text}</strong>`, context)).toBe(false);
    expect(stripDraftHeaders(`${text}\n参与文档核对`, context)).toBe(`${text}\n参与文档核对`);
  });

  it.each(["C#", "#include", "C###"])("技术字面量的井号不是标题装饰：%s", (text) => {
    expect(isHeaderLine(text, { title: "C", name: "include" }, "plain-text")).toBe(false);
  });

  it.each([
    "# 工作经历", "## 公司：锐捷网络", "### 锐捷网络 | C软件工程师 ###",
    "#### 2023.07 - 至今", "##### **锐捷网络** #####", "###### 【工作经历】",
    "**# 锐捷网络**", "# C#", "**C#**",
  ])("Markdown 装饰下有明确依据的抬头仍清理：%s", (text) => {
    expect(isHeaderLine(text, { company: "锐捷网络", title: "C软件工程师", name: "C#" }, "plain-text")).toBe(true);
  });

  it("没有身份依据的分隔符文本保留，不凭分隔符推断抬头", () => {
    expect(isHeaderLine("未知组织 | 维护岗位")).toBe(false);
    expect(isHeaderLine("未知组织 / 维护岗位")).toBe(false);
  });

  it("润色结果保留技术术语、实际分工与未上线限定及来源编号", () => {
    const context = { company: "锐捷网络", title: "C软件工程师" };
    const lines = [
      "熟悉 CI/CD 流程", "在锐捷网络担任C软件工程师期间仅参与联调",
      "2023.07 接手接口维护，至今尚未上线",
    ];
    const result = normalizePolishResult({
      draft: ["锐捷网络 | C软件工程师", ...lines].join("\n"),
      draftItems: ["锐捷网络 | C软件工程师", ...lines.map((text, index) => ({ text, sourceIndices: [index + 1] }))],
    }, context, { sourceCount: 3 });
    expect(result?.draftItems).toEqual(lines);
    expect(result?.draftItemDetails).toEqual(lines.map((text, index) => ({ text, sourceIndices: [index + 1] })));
    expect(result?.draft).toBe(lines.map((text) => `• ${text}`).join("\n"));
  });

  it.each([
    "2023.07 接手接口维护，至今尚未上线",
    "3.14 秒为测试环境耗时",
    "-10% 为测试环境的变化，未上线",
    "<strong>2023.07</strong> 接手接口维护",
  ])("润色分条和结构化条目均保留数值正文：%s", (text) => {
    expect(splitDraftToItems(text)).toEqual([text]);
    expect(splitDraftToItems(`1. ${text}`)).toEqual([text]);
    const result = normalizePolishResult({
      draft: text, draftItems: [text, { text, sourceIndices: [1] }],
    }, undefined, { sourceCount: 1 });
    expect(result?.draftItems).toEqual([text, text]);
    expect(result?.draftItemDetails).toEqual([{ text }, { text, sourceIndices: [1] }]);
  });

  it("stripDraftHeaders 成功剥离第一行的公司和岗位抬头", () => {
    const rawDraft = `锐捷网络 | C软件工程师
• 承担控制面三层域工作包开发，依托架构设计完成协议栈核心模块
• 负责性能瓶颈调优，将网络吞吐量提升 [请填入真实数据，例如：提升30%]`;

    const cleaned = stripDraftHeaders(rawDraft, {
      company: "锐捷网络",
      title: "C软件工程师",
    });

    expect(cleaned).toBe(
      `• 承担控制面三层域工作包开发，依托架构设计完成协议栈核心模块\n• 负责性能瓶颈调优，将网络吞吐量提升 [请填入真实数据，例如：提升30%]`
    );
  });

  it("stripDraftHeaders 剥离多行元信息（公司岗位 + 日期行）", () => {
    const rawDraft = `锐捷网络 | C软件工程师
2023.07 - 至今
• 承担控制面三层域工作包开发
• 负责核心模块重构`;

    const cleaned = stripDraftHeaders(rawDraft, {
      company: "锐捷网络",
      title: "C软件工程师",
    });

    expect(cleaned).toBe(
      `• 承担控制面三层域工作包开发\n• 负责核心模块重构`
    );
  });

  it("normalizePolishResult 能清洗 draft 与 draftItems 中的抬头行", () => {
    const raw = {
      draft: `锐捷网络 | C软件工程师\n• 承担控制面三层域工作包开发\n• 负责性能优化`,
      draftItems: [
        "锐捷网络 | C软件工程师",
        "承担控制面三层域工作包开发",
        "负责性能优化",
      ],
      highlights: ["C语言", "网络协议"],
    };

    const res = normalizePolishResult(raw, {
      company: "锐捷网络",
      title: "C软件工程师",
    });

    expect(res).not.toBeNull();
    expect(res!.draft).toBe(
      `• 承担控制面三层域工作包开发\n• 负责性能优化`
    );
    expect(res!.draftItems).toEqual([
      "承担控制面三层域工作包开发",
      "负责性能优化",
    ]);
  });

  it.each(["结构化条目", "仅整段"])("%s 在 JSON 解析后只按真实换行分条，保留技术字面量", (shape) => {
    const texts = [
      String.raw`维护 C:\new\resume 与 C:\repo\notes，识别 /\r\n|\n/g`,
      '文档记录 <br>、<BR />、<template> 与 &amp;，示例 "\\n• " 保留原义',
    ];
    const raw = JSON.parse(JSON.stringify({
      draft: texts.map((text) => `• ${text}`).join("\r\n"),
      ...(shape === "结构化条目" ? { draftItems: texts.map((text, index) => ({ text, sourceIndices: [index + 1] })) } : {}),
      star: { action: texts[0] },
      quantifiedTips: [{ dimension: texts[1], metric: texts[0], tip: texts[1], example: texts[0] }],
    }));
    const result = normalizePolishResult(raw, undefined, { sourceCount: 2 });
    expect(result?.draft).toBe(texts.map((text) => `• ${text}`).join("\n"));
    expect(result?.draftItems).toEqual(texts);
    expect(splitDraftToItems(result!.draft)).toEqual(texts);
    expect(result?.star?.action).toBe(texts[0]);
    expect(result?.quantifiedTips[0]).toEqual({ dimension: texts[1], metric: texts[0], tip: texts[1], example: texts[0] });
    if (shape === "结构化条目") {
      expect(result?.draftItemDetails).toEqual(texts.map((text, index) => ({ text, sourceIndices: [index + 1] })));
    }
  });

  it("纯文本技术标签不会因剥标签而变成抬头，旧富文本标题仍可清理", () => {
    const text = "示例公司 <template>";
    const context = { company: "示例公司" };
    expect(normalizePolishResult({ draft: `${text}\n• 正文`, draftItems: [{ text, sourceIndices: [1] }] }, context)?.draftItems).toEqual([text]);
    expect(stripDraftHeaders("<strong>示例公司</strong><br>• 维护接口", context)).toBe("• 维护接口");
    expect(stripDraftHeaders(String.raw`维护 C:\new\resume`)).toBe(String.raw`维护 C:\new\resume`);
  });

  it("buildPolishPrompt 支持多来源段落并为各段落生成编号标记", () => {
    const prompt = buildPolishPrompt({
      text: "",
      sourceParagraphs: [
        "负责订单系统高并发重构，拆分微服务架构",
        "排查库存超卖问题，设计分布式锁与对账兜底机制",
      ],
      moduleType: "work",
      mode: "star",
    });

    expect(prompt.user).toContain("[来源段落 1]：\n负责订单系统高并发重构");
    expect(prompt.user).toContain("[来源段落 2]：\n排查库存超卖问题");
    expect(prompt.user).toContain("在 draftItems 中输出各条目并标明对应的来源段落索引 sourceIndices");
    expect(prompt.system).toContain("sourceIndices 是对应来源段落的 1-based 整数数组");
    expect(prompt.system).toContain("以下 JSON 示例已按本次模块、模式与有无原文选择字段及空值");
  });

  it("normalizePolishResult 正确解析 draftItems 中的对象格式与多来源段落映射 (sourceIndices)", () => {
    const raw = {
      draft: `• 主导订单状态机微服务重构，支撑高并发读写 [请填入真实数据]\n• 落地分布式锁与事务补偿机制，消除库存超卖 [请填入真实数据]`,
      draftItems: [
        {
          text: "主导订单状态机微服务重构，支撑高并发读写 [请填入真实数据]",
          sourceIndices: [1],
        },
        {
          text: "落地分布式锁与事务补偿机制，消除库存超卖 [请填入真实数据]",
          sourceIndices: [1, 2], // 融合了段落 1 和段落 2
        },
      ],
      highlights: ["分布式锁", "微服务架构"],
    };

    const res = normalizePolishResult(raw);

    expect(res).not.toBeNull();
    expect(res!.draftItems).toHaveLength(2);
    expect(res!.draftItems![0]).toBe("主导订单状态机微服务重构，支撑高并发读写 [请填入真实数据]");
    expect(res!.draftItems![1]).toBe("落地分布式锁与事务补偿机制，消除库存超卖 [请填入真实数据]");

    // 验证 draftItemDetails
    expect(res!.draftItemDetails).toBeDefined();
    expect(res!.draftItemDetails![0]?.sourceIndices).toEqual([1]);
    expect(res!.draftItemDetails![1]?.sourceIndices).toEqual([1, 2]);
  });

  it("一条合并草稿可关联超过输出条目数的真实来源", () => {
    const sourceCount = POLISH_OUTPUT_LIMITS.maxDraftItems + 1;
    const sourceIndices = Array.from({ length: sourceCount }, (_, index) => index + 1);
    const raw = { draft: "• 参与同一任务的实现和验证", draftItems: [{ text: "参与同一任务的实现和验证", sourceIndices }] };
    expect(validateGeneratedPolishResult(raw, undefined, { sourceCount })?.draftItemDetails?.[0]?.sourceIndices)
      .toEqual(sourceIndices);
  });

  it("结构化分条拼接后的整段正文也遵守上限，恰好达到可返回", () => {
    const texts = Array.from({ length: 16 }, () => "字".repeat(POLISH_OUTPUT_LIMITS.draftItem));
    const prefix = texts.map((text) => `• ${text}`).join("\n");
    texts.push("字".repeat(POLISH_OUTPUT_LIMITS.draft - prefix.length - 3));
    const raw = { draft: "模型返回的另一份短正文", draftItems: texts.map((text, index) => ({ text, sourceIndices: [index + 1] })) };
    expect(validateGeneratedPolishResult(raw)?.draft).toHaveLength(POLISH_OUTPUT_LIMITS.draft);
    expect(validateGeneratedPolishResult({ ...raw, draftItems: [...raw.draftItems.slice(0, -1), { ...raw.draftItems.at(-1)!, text: texts.at(-1) + "字" }] })).toBeNull();
  });

  it("新生成润色结果按篇幅和数量整份校验，兼容清洗不套用上限", () => {
    const valid = {
      draft: "• " + "字".repeat(POLISH_OUTPUT_LIMITS.draftItem),
      draftItems: [{ text: "字".repeat(POLISH_OUTPUT_LIMITS.draftItem), sourceIndices: [1] }],
      star: { action: "字".repeat(POLISH_OUTPUT_LIMITS.starField) },
      quantifiedTips: [{ dimension: "维度", metric: "指标", tip: "核实方式", example: "" }],
      highlights: ["字".repeat(POLISH_OUTPUT_LIMITS.highlight)],
    };
    expect(validateGeneratedPolishResult(valid, undefined, { sourceCount: 1 })).not.toBeNull();
    expect(validateGeneratedPolishResult({ ...valid, draft: "字".repeat(POLISH_OUTPUT_LIMITS.draft + 1) }, undefined, { sourceCount: 1 })).toBeNull();
    expect(validateGeneratedPolishResult({ ...valid, draftItems: [{ text: "字".repeat(POLISH_OUTPUT_LIMITS.draftItem + 1) }] }, undefined, { sourceCount: 1 })).toBeNull();
    expect(validateGeneratedPolishResult({ ...valid, quantifiedTips: Array.from({ length: POLISH_OUTPUT_LIMITS.maxQuantifiedTips + 1 }, () => ({ dimension: "维度" })) }, undefined, { sourceCount: 1 })).toBeNull();
    expect(validateGeneratedPolishResult({ ...valid, highlights: Array.from({ length: POLISH_OUTPUT_LIMITS.maxHighlights + 1 }, () => "关键词") }, undefined, { sourceCount: 1 })).toBeNull();

    const long = { draft: "字".repeat(POLISH_OUTPUT_LIMITS.draft + 1) };
    expect(normalizePolishResult(long)?.draft).toHaveLength(POLISH_OUTPUT_LIMITS.draft + 1);
    expect(validateGeneratedPolishResult(long)).toBeNull();
  });

  it("拒绝非空字段中的不可见或纯标点占位，同时保留协议允许的空字段", () => {
    const raw = { draft: "• 有依据的正文", draftItems: [{ text: "有依据的正文", sourceIndices: [1] }] };
    expect(validateGeneratedPolishResult({ ...raw, draft: "\u200b" })).toBeNull();
    expect(validateGeneratedPolishResult({ ...raw, draftItems: [{ text: "!!!", sourceIndices: [1] }] })).toBeNull();
    expect(validateGeneratedPolishResult({ ...raw, highlights: ["\u2060"] })).toBeNull();
    expect(validateGeneratedPolishResult({ ...raw, star: { action: "\u200b" } })).toBeNull();
    expect(validateGeneratedPolishResult({ ...raw, star: null, quantifiedTips: [], highlights: [] })).not.toBeNull();
  });

  it.each([
    { draft: "正文", note: "解释" },
    { draft: "正文", star: { action: "行动", note: "解释" } },
    { draft: "正文", quantifiedTips: [{ dimension: "维度", note: "解释" }] },
    { draft: "正文", draftItems: [{ text: "条目", confidence: 1 }] },
  ])("新生成结果的结构化字段出现未声明的键时拒绝整份结果", (raw) => {
    expect(validateGeneratedPolishResult(raw)).toBeNull();
    expect(normalizePolishResult(raw)).not.toBeNull();
  });

  it.each([
    ["content 别名", [{ content: "条目", sourceIndices: [1] }]],
    ["source_indices 别名", [{ text: "条目", source_indices: [1] }]],
    ["缺少来源索引", [{ text: "条目" }]],
    ["重复来源索引", [{ text: "条目", sourceIndices: [1, 1] }]],
    ["逆序来源索引", [{ text: "条目", sourceIndices: [2, 1] }]],
    ["越界来源索引", [{ text: "条目", sourceIndices: [2] }]],
    ["非整数来源索引", [{ text: "条目", sourceIndices: [1.5] }]],
  ])("新生成结果拒绝非规范的%s，同时保留历史兼容清洗", (_label, draftItems) => {
    const raw = { draft: "• 条目", draftItems };
    expect(validateGeneratedPolishResult(raw, undefined, { sourceCount: 1 })).toBeNull();
    expect(normalizePolishResult(raw, undefined, { sourceCount: 1 })).not.toBeNull();
  });

  it("新生成对象条目允许无来源时显式空映射，并拒绝省略 draftItems", () => {
    const raw = { draft: "• 待补充", draftItems: [{ text: "待补充", sourceIndices: [] }] };
    expect(validateGeneratedPolishResult(raw, undefined, { sourceCount: 0 })).not.toBeNull();
    expect(validateGeneratedPolishResult({ ...raw, draftItems: [{ text: "待补充", sourceIndices: [1] }] }, undefined, { sourceCount: 0 })).toBeNull();
  });

  it.each([
    ["缺少 draftItems", { draft: "• 参与接口开发" }],
    ["多来源正文未提供来源映射", { draft: "• 参与接口开发" }],
    ["字符串格式 draftItems", { draft: "• 参与接口开发", draftItems: ["参与接口开发"] }],
  ])("新生成结果拒绝%s，同时保留历史兼容清洗", (_label, raw) => {
    expect(validateGeneratedPolishResult(raw, undefined, { sourceCount: 2 })).toBeNull();
    expect(normalizePolishResult(raw, undefined, { sourceCount: 2 })).not.toBeNull();
  });
});
