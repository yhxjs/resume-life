import { describe, expect, it } from "vitest";
import {
  buildPolishPrompt,
  isHeaderLine,
  normalizePolishResult,
  stripDraftHeaders,
} from "@/lib/polish";

describe("polish 工具函数与清洗逻辑", () => {
  it("buildPolishPrompt 包含禁止输出抬头标题的严格指令", () => {
    const prompt = buildPolishPrompt({
      text: "负责开发工作",
      moduleType: "work",
      mode: "star",
      context: { company: "锐捷网络", title: "C软件工程师" },
    });
    expect(prompt.system).toContain("严禁输出抬头标题");
    expect(prompt.system).toContain("智能精简合并与动态合理条目数");
    expect(prompt.system).toContain("聚合同类项");
    expect(prompt.user).toContain("严禁在 draft 中输出公司/职位/项目标题抬头行");
    expect(prompt.user).toContain("所属公司/组织：锐捷网络");
  });

  it("buildPolishPrompt 支持 condense 模式并包含提纯归纳指令", () => {
    const prompt = buildPolishPrompt({
      text: "1. 负责开发某接口\n2. 优化了缓存\n3. 参加日常需求评审",
      moduleType: "projects",
      mode: "condense",
      context: { name: "电商交易中台" },
    });
    expect(prompt.user).toContain("【润色重点】：智能精简合并与深度提纯");
    expect(prompt.user).toContain("剔除日常流水账事务");
    expect(prompt.user).toContain("最恰当数量的高含金量条目");
  });

  it("buildPolishPrompt 为自我评价生成专属提示词（无具体数值，突出工程素养与核心优势）", () => {
    const prompt = buildPolishPrompt({
      text: "具备多年全栈经验，熟悉前端与服务端开发",
      moduleType: "summary",
      mode: "summary",
      targetRole: "资深全栈工程师",
    });

    // 验证 system 提示词中包含自我评价场景与无具体数值的核心原则
    expect(prompt.system).toContain("自我评价真实场景撰写逻辑");
    expect(prompt.system).toContain("自我评价无需任何具体数值");
    expect(prompt.system).toContain("严禁输出 \"[请填入真实数据...]\" 这类量化占位符");
    expect(prompt.system).toContain("拒绝假大空套话");

    // 验证 user 提示词
    expect(prompt.user).toContain("【模块类型】：自我评价");
    expect(prompt.user).toContain("无需任何具体数值与量化占位符");
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

  it("当模型返回字面量 \\n 字符时，normalizePolishResult 与 splitDraftToItems 能自动还原为真实换行", () => {
    // 模拟大模型输出 JSON 中包含转义反斜杠加字母 n（\\n）的情形
    const literalNewlineDraft =
      "• 主导设计并实现追番核心模块，支持追番状态流转。\\n• 设计账号认证与接口防护机制。\\n• 构建兴趣社交与实时通信能力。";

    const res = normalizePolishResult({
      draft: literalNewlineDraft,
      highlights: ["Spring Boot"],
    });

    expect(res).not.toBeNull();
    // 验证 draft 中的 \\n 已被转换为真实换行符
    expect(res!.draft).toBe(
      "• 主导设计并实现追番核心模块，支持追番状态流转。\n• 设计账号认证与接口防护机制。\n• 构建兴趣社交与实时通信能力。"
    );
    // 验证 draftItems 能够正确切分为 3 条独立条目，而不是挤在 1 条
    expect(res!.draftItems).toEqual([
      "主导设计并实现追番核心模块，支持追番状态流转。",
      "设计账号认证与接口防护机制。",
      "构建兴趣社交与实时通信能力。",
    ]);
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
    expect(prompt.system).toContain("来源段落溯源与多段融合");
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
});
