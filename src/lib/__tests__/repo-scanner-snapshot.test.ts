import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectRepoSourceSnapshot, isSafeRepoSourceText } from "../repo-scanner/source-snapshot";

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-scan-fixture-")); });
afterEach(() => {
  vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-scan-fixture-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("仓库材料白名单", () => {
  it.each([
    [process.platform === "win32" ? "C:\\" : "/", "不能直接选择系统磁盘或根目录"],
    [process.platform === "win32" ? "C:\\Windows\\synthetic-project" : "/etc/synthetic-project", "禁止扫描系统敏感目录"],
    ...(process.platform === "win32" ? [
      ["\\\\?\\C:\\Windows\\synthetic-project", "禁止扫描系统敏感目录"],
      ["\\\\.\\C:\\Windows\\synthetic-project", "禁止扫描系统敏感目录"],
    ] : []),
  ])("快照开始时拒绝真实根 %s，且不遍历目录", async (root, message) => {
    vi.spyOn(fsPromises, "realpath").mockResolvedValue(root);
    const readdir = vi.spyOn(fsPromises, "readdir").mockRejectedValue(new Error("不应遍历受限目录"));

    await expect(collectRepoSourceSnapshot([{ path: directory }])).rejects.toThrow(message);
    expect(readdir).not.toHaveBeenCalled();
  });

  it("包含源码但排除凭证、运行数据和模型指令文件", async () => {
    fs.writeFileSync(path.join(directory, "index.ts"), "export const answer = 42;");
    for (const filename of [".env", ".env.local", "credentials.json", "private.pem", "AGENTS.md", "CLAUDE.md"]) {
      fs.writeFileSync(path.join(directory, filename), "SYNTHETIC_SECRET_MARKER");
    }
    for (const name of ["data", "node_modules", ".git", ".claude", ".codex"]) {
      fs.mkdirSync(path.join(directory, name));
      fs.writeFileSync(path.join(directory, name, "secret.ts"), "SYNTHETIC_SECRET_MARKER");
    }
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshot).toContain("export const answer = 42");
    expect(snapshot).not.toContain("SYNTHETIC_SECRET_MARKER");
  });

  it("大文件只读取预算内的内容并注明截断", async () => {
    fs.writeFileSync(path.join(directory, "large.ts"), "x".repeat(500_000));
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshot.length).toBeLessThanOrEqual(200_000);
    expect(snapshot).toContain("截断");
  });

  it("正常文件名下的明文凭证和连接串不会外发", async () => {
    fs.writeFileSync(path.join(directory, "appsettings.json"), JSON.stringify({ ApiKey: "SYNTHETIC_CREDENTIAL_MARKER" }));
    fs.writeFileSync(path.join(directory, "application.yml"), "password: SYNTHETIC_CREDENTIAL_MARKER");
    fs.writeFileSync(path.join(directory, "config.ts"), "const connection = 'Server=localhost;Password=SYNTHETIC_CREDENTIAL_MARKER';");
    expect(await collectRepoSourceSnapshot([{ path: directory }])).not.toContain("SYNTHETIC_CREDENTIAL_MARKER");
  });

  it.each([
    'const OPENAI_API_KEY = "SYNTHETIC_CREDENTIAL_MARKER";',
    'ANTHROPIC_API_KEY=SYNTHETIC_CREDENTIAL_MARKER',
    'AWS_ACCESS_KEY_ID=SYNTHETIC_CREDENTIAL_MARKER',
    'AWS_SECRET_ACCESS_KEY=SYNTHETIC_CREDENTIAL_MARKER',
    'AZURE_OPENAI_API_KEY: SYNTHETIC_CREDENTIAL_MARKER',
    'GITHUB_TOKEN=SYNTHETIC_CREDENTIAL_MARKER',
    'stripe_secret_key: "SYNTHETIC_CREDENTIAL_MARKER"',
    '{"openaiApiKey":"SYNTHETIC_CREDENTIAL_MARKER"}',
    'config.awsAccessKeyId = "SYNTHETIC_CREDENTIAL_MARKER";',
    'Authorization: Bearer SYNTHETIC_CREDENTIAL_MARKER',
    '{"authorization":"bearer SYNTHETIC_CREDENTIAL_MARKER"}',
    "headers.Authorization = 'Bearer SYNTHETIC_CREDENTIAL_MARKER';",
  ])("供应商凭证与 Bearer 认证使整个文件退出快照：%s", async (content) => {
    fs.writeFileSync(path.join(directory, "settings.ts"), `export const fileMarker = "SYNTHETIC_FILE_MARKER";\n${content}`);
    fs.writeFileSync(path.join(directory, "index.ts"), "export const safeAnswer = 42;");
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshot).not.toContain("SYNTHETIC_CREDENTIAL_MARKER");
    expect(snapshot).not.toContain("SYNTHETIC_FILE_MARKER");
    expect(snapshot).not.toContain("[文件 settings.ts]");
    expect(snapshot).toContain("export const safeAnswer = 42");
  });

  it.each([
    "const apiKeyCount = 2;",
    "const OPENAI_API_KEY_STATUS = 'missing';",
    "const AWS_ACCESS_KEY_ID_LENGTH = 20;",
    "const tokenCount = 8;",
    "const secretName = 'setting';",
    'const headers = { Authorization: "application/json" };',
  ])("普通标识符和非 Bearer header 仍可被扫描：%s", (content) => {
    expect(isSafeRepoSourceText(content)).toBe(true);
  });

  it("凭证引号跨越读取预算时也丢弃整个文件，避免泄漏截断的密钥", async () => {
    const prefix = `${" ".repeat(31_950)}\nconst OPENAI_API_KEY = "`;
    fs.writeFileSync(path.join(directory, "settings.ts"), prefix + "SYNTHETIC_CREDENTIAL_MARKER".repeat(4) + '";');
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshot).not.toContain("[文件 settings.ts]");
    expect(snapshot).not.toContain("SYNTHETIC_CREDENTIAL_MARKER");
  });

  it.each([
    "password: test", "token: abc", "secret = x",
    "postgresql://audit_user:SYNTHETIC_CREDENTIAL_MARKER@localhost/app",
    "mysql://audit_user:SYNTHETIC_CREDENTIAL_MARKER@localhost/app",
  ])("短凭证和 URI 密码也会被排除：%s", async (content) => {
    expect(isSafeRepoSourceText(content)).toBe(false);
    fs.writeFileSync(path.join(directory, "settings.yml"), content);
    expect(await collectRepoSourceSnapshot([{ path: directory }])).not.toContain(content);
  });
});
