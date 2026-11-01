import { computeIndicators, rollingPercentile } from "./indicators";
import { computeStructure, swingLiquidity } from "./structure";
import { computeSessionLevels, sessionInfo, type SessionLevels } from "./sessions";
import type { Candle, Direction, MarketState, TfAnalysis, Timeframe, Trend, SessionInfo, LiquidityLevel } from "./types";
import { TF_SECONDS } from "./types";

export const SWING_LOOKBACK: Record<Timeframe, number> = { D1: 2, H4: 2, H1: 3, M15: 3, M5: 3, M1: 3 };

export function analyzeTf(tf: Timeframe, candles: Candle[]): TfAnalysis {
  const ind = computeIndicators(candles);
  const structure = computeStructure(candles, ind.atr, SWING_LOOKBACK[tf]);
  const i = candles.length - 1;
  const emaTrend = emaTrendAt(candles, ind, i);
  const structureTrend = structure.trend[i] ?? "NEUTRAL";
  return { tf, candles, ind, structure, emaTrend, structureTrend, trend: combineTrend(emaTrend, structureTrend) };
}

export function emaTrendAt(c: Candle[], ind: TfAnalysis["ind"], i: number): Trend {
  const p = c[i]?.close;
  const e20 = ind.ema20[i], e50 = ind.ema50[i], e200 = ind.ema200[i];
  if (![p, e20, e50].every(Number.isFinite)) return "NEUTRAL";
  const longOk = p > e50 && e20 > e50 && (!Number.isFinite(e200) || e50 > e200);
  const shortOk = p < e50 && e20 < e50 && (!Number.isFinite(e200) || e50 < e200);
  return longOk ? "BULLISH" : shortOk ? "BEARISH" : "NEUTRAL";
}

export function combineTrend(a: Trend, b: Trend): Trend {
  if (a === b) return a;
  if (a === "NEUTRAL") return b;
  if (b === "NEUTRAL") return a;
  return "NEUTRAL";
}

export const trendToDir = (t: Trend): Direction | null => (t === "BULLISH" ? "LONG" : t === "BEARISH" ? "SHORT" : null);
export const opposite = (d: Direction): Direction => (d === "LONG" ? "SHORT" : "LONG");
export const sign = (d: Direction) => (d === "LONG" ? 1 : -1);

/** Índice de la última vela de `htf` ya CERRADA en el instante `closeTime`. */
export function alignIndex(c: Candle[], tfSec: number, closeTime: number): number {
  let lo = 0, hi = c.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c[mid].time + tfSec <= closeTime) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export interface TfView {
  a: TfAnalysis;
  i: number; // índice evaluado (última vela cerrada a la hora de evaluación)
  trend: Trend;
}

export interface EngineContext {
  time: number; // cierre de la vela base evaluada (UTC s)
  price: number;
  tf: Partial<Record<Timeframe, TfView>>;
  m15Levels: SessionLevels[];
  m5Levels: SessionLevels[];
  session: SessionInfo;
  atrM15: number;
  atrM5: number;
  atrPctM15: number;
  atrPctSeriesM15: number[];
  marketState: MarketState;
  liquidity: LiquidityLevel[];
  spreadPips: number;
}

/** Análisis completo precomputado (se reutiliza en cada paso del backtest). */
export interface Prepared {
  a: Partial<Record<Timeframe, TfAnalysis>>;
  m15Levels: SessionLevels[];
  m5Levels: SessionLevels[];
  atrPctM15: number[];
}

export function prepare(candles: Partial<Record<Timeframe, Candle[]>>): Prepared {
  const a: Prepared["a"] = {};
  for (const tf of Object.keys(candles) as Timeframe[]) {
    const cs = candles[tf];
    if (cs && cs.length) a[tf] = analyzeTf(tf, cs);
  }
  return {
    a,
    m15Levels: a.M15 ? computeSessionLevels(a.M15.candles) : [],
    m5Levels: a.M5 ? computeSessionLevels(a.M5.candles) : [],
    atrPctM15: a.M15 ? rollingPercentile(a.M15.ind.atr, 200) : [],
  };
}

/** Construye el contexto al cierre de la vela M5 `i5` usando sólo información disponible entonces. */
export function contextAt(p: Prepared, i5: number, spreadPips: number, livePrice?: number): EngineContext | null {
  const m5 = p.a.M5;
  const m15 = p.a.M15;
  if (!m5 || !m15) return null;
  const time = m5.candles[i5].time + TF_SECONDS.M5;
  const tf: EngineContext["tf"] = {};
  for (const k of Object.keys(p.a) as Timeframe[]) {
    const an = p.a[k]!;
    const i = k === "M5" ? i5 : alignIndex(an.candles, TF_SECONDS[k], time);
    if (i < 0) continue;
    const et = emaTrendAt(an.candles, an.ind, i);
    tf[k] = { a: an, i, trend: combineTrend(et, an.structure.trend[i]) };
  }
  const v15 = tf.M15;
  if (!v15) return null;
  const i15 = v15.i;
  const atrM15 = m15.ind.atr[i15];
  const atrM5 = m5.ind.atr[i5];
  const price = livePrice ?? m5.candles[i5].close;
  const atrPct = p.atrPctM15[i15];

  // estado de mercado
  const adxH1 = tf.H1 ? tf.H1.a.ind.adx[tf.H1.i] : NaN;
  const adx15 = m15.ind.adx[i15];
  let marketState: MarketState = "RANGING";
  if (Number.isFinite(atrPct) && atrPct >= 92) marketState = "HIGH_VOLATILITY";
  else if ((adxH1 >= 25 && tf.H1?.trend !== "NEUTRAL") || (adx15 >= 25 && v15.trend !== "NEUTRAL")) marketState = "TRENDING";

  // liquidez pendiente
  const L = p.m15Levels[i15];
  const raw: { name: string; price: number }[] = [];
  if (L) {
    if (L.pdh !== null) raw.push({ name: "PDH", price: L.pdh });
    if (L.pdl !== null) raw.push({ name: "PDL", price: L.pdl });
    if (L.asiaComplete && L.asiaH !== null && L.asiaL !== null) raw.push({ name: "ASIA_H", price: L.asiaH }, { name: "ASIA_L", price: L.asiaL });
    if (L.lonComplete && L.lonH !== null && L.lonL !== null) raw.push({ name: "LON_H", price: L.lonH }, { name: "LON_L", price: L.lonL });
  }
  raw.push(...swingLiquidity(m15.structure, m15.candles, i15 + 1, 4));
  if (tf.H1) raw.push(...swingLiquidity(tf.H1.a.structure, tf.H1.a.candles, tf.H1.i + 1, 3).map((x) => ({ ...x, name: `H1_${x.name}` })));
  const dayH = L?.dayH ?? -Infinity, dayL = L?.dayL ?? Infinity;
  const liquidity: LiquidityLevel[] = raw.map((x) => ({
    name: x.name,
    price: x.price,
    side: x.price > price ? "BUY_SIDE" : "SELL_SIDE",
    swept: (x.name === "PDH" && dayH > x.price) || (x.name === "PDL" && dayL < x.price),
  }));

  return {
    time,
    price,
    tf,
    m15Levels: p.m15Levels,
    m5Levels: p.m5Levels,
    session: sessionInfo(time, false),
    atrM15,
    atrM5,
    atrPctM15: atrPct,
    atrPctSeriesM15: p.atrPctM15,
    marketState,
    liquidity,
    spreadPips,
  };
}
