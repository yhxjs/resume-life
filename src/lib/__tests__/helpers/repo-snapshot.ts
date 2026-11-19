type RepositoryRecord = { kind: "repository"; repoNumber: number };
export type SnapshotFile = { kind: "file"; repoNumber: number; path: string; content: string; truncated: boolean };
type LimitRecord = { kind: "limit"; repoNumber: number; budgetLimited: boolean; depthLimited: boolean; note: string };
type SnapshotRecord = RepositoryRecord | SnapshotFile | LimitRecord;

/** 测试只解码记录，不根据材料正文猜测文件或仓库边界。 */
export function snapshotRecords(snapshot: string): SnapshotRecord[] {
  return snapshot ? snapshot.trimEnd().split("\n").map(line => JSON.parse(line)) : [];
}

export function snapshotFiles(snapshot: string): SnapshotFile[] {
  return snapshotRecords(snapshot).filter((record): record is SnapshotFile => record.kind === "file");
}

export function promptSnapshot(prompt: string): string {
  const wrapped = prompt.match(/<repo_source>\n([\s\S]*?)\n<\/repo_source>/)?.[1];
  if (wrapped === undefined) throw new Error("Missing repo_source block");
  return wrapped.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
