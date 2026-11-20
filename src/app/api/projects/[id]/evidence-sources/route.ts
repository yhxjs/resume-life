import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { loadProjectRow } from "@/lib/projects";
import { validateRepoPaths } from "@/lib/repo-scanner/path-validator";
import { collectRepoSourceSnapshot, RepoSourceEmptyError } from "@/lib/repo-scanner/source-snapshot";
import { captureScanEvidence } from "@/lib/repo-scanner/evidence";

/** Reuse the scanner's restricted reader without CLI/model generation or archive writes. */
export const POST = withRouteErrorHandling("POST /api/projects/[id]/evidence-sources", async (req, { params }) => {
  const id = parseCanonicalPositiveId((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "项目编号无效" }, { status: 400 });
  if (!loadProjectRow(id)) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  const body = await parseApiJson<unknown>(req);
  if (!body.ok) return body.response;
  const paths = body.data && typeof body.data === "object" && !Array.isArray(body.data)
    ? (body.data as Record<string, unknown>).repoPaths : undefined;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 32 || paths.some(path => typeof path !== "string" || !path.trim())) {
    return NextResponse.json({ error: "请选择 1–32 个代码仓库目录" }, { status: 400 });
  }
  req.signal.throwIfAborted();
  const checked = validateRepoPaths(paths);
  if (!checked.valid) return NextResponse.json({ error: checked.error }, { status: 400 });
  const targets = checked.paths.map(target => ({ path: target.normalizedPath! }));
  try {
    const source = await collectRepoSourceSnapshot(targets, req.signal);
    req.signal.throwIfAborted();
    if (!loadProjectRow(id)) return NextResponse.json({ error: "项目已删除" }, { status: 404 });
    return NextResponse.json({ sourceFiles: captureScanEvidence(source, targets, id) });
  } catch (error) {
    if (error instanceof RepoSourceEmptyError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
});
