import { NextResponse } from "next/server";
import { loadPortfolioSources, PortfolioError } from "@/lib/portfolio";
import { withRouteErrorHandling } from "@/lib/api-route";

async function handleGet() {
  try {
    return NextResponse.json(loadPortfolioSources());
  } catch (error) {
    if (error instanceof PortfolioError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

export const GET = withRouteErrorHandling("GET /api/portfolio/sources", handleGet);
