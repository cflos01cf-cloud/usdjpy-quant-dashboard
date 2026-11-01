import { NextResponse } from "next/server";
import { db } from "@/lib/services/db";
import { analyzeTf } from "@/lib/engine/context";
import { detectSweep, swingLiquidity } from "@/lib/engine/structure";
import { computeSessionLevels, sessionLiquidityBefore } from "@/lib/engine/sessions";
import type { Candle, Timeframe } from "@/lib/engine/types";

export const dynamic = "force-dynamic";
const TFS: Timeframe[] = ["D1", "H4", "H1", "M15", "M5", "M1"];

/** Velas + overlays (EMAs, RSI, MACD, ATR, BOS/CHoCH, FVG/OB) desde el caché. Sin créditos. */
export async function GET(req: Request) {
  const tf = (new URL(req.url).searchParams.get("tf") ?? "M15") as Timeframe;
  if (!TFS.includes(tf)) return NextResponse.json({ error: "tf inválida" }, { status: 400 });
  const { data, error } = await db().from("candles_cache").select("candles,fetched_at").eq("tf", tf).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const candles = (data?.candles ?? []) as Candle[];
  if (!candles.length) return NextResponse.json({ tf, candles: [], fetchedAt: null });
  const a = analyzeTf(tf, candles);
  const n = candles.length;
  const startIdx = Math.max(0, n - 250);
  const series = (arr: number[]) => arr.slice(startIdx).map((v, k) => ({ time: candles[startIdx + k].time, value: Number.isFinite(v) ? v : null }));
  const zones = a.structure.zones
    .filter((z) => z.createdAt >= startIdx && (z.mitigatedAt === null) && n - 1 - z.createdAt <= 120)
    .slice(-14)
    .map((z) => ({ ...z, fromTime: candles[z.originIndex].time }));
  const intraday = tf !== "D1" && tf !== "H4";
  const levels = intraday ? computeSessionLevels(candles) : [];
  const sweeps = [];
  for (let k = startIdx; k < n; k++) {
    const lv = [...(intraday ? sessionLiquidityBefore(levels, k) : []), ...swingLiquidity(a.structure, candles, k, 4)];
    const s = detectSweep(candles[k], lv, k);
    if (s) sweeps.push({ ...s, time: candles[k].time });
  }
  return NextResponse.json({
    tf,
    sweeps,
    fetchedAt: data?.fetched_at,
    candles: candles.slice(startIdx),
    ema20: series(a.ind.ema20), ema50: series(a.ind.ema50), ema200: series(a.ind.ema200),
    rsi: series(a.ind.rsi), macd: series(a.ind.macd), macdSignal: series(a.ind.macdSignal), macdHist: series(a.ind.macdHist), atr: series(a.ind.atr),
    events: a.structure.events.filter((e) => e.index >= startIdx).map((e) => ({ ...e, time: candles[e.index].time })),
    zones,
    trend: a.trend,
  });
}
