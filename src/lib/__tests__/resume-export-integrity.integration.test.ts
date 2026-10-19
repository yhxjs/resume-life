import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let directory: string;
let db: DatabaseSync;
const renderPdf = vi.hoisted(() => vi.fn(async () => Buffer.from("%PDF-1.4")));
vi.mock("@/lib/pdf-render", async (original) => ({
  ...await original<typeof import("@/lib/pdf-render")>(), generateResumePdf: renderPdf,
}));

beforeEach(async () => {
  vi.resetModules();
  renderPdf.mockClear();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-export-integrity-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("@/lib/db")).getDb();
  db.prepare("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'Audit Resume','','')").run();
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,sort,content,updated_at) VALUES (1,'work','work','工作经历',0,?,'')").run("{broken");
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-export-integrity-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("损坏简历不能生成成功附件", () => {
  it.each(["md", "pdf", "docx"] as const)("%s 拒绝损坏排版且不能跳过完整性校验", async (format) => {
    db.prepare("UPDATE resume_modules SET content='[]' WHERE resume_id=1").run();
    db.prepare("UPDATE resumes SET style_overrides='{broken' WHERE id=1").run();
    const route = format === "md" ? await import("@/app/api/resumes/[id]/export/route")
      : format === "pdf" ? await import("@/app/api/resumes/[id]/export/pdf/route")
        : await import("@/app/api/resumes/[id]/export/docx/route");
    for (const body of [undefined, {}, { skipExportCheck: true }]) {
      const request = new Request("http://localhost/export", body === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const response = await (body === undefined ? route.GET : route.POST)(request, { params: Promise.resolve({ id: "1" }) });
      expect(response.status).toBe(422);
      expect(response.headers.has("content-disposition")).toBe(false);
      expect((await response.json()).error).toContain("排版数据损坏");
    }
    expect(renderPdf).not.toHaveBeenCalled();
    db.prepare("UPDATE resumes SET style_overrides='{}' WHERE id=1").run();
    expect((await route.GET(new Request("http://localhost/export"), { params: Promise.resolve({ id: "1" }) })).status).toBe(200);
  });

  it.each(["md", "pdf", "docx"] as const)("%s 的 GET/POST/跳过核对均拒绝损坏模块，修复内容后可导出", async (format) => {
    const route = format === "md" ? await import("@/app/api/resumes/[id]/export/route")
      : format === "pdf" ? await import("@/app/api/resumes/[id]/export/pdf/route")
        : await import("@/app/api/resumes/[id]/export/docx/route");
    const params = () => ({ params: Promise.resolve({ id: "1" }) });
    for (const body of [undefined, {}, { skipExportCheck: true }]) {
      const request = new Request("http://localhost/api/resumes/1/export", body === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const response = await (body === undefined ? route.GET : route.POST)(request, params());
      expect(response.status).toBe(422);
      expect(response.headers.has("content-disposition")).toBe(false);
      expect(await response.json()).toMatchObject({ corruptedKeys: ["work"] });
    }
    expect(renderPdf).not.toHaveBeenCalled();
    db.prepare("UPDATE resume_modules SET content='[]' WHERE resume_id=1").run();
    expect((await route.GET(new Request("http://localhost/export"), params())).status).toBe(200);
  });
});
