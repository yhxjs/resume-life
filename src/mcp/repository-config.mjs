import path from "node:path";

/** Parse the directory restriction without opening a database or traversing repositories. */
export function readMcpRepositoryRoots(env = process.env) {
  let roots;
  try { roots = JSON.parse(env.RESUME_LIFE_MCP_REPO_ROOTS ?? "[]"); }
  catch { throw new Error("RESUME_LIFE_MCP_REPO_ROOTS 必须是绝对仓库目录的 JSON 数组。"); }
  if (!Array.isArray(roots) || roots.length > 32 || roots.some(root => typeof root !== "string" || !path.isAbsolute(root))) {
    throw new Error("RESUME_LIFE_MCP_REPO_ROOTS 最多包含 32 个绝对仓库目录。");
  }
  return roots;
}
