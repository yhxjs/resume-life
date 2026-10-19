import { expect, test } from "@playwright/test";
import JSZip from "jszip";

test("真实登录拒绝反斜杠站外回跳，移动端表单可用", async ({ page }) => {
  await page.context().clearCookies();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login?next=%2F%5Caudit.invalid");
  await page.getByLabel("用户名", { exact: true }).fill("e2e");
  await page.getByLabel("密码", { exact: true }).fill("e2e-password-123");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3319/");
  await expect(page.getByRole("link", { name: /简历/ }).first()).toBeVisible();
});

test("真实 API 登录拒绝 null 根值且重复初始化不可覆写", async ({ request }) => {
  const invalid = await request.post("/api/auth/login", { data: "null", headers: { "Content-Type": "application/json" } });
  expect(invalid.status()).toBe(400);
  const reinit = await request.post("/api/auth/init", { data: { username: "replacement", password: "replacement-password" } });
  expect(reinit.status()).toBe(403);
});

for (const keepDrafts of [false, true]) {
  test(`真实退出按选择保留草稿=${keepDrafts}，清理敏感原词并撤销会话`, async ({ page }) => {
    // 创建本用例独立会话，退出不能撤销其他用例共用的初始化会话。
    await page.context().clearCookies();
    expect((await page.request.post("/api/auth/login", { data: { username: "e2e", password: "e2e-password-123" } })).status()).toBe(200);
    await page.goto("/settings");
    await expect(page.getByRole("button", { name: "清除本机敏感副本" })).toBeVisible();
    await page.evaluate(() => {
      localStorage.setItem("resume_life_anonymize_config", '{"customRules":[{"source":"合成秘密名称"}]}');
      sessionStorage.setItem("resume-life:draft:synthetic", '{"title":"合成草稿"}');
      localStorage.setItem("unrelated-test-key", "keep");
      localStorage.setItem("resume_life_project_repo_paths_1", '["C:/synthetic/legacy"]');
      localStorage.setItem("resume_life_project_repo_paths_initial:1", '["C:/synthetic/project"]');
    });
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "退出前处理未保存草稿" })).toBeVisible();
    await page.getByRole("button", { name: keepDrafts ? "保留草稿并退出" : "清除草稿并退出", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    const state = await page.evaluate(() => ({ config: localStorage.getItem("resume_life_anonymize_config"), draft: sessionStorage.getItem("resume-life:draft:synthetic"), other: localStorage.getItem("unrelated-test-key") }));
    expect(state).toEqual({ config: null, draft: keepDrafts ? '{"title":"合成草稿"}' : null, other: "keep" });
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("resume_life_project_repo_paths_")))).toEqual([]);
    expect((await page.request.get("/api/resumes")).status()).toBe(401);
  });
}

test("真实设置页主动清理只删除本应用敏感副本", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "清除本机敏感副本" })).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem("resume_life_anonymize_config", "synthetic");
    sessionStorage.setItem("resume-life:draft:synthetic", '{"title":"合成草稿"}');
    sessionStorage.setItem("unrelated-test-key", "keep");
    localStorage.setItem("resume_life_project_repo_paths_initial:1", '["C:/synthetic/project"]');
  });
  await page.getByRole("button", { name: "清除本机敏感副本" }).click();
  await page.getByRole("button", { name: "清除副本", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "已清除本机脱敏规则" })).toBeVisible();
  expect(await page.evaluate(() => ({ config: localStorage.getItem("resume_life_anonymize_config"), draft: sessionStorage.getItem("resume-life:draft:synthetic"), other: sessionStorage.getItem("unrelated-test-key") }))).toEqual({ config: null, draft: null, other: "keep" });
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("resume_life_project_repo_paths_")))).toEqual([]);
});

test("真实作品集 ZIP 不保留标题姓名和不可识别门牌", async ({ request }) => {
  const name = "审计测试人甲";
  const address = "审计街道42号9室";
  const created = await request.post("/api/resumes", { data: { title: `${name}的简历`, modules: {
    basic: { name, title: "工程师", location: address },
    summary: { text: "虚构测试资料" },
  } } });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  try {
    const exported = await request.post("/api/portfolio/export", { data: {
      resumeId: id, selectedProjects: [], siteTitle: `${name}的作品集`, siteSubtitle: `${name}的展示`,
    } });
    expect(exported.status()).toBe(200);
    const zip = await JSZip.loadAsync(await exported.body());
    for (const file of Object.values(zip.files).filter((file) => !file.dir)) {
      const content = await file.async("string");
      expect(content).not.toContain(name);
      expect(content).not.toContain(address);
    }
  } finally {
    await request.delete(`/api/resumes/${id}`);
  }
});
