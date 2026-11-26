import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { ApplicationInputError } from "@/lib/applications";
import { createCustomTemplate, listCustomTemplates } from "@/lib/template-store";

async function handleGet() { return NextResponse.json({ items: listCustomTemplates() }); }
async function handlePost(req: Request) {
  const parsed = await parseApiJson<unknown>(req);
  if (!parsed.ok) return parsed.response;
  try { return NextResponse.json(createCustomTemplate(parsed.data), { status: 201 }); }
  catch (error) {
    if (error instanceof ApplicationInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
export const GET = withRouteErrorHandling("GET /api/templates", handleGet);
export const POST = withRouteErrorHandling("POST /api/templates", handlePost);
