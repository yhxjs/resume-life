import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { parseApiJson } from "@/lib/api-request";
import { assertTrustedSettingsRequest, readModelSettingsRequest } from "@/lib/settings-request";
import { describeNetworkError } from "@/lib/llm-adapter";
import { LlmBusyError, LlmHttpError, LlmTimeoutError } from "@/lib/llm";
import { LLM_FEATURES, safeChat } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";

/** 用当前或表单传入的配置向 LLM 服务发一次最小补全请求，验证连通性与模型可用性 */
async function handlePost(request: Request) {
  let settings: ReturnType<typeof readModelSettingsRequest>;
  try { assertTrustedSettingsRequest(request); }
  catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 400 });
  }
  const parsedBody = await parseApiJson<unknown>(request, { allowEmpty: true, emptyValue: {} });
  if (!parsedBody.ok) {
    // 解析失败时正文不一定还是 JSON，容错解析并回退到状态码，避免错误文案静默变成 undefined
    const body = (await parsedBody.response.json().catch(() => null)) as { error?: unknown } | null;
    const message = typeof body?.error === "string" && body.error.trim()
      ? body.error
      : `请求无效 HTTP ${parsedBody.response.status}`;
    return NextResponse.json({ ok: false, error: message }, { status: parsedBody.response.status });
  }
  try { settings = readModelSettingsRequest(parsedBody.data); }
  catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 400 });
  }
  if (!settings.model) {
    return NextResponse.json(
      { ok: false, error: "请至少填写一个模型名" },
      { status: 400 }
    );
  }

  try {
    const reply = await safeChat("parse", { feature: LLM_FEATURES.settingsConnectionTest }, "", [
      { role: "user", parts: [{ trust: "trusted", text: "回复 ok" }] },
    ], { connectionTest: settings, signal: request.signal });
    return NextResponse.json({ ok: true, reply });
  } catch (err) {
    if (err instanceof LlmBusyError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 429 });
    }
    if (request.signal.aborted) {
      return NextResponse.json({ ok: false, error: "已取消连接测试" }, { status: 499 });
    }
    if (err instanceof LlmHttpError) {
      return NextResponse.json({ ok: false, error: `HTTP ${err.status}` }, { status: 502 });
    }
    const timedOut = err instanceof LlmTimeoutError || (err instanceof DOMException && err.name === "AbortError");
    const message = timedOut
      ? `连接超时（15 秒无响应），请检查 Base URL 与网络是否可达`
      : `无法连接模型服务：${describeNetworkError(err)}`;
    return NextResponse.json({ ok: false, error: message }, { status: timedOut ? 504 : 502 });
  }
}

export const POST = withRouteErrorHandling("POST /api/settings/test", handlePost);
