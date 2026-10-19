import { expect, test } from "@playwright/test";
import { Buffer } from "node:buffer";
import {
  BACKUP_MEDIA_TYPE,
  exportEncryptedBackup,
  postEncryptedBackup,
} from "./backup-helpers";

test("真实 API：自我评价列表类型和条目跨保存、刷新及打印预览保留", async ({ page, request }) => {
  const created = await request.post("/api/resumes", { data: { title: "E2E 自我评价列表" } });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  try {
    await page.goto(`/resumes/${id}`);
    await page.getByRole("tab", { name: "自我评价", exact: true }).click();
    await page.getByRole("textbox", { name: "自我评价第 1 行", exact: true }).fill("合成优势第一项");
    await page.getByRole("button", { name: "+ 添加一行评价", exact: true }).click();
    await page.getByRole("textbox", { name: "自我评价第 2 行", exact: true }).fill("合成优势第二项");
    await page.getByRole("button", { name: "+ 添加一行评价", exact: true }).click();

    for (const descriptionStyle of ["ordered", "unordered"] as const) {
      await page.getByRole("button", { name: descriptionStyle === "ordered" ? "1. 有序列表" : "• 无序列表", exact: true }).click();
      await expect.poll(async () => {
        const response = await request.get(`/api/resumes/${id}`);
        const document = await response.json();
        return document.modules.find((module: { key: string }) => module.key === "summary").content;
      }).toEqual({
        text: "合成优势第一项\n合成优势第二项",
        descriptionItems: ["合成优势第一项", "合成优势第二项", ""],
        descriptionStyle,
      });

      await page.reload();
      await page.getByRole("tab", { name: "自我评价", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "自我评价第 1 行", exact: true })).toHaveText("合成优势第一项");
      await expect(page.getByRole("textbox", { name: "自我评价第 2 行", exact: true })).toHaveText("合成优势第二项");
      await expect(page.getByRole("textbox", { name: "自我评价第 3 行", exact: true })).toBeEmpty();
      const firstEntry = page.locator(".paper [data-resume-entry]").filter({ hasText: "合成优势第一项" });
      await expect(firstEntry).toContainText(descriptionStyle === "ordered" ? "1." : "•");
    }
    await page.goto(`/resumes/${id}/print`);
    await expect(page.locator(".paper [data-resume-entry]").filter({ hasText: "合成优势第二项" })).toContainText("•");
  } finally {
    await request.delete(`/api/resumes/${id}`);
  }
});

test("真实 API：编辑离页仍保存，加密备份可校验并恢复导出时状态", async ({ page, request }) => {
  const baseline = await exportEncryptedBackup(request);
  if (!baseline.response.ok()) {
    throw new Error(`导出 persistence E2E baseline 失败 (${baseline.response.status()})`);
  }

  try {
    const created = await request.post("/api/resumes", { data: { title: "E2E 保存与备份" } });
    expect(created.status()).toBe(201);
    const { id } = await created.json();
    await page.goto(`/resumes/${id}`);
    const name = page.getByLabel("姓名", { exact: true });
    await name.fill("真实持久化合成人物");
    await page.locator('a[href="/tools"]').first().click();
    await expect.poll(async () => {
      const response = await request.get(`/api/resumes/${id}`);
      const data = await response.json();
      return data.modules.find((module: { type: string }) => module.type === "basic").content.name;
    }).toBe("真实持久化合成人物");

    const stats = await (await request.get("/api/backup/stats")).json();
    const exported = await exportEncryptedBackup(request);
    expect(exported.response.ok()).toBe(true);
    expect(exported.response.headers()["content-type"]).toBe(BACKUP_MEDIA_TYPE);
    expect(exported.response.headers()["content-disposition"]).toMatch(/^attachment;.*\.rlbackup/i);
    expect(exported.bytes.byteLength).toBeGreaterThan(0);

    const validation = await postEncryptedBackup(request, "/api/backup/validate", exported.bytes);
    expect(validation.status()).toBe(200);
    const validated = await validation.json();
    expect(validated.ok).toBe(true);
    expect(validated.manifest.dbVersion).toBe(stats.stats.dbVersion);
    expect(validated.stats).toBeTruthy();
    expect(validated.totalRecords).toBe(stats.stats.totalRecords);

    const before = await (await request.get(`/api/resumes/${id}`)).json();
    const added = await request.post("/api/resumes", { data: { title: "导出后新增" } });
    expect(added.status()).toBe(201);
    const { id: addedId } = await added.json();
    const afterChange = await (await request.get("/api/resumes")).json();
    expect(afterChange.some((resume: { id: number }) => resume.id === addedId)).toBe(true);

    const ordinaryJson = Buffer.from(JSON.stringify({ meta: { appName: "resume-life" }, data: {} }), "utf8");
    const invalid = await postEncryptedBackup(request, "/api/backup/restore", ordinaryJson, {
      preserveAiConfig: true,
    });
    expect(invalid.status()).toBe(400);
    expect(await (await request.get("/api/resumes")).json()).toEqual(afterChange);

    const restored = await postEncryptedBackup(request, "/api/backup/restore", exported.bytes, {
      preserveAiConfig: true,
    });
    expect(restored.ok()).toBe(true);
    const restoreResult = await restored.json();
    expect(restoreResult.snapshotCreated).toBeTruthy();
    const afterRestore = await (await request.get(`/api/resumes/${id}`)).json();
    expect(afterRestore.resume.dataGeneration).not.toBe(before.resume.dataGeneration);
    expect(afterRestore.resume.titleRevision).not.toBe(before.resume.titleRevision);
    expect(afterRestore.resume.styleRevision).not.toBe(before.resume.styleRevision);
    expect(afterRestore.resume.draftRevision).not.toBe(before.resume.draftRevision);
    expect(afterRestore).toEqual({
      ...before,
      resume: {
        ...before.resume,
        dataGeneration: afterRestore.resume.dataGeneration,
        titleRevision: afterRestore.resume.titleRevision,
        styleRevision: afterRestore.resume.styleRevision,
        draftRevision: afterRestore.resume.draftRevision,
      },
      modules: before.modules.map((module: { key: string; revision: string }) => {
        const restoredModule = afterRestore.modules.find((item: { key: string }) => item.key === module.key);
        expect(restoredModule.revision).not.toBe(module.revision);
        return { ...module, revision: restoredModule.revision };
      }),
    });
    expect((await request.get(`/api/resumes/${addedId}`)).status()).toBe(404);
  } finally {
    const cleanup = await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes, {
      preserveAiConfig: false,
    });
    if (!cleanup.ok()) {
      throw new Error(`恢复 persistence E2E baseline 失败 (${cleanup.status()}): ${await cleanup.text()}`);
    }
  }
});
