import fs from "node:fs/promises";
import path from "node:path";

/** Observe only previously captured names under the same allowed root; never follow links. */
export async function observeMissingRepositoryFile(root: string, relative: string): Promise<"deleted" | "not-captured"> {
  const parts = relative.split("/");
  if (path.isAbsolute(relative) || parts.some(part => !part || part === "." || part === ".." || part.includes("\\") || part.includes(":"))) return "not-captured";
  try {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(root) !== root) return "not-captured";
  } catch { return "not-captured"; }
  let target = root;
  for (const [index, part] of parts.entries()) {
    target = path.join(target, part);
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) return "not-captured";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "deleted" : "not-captured";
    }
  }
  return "not-captured";
}
