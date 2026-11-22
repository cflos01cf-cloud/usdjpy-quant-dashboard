import { NextResponse } from "next/server";
import { db } from "@/lib/services/db";
import { computeMetrics, type TradeResult } from "@/lib/engine/metrics";

export const dynamic = "force-dynamic";

/**
 * Registro de señales para el Global Quant Hub. SÓLO LECTURA de Supabase:
 * no llama a TwelveData, no corre el motor y no escribe nada.
 */
interface Fill { reason: string; time: number; price: number; fraction: number }

function outcomeOf(status: string, r: number | null, fills: Fill[]): string {
  if (status === "EXPIRED") return "EXPIRED";
  if (status === "INVALIDATED") return "INVALIDATED";
  if (status !== "CLOSED") return status;
  const tps = fills.filter((f) => /^TP\d$/.test(f.reason)).map((f) => f.reason).sort();
  if (r !== null && r > 0.05) return tps.length ? `WIN_${tps[tps.length - 1]}` : "WIN";
  if (r !== null && r < -0.05) return "LOSS";
  return "BREAKEVEN";
}

export async function GET(req: Request) {
  const limit = Math.min(500, Math.max(1, Number(new URL(req.url).searchParams.get("limit") ?? 200) || 200));
  const [sigs, trades, snap] = await Promise.all([
    db().from("signals").select("id,direction,entry,stop,tp1,tp2,tp3,rr,score,strategies,reasons,confirmation_tf,session,status,result_r,created_at,closed_at,valid_until").order("created_at", { ascending: false }).limit(limit),
    db().from("paper_trades").select("signal_id,status,state,result_r"),
    db().from("engine_snapshots").select("created_at,data_status,snapshot->price,snapshot->evaluatedBarClose").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (sigs.error) return NextResponse.json({ error: sigs.error.message }, { status: 500 });
  const byId = new Map((trades.data ?? []).map((t) => [t.signal_id, t]));
  const outcomes = (sigs.data ?? []).map((s) => {
    const t = byId.get(s.id);
    const st = t?.state as { fills?: Fill[]; filledAt?: number | null; fillPrice?: number | null; mfeR?: number; maeR?: number } | undefined;
    const fills = st?.fills ?? [];
    const r = s.result_r === null || s.result_r === undefined ? null : Number(s.result_r);
    const status = (t?.status as string) ?? s.status;
    const last = fills[fills.length - 1];
    return {
      id: s.id,
      direction: s.direction,
      status,
      outcome: outcomeOf(status, r, fills),
      score: s.score,
      strategies: s.strategies,
      reasons: s.reasons,
      timeframe: s.confirmation_tf,
      session: s.session,
      entry: Number(s.entry), stop: Number(s.stop), tp1: Number(s.tp1), tp2: Number(s.tp2), tp3: Number(s.tp3),
      rrNetTp2: s.rr?.netTp2 ?? null,
      created_at: s.created_at,
      filled_at: st?.filledAt ? new Date(st.filledAt * 1000).toISOString() : null,
      exit_time: s.closed_at ?? (last ? new Date(last.time * 1000).toISOString() : null),
      exit_price: last?.price ?? null,
      r_multiple: r,
      mfe_r: st?.mfeR ?? null,
      mae_r: st?.maeR ?? null,
      exits: fills.map((f) => f.reason),
    };
  });
  const closed: TradeResult[] = outcomes.filter((o) => o.status === "CLOSED" && o.r_multiple !== null).map((o) => ({ r: o.r_multiple as number, time: Date.parse(o.created_at) / 1000 }));
  const m = computeMetrics(closed);
  return NextResponse.json({
    engine: "usdjpy",
    generatedAt: new Date().toISOString(),
    lastRun: snap.data ? { at: snap.data.created_at, dataStatus: snap.data.data_status, price: snap.data.price ?? null } : null,
    outcomes,
    stats: {
      totalOpen: outcomes.filter((o) => o.status === "PENDING" || o.status === "ACTIVE").length,
      totalClosed: closed.length,
      expired: outcomes.filter((o) => o.status === "EXPIRED" || o.status === "INVALIDATED").length,
      winRate: closed.length ? m.winRate : null,
      profitFactor: closed.length && Number.isFinite(m.profitFactor) ? m.profitFactor : null,
      expectancyR: closed.length ? m.expectancyR : null,
      hasSignificance: closed.length >= 50,
      note: "R neto de spread, deslizamiento y comisión (perfil de costos del motor). Paper trading.",
    },
  });
}
