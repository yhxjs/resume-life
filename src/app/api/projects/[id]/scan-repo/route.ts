import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { loadProjectRow } from "@/lib/projects";
import { createSseResponse } from "@/lib/sse";
import { parseApiJson } from "@/lib/api-request";
import { validateRepoPaths } from "@/lib/repo-scanner/path-validator";
import { detectInstalledClis, runRepoScan } from "@/lib/repo-scanner/cli-runner";
import { CliConfigError, parseCliSelection } from "@/lib/repo-scanner/cli-config";
import { DirectoryBrowseError, listDirectory } from "@/lib/repo-scanner/dir-browser";
import { checkPathsRelation } from "@/lib/repo-scanner/relation-checker";
import { requestIdFrom, logServerError } from "@/lib/server-errors";
import { errorMessage } from "@/lib/error-message";
import { ProjectSummaryCorruptError } from "@/lib/summary";
import { ModelInputBudgetError } from "@/lib/llm-input-budget";
import { buildRepoScanArchive } from "@/lib/repo-scanner/prompts";
import { RepoSourceEmptyError } from "@/lib/repo-scanner/source-snapshot";
import { captureScanEvidence } from "@/lib/repo-scanner/evidence";
import { captureProjectSummarySource, prepareProjectSummaryProposal, ProjectSummaryHistoryError } from "@/lib/project-summary-history";

/**
 * GET /api/projects/[id]/scan-repo
 * 探测宿主机环境上的可用 CLI 状态，或浏览本地目录
 */
async function handleGet(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const projectId = parseCanonicalPositiveId(id);
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
    try {
      return NextResponse.json(await listDirectory(browsePath, req.signal));
    } catch (error) {
      if (error instanceof DirectoryBrowseError) return NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }

  try {
    req.signal.throwIfAborted();
    const clis = await detectInstalledClis(req.signal);
    req.signal.throwIfAborted();
    return NextResponse.json(clis);
  } catch (error) {
    if (req.signal.aborted) return NextResponse.json({ error: "CLI 环境检测已取消" }, { status: 499 });
    throw error;
  }
}

/**
 * POST /api/projects/[id]/scan-repo
 * 启动本地仓库扫描并以 SSE 形式返回阶段日志与最终五字段总结，
 * 或快速研判多个待合并代码库的业务/架构关联性 (action=check-relation)
 */
async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const projectId = parseCanonicalPositiveId(id);
  if (!Number.isInteger(projectId)) {
    return NextResponse.json({ error: "无效的项目 ID" }, { status: 400 });
  }
  if (!loadProjectRow(projectId)) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  const url = new URL(req.url);
  const actionParam = url.searchParams.get("action");

  const parsedJson = await parseApiJson<unknown>(req);
  if (!parsedJson.ok) {
    return parsedJson.response;
  }

  if (!parsedJson.data || typeof parsedJson.data !== "object" || Array.isArray(parsedJson.data)) {
    return NextResponse.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  }
  const { repoPath, repoPaths, preferredCli, customCli, action: bodyAction } = parsedJson.data as Record<string, unknown>;
  if ((repoPath !== undefined && typeof repoPath !== "string") ||
    (repoPaths !== undefined && (!Array.isArray(repoPaths) || repoPaths.some((value) => typeof value !== "string")))) {
    return NextResponse.json({ error: "仓库路径必须是字符串，repoPaths 必须是字符串数组" }, { status: 400 });
  }
  let selection: ReturnType<typeof parseCliSelection>;
  try { selection = parseCliSelection(preferredCli, customCli); }
  catch (error) {
    if (error instanceof CliConfigError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
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
    if (!loadProjectRow(projectId)) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    const relationResult = await checkPathsRelation(pathsCheck.paths, { ...selection, signal: req.signal, projectId });
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

  let source: ReturnType<typeof captureProjectSummarySource>;
  try {
    source = captureProjectSummarySource(projectId);
    buildRepoScanArchive(source.project.summary);
  } catch (error) {
    if (error instanceof ProjectSummaryHistoryError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof ProjectSummaryCorruptError) return NextResponse.json({ error: error.message }, { status: 422 });
    if (error instanceof ModelInputBudgetError) return NextResponse.json({ error: error.message }, { status: 413 });
    throw error;
  }
  const { project: row, materials: sourceMaterials, revisionId: sourceRevisionId } = source;
  const requestId = requestIdFrom(req);
  const validatedPaths = pathsCheck.paths.map((p) => p.normalizedPath!);
  const firstPath = pathsCheck.paths[0];
  const projectName = row.name || firstPath?.projectName || "项目";
  const projectArchive = row.summary;
  const targets = pathsCheck.paths.map((p) => ({
    path: p.normalizedPath!,
    name: p.projectName,
  }));

  return createSseResponse(async (emitter) => {
    try {
      emitter.sendDelta("正在初始化扫描环境与引擎...", { stage: "init" });

      const scanResult = await runRepoScan({
        repoPaths: validatedPaths,
        targets,
        projectName,
        projectArchive,
        ...selection,
        signal: emitter.signal,
        onDelta: (text, log) => {
          emitter.sendDelta(text, { log });
        },
      });

      // 扫描成功，返回符合系统草稿确认制规范的五维总结
      emitter.sendDone({
        ...prepareProjectSummaryProposal(projectId, scanResult.summary, sourceMaterials, sourceRevisionId, row.name),
        cliUsed: scanResult.cliUsed,
        repoPath: validatedPaths.join(" ; "),
        repoPaths: validatedPaths,
        features: pathsCheck.paths.flatMap((p) => p.features || []),
        logs: scanResult.logs,
        sourceFiles: captureScanEvidence(scanResult.sourceSnapshot ?? "", targets, projectId),
      });
    } catch (err) {
      if (emitter.signal.aborted) {
        emitter.sendError("扫描已被取消");
        return;
      }
      if (err instanceof RepoSourceEmptyError || err instanceof CliConfigError) {
        emitter.sendError(err.message);
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
