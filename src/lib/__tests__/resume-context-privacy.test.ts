import { expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  basic: { name: "NAME_PRIVATE", phone: "PHONE_PRIVATE", email: "EMAIL_PRIVATE", location: "EXACT_ADDRESS_PRIVATE", links: "LINK_PRIVATE" },
}));
vi.mock("../db", () => ({ DATA_DIR: "/synthetic-resume-life-context-privacy", dataGeneration: () => null, getDb: () => ({ prepare: (sql: string) => ({
  get: () => ({ id: 1, title: "求职资料", template: "default" }),
  all: () => sql.includes("resume_modules") ? [
    { module_key: "basic", type: "basic", label: "基本信息", sort: 0, content: JSON.stringify(fixture.basic) },
    { module_key: "extra-basic", type: "basic", label: "其他联系信息", sort: 1, content: JSON.stringify(fixture.basic) },
    { module_key: "skills", type: "skills", label: "技能", sort: 2, content: JSON.stringify({ items: ["TypeScript", "性能优化"] }) },
  ] : [],
}) }) }));
import { formatResumeContext, loadResumeContext } from "../resumes";

it("模型简历上下文保留职业技能但省略全部基本身份与联系字段", () => {
  const prompt = loadResumeContext(1);
  expect(prompt).toContain("TypeScript");
  for (const marker of Object.values(fixture.basic)) expect(prompt).not.toContain(marker);
});

it("职业投影保留工作、项目和自定义条目的结构化子项，排除未知身份字段", () => {
  const context = formatResumeContext([
    { type: "work", label: "工作经历", content: [{ company: "职业公司", title: "软件工程师",
      description: "优化响应性能", subItems: [{ label: "所属部门", value: "CAREER_DEPARTMENT" }], email: "PRIVATE_EXTRA_EMAIL" }] },
    { type: "projects", label: "项目经历", content: [{ name: "职业项目", role: "负责工程化",
      subItems: [{ label: "技术栈", value: "CAREER_TECH_STACK" }] }] },
    { type: "custom", label: "职业补充", content: [{ title: "认证与成果",
      subItems: [{ label: "成果", value: "CAREER_ACHIEVEMENT" }] }] },
  ]);
  for (const marker of ["CAREER_DEPARTMENT", "CAREER_TECH_STACK", "CAREER_ACHIEVEMENT"]) expect(context).toContain(marker);
  expect(context).not.toContain("PRIVATE_EXTRA_EMAIL");
});
