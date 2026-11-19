import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { METRIC_EVIDENCE_RULES } from "../prompt-guidelines";
import { wrapUntrustedData } from "../prompt-safety";

const model = vi.hoisted(() => ({ chat: vi.fn(), stream: vi.fn() }));
vi.mock("@/lib/llm", async original => ({
  ...await original<typeof import("@/lib/llm")>(), chat: model.chat, chatStream: model.stream,
}));

const PREFIX = "resume-life-intro-metrics-";
const original = [{ text: "旧版介绍。", comment: "旧版点评。" }];
let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset();
  model.stream.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'合成简历','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'summary','summary','简介',?,'original')")
    .run(JSON.stringify({ text: "待设置的合成材料" }));
  db.exec("INSERT INTO intros (id,resume_id,jd,created_at) VALUES (1,1,'接口验证岗位','original')");
  for (const kind of ["30s", "2min"]) {
    db.prepare("INSERT INTO intro_versions (intro_id,kind,sentences,updated_at) VALUES (1,?,?,'original')")
      .run(kind, JSON.stringify(original));
  }
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

const scenarios = [
  {
    label: "前后值与原比例冲突",
    source: "测试环境接口 P95 耗时由 200ms 降到 100ms，原文写降低 80%；本人只参与测试，尚未上线。",
    text: "我参与了测试环境的接口验证，P95 耗时从 200ms 降至 100ms，尚未上线。",
    comment: "保留前后值与个人分工，原文 80% 与前后值冲突，比例待核实。",
  },
  {
    label: "百分点与相对变化率不同",
    source: "某任务失败率由 10% 降至 8%，原文写降低 2%；本人参与验证，其余统计口径未提供。",
    text: "我参与的任务记录失败率从 10% 降至 8%，其他统计口径待核实。",
    comment: "两个百分点是率值之差，与相对变化率不同，仍需核对统计口径。",
  },
  {
    label: "提升比例缺少基线",
    source: "优化前未测量吞吐量，当前在测试环境测得约 100 QPS；原文写吞吐提升 100%，本人参与验证。",
    text: "我参与的测试环境测得吞吐约 100 QPS，缺少优化前基线。",
    comment: "缺少可比基线，不把 100% 提升写成确定成果，保留约数和环境。",
  },
];

describe.each(["create", "regenerate", "recomment"] as const)("自我介绍 %s 的指标上下文", action => {
  it.each(scenarios)("$label：传递完整规则与原始材料，只保存本次对应的正文或点评", async scenario => {
    db.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run(JSON.stringify({ text: scenario.source }));
    const version = (await import("../resume-versions")).publishResumeVersion(1, { name: "指标材料发布版" });
    db.prepare("UPDATE intros SET resume_version_id=? WHERE id=1").run(version.id);
    if (action === "recomment") {
      db.prepare("UPDATE intro_versions SET sentences=? WHERE intro_id=1 AND kind='30s'")
        .run(JSON.stringify([{ text: scenario.source, comment: "旧版点评。" }]));
    }
    const contextTables = ["resumes", "resume_modules", "resume_versions"];
    const contextState = () => contextTables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    const beforeContext = contextState();
    const beforeIntros = db.prepare("SELECT * FROM intros ORDER BY id").all();
    const beforeVersions = db.prepare("SELECT * FROM intro_versions ORDER BY id").all();
    const sentences = [{ text: scenario.text, comment: scenario.comment }];
    const kinds = action === "create" ? ["30s", "2min"] : ["30s"];
    const reply = JSON.stringify(action === "recomment" ? { comments: [scenario.comment] }
      : { versions: kinds.map(kind => ({ kind, sentences })) });
    const caller = action === "create" ? model.stream : model.chat;
    caller.mockResolvedValueOnce(reply);
    const request = new Request("http://localhost/api/intros", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action === "create" ? { resume_id: 1, resume_version_id: version.id, jd: "接口验证岗位" } : { kind: "30s" }),
    });
    const context = { params: Promise.resolve({ id: "1" }) };
    const response = action === "create" ? await (await import("@/app/api/intros/route")).POST(request)
      : action === "regenerate" ? await (await import("@/app/api/intros/[id]/regenerate/route")).POST(request, context)
      : await (await import("@/app/api/intros/[id]/recomment/route")).POST(request, context);
    expect(response.status).toBe(200);
    if (action === "create") expect(await response.text()).toContain("event: done");
    else expect((await response.json()).sentences).toEqual(action === "recomment" ? [{ text: scenario.source, comment: scenario.comment }] : sentences);

    expect(caller).toHaveBeenCalledOnce();
    const messages = caller.mock.calls[0]![1] as { role: string; content: string }[];
    const system = messages.find(message => message.role === "system")!.content;
    expect(system).toContain(METRIC_EVIDENCE_RULES);
    const { INTRO_COMMENT_SYSTEM_PROMPT, INTRO_SYSTEM_PROMPT } = await import("../intro-llm");
    expect(system).toContain(action === "recomment" ? INTRO_COMMENT_SYSTEM_PROMPT : INTRO_SYSTEM_PROMPT);
    const material = action === "recomment"
      ? wrapUntrustedData("intro_sentences", JSON.stringify([{ i: 1, text: scenario.source }]))
      : wrapUntrustedData("candidate_resume", (await import("../resumes")).loadResumeContext(1, version.id));
    expect(messages.find(message => message.role === "user")!.content).toContain(material);
    expect(caller.mock.calls[0]!.at(-1)).toMatchObject({ requireJson: "strict" });
    expect(contextState()).toEqual(beforeContext);

    const introId = action === "create" ? 2 : 1;
    const saved = db.prepare("SELECT sentences FROM intro_versions WHERE intro_id=? AND kind='30s'").get(introId) as { sentences: string };
    expect(JSON.parse(saved.sentences)).toEqual(action === "recomment" ? [{ text: scenario.source, comment: scenario.comment }] : sentences);
    if (action === "create") {
      expect(db.prepare("SELECT * FROM intros WHERE id=1").get()).toEqual(beforeIntros[0]);
      expect(db.prepare("SELECT * FROM intro_versions WHERE intro_id=1 ORDER BY id").all()).toEqual(beforeVersions);
      const longVersion = db.prepare("SELECT sentences FROM intro_versions WHERE intro_id=2 AND kind='2min'").get() as { sentences: string };
      expect(JSON.parse(longVersion.sentences)).toEqual(sentences);
    } else {
      expect(db.prepare("SELECT * FROM intros ORDER BY id").all()).toEqual(beforeIntros);
      expect(db.prepare("SELECT * FROM intro_versions WHERE intro_id=1 AND kind='2min'").get()).toEqual(beforeVersions[1]);
    }
  });
});
