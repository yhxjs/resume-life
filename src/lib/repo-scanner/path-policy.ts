const path = process.getBuiltinModule("path");

/** 校验入口与快照读取共用；读取前必须以 realpath 后的真实根执行策略。 */
export function repoRootPathError(directory: string): string | undefined {
  if (directory === path.parse(directory).root) {
    return "不能直接选择系统磁盘或根目录作为代码仓库";
  }

  // Windows realpath 可能保留 \\?\ 或 \\.\ 盘符前缀，仍须按同一敏感根判断。
  const lower = directory.toLowerCase().replace(/\\/g, "/").replace(/^\/\/[?.]\/(?=[a-z]:\/)/, "");
  const forbiddenRoots = process.platform === "win32"
    ? ["/windows", "/program files", "/program files (x86)", "/perflogs", "/recovery", "/system volume information", "/system"]
    : ["/etc", "/usr", "/bin", "/sbin", "/sys", "/proc", "/dev", "/system"];
  const drivePrefix = /^[a-z]:/.test(lower) ? lower.slice(0, 2) : "";
  const isSensitiveRoot = forbiddenRoots.some((root) => {
    const candidate = `${drivePrefix}${root}`;
    return lower === candidate || lower.startsWith(`${candidate}/`);
  });
  return isSensitiveRoot ? "禁止扫描系统敏感目录" : undefined;
}
