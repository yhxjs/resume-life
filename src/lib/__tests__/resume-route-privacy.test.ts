import { beforeEach, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ chat: vi.fn(), basic: {
  name: "NAME_PRIVATE", phone: "PHONE_PRIVATE", email: "EMAIL_PRIVATE", location: "LOCATION_PRIVATE", links: "LINK_PRIVATE",
} }));
vi.mock("../llm", async (importOriginal) => ({ ...await importOriginal<typeof import("../llm")>(), chat: boundary.chat }));
vi.mock("../db", () => ({ DATA_DIR: "/synthetic-resume-life-route-privacy", requestDataGeneration: () => null, dataGeneration: () => null, now: () => "2026-09-27T00:00:00.000Z", getDb: () => ({ prepare: (sql: string) => ({
  get: () => sql.includes("resume_versions") ? { id: 1, snapshot: JSON.stringify({ title: "NAME_PRIVATE 的简历", template: "default", style_overrides: {}, modules: [
    { key: "basic", type: "basic", label: "基本信息", sort: 0, content: boundary.basic },
    { key: "skills", type: "skills", label: "技能", sort: 1, content: { items: ["TypeScript"] } },
  ] }) } : ({ id: 1, title: "NAME_PRIVATE 的简历", template: "default" }),
  all: () => sql.includes("resume_modules") ? [
    { module_key: "basic", type: "basic", label: "基本信息", sort: 0, content: JSON.stringify(boundary.basic) },
    { module_key: "skills", type: "skills", label: "技能", sort: 1, content: '{"items":["TypeScript"]}' },
  ] : [],
}) }) }));
import { POST as diagnose } from "../../app/api/resumes/[id]/diagnose/route";
import { POST as defense } from "../../app/api/tools/resume-defenses/route";
beforeEach(() => { boundary.chat.mockReset().mockRejectedValue(new Error("模拟模型边界停止")); });

it.each(["diagnose", "defense"])("%s 不将保存简历中的身份联系方式送到模型", async (route) => {
  const req = new Request("http://localhost/mock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jd: "TypeScript", resumeId: 1 }),
  });
  if (route === "diagnose") await diagnose(req, { params: Promise.resolve({ id: "1" }) });
  else await defense(req);
  const prompt = JSON.stringify(boundary.chat.mock.calls[0]?.[1]);
  expect(prompt).toContain("TypeScript");
  for (const marker of Object.values(boundary.basic)) expect(prompt).not.toContain(marker);
});

it("用户明确提交的待评估原文保留", async () => {
  await defense(new Request("http://localhost/mock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resumeContent: "用户明确提交的内容 TypeScript" }),
  }));
  expect(JSON.stringify(boundary.chat.mock.calls[0]?.[1])).toContain("用户明确提交的内容 TypeScript");
});
