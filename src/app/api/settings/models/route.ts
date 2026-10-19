import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { parseApiJson } from "@/lib/api-request";
import { assertTrustedSettingsRequest, readModelSettingsRequest } from "@/lib/settings-request";
import { buildHeaders, buildModelsUrl, describeNetworkError } from "@/lib/llm-adapter";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import { errorMessage } from "@/lib/error-message";
import { readModelProbeJson } from "@/lib/model-probe-response";
import { proxyFetchInit } from "@/lib/proxy-dispatcher";

/** 拉取服务的模型列表；优先用表单里未保存的 Base URL / API Key / 协议格式（脱敏占位符视为沿用旧值） */
async function handlePost(request: Request) {
  const requestId = requestIdFrom(request);
  let settings: ReturnType<typeof readModelSettingsRequest>;
  try { assertTrustedSettingsRequest(request); }
  catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 400 });
  }
  const parsedBody = await parseApiJson<unknown>(request, { allowEmpty: true, emptyValue: {} });
  if (!parsedBody.ok) {
    const error = (await parsedBody.response.json()) as { error: string };
    return NextResponse.json({ ok: false, error: error.error }, { status: parsedBody.response.status });
  }
  try { settings = readModelSettingsRequest(parsedBody.data); }
  catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 400 });
  }
  const { baseUrl, apiKey, format } = settings;

  const url = buildModelsUrl(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      ...proxyFetchInit(settings.proxy),
      signal: controller.signal,
      redirect: "manual",
      headers: buildHeaders(format, apiKey),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      logServerError("settings.models.upstream", new Error("upstream HTTP failure"), {
        requestId,
        status: 502,
        context: { upstreamStatus: res.status },
      });
      return NextResponse.json(
        { ok: false, error: `HTTP ${res.status}` },
        { status: 502 }
      );
    }
    const data = await readModelProbeJson<{ data?: { id?: unknown }[] }>(res);
    const raw = Array.isArray(data) ? data : (data.data ?? []);
    const models = Array.from(
      new Set(
        raw
          .map((m) => (typeof m?.id === "string" ? m.id : ""))
          .filter((id) => id !== "")
      )
    ).sort();
    return NextResponse.json({ ok: true, models });
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "AbortError";
    const status = timedOut ? 504 : 502;
    const requestIdForResponse = logServerError("settings.models.fetch", err, { requestId, status });
    return NextResponse.json(
      {
        ok: false,
        error: timedOut
          ? "模型服务请求超时"
          : `无法连接模型服务：${describeNetworkError(err)}`,
        requestId: requestIdForResponse,
      },
      { status }
    );
  } finally {
    clearTimeout(timer);
  }
}

export const POST = withRouteErrorHandling("POST /api/settings/models", handlePost);
