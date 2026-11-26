import { withRouteErrorHandling } from "@/lib/api-route";
import { validateMutationOrigin } from "@/lib/api-origin";
import { diagnoseMcpConnection, generateMcpConnection, McpConnectionInputError, parseMcpConnectionInput } from "@/lib/mcp-connection";
import { readJsonBody, RequestFormatError, RequestTooLargeError } from "@/lib/request-limits";

export const runtime = "nodejs";

function rejectedOrigin(request: Request) {
  // Apply the application's Host + Origin policy to diagnostics too. Next may
  // rewrite request.url to the bind address; compare the real Host header.
  const source = new Request(request.url, { method: "POST", headers: request.headers });
  if (!validateMutationOrigin(source).ok || request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: "拒绝跨站设置请求" }, { status: 403 });
  }
}

export const GET = withRouteErrorHandling("GET /api/settings/mcp", async request => {
  const rejected = rejectedOrigin(request);
  if (rejected) return rejected;
  return Response.json(await diagnoseMcpConnection());
});

export const POST = withRouteErrorHandling("POST /api/settings/mcp", async request => {
  const rejected = rejectedOrigin(request);
  if (rejected) return rejected;
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return Response.json({ error: "Content-Type 必须为 application/json" }, { status: 415 });
  }
  let input;
  try { input = parseMcpConnectionInput(await readJsonBody<unknown>(request, 256)); }
  catch (error) {
    if (error instanceof RequestTooLargeError) return Response.json({ error: "请求体超过 256 字节" }, { status: 413 });
    if (error instanceof RequestFormatError || error instanceof McpConnectionInputError) return Response.json({ error: "请选择有效的预设和格式；仅接受 preset 和 format。" }, { status: 400 });
    throw error;
  }
  try { return Response.json(generateMcpConnection(input)); }
  catch { return Response.json({ error: "无法生成配置，请刷新诊断并修正服务端 MCP 配置。" }, { status: 422 }); }
});
