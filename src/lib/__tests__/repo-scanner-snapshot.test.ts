import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectRepoSourceSnapshot, isSafeRepoSourceText } from "../repo-scanner/source-snapshot";
import { buildRepoScanPrompt } from "../repo-scanner/prompts";
import { validateRepoPath } from "../repo-scanner/path-validator";
import { snapshotFiles, snapshotRecords } from "./helpers/repo-snapshot";

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-scan-fixture-")); });
afterEach(() => {
  vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-scan-fixture-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("仓库材料白名单", () => {
  it.each([
    "--index-url https://reader:SYNTHETIC_REGISTRY_KEY@packages.invalid/simple/",
    'source "http://SYNTHETIC_REGISTRY_KEY@packages.invalid/"',
    " ".repeat(31_990) + "https://SYNTHETIC_REGISTRY_KEY@" + "packages.invalid/".repeat(100),
  ])("带认证信息的包源及截断前缀均不进入最终提示词 %#", async content => {
    fs.writeFileSync(path.join(directory, "requirements.txt"), content);
    fs.writeFileSync(path.join(directory, "README.md"), "https://packages.invalid/@public/pkg?q=a@b");
    const targets = [{ path: directory }];
    const snapshot = await collectRepoSourceSnapshot(targets);
    expect(snapshotFiles(snapshot).map(file => file.path)).toEqual(["README.md"]);
    const prompt = buildRepoScanPrompt("示例", targets, snapshot);
    expect(prompt).toContain("packages.invalid/@public/pkg");
    expect(prompt).not.toContain("SYNTHETIC_REGISTRY_KEY");
  });
  it.each([
    ["composer.json", "worker.php", "<?php\nfunction syntheticWorker() { return 'SYNTHETIC_IMPLEMENTATION'; }\n"],
    ["Gemfile", "worker.rb", "def synthetic_worker\n  'SYNTHETIC_IMPLEMENTATION'\nend\n"],
    ["build.gradle", "Worker.groovy", "class Worker { String run() { 'SYNTHETIC_IMPLEMENTATION' } }"],
    ["build.gradle.kts", "worker.kts", "val syntheticWorker = \"SYNTHETIC_IMPLEMENTATION\""],
    ["build.gradle", "Worker.scala", "object Worker { val result = \"SYNTHETIC_IMPLEMENTATION\" }"],
    ...["cc", "cxx", "hh", "hpp", "hxx", "HPP"].map(extension => [
      "CMakeLists.txt", `worker.${extension}`, 'const char* syntheticWorker() { return "SYNTHETIC_IMPLEMENTATION"; }',
    ]),
  ])("%s 预检认可的工程保留 %s 实现，不只提供清单", async (manifest, filename, content) => {
    fs.writeFileSync(path.join(directory, manifest), manifest === "composer.json" ? "{}" : "# synthetic build manifest\n");
    fs.mkdirSync(path.join(directory, "src"));
    fs.writeFileSync(path.join(directory, "src", filename), content);
    expect(validateRepoPath(directory).valid).toBe(true);
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshotFiles(snapshot)).toContainEqual(expect.objectContaining({ path: `src/${filename}`, content, truncated: false }));
  });

  it.each(["php", "rb", "hpp"])("新增 %s 源码仍过滤凭证、敏感文件名、构建产物与近似扩展名", async extension => {
    fs.writeFileSync(path.join(directory, `worker.${extension}`), "SYNTHETIC_SAFE_IMPLEMENTATION");
    fs.writeFileSync(path.join(directory, `unsafe.${extension}`), 'password = "SYNTHETIC_PRIVATE_VALUE"');
    fs.writeFileSync(path.join(directory, `credentials.${extension}`), "SYNTHETIC_EXCLUDED_IMPLEMENTATION");
    fs.writeFileSync(path.join(directory, `worker.${extension}.bak`), "SYNTHETIC_EXCLUDED_IMPLEMENTATION");
    fs.mkdirSync(path.join(directory, "build"));
    fs.writeFileSync(path.join(directory, "build", `worker.${extension}`), "SYNTHETIC_EXCLUDED_IMPLEMENTATION");
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshot).toContain("SYNTHETIC_SAFE_IMPLEMENTATION");
    expect(snapshot).not.toContain("SYNTHETIC_PRIVATE_VALUE");
    expect(snapshot).not.toContain("SYNTHETIC_EXCLUDED_IMPLEMENTATION");
    expect(snapshotFiles(snapshot).some(file => file.path === `unsafe.${extension}`)).toBe(false);
  });

  it("新增 Ruby 文件在字节上限内保留完整 UTF-8 前缀并标记未读后文", async () => {
    const prefix = "#".repeat(31_999);
    fs.writeFileSync(path.join(directory, "worker.rb"), `${prefix}🙂SYNTHETIC_UNREAD_IMPLEMENTATION`);
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshotFiles(snapshot)).toContainEqual(expect.objectContaining({ path: "worker.rb", content: prefix, truncated: true }));
    expect(snapshot).not.toContain("SYNTHETIC_UNREAD_IMPLEMENTATION");
    expect(snapshot).not.toContain("\uFFFD");
  });

  it.each([
    ["php", "<?php return ['password' => 'SYNTHETIC_CREDENTIAL_MARKER'];"],
    ["php", '<?php return array("api_key" => "SYNTHETIC_CREDENTIAL_MARKER");'],
    ["php", "<?php $config['db']['password'] = 'SYNTHETIC_CREDENTIAL_MARKER';"],
    ["php", '<?php $config["api_key"] ??= "SYNTHETIC_CREDENTIAL_MARKER";'],
    ["php", "<?php return ['Authorization' => 'Bearer SYNTHETIC_CREDENTIAL_MARKER'];"],
    ["php", "<?php $headers['Authorization'] = 'Bearer SYNTHETIC_CREDENTIAL_MARKER';"],
    ["rb", "config = { 'password' => 'SYNTHETIC_CREDENTIAL_MARKER' }"],
    ["rb", "config = { :api_key => 'SYNTHETIC_CREDENTIAL_MARKER' }"],
    ["rb", "config = { :'api-key' => 'SYNTHETIC_CREDENTIAL_MARKER' }"],
    ["rb", "config = { password: 'SYNTHETIC_CREDENTIAL_MARKER' }"],
    ["rb", "config['password'] = 'SYNTHETIC_CREDENTIAL_MARKER'"],
    ["rb", "config[:password] ||= 'SYNTHETIC_CREDENTIAL_MARKER'"],
    ["rb", 'config[:"api-key"] = "SYNTHETIC_CREDENTIAL_MARKER"'],
    ["rb", "headers[:Authorization] ||= 'Bearer SYNTHETIC_CREDENTIAL_MARKER'"],
  ])("%s 配置哈希或下标凭证使整个文件退出快照：%s", async (extension, content) => {
    expect(isSafeRepoSourceText(content)).toBe(false);
    fs.writeFileSync(path.join(directory, `database.${extension}`), content + "\n# SYNTHETIC_PRIVATE_FILE");
    fs.writeFileSync(path.join(directory, `worker.${extension}`), "SYNTHETIC_SAFE_IMPLEMENTATION");
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshot).not.toContain("SYNTHETIC_CREDENTIAL_MARKER");
    expect(snapshot).not.toContain("SYNTHETIC_PRIVATE_FILE");
    expect(snapshotFiles(snapshot).map(file => file.path)).not.toContain(`database.${extension}`);
    expect(snapshot).toContain("SYNTHETIC_SAFE_IMPLEMENTATION");
  });

  it.each([
    ["php", "<?php return ['tokenCount' => 8, 'api_key_status' => 'missing'];"],
    ["php", "<?php $config['tokenCount'] = 8; return $config['password'];"],
    ["php", "<?php return $config['password'] === $provided;"],
    ["rb", "config = { :tokenCount => 8, :'api-key-status' => 'missing' }"],
    ["rb", "config[:tokenCount] ||= 8; verify(config[:password])"],
    ["rb", "config[:password] == provided"],
    ["rb", "headers[:Authorization] = 'application/json'"],
  ])("%s 普通配置键、凭证读取和比较仍可扫描：%s", async (extension, content) => {
    expect(isSafeRepoSourceText(content)).toBe(true);
    fs.writeFileSync(path.join(directory, `worker.${extension}`), content);
    expect(snapshotFiles(await collectRepoSourceSnapshot([{ path: directory }]))).toContainEqual(
      expect.objectContaining({ path: `worker.${extension}`, content, truncated: false }),
    );
  });

  it.each([
    ["php", "<?php return ['password' => '"],
    ["rb", "config[:'api-key'] ||= '"],
  ])("%s 哈希或下标凭证的结束引号超出读取预算时仍排除整个文件", async (extension, opening) => {
    const prefix = " ".repeat(31_980 - opening.length) + opening;
    fs.writeFileSync(path.join(directory, `database.${extension}`), prefix + "SYNTHETIC_CREDENTIAL_MARKER".repeat(4) + "'");
    expect(await collectRepoSourceSnapshot([{ path: directory }])).toBe("");
  });

  it.each([
    ["vue", "<script setup>const message = 'SYNTHETIC_COMPONENT_IMPLEMENTATION';</script>\n<template><p>{{ message }}</p></template>"],
    ["svelte", "<script>let message = 'SYNTHETIC_COMPONENT_IMPLEMENTATION';</script>\n<p>{message}</p>"],
    ["astro", "---\nconst message = 'SYNTHETIC_COMPONENT_IMPLEMENTATION';\n---\n<p>{message}</p>"],
  ])("%s 工程预检后保留组件源码，而不只提供工程清单", async (extension, content) => {
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "synthetic-components", dependencies: { [extension]: "1.0.0" } }));
    fs.mkdirSync(path.join(directory, "src"));
    fs.writeFileSync(path.join(directory, "src", `Widget.${extension}`), content);
    expect(validateRepoPath(directory).valid).toBe(true);
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshotFiles(snapshot)).toContainEqual(expect.objectContaining({ path: `src/Widget.${extension}`, content, truncated: false }));
  });

  it.each(["vue", "svelte", "astro"])("%s 组件仍排除凭证内容、敏感文件名、构建产物及近似扩展名", async (extension) => {
    fs.writeFileSync(path.join(directory, `Widget.${extension}`), "<p>SYNTHETIC_SAFE_COMPONENT</p>");
    fs.writeFileSync(path.join(directory, `Private.${extension}`), '<script>const password = "SYNTHETIC_COMPONENT_CREDENTIAL";</script>');
    fs.writeFileSync(path.join(directory, `credentials.${extension}`), "SYNTHETIC_EXCLUDED_COMPONENT");
    fs.writeFileSync(path.join(directory, `Widget.${extension}.map`), "SYNTHETIC_EXCLUDED_COMPONENT");
    fs.mkdirSync(path.join(directory, "dist"));
    fs.writeFileSync(path.join(directory, "dist", `Built.${extension}`), "SYNTHETIC_EXCLUDED_COMPONENT");
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshot).toContain("SYNTHETIC_SAFE_COMPONENT");
    expect(snapshot).not.toContain("SYNTHETIC_COMPONENT_CREDENTIAL");
    expect(snapshot).not.toContain("SYNTHETIC_EXCLUDED_COMPONENT");
    expect(snapshotFiles(snapshot).some(file => file.path === `Private.${extension}`)).toBe(false);
  });

  it("组件文件沿用单文件读取预算，不把尾部未读取实现当成已提供", async () => {
    fs.writeFileSync(path.join(directory, "Widget.vue"), "<template>" + "x".repeat(32_000) + "SYNTHETIC_COMPONENT_UNREAD_TAIL</template>");
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshotFiles(snapshot)).toContainEqual(expect.objectContaining({ path: "Widget.vue", content: expect.stringMatching(/^<template>/), truncated: true }));
    expect(snapshot).not.toContain("SYNTHETIC_COMPONENT_UNREAD_TAIL");
  });

  it.each([
    ["go.mod", "module example.invalid/synthetic-worker\n\ngo 1.24\n"],
    ["requirements.txt", "synthetic-library==1.0.0\n"],
    ["Gemfile", "source 'https://example.invalid'\ngem 'synthetic-library'\n"],
    ["CMakeLists.txt", "cmake_minimum_required(VERSION 3.20)\nproject(synthetic_worker)\n"],
    ["Makefile", "build:\n\techo synthetic-build\n"],
    ["build.gradle", "plugins { id 'java' }\n"],
    ["build.gradle.kts", "plugins { java }\n"],
    ["solution.sln", "Microsoft Visual Studio Solution File, Format Version 12.00\n"],
  ])("路径预检支持的 %s 工程清单也传入源码快照", async (filename, content) => {
    fs.writeFileSync(path.join(directory, filename), content);
    expect(validateRepoPath(directory).valid).toBe(true);
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshotFiles(snapshot)).toContainEqual(expect.objectContaining({ path: filename, content, truncated: false }));
  });

  it.each(["go.mod", "requirements.txt", "Gemfile", "CMakeLists.txt", "Makefile", "build.gradle", "build.gradle.kts", "solution.sln"])("新增可读清单 %s 仍整份过滤明文凭证", async filename => {
    fs.writeFileSync(path.join(directory, filename), 'SYNTHETIC_MANIFEST_MARKER\npassword: "SYNTHETIC_CREDENTIAL_MARKER"');
    fs.writeFileSync(path.join(directory, "index.ts"), "export const safeAnswer = 42;");
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshot).toContain("export const safeAnswer = 42");
    expect(snapshotFiles(snapshot).some(file => file.path === filename)).toBe(false);
    expect(snapshot).not.toContain("SYNTHETIC_MANIFEST_MARKER");
    expect(snapshot).not.toContain("SYNTHETIC_CREDENTIAL_MARKER");
  });

  it.each(["README", "readme"])("保留路径预检可读的无扩展名 %s 文档", async filename => {
    fs.writeFileSync(path.join(directory, "go.mod"), "module example.invalid/synthetic-worker\n");
    fs.writeFileSync(path.join(directory, filename), "SYNTHETIC_EXTENSIONLESS_DOCUMENT");
    expect(validateRepoPath(directory).readmeSnippet).toBe("SYNTHETIC_EXTENSIONLESS_DOCUMENT");
    expect(snapshotFiles(await collectRepoSourceSnapshot([{ path: directory }]))).toContainEqual(expect.objectContaining({ path: filename, content: "SYNTHETIC_EXTENSIONLESS_DOCUMENT", truncated: false }));
  });

  it("明确文件名白名单不放开其他 txt、近似名称或锁文件", async () => {
    for (const filename of ["notes.txt", "requirements-private.txt", "Gemfile.lock", "go.sum", "Makefile.backup"]) {
      fs.writeFileSync(path.join(directory, filename), "SYNTHETIC_UNSUPPORTED_MATERIAL");
    }
    expect(await collectRepoSourceSnapshot([{ path: directory }])).toBe("");
  });

  it.each(["空目录", "只有排除目录", "只有不支持的文件", "只有凭证", "空文件", "空白文件"])("%s 不把仓库标题当作可用材料", async kind => {
    if (kind === "只有排除目录") {
      fs.mkdirSync(path.join(directory, "node_modules"));
      fs.writeFileSync(path.join(directory, "node_modules", "index.ts"), "SHOULD_STAY_EXCLUDED");
    } else if (kind === "只有不支持的文件") fs.writeFileSync(path.join(directory, "image.bin"), "UNSUPPORTED_SYNTHETIC_MATERIAL");
    else if (kind === "只有凭证") fs.writeFileSync(path.join(directory, "README.md"), 'password: "SYNTHETIC_CREDENTIAL_MARKER"');
    else if (kind === "空文件") fs.writeFileSync(path.join(directory, "README.md"), "");
    else if (kind === "空白文件") fs.writeFileSync(path.join(directory, "README.md"), " \n\t\r\n");
    expect(await collectRepoSourceSnapshot([{ path: directory }])).toBe("");
  });

  it("多仓库中有一份有效文档仍可采集，并保留没有材料的仓库顺序", async () => {
    const empty = path.join(directory, "empty");
    const documented = path.join(directory, "documented");
    fs.mkdirSync(empty); fs.mkdirSync(documented);
    fs.writeFileSync(path.join(documented, "README.md"), "SYNTHETIC_DOCUMENTED_PROJECT");
    const snapshot = await collectRepoSourceSnapshot([{ path: empty }, { path: documented }]);
    expect(snapshot).toContain("SYNTHETIC_DOCUMENTED_PROJECT");
    expect(snapshotRecords(snapshot).filter(record => record.kind === "repository").map(record => record.repoNumber)).toEqual([1, 2]);
    expect(snapshotFiles(snapshot)).toHaveLength(1);
    expect(snapshotFiles(snapshot)[0]!.repoNumber).toBe(2);
  });

  it("各仓库预算内只有空白时，不用预算外的正文认定材料有效", async () => {
    const roots = Array.from({ length: 32 }, (_, index) => path.join(directory, `repo-${index}`));
    for (const root of roots) {
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, "README.md"), " ".repeat(31_000) + "SYNTHETIC_TEXT_OUTSIDE_EACH_REPO_BUDGET");
    }
    expect(await collectRepoSourceSnapshot(roots.map(root => ({ path: root })))).toBe("");
  });

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
    expect(snapshot.length).toBeLessThanOrEqual(180_000);
    expect(snapshotFiles(snapshot)).toContainEqual(expect.objectContaining({ path: "large.ts", content: "x".repeat(32_000), truncated: true }));
  });

  it.each(["é", "中", "🚀"].flatMap(character =>
    Array.from({ length: Buffer.byteLength(character) }, (_, index) => [character, index + 1] as const)
  ))("单文件字节预算内 %s 只读到 %s 字节时不生成替换字符", async (character, remaining) => {
    const prefix = "a".repeat(32_000 - remaining);
    fs.writeFileSync(path.join(directory, "README.md"), prefix + character + "SYNTHETIC_UNREAD_TAIL");
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    const expected = remaining === Buffer.byteLength(character) ? prefix + character : prefix;
    expect(snapshotFiles(snapshot)).toContainEqual(expect.objectContaining({ path: "README.md", content: expected, truncated: true }));
    expect(snapshot).not.toContain("�");
    expect(snapshot).not.toContain("SYNTHETIC_UNREAD_TAIL");
  });

  it.each([0, 1])("总字符预算在 emoji 附近结束时保留完整字符和截断说明（offset=%s）", async offset => {
    for (let index = 0; index < 5; index++) {
      fs.writeFileSync(path.join(directory, `module-${index}.ts`), "a".repeat(32_000));
    }
    fs.writeFileSync(path.join(directory, "module-5.ts"), "b".repeat(10_000 + offset) + "🚀".repeat(5_000));
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshot).toContain("🚀");
    expect(snapshot === Buffer.from(snapshot, "utf8").toString("utf8")).toBe(true);
    expect(snapshot).toContain("本代码库采集预算已达上限");
    expect(snapshot.length).toBeLessThanOrEqual(180_000);
  });

  it("完整文件中的 BOM、中文、emoji 与实际存在的替换字符逐字保留", async () => {
    const content = "\ufeff中文项目 🚀\n原文实际包含的字符：�\n";
    fs.writeFileSync(path.join(directory, "README.md"), content);
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshotFiles(snapshot)).toContainEqual(expect.objectContaining({ path: "README.md", content, truncated: false }));
    expect(snapshotFiles(snapshot).every(file => !file.truncated)).toBe(true);
    expect(snapshotRecords(snapshot).some(record => record.kind === "limit")).toBe(false);
  });

  it("普通文件发生多次短读时仍保留完整预算内正文，不误标截断", async () => {
    const content = "中文工程 🚀\nSYNTHETIC_LAST_SOURCE_STATEMENT";
    fs.writeFileSync(path.join(directory, "README.md"), content);
    const open = fsPromises.open.bind(fsPromises);
    vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const file = await open(...args);
      const read = file.read.bind(file);
      vi.spyOn(file, "read").mockImplementation(((buffer: Buffer, offset: number, length: number, position: number) =>
        read(buffer, offset, Math.min(length, 2), position)) as typeof file.read);
      return file;
    });
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshotFiles(snapshot)).toContainEqual(expect.objectContaining({ path: "README.md", content, truncated: false }));
    expect(snapshotFiles(snapshot).every(file => !file.truncated)).toBe(true);
    expect(snapshotRecords(snapshot).some(record => record.kind === "limit")).toBe(false);
    expect(snapshot).not.toContain("�");
  });

  it("短读文件的后文凭证也参与整份过滤", async () => {
    fs.writeFileSync(path.join(directory, "README.md"), 'SYNTHETIC_FILE_WITH_CREDENTIAL\npassword: "SYNTHETIC_CREDENTIAL_MARKER"');
    const open = fsPromises.open.bind(fsPromises);
    vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const file = await open(...args);
      const read = file.read.bind(file);
      vi.spyOn(file, "read").mockImplementation(((buffer: Buffer, offset: number, length: number, position: number) =>
        read(buffer, offset, Math.min(length, 8), position)) as typeof file.read);
      return file;
    });
    expect(await collectRepoSourceSnapshot([{ path: directory }])).toBe("");
  });

  it.each([0, 5])("文件提前 EOF（已读 %s 字节）时停止，不无限重试并关闭句柄", async prefixBytes => {
    fs.writeFileSync(path.join(directory, "README.md"), "safe SYNTHETIC_LATER_CONTENT");
    const open = fsPromises.open.bind(fsPromises);
    let attempts = 0;
    const close = vi.fn();
    vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const file = await open(...args);
      const read = file.read.bind(file);
      const closeFile = file.close.bind(file);
      vi.spyOn(file, "read").mockImplementation(((buffer: Buffer, offset: number, length: number, position: number) => {
        attempts++;
        return read(buffer, offset, attempts === 1 ? Math.min(length, prefixBytes) : 0, position);
      }) as typeof file.read);
      vi.spyOn(file, "close").mockImplementation(async () => { close(); await closeFile(); });
      return file;
    });
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(attempts).toBe(prefixBytes ? 2 : 1);
    expect(close).toHaveBeenCalledOnce();
    if (prefixBytes) expect(snapshotFiles(snapshot)).toContainEqual(expect.objectContaining({ content: "safe ", truncated: true }));
    else expect(snapshot).toBe("");
    expect(snapshot).not.toContain("SYNTHETIC_LATER_CONTENT");
  });

  it("多次短读仍只累计读取单文件预算，不越过 32,000 字节", async () => {
    fs.writeFileSync(path.join(directory, "README.md"), "a".repeat(32_000) + "SYNTHETIC_OUTSIDE_READ_BUDGET");
    const open = fsPromises.open.bind(fsPromises);
    let totalRead = 0;
    vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const file = await open(...args);
      const read = file.read.bind(file);
      vi.spyOn(file, "read").mockImplementation((async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, Math.min(length, 1_200), position);
        totalRead += result.bytesRead;
        return result;
      }) as typeof file.read);
      return file;
    });
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(totalRead).toBe(32_000);
    expect(snapshotFiles(snapshot)).toContainEqual(expect.objectContaining({ content: "a".repeat(32_000), truncated: true }));
    expect(snapshot).not.toContain("SYNTHETIC_OUTSIDE_READ_BUDGET");
  });

  it("第一次短读完成时取消，不发起后续读取且关闭句柄", async () => {
    fs.writeFileSync(path.join(directory, "README.md"), "SYNTHETIC_UNFINISHED_SOURCE");
    const open = fsPromises.open.bind(fsPromises);
    const controller = new AbortController();
    const reason = new Error("SYNTHETIC_ABORT_SHORT_READ");
    let attempts = 0;
    const close = vi.fn();
    vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const file = await open(...args);
      const read = file.read.bind(file);
      const closeFile = file.close.bind(file);
      vi.spyOn(file, "read").mockImplementation((async (buffer: Buffer, offset: number, length: number, position: number) => {
        attempts++;
        const result = await read(buffer, offset, Math.min(length, 2), position);
        controller.abort(reason);
        return result;
      }) as typeof file.read);
      vi.spyOn(file, "close").mockImplementation(async () => { close(); await closeFile(); });
      return file;
    });
    await expect(collectRepoSourceSnapshot([{ path: directory }], controller.signal)).rejects.toBe(reason);
    expect(attempts).toBe(1);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    ["package.json", '{"name":"synthetic-build-manifest"}'],
    ["go.mod", "module example.invalid/synthetic-build-manifest\n"],
    ["Cargo.toml", '[package]\nname = "synthetic-build-manifest"\n'],
  ])("大批字母靠前的文件不挤掉 %s 工程清单", async (filename, content) => {
    fs.writeFileSync(path.join(directory, "README.md"), "SYNTHETIC_README_FIRST");
    fs.writeFileSync(path.join(directory, filename), content);
    for (let index = 0; index < 8; index++) {
      fs.writeFileSync(path.join(directory, `aaa-${index}.ts`), "a".repeat(32_000));
    }
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    const files = snapshotFiles(snapshot);
    expect(files).toContainEqual(expect.objectContaining({ path: filename, content, truncated: false }));
    expect(files.slice(0, 3).map(file => file.path)).toEqual(["README.md", filename, "aaa-0.ts"]);
    expect(snapshot).toContain("本代码库采集预算已达上限");
    expect(snapshot.length).toBeLessThanOrEqual(180_000);
  });

  it.each(["src", "app", "lib", "src/app"])("密集测试目录不挤掉 %s 中的实现，测试仍可采集", async sourceDirectory => {
    fs.mkdirSync(path.join(directory, sourceDirectory), { recursive: true });
    fs.mkdirSync(path.join(directory, "__tests__"));
    fs.writeFileSync(path.join(directory, sourceDirectory, "index.ts"), "export const syntheticBusinessImplementation = 42;");
    for (let index = 0; index < 8; index++) {
      fs.writeFileSync(path.join(directory, "__tests__", `sample-${index}.ts`), "SYNTHETIC_TEST_MATERIAL\n" + "a".repeat(31_900));
    }
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshot.includes("export const syntheticBusinessImplementation = 42;")).toBe(true);
    expect(snapshot).toContain("SYNTHETIC_TEST_MATERIAL");
    expect(snapshot.length).toBeLessThanOrEqual(180_000);
  });

  it("源码分支内的大型测试子目录也不挤掉同层实现", async () => {
    const tests = path.join(directory, "src", "__tests__");
    const implementation = path.join(directory, "src", "feature");
    fs.mkdirSync(tests, { recursive: true });
    fs.mkdirSync(implementation);
    fs.writeFileSync(path.join(implementation, "index.ts"), "export const syntheticNestedImplementation = 42;");
    for (let index = 0; index < 8; index++) fs.writeFileSync(path.join(tests, `sample-${index}.ts`), "a".repeat(32_000));
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshot.includes("export const syntheticNestedImplementation = 42;")).toBe(true);
    expect(snapshotFiles(snapshot).map(file => file.path)).toContain("src/__tests__/sample-0.ts");
  });

  it("只有测试和文档时仍保留有效材料，不因目录优先级返回空快照", async () => {
    fs.mkdirSync(path.join(directory, "__tests__"));
    fs.mkdirSync(path.join(directory, "docs"));
    fs.writeFileSync(path.join(directory, "__tests__", "tool.ts"), "export const syntheticTestUtility = 42;");
    fs.writeFileSync(path.join(directory, "docs", "guide.md"), "SYNTHETIC_DOCUMENTED_TEST_TOOL");
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshot).toContain("export const syntheticTestUtility = 42;");
    expect(snapshot).toContain("SYNTHETIC_DOCUMENTED_TEST_TOOL");
    expect(snapshotFiles(snapshot).every(file => !file.truncated)).toBe(true);
    expect(snapshotRecords(snapshot).some(record => record.kind === "limit")).toBe(false);
  });

  it("目录深度上限阻止继续遍历时，在保留的浅层材料后说明截断", async () => {
    fs.writeFileSync(path.join(directory, "README.md"), "SYNTHETIC_SHALLOW_DOCUMENT");
    const unvisited = path.join(directory, ...Array.from({ length: 13 }, (_, index) => `d${index}`));
    fs.mkdirSync(unvisited, { recursive: true });
    fs.writeFileSync(path.join(unvisited, "index.ts"), "SYNTHETIC_DEEP_UNREAD_SOURCE");
    const read = vi.spyOn(fsPromises, "readdir");
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshot).toContain("SYNTHETIC_SHALLOW_DOCUMENT");
    expect(snapshot).not.toContain("SYNTHETIC_DEEP_UNREAD_SOURCE");
    expect(snapshot).toContain("本代码库目录深度已达上限");
    expect(snapshot).toContain("未提供的文件或后文不代表不存在");
    expect(read.mock.calls.some(([target]) => target === unvisited)).toBe(false);
  });

  it("目录深度恰好 12 层且没有更深目录时，保留源码而不误报截断", async () => {
    const deepest = path.join(directory, ...Array.from({ length: 12 }, (_, index) => `d${index}`));
    fs.mkdirSync(deepest, { recursive: true });
    fs.writeFileSync(path.join(deepest, "index.ts"), "SYNTHETIC_DEPTH_BOUNDARY_SOURCE");
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshot).toContain("SYNTHETIC_DEPTH_BOUNDARY_SOURCE");
    expect(snapshotFiles(snapshot).every(file => !file.truncated)).toBe(true);
    expect(snapshotRecords(snapshot).some(record => record.kind === "limit")).toBe(false);
  });

  it.each(["dist", ".hidden"])("目录深度边界的 %s 属于排除项，不触发深度截断", async name => {
    const deepest = path.join(directory, ...Array.from({ length: 12 }, (_, index) => `d${index}`));
    fs.mkdirSync(path.join(deepest, name), { recursive: true });
    fs.writeFileSync(path.join(deepest, "index.ts"), "SYNTHETIC_DEPTH_BOUNDARY_SOURCE");
    fs.writeFileSync(path.join(deepest, name, "ignored.ts"), "SYNTHETIC_EXCLUDED_SOURCE");
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshot).toContain("SYNTHETIC_DEPTH_BOUNDARY_SOURCE");
    expect(snapshot).not.toContain("SYNTHETIC_EXCLUDED_SOURCE");
    expect(snapshotFiles(snapshot).every(file => !file.truncated)).toBe(true);
    expect(snapshotRecords(snapshot).some(record => record.kind === "limit")).toBe(false);
  });

  it("目录深度截断按仓库记录，不使后续完整仓库也被标作截断", async () => {
    const first = path.join(directory, "first");
    const second = path.join(directory, "second");
    fs.mkdirSync(path.join(first, ...Array.from({ length: 13 }, (_, index) => `d${index}`)), { recursive: true });
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, "README.md"), "SYNTHETIC_FIRST_DOCUMENT");
    fs.writeFileSync(path.join(second, "README.md"), "SYNTHETIC_SECOND_DOCUMENT");
    const snapshot = await collectRepoSourceSnapshot([{ path: first }, { path: second }]);
    const records = snapshotRecords(snapshot);
    expect(records.filter(record => record.kind === "limit")).toEqual([
      expect.objectContaining({ repoNumber: 1, budgetLimited: false, depthLimited: true }),
    ]);
    expect(snapshotFiles(snapshot)).toContainEqual(expect.objectContaining({ repoNumber: 2, content: "SYNTHETIC_SECOND_DOCUMENT", truncated: false }));
  });

  it("目录深度与字符预算同时受限时保留两种原因，且总快照仍不超预算", async () => {
    const deepest = path.join(directory, ...Array.from({ length: 12 }, (_, index) => `d${index}`));
    fs.mkdirSync(path.join(deepest, "deeper"), { recursive: true });
    for (let index = 0; index < 6; index++) fs.writeFileSync(path.join(deepest, `z-large-${index}.ts`), "x".repeat(32_000));
    const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
    expect(snapshot.includes("本代码库采集预算与目录深度已达上限")).toBe(true);
    expect(snapshot.length).toBeLessThanOrEqual(180_000);
  });

  it.each([false, true])("前一个大仓库不会挤掉后续仓库，且保留各仓库的材料范围（reverse=%s）", async (reverse) => {
    const frontend = path.join(directory, "frontend");
    const backend = path.join(directory, "backend");
    for (const [root, name] of [[frontend, "FRONTEND"], [backend, "BACKEND"]] as const) {
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, "README.md"), `SYNTHETIC_${name}_README`);
      for (let index = 0; index < 7; index++) {
        fs.writeFileSync(path.join(root, `module-${index}.ts`), `// ${name}_MODULE_${index}\n` + "x".repeat(31_900));
      }
    }
    const roots = reverse ? [backend, frontend] : [frontend, backend];
    const snapshot = await collectRepoSourceSnapshot(roots.map((root) => ({ path: root })));
    expect(snapshot.includes("SYNTHETIC_FRONTEND_README")).toBe(true);
    expect(snapshot.includes("SYNTHETIC_BACKEND_README")).toBe(true);
    const records = snapshotRecords(snapshot);
    expect(records.filter(record => record.kind === "repository")).toHaveLength(2);
    for (const [index, root] of roots.entries()) {
      expect(snapshotFiles(snapshot)).toContainEqual(expect.objectContaining({ repoNumber: index + 1, content: expect.stringContaining(`${path.basename(root).toUpperCase()}_MODULE_0`) }));
      expect(records).toContainEqual(expect.objectContaining({ kind: "limit", repoNumber: index + 1, budgetLimited: true }));
    }
    expect(snapshot.length).toBeLessThanOrEqual(180_000);
  });

  it("前一个小仓库未使用的字符额度可继续供后续仓库采集", async () => {
    const small = path.join(directory, "small");
    const large = path.join(directory, "large");
    fs.mkdirSync(small); fs.mkdirSync(large);
    fs.writeFileSync(path.join(small, "README.md"), "SYNTHETIC_SMALL_REPO");
    for (let index = 0; index < 5; index++) {
      fs.writeFileSync(path.join(large, `module-${index}.ts`), `// MODULE_${index}\n` + "x".repeat(30_000));
    }
    const snapshot = await collectRepoSourceSnapshot([{ path: small }, { path: large }]);
    expect(snapshot).toContain("SYNTHETIC_SMALL_REPO");
    expect(snapshot).toContain("MODULE_4");
    expect(snapshotFiles(snapshot).every(file => !file.truncated)).toBe(true);
    expect(snapshotRecords(snapshot).some(record => record.kind === "limit")).toBe(false);
    expect(snapshot.length).toBeLessThanOrEqual(180_000);
  });

  it("前一仓库耗尽遍历额度后仍为后续仓库保留采集机会", async () => {
    const first = path.join(directory, "first");
    const second = path.join(directory, "second");
    fs.mkdirSync(first); fs.mkdirSync(second);
    fs.writeFileSync(path.join(second, "README.md"), "SYNTHETIC_SECOND_REPO");
    const entries = Array.from({ length: 10_001 }, (_, index) => ({
      name: `ignored-${index}.log`, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true,
    }));
    vi.spyOn(fsPromises, "readdir").mockResolvedValueOnce(entries as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    const snapshot = await collectRepoSourceSnapshot([{ path: first }, { path: second }]);
    expect(snapshotRecords(snapshot).filter(record => record.kind === "repository").map(record => record.repoNumber)).toEqual([1, 2]);
    expect(snapshot).toContain("SYNTHETIC_SECOND_REPO");
    expect(snapshotRecords(snapshot).filter(record => record.kind === "limit")).toEqual([
      expect.objectContaining({ repoNumber: 1, budgetLimited: true, depthLimited: false }),
    ]);
    expect(snapshot.length).toBeLessThanOrEqual(180_000);
  });

  it("正常文件名下的明文凭证和连接串不会外发", async () => {
    fs.writeFileSync(path.join(directory, "appsettings.json"), JSON.stringify({ ApiKey: "SYNTHETIC_CREDENTIAL_MARKER" }));
    fs.writeFileSync(path.join(directory, "application.yml"), "password: SYNTHETIC_CREDENTIAL_MARKER");
    fs.writeFileSync(path.join(directory, "config.ts"), "const connection = 'Server=localhost;Password=SYNTHETIC_CREDENTIAL_MARKER';");
    expect(await collectRepoSourceSnapshot([{ path: directory }])).not.toContain("SYNTHETIC_CREDENTIAL_MARKER");
  });

  it.each(["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "DSA PRIVATE KEY", "PGP PRIVATE KEY BLOCK"])(
    "%s 标记使整个文件退出快照，不要求读到私钥结束标记", async (label) => {
      const content = `SYNTHETIC_PRIVATE_FILE\n-----BEGIN ${label}-----\nSYNTHETIC_PRIVATE_KEY_BODY`;
      expect(isSafeRepoSourceText(content)).toBe(false);
      fs.writeFileSync(path.join(directory, "README.md"), content);
      fs.writeFileSync(path.join(directory, "index.ts"), "export const safeAnswer = 42;");
      const snapshot = await collectRepoSourceSnapshot([{ path: directory }]);
      expect(snapshotFiles(snapshot).map(file => file.path)).not.toContain("README.md");
      expect(snapshot).not.toContain("SYNTHETIC_PRIVATE_FILE");
      expect(snapshot).not.toContain("SYNTHETIC_PRIVATE_KEY_BODY");
      expect(snapshot).toContain("export const safeAnswer = 42;");
    },
  );

  it.each(["PUBLIC KEY", "RSA PUBLIC KEY", "CERTIFICATE", "CERTIFICATE REQUEST", "PGP PUBLIC KEY BLOCK"])(
    "%s 是公开材料，不因补充私钥标记而被排除", async (label) => {
      const content = `-----BEGIN ${label}-----\nSYNTHETIC_PUBLIC_BODY\n-----END ${label}-----`;
      expect(isSafeRepoSourceText(content)).toBe(true);
      fs.writeFileSync(path.join(directory, "README.md"), content);
      expect(snapshotFiles(await collectRepoSourceSnapshot([{ path: directory }]))).toContainEqual(expect.objectContaining({ path: "README.md", content, truncated: false }));
    },
  );

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
    expect(snapshotFiles(snapshot).map(file => file.path)).not.toContain("settings.ts");
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
    expect(snapshotFiles(snapshot).map(file => file.path)).not.toContain("settings.ts");
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
