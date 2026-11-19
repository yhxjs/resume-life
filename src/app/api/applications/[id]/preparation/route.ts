import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { PreparationInputError, getApplicationPreparation } from "@/lib/application-preparation";

export const GET = withRouteErrorHandling("GET /api/applications/[id]/preparation", async (_req, { params }) => {
  try {
    const id = parseCanonicalPositiveId((await params).id);
    return NextResponse.json(getApplicationPreparation(id));
  } catch (error) {
    if (error instanceof PreparationInputError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
});
