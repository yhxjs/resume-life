import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wrapUntrustedData } from "../prompt-safety";
import type { ResumeSnapshot } from "../resume-version-types";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));
const PREFIX = "resume-life-defense-source-";
const reply = JSON.stringify({ risk_level: "low", overall_roast: "基于所选材料未发现明确风险", items: [] });
let directory: string;
let db: DatabaseSync;
let firstVersion: number;
let secondVersion: number;

beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'所选简历','',''),(2,'其他简历','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'work','work','工作',?,'')")
    .run(JSON.stringify([{ company: "甲 | 工程", title: "维护", description: "参与接口校验，未上线", descriptionItems: ["参与接口校验，未上线"] }]));
  const { publishResumeVersion } = await import("../resume-versions");
  firstVersion = publishResumeVersion(1, { name: "所选发布版" }).id;
  secondVersion = publishResumeVersion(1, { name: "另一发布版" }).id;
  (await import("../resume-defense")).saveDefenseReport({ sourceContent: "历史原文", riskLevel: "low", overallRoast: "历史报告", items: [] });
});
afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

function state() {
  return Object.fromEntries(["resumes", "resume_modules", "resume_versions", "resume_defenses", "resume_defense_drills", "runtime_state"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}
function writerChange(mutate: (writer: DatabaseSync) => void) {
  const writer = new DatabaseSync(path.join(directory, "resume-life.db"));
  try { writer.exec("PRAGMA foreign_keys = ON"); mutate(writer); }
  finally { writer.close(); }
  return state();
}
function changeSnapshot(writer: DatabaseSync, versionId: number, mutate: (snapshot: ResumeSnapshot) => void) {
  const row = writer.prepare("SELECT snapshot FROM resume_versions WHERE id=?").get(versionId)!;
  const snapshot = JSON.parse(row.snapshot as string);
  mutate(snapshot);
  writer.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(JSON.stringify(snapshot), versionId);
}
function firstEntry(snapshot: ResumeSnapshot) {
  return (snapshot.modules[0]!.content as Record<string, unknown>[])[0]!;
}
async function scan(extra: Record<string, unknown> = {}) {
  return (await import("@/app/api/tools/resume-defenses/route")).POST(new Request("http://localhost/api/tools/resume-defenses", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resumeId: 1, resumeVersionId: firstVersion, ...extra }),
  }));
}
async function pause(extra: Record<string, unknown> = {}) {
  const entered = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<string>();
  model.chat.mockImplementationOnce(() => { entered.resolve(); return completion.promise; });
  const response = scan(extra);
  await entered.promise;
  return { response, release: () => completion.resolve(reply) };
}

describe("排雷报告保存前复核实际模型来源", () => {
  it.each(["{broken", "null"])("等待期间所选发布材料损坏时返回冲突并保留旧报告：%s", async snapshot => {
    const pending = await pause();
    try {
      const afterChange = writerChange(writer => writer.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(snapshot, firstVersion));
      pending.release();
      expect((await pending.response).status).toBe(409);
      expect(state()).toEqual(afterChange);
    } finally { pending.release(); await pending.response; }
  });

  it.each(["正文", "字段归属", "描述分条", "模块标签"])("等待模型时%s变化，拒绝旧报告且显式重试使用新材料", async change => {
    const pending = await pause();
    try {
      const afterChange = writerChange(writer => changeSnapshot(writer, firstVersion, snapshot => {
        const entry = firstEntry(snapshot);
        if (change === "正文") entry.description = "改为仅参与文档核对，尚未验证";
        if (change === "字段归属") { entry.company = "甲"; entry.title = "工程 | 维护"; }
        if (change === "描述分条") entry.descriptionItems = ["参与接口", "校验，未上线"];
        if (change === "模块标签") snapshot.modules[0]!.label = "实习经历";
      }));
      pending.release();
      const rejected = await pending.response;
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({ error: expect.stringContaining("重新生成") });
      expect(state()).toEqual(afterChange);
      model.chat.mockResolvedValueOnce(reply);
      const response = await scan();
      expect(response.status).toBe(200);
      const saved = await response.json();
      expect(saved.resumeVersionId).toBe(firstVersion);
      const { loadResumeContext, loadResume, formatResumeEvidenceText } = await import("../resumes");
      expect(model.chat.mock.calls[1]![1][1].content).toContain(wrapUntrustedData("candidate_resume", loadResumeContext(1, firstVersion)));
      expect(saved.sourceContent).toBe(formatResumeEvidenceText(loadResume(1, firstVersion)!.modules));
      expect(state().resume_defenses!.slice(0, -1)).toEqual(afterChange.resume_defenses);
      expect(model.chat).toHaveBeenCalledTimes(2);
    } finally { pending.release(); await pending.response; }
  });

  it.each(["删除版本", "版本归属变化", "删除简历"])("等待模型时%s，不能保存悬空或错配报告", async change => {
    const pending = await pause();
    try {
      const afterChange = writerChange(writer => {
        if (change === "删除版本") writer.prepare("DELETE FROM resume_versions WHERE id=?").run(firstVersion);
        if (change === "版本归属变化") writer.prepare("UPDATE resume_versions SET resume_id=2 WHERE id=?").run(firstVersion);
        if (change === "删除简历") writer.exec("DELETE FROM resumes WHERE id=1");
      });
      pending.release();
      expect((await pending.response).status).toBe(change === "删除简历" ? 404 : 400);
      expect(state()).toEqual(afterChange);
    } finally { pending.release(); await pending.response; }
  });

  it.each(["当前草稿", "其他发布版", "基本身份", "内部标识及键顺序", "版本标题与排版"])("等待时%s变化不影响所选职业材料", async change => {
    const pending = await pause();
    try {
      const afterChange = writerChange(writer => {
        if (change === "当前草稿") writer.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run(JSON.stringify([{ company: "草稿公司" }]));
        if (change === "其他发布版") changeSnapshot(writer, secondVersion, snapshot => { firstEntry(snapshot).company = "其他公司"; });
        if (change === "基本身份") changeSnapshot(writer, firstVersion, snapshot => { snapshot.modules.push({ key: "basic", type: "basic", label: "身份", sort: 0, content: { name: "不外发姓名" } }); });
        if (change === "内部标识及键顺序") changeSnapshot(writer, firstVersion, snapshot => {
          snapshot.modules[0]!.key = "另一内部标识";
          snapshot.modules[0]!.sort = 100;
          const entry = firstEntry(snapshot);
          entry.id = "另一条目标识";
          (snapshot.modules[0]!.content as Record<string, unknown>[])[0] = Object.fromEntries(Object.entries(entry).reverse());
        });
        if (change === "版本标题与排版") changeSnapshot(writer, firstVersion, snapshot => { snapshot.title = "新标题"; snapshot.template = "modern"; });
      });
      pending.release();
      const response = await pending.response;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ resumeVersionId: firstVersion, title: "所选简历 - 简历排雷" });
      const after = state();
      expect(after.resume_defenses!.slice(0, -1)).toEqual(afterChange.resume_defenses);
      for (const table of ["resumes", "resume_modules", "resume_versions", "resume_defense_drills"]) expect(after[table]).toEqual(afterChange[table]);
    } finally { pending.release(); await pending.response; }
  });

  it("自动选择最新版本后，后来发布不会更换本次来源", async () => {
    const pending = await pause({ resumeVersionId: undefined });
    try {
      (await import("../resume-versions")).publishResumeVersion(1, { name: "后来发布" });
      pending.release();
      const response = await pending.response;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ resumeVersionId: secondVersion });
    } finally { pending.release(); await pending.response; }
  });

  it("恢复世代变化即使材料相同也拒绝旧请求，显式重试可成功", async () => {
    const pending = await pause();
    try {
      const afterChange = writerChange(writer => writer.exec("INSERT INTO runtime_state (id,data_generation) VALUES (1,'defense-restored') ON CONFLICT(id) DO UPDATE SET data_generation=excluded.data_generation"));
      pending.release();
      const rejected = await pending.response;
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({ error: expect.stringContaining("数据已恢复") });
      expect(state()).toEqual(afterChange);
      model.chat.mockResolvedValueOnce(reply);
      expect((await scan()).status).toBe(200);
    } finally { pending.release(); await pending.response; }
  });

  it("粘贴原文不依赖任何已存简历", async () => {
    const pending = await pause({ resumeId: undefined, resumeVersionId: undefined, resumeContent: "粘贴原文，尚未上线" });
    try {
      writerChange(writer => writer.exec("DELETE FROM resumes"));
      pending.release();
      const response = await pending.response;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ resumeId: null, resumeVersionId: null, sourceContent: "粘贴原文，尚未上线" });
    } finally { pending.release(); await pending.response; }
  });
});
