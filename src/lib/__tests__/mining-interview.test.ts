import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getInterviewStyle, interviewStyleOf, INTERVIEW_STYLES } from "../interview";
import { normalizeReport } from "../scores";
import { MINING_INTERVIEW_RULES } from "../prompt-guidelines";

const model = vi.hoisted(() => ({ chatStream: vi.fn() }));
vi.mock("@/lib/llm", async (original) => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));

let tempDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  model.chatStream.mockReset();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-mining-test-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-mining-test-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("经历挖掘访谈官 (mining style)", () => {
  it("INTERVIEW_STYLES 包含 mining 经历挖掘风格，且 persona 符合启发式人设", () => {
    const mining = INTERVIEW_STYLES.find((s) => s.key === "mining");
    expect(mining).toBeDefined();
    expect(mining?.label).toBe("经历挖掘");
    expect(mining?.persona).toContain("经历挖掘访谈官");
    expect(mining?.persona).toContain("开放式提问");
    expect(mining?.persona).toContain("接受定性结果与记忆边界");
  });

  it("getInterviewStyle 与 interviewStyleOf 正确识别 mining 风格", () => {
    expect(getInterviewStyle("mining")).toBe("mining");
    expect(interviewStyleOf("mining").key).toBe("mining");
    expect(interviewStyleOf("mining").label).toBe("经历挖掘");
  });

  it.each([1, 3])("首题与后续作答共用事实边界，题数 %i 时仍遵守结束协议", async (rounds) => {
    db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'普通维护经历','','')");
    (await import("../resume-versions")).publishResumeVersion(1, { name: "真实维护经历" });
    model.chatStream.mockResolvedValueOnce(JSON.stringify({ question: "请选一段你愿意讨论的真实工作，介绍当时要完成的任务。" }));
    const create = (await import("@/app/api/interviews/route")).POST;
    const initial = await create(new Request("http://localhost/api/interviews", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resume_id: 1, jd: "维护业务接口", style: "mining", rounds }),
    }));
    expect(await initial.text()).toContain("event: done");
    const interview = db.prepare("SELECT id FROM interviews").get() as { id: number };
    const firstTurn = db.prepare("SELECT id FROM interview_turns WHERE interview_id = ?").get(interview.id) as { id: number };
    const candidateAnswer = "我只参与接口维护，没有选型权，结果没有量化统计。";
    model.chatStream.mockResolvedValueOnce(JSON.stringify({
      depth: 7, structure: 8, authenticity: 8, completeness: 8,
      comment: "已说明维护职责和记忆边界，具体处理方式可在后续核实。",
      next_kind: "question", next_question: rounds === 1 ? "" : "你能确认当时实际完成了哪一项维护工作？",
    }));
    const answer = (await import("@/app/api/interviews/[id]/answer/route")).POST;
    const response = await answer(new Request(`http://localhost/api/interviews/${interview.id}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turn_id: firstTurn.id, answer: candidateAnswer }),
    }), { params: Promise.resolve({ id: String(interview.id) }) });
    const events = await response.text();
    expect(events).toContain("event: done");
    expect(events).not.toContain("event: error");
    for (const call of model.chatStream.mock.calls) {
      const system = call[1][0].content as string;
      expect(system).toContain(MINING_INTERVIEW_RULES);
      expect(system).not.toContain("【量化结果与个人核心贡献】");
      expect(system).not.toContain("【量化结果与个人贡献】");
    }
    const answerMessages = model.chatStream.mock.calls[1]![1] as { role: string; content: string }[];
    expect(answerMessages.some((message) => message.role === "user" && message.content.includes(candidateAnswer))).toBe(true);
    const saved = db.prepare("SELECT answer FROM interview_turns WHERE id = ?").get(firstTurn.id);
    expect(saved).toEqual({ answer: candidateAnswer });
    const result = db.prepare("SELECT status FROM interviews WHERE id = ?").get(interview.id);
    expect(result).toEqual({ status: rounds === 1 ? "finished" : "ongoing" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM interview_turns WHERE interview_id = ?").get(interview.id))
      .toEqual({ count: rounds === 1 ? 1 : 2 });
  });

  it("数据库 interviews 表支持插入与读取 style='mining' 记录，并保存 mining_summary 报告", async () => {
    const { inTransaction, now } = await import("@/lib/db");
    const ts = now();

    db.exec("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, '经历挖掘测试简历', '', '')");

    const interviewId = inTransaction(() => {
      const res = db.prepare(
        `INSERT INTO interviews (resume_id, jd, rounds, style, status, created_at)
         VALUES (?, ?, ?, ?, 'ongoing', ?) RETURNING id`
      ).get(1, "测试高并发架构岗位JD", 4, "mining", ts) as { id: number };
      return res.id;
    });

    expect(interviewId).toBeGreaterThan(0);

    const fetched = db.prepare("SELECT id, style, status FROM interviews WHERE id = ?").get(interviewId) as {
      id: number;
      style: string;
      status: string;
    };
    expect(fetched.style).toBe("mining");
    expect(fetched.status).toBe("ongoing");

    // 测试完结更新写入 mining_summary 报告
    const mockReport = {
      depth: 9,
      structure: 8,
      authenticity: 9,
      completeness: 8,
      jd_match: 9,
      strengths: "挖掘出了核心系统的高可用取舍",
      weaknesses: "缺少大促具体错误率",
      suggestions: "建议核实原日志监控",
      mining_summary: {
        project_name: "支付中台解耦",
        background: "单体架构在流量高峰出现级联故障",
        actions: "基于事件驱动拆分为微服务集群",
        tradeoffs: "采用 Saga 事务模式权衡分布式一致性",
        results: "大促可用率达到 99.99%",
        contribution: "主导事务状态机与补偿机制设计",
        pending_confirmations: [
          { category: "量化指标", item: "补偿成功率数据", source_hint: "查阅监控大盘" },
        ],
        resume_bullets: [
          "主导支付核心链路解耦，设计 Saga 分布式事务与自动补偿机制，将系统可用率提升至 99.99%",
        ],
      },
    };

    const normalized = normalizeReport(mockReport);
    expect(normalized).not.toBeNull();

    db.prepare(
      "UPDATE interviews SET status = 'finished', report = ?, finished_at = ? WHERE id = ?"
    ).run(JSON.stringify(normalized), ts, interviewId);

    const afterFinish = db.prepare("SELECT report, status FROM interviews WHERE id = ?").get(interviewId) as {
      report: string;
      status: string;
    };
    expect(afterFinish.status).toBe("finished");
    const parsedBack = normalizeReport(JSON.parse(afterFinish.report));
    expect(parsedBack?.mining_summary?.project_name).toBe("支付中台解耦");
    expect(parsedBack?.mining_summary?.pending_confirmations).toHaveLength(1);
    expect(parsedBack?.mining_summary?.pending_confirmations[0]?.item).toBe("补偿成功率数据");
    expect(parsedBack?.mining_summary?.resume_bullets[0]).toContain("Saga 分布式事务");
  });
});
