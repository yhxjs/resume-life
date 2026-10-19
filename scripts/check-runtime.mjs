const [major, minor] = process.versions.node.split(".").map(Number);
if (major !== 24 || minor < 21) {
  console.error("请使用 Node.js 24.21.0 或更新的 24.x LTS 版本（参见 .nvmrc），当前为 " + process.version);
  process.exit(1);
}
try {
  await import("node:sqlite");
} catch {
  console.error("当前 Node.js 运行时不支持应用需要的 node:sqlite，请使用官方 Node.js 24 LTS。");
  process.exit(1);
}
