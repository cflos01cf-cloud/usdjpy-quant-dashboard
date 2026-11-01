import { NextResponse } from "next/server";
import { db } from "@/lib/services/db";

export const dynamic = "force-dynamic";

/** Último snapshot del motor. No consume créditos de TwelveData. */
export async function GET() {
  try {
    const { data, error } = await db().from("engine_snapshots").select("created_at,data_status,snapshot").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(error.message);
    const { data: active } = await db().from("signals").select("*").in("status", ["PENDING", "ACTIVE"]).order("created_at", { ascending: false });
    const { data: runs } = await db().from("engine_runs").select("started_at,duration_ms,data_status,credits_used,errors").order("started_at", { ascending: false }).limit(1);
    return NextResponse.json({ snapshot: data?.snapshot ?? null, savedAt: data?.created_at ?? null, activeSignals: active ?? [], lastRun: runs?.[0] ?? null });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
