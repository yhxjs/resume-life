import { expect, test } from "@playwright/test";
import { Buffer } from "node:buffer";
import {
  BACKUP_MEDIA_TYPE,
  E2E_BACKUP_PASSWORD,
  encodeBackupPasswordHeader,
} from "./backup-helpers";
import { gate } from "./synthetic-api";

test("备份密码控件不声明登录密码语义", async ({ page }) => {
  await page.goto("/settings");

  for (const label of ["导出密码", "确认导出密码", "导入密码"]) {
    await expect(page.getByLabel(label, { exact: true })).toHaveAttribute("autocomplete", "off");
  }
  await expect(page.getByText(/应用自身不持久化密码/)).toBeVisible();
});

test("导入密码逐键输入只在停顿后验证一次", async ({ page }) => {
  const fixture = Buffer.from([0x52, 0x4c, 0x49, 0x46, 0x45, 0, 1, 0xff, 0x10, 0x00]);
  let validateRequests = 0;

  await page.route("**/api/backup/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/backup/stats") {
      await route.fulfill({ json: { ok: true, stats: null } });
      return;
    }
    if (pathname === "/api/backup/validate") {
      validateRequests += 1;
      await route.fulfill({
        json: {
          ok: true,
          manifest: {
            kind: "manifest",
            appName: "resume-life",
            backupVersion: "1.0.0",
            dbVersion: 1,
            createdAt: "2026-09-16T00:00:00.000Z",
            tables: [],
          },
          stats: {},
          totalRecords: 0,
        },
      });
      return;
    }
    await route.fallback();
  });

  await page.goto("/settings");
  await page.locator('input[type="file"]').setInputFiles({
    name: "fixture.rlbackup",
    mimeType: BACKUP_MEDIA_TYPE,
    buffer: fixture,
  });
  await page.getByLabel("导入密码", { exact: true }).pressSequentially(E2E_BACKUP_PASSWORD, { delay: 25 });
  await expect.poll(() => validateRequests).toBe(1);
});

test("忽略 signal 的乱序校验响应只保留最新结果", async ({ page }) => {
  const fixture = Buffer.from([0x52, 0x4c, 0x49, 0x46, 0x45, 0, 1, 0xff, 0x10, 0x00]);
  const oldPassword = "old-validation-password";
  const newPassword = "new-validation-password";

  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    const pending: Array<{ password: string; resolve: (response: Response) => void }> = [];
    const seenPasswords: string[] = [];
    const harness = window as typeof window & {
      __backupValidationPasswords: () => string[];
      __releaseBackupValidation: (password: string, totalRecords: number) => void;
    };

    harness.__backupValidationPasswords = () => [...seenPasswords];
    harness.__releaseBackupValidation = (password, totalRecords) => {
      const index = pending.findIndex((request) => request.password === password);
      if (index < 0) throw new Error(`找不到待释放的校验请求：${password}`);
      const [request] = pending.splice(index, 1);
      request!.resolve(new Response(JSON.stringify({
        ok: true,
        manifest: {
          kind: "manifest",
          appName: "resume-life",
          backupVersion: "1.0.0",
          dbVersion: 1,
          createdAt: "2026-09-16T00:00:00.000Z",
          tables: [],
        },
        stats: {},
        totalRecords,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    };

    window.fetch = (input, init) => {
      const requestUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (new URL(requestUrl, window.location.href).pathname !== "/api/backup/validate") {
        return nativeFetch(input, init);
      }

      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const password = headers.get("X-Resume-Life-Backup-Password") ?? "";
      seenPasswords.push(password);
      return new Promise<Response>((resolve) => {
        pending.push({ password, resolve });
      });
    };
  });

  await page.goto("/settings");
  await page.locator('input[type="file"]').setInputFiles({
    name: "fixture.rlbackup",
    mimeType: BACKUP_MEDIA_TYPE,
    buffer: fixture,
  });

  const importPassword = page.getByLabel("导入密码", { exact: true });
  await importPassword.fill(oldPassword);
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __backupValidationPasswords: () => string[] }
  ).__backupValidationPasswords())).toEqual([encodeBackupPasswordHeader(oldPassword)]);

  await importPassword.fill(newPassword);
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __backupValidationPasswords: () => string[] }
  ).__backupValidationPasswords())).toEqual([
    encodeBackupPasswordHeader(oldPassword),
    encodeBackupPasswordHeader(newPassword),
  ]);

  await page.evaluate(({ password, totalRecords }) => (
    window as typeof window & { __releaseBackupValidation: (value: string, totalRecords: number) => void }
  ).__releaseBackupValidation(password, totalRecords), { password: encodeBackupPasswordHeader(newPassword), totalRecords: 202 });
  await expect(page.getByText("共 202 条记录", { exact: true })).toBeVisible();

  await page.evaluate(({ password, totalRecords }) => (
    window as typeof window & { __releaseBackupValidation: (value: string, totalRecords: number) => void }
  ).__releaseBackupValidation(password, totalRecords), { password: encodeBackupPasswordHeader(oldPassword), totalRecords: 101 });
  await expect(page.getByText("共 101 条记录", { exact: true })).toHaveCount(0);
  await expect(page.getByText("共 202 条记录", { exact: true })).toBeVisible();
});

test("通过可见按钮连续重选同一备份文件仍会再次验证", async ({ page }) => {
  const fixture = Buffer.from([0x52, 0x4c, 0x49, 0x46, 0x45, 0, 1, 0xff, 0x10, 0x00]);
  const backupFile = {
    name: "same-file.rlbackup",
    mimeType: BACKUP_MEDIA_TYPE,
    buffer: fixture,
  };
  let validateRequests = 0;

  await page.route("**/api/backup/validate", async (route) => {
    validateRequests += 1;
    await route.fulfill({
      json: {
        ok: true,
        manifest: {
          kind: "manifest",
          appName: "resume-life",
          backupVersion: "1.0.0",
          dbVersion: 1,
          createdAt: "2026-09-16T00:00:00.000Z",
          tables: [],
        },
        stats: {},
        totalRecords: 0,
      },
    });
  });

  await page.goto("/settings");
  await page.getByLabel("导入密码", { exact: true }).fill(E2E_BACKUP_PASSWORD);

  const firstChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "选择备份文件 (.rlbackup)", exact: true }).click();
  await (await firstChooserPromise).setFiles(backupFile);
  await expect.poll(() => validateRequests).toBe(1);

  const secondChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "更换备份文件", exact: true }).click();
  await (await secondChooserPromise).setFiles(backupFile);
  await expect.poll(() => validateRequests).toBe(2);
});

test("离开设置页会中止正在进行的导出请求", async ({ page }) => {
  let exportHasSignal: boolean | null = null;
  let exportAborted = false;

  await page.exposeFunction("__recordBackupExportStarted", (hasSignal: boolean) => {
    exportHasSignal = hasSignal;
  });
  await page.exposeFunction("__recordBackupExportAborted", () => {
    exportAborted = true;
  });
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    const callbacks = window as typeof window & {
      __recordBackupExportStarted: (hasSignal: boolean) => Promise<void>;
      __recordBackupExportAborted: () => Promise<void>;
    };

    window.fetch = (input, init) => {
      const requestUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (new URL(requestUrl, window.location.href).pathname !== "/api/backup/export") {
        return nativeFetch(input, init);
      }

      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      void callbacks.__recordBackupExportStarted(Boolean(signal));
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          void callbacks.__recordBackupExportAborted();
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    };
  });

  await page.goto("/settings");
  await page.getByLabel("导出密码", { exact: true }).fill(E2E_BACKUP_PASSWORD);
  await page.getByLabel("确认导出密码", { exact: true }).fill(E2E_BACKUP_PASSWORD);
  await page.getByRole("button", { name: "导出加密备份 (.rlbackup)", exact: true }).click();
  await expect.poll(() => exportHasSignal).not.toBeNull();
  expect(exportHasSignal).toBe(true);

  await page.locator('a[href="/tools"]').first().click();
  await expect(page).toHaveURL(/\/tools$/);
  await expect.poll(() => exportAborted).toBe(true);
});

test("加密备份 UI 遵循导出、验证、恢复与手动刷新合同", async ({ page }) => {
  const fixture = Buffer.from([0x52, 0x4c, 0x49, 0x46, 0x45, 0, 1, 0xff, 0x10, 0x00]);
  const snapshotPath = "C:\\synthetic-backups\\resume-life.db.pre-restore-fixture";
  const exportRequests: Array<{ method: string; body: unknown }> = [];
  const validateBodies: Buffer[] = [];
  const restoreBodies: Buffer[] = [];
  const validatePasswordHeaders: string[] = [];
  const restorePasswordHeaders: string[] = [];
  const preserveHeaders: string[] = [];
  let nextValidationGate: ReturnType<typeof gate> | null = null;
  let releasedValidationResponses = 0;

  await page.route("**/api/backup/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/backup/stats") {
      await route.fulfill({
        json: {
          ok: true,
          stats: {
            resumes: 1,
            projects: 2,
            interviews: 3,
            drills: 4,
            bank_entries: 5,
            notebook_entries: 6,
            intros: 7,
            templates: 8,
            totalRecords: 37,
            hasAiConfig: true,
            dbVersion: 1,
          },
        },
      });
      return;
    }
    if (pathname === "/api/backup/export") {
      exportRequests.push({ method: request.method(), body: request.postDataJSON() });
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": BACKUP_MEDIA_TYPE,
          "Content-Disposition": "attachment; filename=mock-backup.rlbackup",
        },
        body: fixture,
      });
      return;
    }
    if (pathname === "/api/backup/validate") {
      validateBodies.push(request.postDataBuffer() ?? Buffer.alloc(0));
      validatePasswordHeaders.push(request.headers()["x-resume-life-backup-password"] ?? "");
      const validationGate = nextValidationGate;
      nextValidationGate = null;
      if (validationGate) await validationGate.promise;
      try {
        await route.fulfill({
          json: {
            ok: true,
            manifest: {
              kind: "manifest",
              appName: "resume-life",
              backupVersion: "1.0.0",
              dbVersion: 1,
              createdAt: "2026-09-16T00:00:00.000Z",
              tables: ["resumes", "projects", "interviews"],
            },
            stats: { resumes: 1, projects: 2, interviews: 3 },
            totalRecords: 6,
          },
        });
      } finally {
        if (validationGate) releasedValidationResponses += 1;
      }
      return;
    }
    if (pathname === "/api/backup/restore") {
      restoreBodies.push(request.postDataBuffer() ?? Buffer.alloc(0));
      restorePasswordHeaders.push(request.headers()["x-resume-life-backup-password"] ?? "");
      preserveHeaders.push(request.headers()["x-resume-life-preserve-ai-config"] ?? "");
      await route.fulfill({ json: { ok: true, snapshotCreated: snapshotPath, stats: {} } });
      return;
    }
    await route.fallback();
  });

  await page.goto("/settings");
  await expect(page.getByText(/数据库版本 1/)).toBeVisible();

  const exportPassword = page.getByLabel("导出密码", { exact: true });
  const exportConfirmation = page.getByLabel("确认导出密码", { exact: true });
  const exportButton = page.getByRole("button", { name: "导出加密备份 (.rlbackup)", exact: true });

  await exportPassword.fill("12345678901");
  await exportConfirmation.fill("12345678901");
  await exportButton.click();
  await expect(page.getByRole("alert").filter({ hasText: "备份密码长度" })).toContainText("12");
  expect(exportRequests).toHaveLength(0);

  await exportPassword.fill(E2E_BACKUP_PASSWORD);
  await exportConfirmation.fill("another-backup-password");
  await exportButton.click();
  await expect(page.getByRole("alert").filter({ hasText: "不一致" })).toBeVisible();
  expect(exportRequests).toHaveLength(0);

  await exportConfirmation.fill(E2E_BACKUP_PASSWORD);
  const downloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("mock-backup.rlbackup");
  expect(exportRequests).toEqual([{
    method: "POST",
    body: { password: E2E_BACKUP_PASSWORD, confirmation: E2E_BACKUP_PASSWORD },
  }]);
  await expect(exportPassword).toHaveValue("");
  await expect(exportConfirmation).toHaveValue("");
  await expect(page.getByRole("status")).toContainText("导出成功");

  const importPassword = page.getByLabel("导入密码", { exact: true });
  const fileInput = page.locator('input[type="file"]');
  await importPassword.fill(E2E_BACKUP_PASSWORD);
  await fileInput.setInputFiles({
    name: "unsupported-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"unsupported":true}', "utf8"),
  });
  await expect(page.getByRole("alert").filter({ hasText: "不支持 JSON 文件" })).toBeVisible();
  expect(validateBodies).toHaveLength(0);
  await expect(page.getByRole("button", { name: "完全覆盖并恢复系统数据" })).toHaveCount(0);

  await fileInput.setInputFiles({
    name: "fixture.rlbackup",
    mimeType: BACKUP_MEDIA_TYPE,
    buffer: fixture,
  });
  await expect(page.getByText("待恢复备份包详情", { exact: true })).toBeVisible();
  await expect(page.getByText("格式版本 v1.0.0", { exact: true })).toBeVisible();
  await expect(page.getByText("备份数据库版本：1", { exact: true })).toBeVisible();
  await expect(page.getByText("共 6 条记录", { exact: true })).toBeVisible();
  expect(validateBodies).toHaveLength(1);
  expect(validateBodies[0]).toEqual(fixture);
  const expectedPasswordHeader = encodeBackupPasswordHeader(E2E_BACKUP_PASSWORD);
  expect(validatePasswordHeaders).toEqual([expectedPasswordHeader]);

  await fileInput.setInputFiles({
    name: "unsupported-after-validation.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"unsupported":true}', "utf8"),
  });
  await expect(page.getByRole("alert").filter({ hasText: "不支持 JSON 文件" })).toBeVisible();
  expect(validateBodies).toHaveLength(1);
  await expect(page.getByRole("button", { name: "完全覆盖并恢复系统数据" })).toHaveCount(0);

  await fileInput.setInputFiles({
    name: "fixture.rlbackup",
    mimeType: BACKUP_MEDIA_TYPE,
    buffer: fixture,
  });
  await expect(page.getByText("待恢复备份包详情", { exact: true })).toBeVisible();
  expect(validateBodies).toHaveLength(2);
  expect(validateBodies[1]).toEqual(fixture);
  expect(validatePasswordHeaders).toEqual([expectedPasswordHeader, expectedPasswordHeader]);

  const staleValidation = gate();
  const changedPassword = "another-valid-password";
  try {
    nextValidationGate = staleValidation;
    await importPassword.fill(changedPassword);
    await expect.poll(() => validateBodies.length).toBe(3);
    await expect(page.getByText("待恢复备份包详情", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "完全覆盖并恢复系统数据" })).toHaveCount(0);

    await importPassword.fill("too-short");
    await expect(page.getByRole("button", { name: "完全覆盖并恢复系统数据" })).toHaveCount(0);
  } finally {
    staleValidation.release();
  }
  await expect.poll(() => releasedValidationResponses).toBe(1);
  await expect(page.getByText("待恢复备份包详情", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "完全覆盖并恢复系统数据" })).toHaveCount(0);

  await importPassword.fill(E2E_BACKUP_PASSWORD);
  await expect(page.getByText("待恢复备份包详情", { exact: true })).toBeVisible();
  expect(validateBodies).toHaveLength(4);
  expect(validatePasswordHeaders).toEqual([
    expectedPasswordHeader,
    expectedPasswordHeader,
    encodeBackupPasswordHeader(changedPassword),
    expectedPasswordHeader,
  ]);

  await page.getByRole("checkbox", { name: /保留当前设备的 AI Key/ }).uncheck();
  await page.getByRole("button", { name: "完全覆盖并恢复系统数据", exact: true }).click();
  let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  await page.getByRole("dialog").getByRole("button", { name: "确认完全覆盖并恢复", exact: true }).click();

  await expect(page.getByText(snapshotPath, { exact: true })).toBeVisible();
  await expect(page.getByText("恢复前灾备位置", { exact: true })).toBeVisible();
  expect(restoreBodies).toEqual([fixture]);
  expect(restorePasswordHeaders).toEqual([expectedPasswordHeader]);
  expect(preserveHeaders).toEqual(["false"]);
  await expect(fileInput).toHaveValue("");
  await expect(importPassword).toHaveValue("");
  await expect(page.getByText("fixture.rlbackup", { exact: false })).toHaveCount(0);
  await expect(page.getByText("待恢复备份包详情", { exact: true })).toHaveCount(0);
  // 观察窗为 0（否定断言无法用 expect.poll 表达「等一会儿确认没发生」，故不做任何等待）。
  // 可证事实有二：监听在点击前已挂上；上面的 await expect 系列只在 restore 响应落地后才放行。
  // 至于 CDP 的 frameNavigated 事件此刻是否已送达 Node 侧计数器，无从断言。
  // 后续任一处计数变 ≥2 即失败（不限于最后那条 poll）——延迟发生的重载逃不过这一整段。
  expect(navigations).toBe(0);
  await expect(page.getByText(snapshotPath, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认完成并刷新页面", exact: true }).click();
  await expect.poll(() => navigations).toBe(1);
});
