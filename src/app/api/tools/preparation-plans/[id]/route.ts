import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { ApplicationInputError } from "@/lib/applications";
import { PreparationInputError } from "@/lib/application-preparation";
import { completePreparationStep, generatePreparationPlan, getPreparationPlan } from "@/lib/preparation-plan";

function handle(method: "GET" | "POST" | "PATCH") {
  return async (request: Request, { params }: { params: Promise<Record<string, string>> }) => {
    try {
      const id = parseCanonicalPositiveId((await params).id);
      if (method === "GET") return NextResponse.json(getPreparationPlan(id));
      const parsed = await parseApiJson<unknown>(request);
      if (!parsed.ok) return parsed.response;
      if (!parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) throw new ApplicationInputError("清单参数无效");
      const body = parsed.data as { contextKey?: unknown; key?: unknown; done?: unknown };
      return NextResponse.json(method === "POST" ? generatePreparationPlan(id, body.contextKey) : completePreparationStep(id, body));
    } catch (error) {
      if (error instanceof ApplicationInputError || error instanceof PreparationInputError) {
        return NextResponse.json({ error: error.message }, { status: error instanceof PreparationInputError ? error.status : 400 });
      }
      throw error;
    }
  };
}

export const GET = withRouteErrorHandling("GET /api/tools/preparation-plans/[id]", handle("GET"));
export const POST = withRouteErrorHandling("POST /api/tools/preparation-plans/[id]", handle("POST"));
export const PATCH = withRouteErrorHandling("PATCH /api/tools/preparation-plans/[id]", handle("PATCH"));
