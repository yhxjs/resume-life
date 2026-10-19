import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-report-summary-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(directory, "data"));
  db = (await import("@/lib/db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'测试简历','',''); INSERT INTO interview_series (id,resume_id,jd,created_at) VALUES (1,1,'JD',''); INSERT INTO interviews (id,resume_id,series_id,round_no,jd,created_at) VALUES (1,1,1,1,'JD','')");
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-report-summary-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

describe.each(["series list", "interview siblings"] as const)("%s 总分摘要", (endpoint) => {
  it.each([
    ["零分", '{"overall":0}', 0],
    ["满分", '{"overall":10}', 10],
    ["小数", '{"overall":7.5}', 7.5],
    ["缺少总分", '{}', null],
    ["空报告", '', null],
    ["损坏 JSON", '{broken', null],
    ["null 根值", 'null', null],
    ["null 总分", '{"overall":null}', null],
    ["布尔总分", '{"overall":true}', null],
    ["空字符串总分", '{"overall":" "}', null],
    ["负分", '{"overall":-1}', null],
    ["超范围评分", '{"overall":11}', null],
    ["无限评分", '{"overall":1e309}', null],
  ])("%s按数值范围返回总分摘要", async (_label, report, expected) => {
    db.prepare("UPDATE interview_series SET final_report=? WHERE id=1").run(report);
    db.prepare("UPDATE interviews SET report=? WHERE id=1").run(report);
    let actual: number | null;
    if (endpoint === "series list") {
      const { GET } = await import("@/app/api/interviews/series/route");
      const response = await GET(new Request("http://localhost/api/interviews/series"));
      expect(response.status).toBe(200);
      actual = (await response.json()).items[0].final_overall;
    } else {
      const { GET } = await import("@/app/api/interviews/[id]/route");
      const response = await GET(new Request("http://localhost/api/interviews/1"), { params: Promise.resolve({ id: "1" }) });
      expect(response.status).toBe(200);
      actual = (await response.json()).series_rounds[0].overall;
    }
    expect(actual).toBe(expected);
  });
});
