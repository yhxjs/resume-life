import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { withRouteErrorHandling } from "@/lib/api-route";

/** 题库中已使用的方向列表（含各方向题数），供筛选与出题表单选择 */
async function handleGet() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT direction, COUNT(*) AS count FROM bank_entries
       WHERE direction != '' GROUP BY direction ORDER BY direction`
    )
    .all() as { direction: string; count: number }[];
  return NextResponse.json(rows);
}

export const GET = withRouteErrorHandling("GET /api/bank/directions", handleGet);
