import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { PreparationInputError, preparationApplication, listPreparationResources, listPreparationTasks } from "@/lib/application-preparation";
import { PREPARATION_KINDS } from "@/lib/application-preparation-types";

export const GET = withRouteErrorHandling("GET /api/applications/[id]/preparation", async (_req, { params }) => {
  try {
    const id = Number((await params).id);
    const application = preparationApplication(id);
    return NextResponse.json({ application, resources: Object.fromEntries(PREPARATION_KINDS.map((kind) => [kind, listPreparationResources(id, kind)])), tasks: listPreparationTasks(id) });
  } catch (error) {
    if (error instanceof PreparationInputError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
});
