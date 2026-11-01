import { NextResponse } from "next/server";
import { db } from "@/lib/services/db";
import { computeMetrics, groupMetrics, type TradeResult } from "@/lib/engine/metrics";

export const dynamic = "force-dynamic";

/** Historial de señales + métricas de paper trading. */
export async function GET() {
  const { data: sigs, error } = await db().from("signals").select("*").order("created_at", { ascending: false }).limit(300);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const { data: trades } = await db().from("paper_trades").select("signal_id,status,strategy,session,result_r,pnl_amount,duration_min,state");
  const closed: TradeResult[] = (trades ?? [])
    .filter((t) => t.status === "CLOSED" && t.result_r !== null)
    .map((t) => ({ r: Number(t.result_r), time: t.state?.filledAt ?? 0, strategy: t.strategy, session: t.session }));
  const weekday = (x: TradeResult) => ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"][new Date(x.time * 1000).getUTCDay()];
  return NextResponse.json({
    signals: sigs,
    trades,
    metrics: computeMetrics(closed),
    byStrategy: groupMetrics(closed, (x) => x.strategy),
    bySession: groupMetrics(closed, (x) => x.session),
    byWeekday: groupMetrics(closed, weekday),
    counts: {
      total: trades?.length ?? 0,
      closed: closed.length,
      expired: trades?.filter((t) => t.status === "EXPIRED").length ?? 0,
      invalidated: trades?.filter((t) => t.status === "INVALIDATED").length ?? 0,
      open: trades?.filter((t) => t.status === "PENDING" || t.status === "ACTIVE").length ?? 0,
    },
    equityCurve: closed.sort((a, b) => a.time - b.time).reduce<{ time: number; r: number }[]>((acc, x) => [...acc, { time: x.time, r: (acc.at(-1)?.r ?? 0) + x.r }], []),
  });
}
