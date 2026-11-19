import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeDiagnosisValue } from "@/lib/module-descriptions";
import { escapePlainTextToRichHtml } from "@/lib/rich-text";
import type { WorkItem } from "@/lib/modules";

const model = vi.hoisted(() => ({ safeChat: vi.fn() }));
vi.mock("@/lib/safe-llm", async (original) => ({
  ...await original<typeof import("@/lib/safe-llm")>(), ...model,
}));

let directory: string;
let db: DatabaseSync;
const params = { params: Promise.resolve({ id: "1" }) };
const sourceLines = [
  "*ptr 为被测指针的解引用，仅完成本地验证。",
  "--dry-run 仅验证部署流程，未实际发布。",
  "-O2 仅用于测试构建，未验证生产性能。",
  "3.x 版本仅完成兼容性测试，尚未上线。",
  "2.example.com 为测试域名，未用于生产。",
];

beforeEach(async () => {
  vi.resetModules();
  model.safeChat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-polish-review-markers-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("@/lib/db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'复现简历','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'work','work','工作经历',?,'')")
    .run(JSON.stringify([{ id: "w1", company: "测试公司", title: "开发工程师", description: "原经历", descriptionItems: ["原经历"] }]));
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-polish-review-markers-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("独立复核：技术前缀不是列表标记", () => {
  it.each(sourceLines)("润色接口保持模型已返回的技术语义：%s", async (text) => {
    model.safeChat.mockResolvedValue(JSON.stringify({ draft: `• ${text}`, draftItems: [{ text, sourceIndices: [1] }] }));
    const route = await import("@/app/api/resumes/[id]/polish/route");
    const response = await route.POST(new Request("http://localhost/api/resumes/1/polish", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, moduleType: "work", mode: "condense" }),
    }), params);
    expect(response.status).toBe(200);
    const { result } = await response.json();
    expect(result.draftItems).toEqual([text]);
    expect(result.draftItemDetails).toEqual([{ text, sourceIndices: [1] }]);
  });

  it.each(sourceLines)("采纳保存和重新加载保留技术前缀：%s", async (text) => {
    const { loadResume } = await import("@/lib/resumes");
    const route = await import("@/app/api/resumes/[id]/route");
    const mod = loadResume(1)!.modules.find((entry) => entry.key === "work")!;
    const content = writeDiagnosisValue("work", mod.content, "w1", escapePlainTextToRichHtml(text));
    const response = await route.PATCH(new Request("http://localhost/api/resumes/1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ modules: { work: content }, moduleRevisions: { work: mod.revision } }),
    }), params);
    expect(response.status).toBe(200);
    const saved = loadResume(1)!.modules.find((entry) => entry.key === "work")!.content as WorkItem[];
    expect(saved[0]!.description).toBe(text);
    expect(saved[0]!.descriptionItems).toEqual([text]);
  });
});
