import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptySummary } from "../../src/lib/summary";

for (const width of [390, 1280]) test(`自定义 SDK 客户端保存复用并真实完成预检和扫描 (${width}px)`, async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const prefix = "resume-life-e2e-custom-cli-";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const script = path.join(directory, "SDK client.cjs");
  const captureFile = path.join(directory, "capture.json");
  const summary = { ...emptySummary(), overview: "自定义客户端合成项目概况", architecture: "合成模块架构", techStack: "TypeScript", brief: "SDK 合成提炼结果", achievements: ["验证双模块提炼"] };
  const customCli = { command: process.execPath, args: [script, "--text", "synthetic value", ""] };
  const paths = [path.join(directory, "repo one"), path.join(directory, "repo two")];
  for (const repo of paths) {
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "合成工程模块，通过共同接口协作。SDK_SOURCE_MARKER");
  }
  // 无模型调用：真实子进程按 stdin 请求类型返回合成协议结果。
  fs.writeFileSync(script, [
    "const fs = require('node:fs');",
    `const captureFile = ${JSON.stringify(captureFile)};`,
    "let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk);",
    "process.stdin.on('end', () => {",
    "const relation = input.includes('<repo_summaries>');",
    "const captures = fs.existsSync(captureFile) ? JSON.parse(fs.readFileSync(captureFile, 'utf8')) : [];",
    "captures.push({ relation, input, args: process.argv.slice(2), cwd: process.cwd(), entries: fs.readdirSync(process.cwd()) });",
    "fs.writeFileSync(captureFile, JSON.stringify(captures));",
    `process.stdout.write(JSON.stringify(relation ? { isRelated: true, reason: '合成接口证明两个模块协作' } : ${JSON.stringify(summary)}));`,
    "});",
  ].join("\n"));
  let root: string | undefined;
  try {
    const created = await request.post("/api/projects", { data: { name: `自定义客户端 ${width}` } });
    expect(created.status()).toBe(201);
    root = `/api/projects/${(await created.json()).id}`;
    const original = await (await request.get(root)).json();
    // 内置程序探测与外部模型完全无关；自定义链路必须独立工作。
    await page.route(`**${root}/scan-repo`, async route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { codex: { available: false }, claude: { available: false }, recommended: null } });
      return route.continue();
    });
    await page.goto(root.replace("/api/projects/", "/knowledge/"));
    await page.getByRole("button", { name: /扫描本地代码仓库/ }).click();
    const dialog = page.getByRole("dialog", { name: /一键扫描本地仓库提炼项目亮点/ });
    for (const repo of paths) {
      await dialog.locator("#repo-path-input").fill(repo);
      await dialog.getByRole("button", { name: "+ 添加", exact: true }).click();
    }
    await dialog.getByRole("button", { name: /自定义 CLI \/ SDK/ }).click();
    await dialog.getByLabel("客户端名称（保存时填写）").fill("合成 SDK 客户端");
    await dialog.getByLabel("可执行程序", { exact: false }).fill(customCli.command);
    await dialog.getByLabel("命令参数（JSON 数组）").fill(JSON.stringify(customCli.args));
    const preview = dialog.getByRole("region", { name: "最终命令预览" });
    await expect(preview.locator("code")).toContainText('SDK client.cjs" --text "synthetic value" ""');
    await expect(preview.locator("code")).toContainText("stdin: {{PROMPT}}");
    await expect(preview).not.toContainText("SDK_SOURCE_MARKER");
    await dialog.getByRole("button", { name: "保存客户端配置", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText("客户端已保存到当前浏览器");
    await preview.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("custom-cli.png") });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: /扫描本地代码仓库/ }).click();
    await dialog.getByRole("button", { name: /自定义 CLI \/ SDK/ }).click();
    await dialog.getByLabel("已保存的客户端").selectOption({ label: "合成 SDK 客户端" });
    await expect(dialog.getByLabel("可执行程序", { exact: false })).toHaveValue(customCli.command);
    await expect(preview.locator("code")).toContainText('SDK client.cjs" --text "synthetic value" ""');
    await dialog.getByRole("button", { name: "合并扫描 2 个代码库", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("AI 草稿待确认：", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "确认采用草稿", exact: true })).toBeVisible();
    const captures = JSON.parse(fs.readFileSync(captureFile, "utf8")) as { relation: boolean; input: string; args: string[]; cwd: string; entries: string[] }[];
    expect(captures.map(item => item.relation)).toEqual([true, false]);
    for (const capture of captures) {
      expect(capture.input).toContain("SDK_SOURCE_MARKER");
      expect(capture.input).not.toContain("{{PROMPT}}");
      expect(capture.args).toEqual(customCli.args.slice(1));
      expect(capture.entries).toEqual([]);
      expect(fs.existsSync(capture.cwd)).toBe(false);
    }
    expect(await (await request.get(root)).json()).toEqual(original);
    expect((await (await request.get(`${root}/summary-history`)).json()).items).toEqual([]);
  } finally {
    await page.goto("/knowledge");
    if (root) expect((await request.delete(root)).status()).toBe(200);
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)) throw new Error("Unsafe cleanup path");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
