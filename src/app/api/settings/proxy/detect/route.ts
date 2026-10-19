import { withRouteErrorHandling } from "@/lib/api-route";
import { detectProxyCandidates } from "@/lib/proxy-detect";
import { assertTrustedSettingsRequest } from "@/lib/settings-request";
import { errorMessage } from "@/lib/error-message";
import { NextResponse } from "next/server";

async function handleGet(request: Request) {
  try { assertTrustedSettingsRequest(request); }
  catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 400 });
  }
  try {
    const candidates = await detectProxyCandidates();
    return NextResponse.json({ ok: true, candidates });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "发现本机代理失败" },
      { status: 502 },
    );
  }
}

export const GET = withRouteErrorHandling("GET /api/settings/proxy/detect", handleGet);
