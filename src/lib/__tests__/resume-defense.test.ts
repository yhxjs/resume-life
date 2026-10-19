import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleData } from "../modules";

let directory: string;
let opened: DatabaseSync | undefined;

beforeEach(() => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-defense-test-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
});

describe("简历排雷输出归一化", () => {
  it.each([null, undefined, "text", {}, { originalText: "   " }])("拒绝没有正文的条目 %j", async (raw) => {
    const { normalizeScannedDefenseItem } = await import("../resume-defense");
    expect(normalizeScannedDefenseItem(raw)).toBeNull();
  });

  it("支持 snake_case 字段并过滤空白与非文本数组成员", async () => {
    const { normalizeScannedDefenseItem } = await import("../resume-defense");
    const item = normalizeScannedDefenseItem({
      original_text: " 合成成果 ", section_hint: "项目", risk_level: "critical", risk_type: "data_suspicion",
      interviewer_roast: " 证据是什么？ ", deadly_questions: ["提供基线", " ", null, 3],
      defense_plan: { interviewer_intent: " 核对证据 ", standard_defense: " 说明基线 ", taboo_mistakes: ["编造数字", "", 1] },
    }, 2);
    expect(item).toEqual({
      id: "item_3", originalText: "合成成果", sectionHint: "项目", riskLevel: "critical", riskType: "data_suspicion",
      interviewerRoast: "证据是什么？", deadlyQuestions: ["提供基线"],
      defensePlan: { interviewerIntent: "核对证据", standardDefense: "说明基线", tabooMistakes: ["编造数字"] },
    });
  });

  it("保留合法 camelCase 值与明确条目 ID", async () => {
    const { normalizeScannedDefenseItem } = await import("../resume-defense");
    const input = {
      id: "evidence", originalText: "优化响应时间", sectionHint: "工作经历", riskLevel: "high", riskType: "scope_ambiguity",
      interviewerRoast: "说明边界", deadlyQuestions: ["个人贡献是什么？"],
      defensePlan: { interviewerIntent: "明确职责", standardDefense: "列举本人提交", tabooMistakes: ["揽功"] },
    };
    expect(normalizeScannedDefenseItem(input)).toEqual(input);
  });

  it("非法枚举和缺失方案回退为可用的默认字段", async () => {
    const { normalizeScannedDefenseItem } = await import("../resume-defense");
    const item = normalizeScannedDefenseItem({ originalText: "合成内容", riskLevel: "low", riskType: "unknown" });
    expect(item).toMatchObject({ id: "item_1", riskLevel: "medium", riskType: "vague_phrase", sectionHint: "简历内容" });
    expect(item?.deadlyQuestions).toHaveLength(1);
    expect(item?.defensePlan.interviewerIntent).toBeTruthy();
    expect(item?.defensePlan.standardDefense).toBeTruthy();
    expect(item?.defensePlan.tabooMistakes).toHaveLength(1);
  });

  it.each([null, undefined, "report", 5])("拒绝非法报告顶层 %j", async (raw) => {
    const { normalizeDefenseReport } = await import("../resume-defense");
    expect(() => normalizeDefenseReport(raw)).toThrow("排雷报告输出结构异常");
  });

  it("报告过滤无正文条目并沿用原数组索引生成 ID", async () => {
    const { normalizeDefenseReport } = await import("../resume-defense");
    const result = normalizeDefenseReport({ items: [null, {}, { original_text: "合成项目成果" }] });
    expect(result.riskLevel).toBe("medium");
    expect(result.overallRoast).toBeTruthy();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: "item_3", originalText: "合成项目成果" });
  });

  it("报告接受合法风险与 snake_case 点评，忽略非数组 items", async () => {
    const { normalizeDefenseReport } = await import("../resume-defense");
    expect(normalizeDefenseReport({ risk_level: "low", overall_roast: " 合成点评 ", items: {} }))
      .toEqual({ riskLevel: "low", overallRoast: "合成点评", items: [] });
  });
});

describe("简历排雷文本材料", () => {
  it("按顺序格式化全部模块与时间，保留可核对字段", async () => {
    const { formatResumeModulesToText } = await import("../resume-defense");
    const modules: ModuleData[] = [
      { key: "basic", type: "basic", label: "基本信息", sort: 0, content: { name: "演示候选人", phone: "合成电话", email: "demo@example.com", location: "示例市", links: "https://example.com" } },
      { key: "education", type: "education", label: "教育", sort: 1, content: [{ school: "示例学校", degree: "本科", field: "计算机", start: "2020", end: "2024", description: "合成课程" }] },
      { key: "work", type: "work", label: "工作", sort: 2, content: [{ company: "示例公司", title: "工程师", start: "2024", end: "2026", description: "合成工作成果" }] },
      { key: "projects", type: "projects", label: "项目", sort: 3, content: [{ name: "演示项目", role: "开发", start: "2025", end: "2026", description: "合成项目成果" }] },
      { key: "skills", type: "skills", label: "技能", sort: 4, content: { items: ["Node.js", "", "SQLite"] } },
      { key: "summary", type: "summary", label: "介绍", sort: 5, content: { text: "合成个人介绍" } },
      { key: "awards", type: "custom", label: "其他", sort: 6, content: [{ title: "合成奖项", subTitle: "演示类别", start: "2025", end: "2026", description: "合成补充信息" }] },
    ];
    expect(formatResumeModulesToText("合成简历", modules)).toBe([
      "# 合成简历", "## 基本信息\n演示候选人 | 合成电话 | demo@example.com | 示例市 | https://example.com",
      "## 教育\n示例学校 · 本科 · 计算机 · 2020 ~ 2024\n合成课程",
      "## 工作\n示例公司 · 工程师 · 2024 ~ 2026\n合成工作成果",
      "## 项目\n演示项目 · 开发 · 2025 ~ 2026\n合成项目成果",
      "## 技能\n- Node.js\n- SQLite", "## 介绍\n合成个人介绍",
      "## 其他\n合成奖项 · 演示类别 · 2025 ~ 2026\n合成补充信息",
    ].join("\n\n"));
  });

  it("空内容不生成模块标题，省略空简历标题并回退模块 key", async () => {
    const { formatResumeModulesToText } = await import("../resume-defense");
    const kinds: ModuleData["type"][] = ["basic", "education", "work", "projects", "skills", "summary", "custom"];
    const empty = kinds.map((type, sort) => ({ key: type, type, label: "", sort, content: null }));
    expect(formatResumeModulesToText("", empty)).toBe("");
    expect(formatResumeModulesToText("", [{ key: "bio", type: "summary", label: "", sort: 0, content: { text: "合成介绍" } }]))
      .toBe("## bio\n合成介绍");
  });
});

afterEach(() => {
  opened?.close();
  opened = undefined;
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-defense-test-")) {
    throw new Error("Unsafe cleanup");
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("简历排雷数据管理与删除", () => {
  it("创建排雷报告、演练记录并支持级联删除", async () => {
    const { getDb } = await import("../db");
    const {
      saveDefenseReport,
      saveDefenseDrill,
      getDefenseReport,
      getDefenseDrills,
      deleteDefenseReport,
    } = await import("../resume-defense");

    opened = getDb();

    const report = saveDefenseReport({
      resumeId: null,
      title: "测试排雷报告",
      sourceContent: "这是测试简历内容",
      targetRole: "全栈工程师",
      riskLevel: "high",
      overallRoast: "假大空较多",
      items: [
        {
          id: "item-1",
          originalText: "负责核心系统优化",
          sectionHint: "工作经历",
          riskLevel: "high",
          riskType: "vague_phrase",
          interviewerRoast: "到底怎么优化的？",
          deadlyQuestions: ["有什么指标？"],
          defensePlan: {
            interviewerIntent: "考察真实度",
            standardDefense: "从QPS、延迟说明",
            tabooMistakes: ["泛泛而谈"],
          },
        },
      ],
    });

    expect(report.id).toBeGreaterThan(0);
    expect(getDefenseReport(report.id)).not.toBeNull();

    const drill = saveDefenseDrill({
      defenseId: report.id,
      itemId: "item-1",
      question: "有什么指标？",
      userAnswer: "提升了30%",
      interviewerRoast: "基数是多少？",
      defenseScore: 70,
      defenseCritique: "缺少基线数据",
      improvedAnswer: "原本100ms降低至70ms",
    });

    expect(drill.id).toBeGreaterThan(0);
    expect(getDefenseDrills(report.id)).toHaveLength(1);

    const deleted = deleteDefenseReport(report.id);
    expect(deleted).toBe(true);

    expect(getDefenseReport(report.id)).toBeNull();
    expect(getDefenseDrills(report.id)).toHaveLength(0);

    expect(deleteDefenseReport(report.id)).toBe(false);
  });

  it("DELETE /api/tools/resume-defenses/[id] 接口能正确删除并处理404与无效ID", async () => {
    const { getDb } = await import("../db");
    const { saveDefenseReport } = await import("../resume-defense");
    const route = await import("@/app/api/tools/resume-defenses/[id]/route");

    opened = getDb();

    const report = saveDefenseReport({
      resumeId: null,
      title: "待删除报告",
      sourceContent: "简历文本",
      targetRole: "测试岗位",
      riskLevel: "medium",
      overallRoast: "总体吐槽",
      items: [],
    });

    const delReq = new Request(`http://127.0.0.1/api/tools/resume-defenses/${report.id}`, {
      method: "DELETE",
      headers: { origin: "http://127.0.0.1", host: "127.0.0.1" },
    });

    // 正常删除
    const res = await route.DELETE(delReq, { params: Promise.resolve({ id: String(report.id) }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });

    // 重复删除返回 404
    const res404 = await route.DELETE(delReq, { params: Promise.resolve({ id: String(report.id) }) });
    expect(res404.status).toBe(404);

    // 无效 ID 返回 400
    const res400 = await route.DELETE(delReq, { params: Promise.resolve({ id: "invalid" }) });
    expect(res400.status).toBe(400);
  });

  it("normalizeScannedDefenseItem 能将转义的富文本实体还原为 HTML 标签", async () => {
    const { normalizeScannedDefenseItem } = await import("../resume-defense");
    const item = normalizeScannedDefenseItem({
      id: "item-rich",
      original_text: "保障系统可用率 &lt;strong&gt;99.9%+&lt;/strong&gt;，推动线上故障次数&lt;strong&gt;下降 80%&lt;/strong&gt;。",
      section_hint: "项目经历",
      risk_level: "critical",
      risk_type: "data_suspicion",
    });

    expect(item).not.toBeNull();
    expect(item?.originalText).toBe(
      "保障系统可用率 <strong>99.9%+</strong>，推动线上故障次数<strong>下降 80%</strong>。"
    );
  });
});
