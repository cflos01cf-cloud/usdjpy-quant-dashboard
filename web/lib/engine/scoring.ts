import type { Direction, ScoreBreakdown, Setup, StrategyId } from "./types";
import type { EngineContext } from "./context";
import { trendToDir, opposite } from "./context";
import { activeZonesAsOf, lastEventAsOf, rangePosition, recentSweep } from "./structure";
import { sessionLiquidityBefore } from "./sessions";
import { PIP } from "../config";

export interface NewsState {
  blocked: boolean; // dentro de la ventana de bloqueo
  nearHighImpact: boolean; // dentro de 2× ventana
  next?: { title: string; time: number; impact: string; currency: string } | null;
}

const trendPts = (tfDir: Direction | null, d: Direction, full: number, neutral: number) =>
  tfDir === d ? full : tfDir === null ? neutral : 0;

export function scoreDirection(ctx: EngineContext, d: Direction, setups: Setup[], news: NewsState): ScoreBreakdown {
  const notes: string[] = [];
  const mine = setups.filter((s) => s.direction === d);
  const v15 = ctx.tf.M15!, v5 = ctx.tf.M5!;

  // 1) Tendencia y estructura (20)
  let trendStructure = 0;
  trendStructure += trendPts(ctx.tf.D1 ? trendToDir(ctx.tf.D1.trend) : null, d, 5, 2);
  trendStructure += trendPts(ctx.tf.H4 ? trendToDir(ctx.tf.H4.trend) : null, d, 6, 3);
  trendStructure += trendPts(ctx.tf.H1 ? trendToDir(ctx.tf.H1.trend) : null, d, 5, 2);
  const ev15 = lastEventAsOf(v15.a.structure, v15.i, 24);
  if (ev15?.direction === d) trendStructure += 4;
  else if (trendToDir(v15.trend) === d) trendStructure += 2;

  // 2) SMC (20)
  let smc = 0;
  const sweep15 = recentSweep(v15.a.candles, v15.i, 12, (k) => sessionLiquidityBefore(ctx.m15Levels, k), d);
  if (sweep15 || mine.some((s) => s.usedSweep)) { smc += 6; notes.push("Liquidity sweep confirmado"); }
  const ev5 = lastEventAsOf(v5.a.structure, v5.i, 24);
  if (ev5?.direction === d) { smc += ev5.type === "CHOCH" ? 5 : 4; notes.push(`${ev5.type} M5 a favor`); }
  const inZone = [...activeZonesAsOf(v5.a.structure, v5.i, d, 36), ...activeZonesAsOf(v15.a.structure, v15.i, d, 24)].some(
    (z) => ctx.price <= z.top + 0.1 * ctx.atrM15 && ctx.price >= z.bottom - 0.1 * ctx.atrM15,
  );
  if (inZone || mine.some((s) => s.usedZone)) { smc += 5; notes.push("Precio en FVG/OB"); }
  const pos = rangePosition(v15.a.structure, v15.i, ctx.price);
  if (pos !== null) {
    const p = d === "LONG" ? pos : 1 - pos; // 0 = extremo favorable
    if (p >= 0.21 && p <= 0.38) { smc += 4; notes.push("Zona OTE (62–79%)"); }
    else if (p < 0.5) { smc += 3; notes.push(d === "LONG" ? "Discount" : "Premium"); }
  }

  // 3) Confirmación técnica (15): estrategias independientes que coinciden
  const strategies = new Set<StrategyId>(mine.map((s) => s.strategy));
  const technical = Math.min(15, 5 * strategies.size);

  // 4) Liquidez (15)
  let liquidity = 0;
  if (sweep15) liquidity += 7;
  else if (mine.some((s) => s.usedSweep)) liquidity += 4;
  const primary = mine[0];
  const r = primary ? Math.abs(primary.entry - primary.stop) : 1.2 * ctx.atrM15;
  const ahead = ctx.liquidity
    .filter((l) => !l.swept && (d === "LONG" ? l.price > ctx.price : l.price < ctx.price))
    .map((l) => Math.abs(l.price - ctx.price))
    .sort((a, b) => a - b);
  if (ahead.some((x) => x >= 1.5 * r)) liquidity += 4; // existe objetivo de liquidez
  if (!ahead.length || ahead[0] >= 2 * r) { liquidity += 4; } // sin obstáculo antes de 2R
  else notes.push("Liquidez opuesta cercana antes de 2R");

  // 5) Momentum (10)
  let momentum = 0;
  const ind = v15.a.ind, i = v15.i, s = d === "LONG" ? 1 : -1;
  if (s * ind.macdHist[i] > 0) momentum += 2;
  if (s * (ind.macdHist[i] - ind.macdHist[i - 1]) > 0) momentum += 2;
  const rsi = ind.rsi[i];
  const rr = d === "LONG" ? rsi : 100 - rsi;
  if (rr >= 50 && rr <= 70) momentum += 3;
  else if (rr >= 45 && rr < 50) momentum += 1;
  if (ind.adx[i] >= 20 && ind.adx[i] > ind.adx[i - 3]) momentum += 3;
  else if (ind.adx[i] >= 20) momentum += 1;

  // 6) Volatilidad (10)
  let volatility = 0;
  const pct = ctx.atrPctM15;
  if (pct >= 20 && pct <= 85) volatility += 6;
  else if ((pct >= 10 && pct < 20) || (pct > 85 && pct <= 92)) volatility += 3;
  const atrPips = ctx.atrM15 / PIP;
  const sr = ctx.spreadPips / atrPips;
  if (sr <= 0.1) volatility += 4;
  else if (sr <= 0.2) volatility += 2;
  if (ctx.marketState === "HIGH_VOLATILITY") notes.push("Volatilidad extrema");

  // 7) Sesión y noticias (10)
  let sessionNews = 0;
  const a = ctx.session.active;
  if (a.includes("LONDON") || a.includes("NEW_YORK")) sessionNews += 6;
  else if (a.includes("TOKYO")) sessionNews += 3;
  if (!news.nearHighImpact) sessionNews += 4;
  else notes.push("Noticia de alto impacto cercana");

  const total = Math.round(trendStructure + smc + technical + liquidity + momentum + volatility + sessionNews);
  return { trendStructure, smc, technical, liquidity, momentum, volatility, sessionNews, total, notes };
}

export function classify(score: number): { label: string; action: string } {
  if (score >= 90) return { label: "EXCELENTE", action: "ENTRADA PRIORITARIA" };
  if (score >= 80) return { label: "ALTA CALIDAD", action: "POSIBLE ENTRADA" };
  if (score >= 70) return { label: "MODERADA", action: "ESPERAR CONFIRMACIÓN" };
  if (score >= 60) return { label: "DÉBIL", action: "NO OPERAR" };
  return { label: "DESCARTADA", action: "NO OPERAR" };
}

/** ¿Opera contra D1 y H4 a la vez? */
export function isCounterTrend(ctx: EngineContext, d: Direction) {
  const o = opposite(d);
  return (ctx.tf.D1 ? trendToDir(ctx.tf.D1.trend) === o : false) && (ctx.tf.H4 ? trendToDir(ctx.tf.H4.trend) === o : false);
}
