import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { loadProjectRow } from "@/lib/projects";
import { createSseResponse } from "@/lib/sse";
import { parseApiJson } from "@/lib/api-request";
import { validateRepoPaths } from "@/lib/repo-scanner/path-validator";
import { detectInstalledClis, runRepoScan } from "@/lib/repo-scanner/cli-runner";
import { listDirectory } from "@/lib/repo-scanner/dir-browser";
import { checkPathsRelation } from "@/lib/repo-scanner/relation-checker";
import { requestIdFrom, logServerError } from "@/lib/server-errors";
import { errorMessage } from "@/lib/error-message";
import { captureProjectMaterialSnapshot, prepareProjectSummaryProposal, projectSummaryRevision } from "@/lib/project-summary-history";

/**
 * GET /api/projects/[id]/scan-repo
 * 探测宿主机环境上的可用 CLI 状态，或浏览本地目录
 */
async function handleGet(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const projectId = Number(id);
  if (!Number.isInteger(projectId)) {
    return NextResponse.json({ error: "无效的项目 ID" }, { status: 400 });
  }
  const row = loadProjectRow(projectId);
  if (!row) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // 支持目录浏览
  if (action === "browse") {
    const browsePath = url.searchParams.get("path") || undefined;
    const browseResult = listDirectory(browsePath);
    return NextResponse.json(browseResult);
  }

  const clis = await detectInstalledClis();
  return NextResponse.json(clis);
}

/**
 * POST /api/projects/[id]/scan-repo
 * 启动本地仓库扫描并以 SSE 形式返回阶段日志与最终五字段总结，
 * 或快速研判多个待合并代码库的业务/架构关联性 (action=check-relation)
 */
async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const projectId = Number(id);
  if (!Number.isInteger(projectId)) {
    return NextResponse.json({ error: "无效的项目 ID" }, { status: 400 });
  }
  const row = loadProjectRow(projectId);
  if (!row) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  const url = new URL(req.url);
  const actionParam = url.searchParams.get("action");

  const parsedJson = await parseApiJson<unknown>(req);
  if (!parsedJson.ok) {
    return parsedJson.response;
  }

  if (!parsedJson.data || typeof parsedJson.data !== "object" || Array.isArray(parsedJson.data)) {
    return NextResponse.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  }
  const { repoPath, repoPaths, preferredCli = "auto", action: bodyAction } = parsedJson.data as Record<string, unknown>;
  if ((repoPath !== undefined && typeof repoPath !== "string") ||
    (repoPaths !== undefined && (!Array.isArray(repoPaths) || repoPaths.some((value) => typeof value !== "string")))) {
    return NextResponse.json({ error: "仓库路径必须是字符串，repoPaths 必须是字符串数组" }, { status: 400 });
  }
  if (preferredCli !== "auto" && preferredCli !== "codex" && preferredCli !== "claude") {
    return NextResponse.json({ error: "preferredCli 必须是 auto、codex 或 claude" }, { status: 400 });
  }
  if ((bodyAction !== undefined && bodyAction !== "scan" && bodyAction !== "check-relation") ||
    (actionParam !== null && actionParam !== "scan" && actionParam !== "check-relation")) {
    return NextResponse.json({ error: "action 必须是 scan 或 check-relation" }, { status: 400 });
  }
  const isCheckRelation = actionParam === "check-relation" || bodyAction === "check-relation";

  const rawPaths = Array.isArray(repoPaths) && repoPaths.length > 0
    ? repoPaths
    : repoPath
    ? [repoPath]
    : [];

  if (rawPaths.length === 0) {
    return NextResponse.json({ error: "必须提供至少一个本地代码仓库路径" }, { status: 400 });
  }

  // 严格安全校验路径列表
  const pathsCheck = validateRepoPaths(rawPaths);
  if (!pathsCheck.valid || pathsCheck.paths.length === 0) {
    return NextResponse.json({ error: pathsCheck.error || "路径校验未通过" }, { status: 400 });
  }

  // 若为 AI 多路径关联性研判动作
  if (isCheckRelation) {
    const relationResult = await checkPathsRelation(pathsCheck.paths, { preferredCli, signal: req.signal, projectId });
    return NextResponse.json({
      isRelated: relationResult.isRelated,
      reason: relationResult.reason,
      method: relationResult.method,
      paths: pathsCheck.paths.map((p) => ({
        path: p.normalizedPath,
        projectName: p.projectName,
        features: p.features,
      })),
    });
  }

  const requestId = requestIdFrom(req);
  const validatedPaths = pathsCheck.paths.map((p) => p.normalizedPath!);
  const firstPath = pathsCheck.paths[0];
  const projectName = row.name || firstPath?.projectName || "项目";
  const targets = pathsCheck.paths.map((p) => ({
    path: p.normalizedPath!,
    name: p.projectName,
  }));
  const sourceMaterials = captureProjectMaterialSnapshot(projectId);
  const sourceRevisionId = projectSummaryRevision(projectId);

  return createSseResponse(async (emitter) => {
    try {
      emitter.sendDelta("正在初始化扫描环境与引擎...", { stage: "init" });

      const scanResult = await runRepoScan({
        repoPaths: validatedPaths,
        targets,
        projectName,
        preferredCli,
        signal: emitter.signal,
        onDelta: (text, log) => {
          emitter.sendDelta(text, { log });
        },
      });

      // 扫描成功，返回符合系统草稿确认制规范的五维总结
      emitter.sendDone({
        ...prepareProjectSummaryProposal(projectId, scanResult.summary, sourceMaterials, sourceRevisionId),
        cliUsed: scanResult.cliUsed,
        repoPath: validatedPaths.join(" ; "),
        repoPaths: validatedPaths,
        features: pathsCheck.paths.flatMap((p) => p.features || []),
        logs: scanResult.logs,
      });
    } catch (err) {
      if (emitter.signal.aborted) {
        emitter.sendError("扫描已被取消");
        return;
      }
      const msg = errorMessage(err);
      logServerError("sse.projects.scan-repo", err, { requestId, status: 500 });
      emitter.sendError(msg);
    }
  }, requestId);
}

export const GET = withRouteErrorHandling("GET /api/projects/[id]/scan-repo", handleGet);
export const POST = withRouteErrorHandling("POST /api/projects/[id]/scan-repo", handlePost);
