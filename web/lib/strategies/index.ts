import type { Candle, Direction, Setup, Sweep } from "../engine/types";
import type { EngineContext } from "../engine/context";
import { opposite, trendToDir } from "../engine/context";
import { activeZonesAsOf, recentSweep, swingLiquidity } from "../engine/structure";
import { sessionLiquidityBefore, localParts, isSessionActive, tradingDayKey } from "../engine/sessions";
import { fmtPrice } from "../format";

const DIRS: Direction[] = ["LONG", "SHORT"];
const body = (c: Candle) => Math.abs(c.close - c.open);
const range = (c: Candle) => c.high - c.low;

/** Liquidez conocida justo antes de la vela M15 k (sesión + swings intactos). */
function m15LevelsBefore(ctx: EngineContext, k: number) {
  const v = ctx.tf.M15!;
  return [...sessionLiquidityBefore(ctx.m15Levels, k), ...swingLiquidity(v.a.structure, v.a.candles, k, 4)];
}

/** Objetivo: nivel de liquidez opuesto más cercano a ≥ minDist de la entrada. */
export function liquidityTarget(ctx: EngineContext, d: Direction, entry: number, minDist: number): { price: number; name: string } | undefined {
  const cands = ctx.liquidity
    .filter((l) => !l.swept && (d === "LONG" ? l.price >= entry + minDist : l.price <= entry - minDist))
    .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  return cands[0] ? { price: cands[0].price, name: cands[0].name } : undefined;
}

/** Desplazamiento (BOS/CHoCH) en M5 en dirección d posterior a un instante. */
function m5ShiftAfter(ctx: EngineContext, d: Direction, afterTime: number) {
  const v5 = ctx.tf.M5!;
  const c5 = v5.a.candles;
  const ev = v5.a.structure.events.filter((e) => e.index <= v5.i && c5[e.index].time >= afterTime && e.direction === d);
  return ev.length ? ev[ev.length - 1] : null;
}

// ───────────────────────── A: ICT / Smart Money ─────────────────────────
export function strategySMC(ctx: EngineContext): Setup[] {
  const v15 = ctx.tf.M15, v5 = ctx.tf.M5;
  if (!v15 || !v5) return [];
  const out: Setup[] = [];
  const c15 = v15.a.candles, c5 = v5.a.candles, i5 = v5.i;
  for (const d of DIRS) {
    const sw = recentSweep(c15, v15.i, 12, (k) => m15LevelsBefore(ctx, k), d);
    if (!sw) continue;
    const sweepTime = c15[sw.index].time;
    const shift = m5ShiftAfter(ctx, d, sweepTime);
    if (!shift) continue;
    const zones = activeZonesAsOf(v5.a.structure, i5, d, 36).filter((z) => c5[z.originIndex].time >= sweepTime && z.createdAt < i5);
    const cur = c5[i5];
    const z = [...zones].reverse().find((z) => (d === "LONG" ? cur.low <= z.top && cur.close >= z.bottom : cur.high >= z.bottom && cur.close <= z.top));
    if (!z) continue;
    const ce = (z.top + z.bottom) / 2;
    const entry = d === "LONG" ? Math.min(ctx.price, z.top) : Math.max(ctx.price, z.bottom);
    out.push({
      strategy: "A_SMC",
      direction: d,
      entry,
      stop: sw.extreme,
      target: liquidityTarget(ctx, d, entry, Math.abs(entry - sw.extreme) * 1.5)?.price,
      timeframe: "M5",
      reasons: [
        `Barrido de liquidez ${sw.levelName} (${fmtPrice(sw.level)}) en M15`,
        `${shift.type} ${d === "LONG" ? "alcista" : "bajista"} en M5 tras el barrido`,
        `Retroceso a ${z.kind} M5 ${fmtPrice(z.bottom)}–${fmtPrice(z.top)} (CE ${fmtPrice(ce)})`,
      ],
      key: `A|${d}|${sweepTime}`,
      invalidation: `Cierre M5 ${d === "LONG" ? "por debajo" : "por encima"} de ${fmtPrice(z.kind === "FVG" ? (d === "LONG" ? z.bottom : z.top) : sw.extreme)} o toque del extremo del barrido`,
      usedSweep: true,
      usedZone: true,
    });
  }
  return out;
}

// ───────────────────────── B: Trend Following ─────────────────────────
export function strategyTrend(ctx: EngineContext): Setup[] {
  const h1 = ctx.tf.H1, h4 = ctx.tf.H4, v15 = ctx.tf.M15, v5 = ctx.tf.M5;
  if (!h1 || !v15 || !v5) return [];
  const d = trendToDir(h1.trend);
  if (!d) return [];
  if (h4 && trendToDir(h4.trend) === opposite(d)) return [];
  if (!(h1.a.ind.adx[h1.i] >= 20)) return [];
  const c = v15.a.candles, ind = v15.a.ind, i = v15.i, atr = ctx.atrM15;
  if (!Number.isFinite(atr)) return [];
  const s = d === "LONG" ? 1 : -1;
  // pullback a EMA20/50 en las últimas 4 velas M15 sin cerrar al otro lado de la EMA50
  let first = -1;
  for (let k = i - 3; k <= i; k++) {
    const touch = d === "LONG" ? c[k].low <= ind.ema20[k] + 0.1 * atr : c[k].high >= ind.ema20[k] - 0.1 * atr;
    const held = s * (c[k].close - ind.ema50[k]) > -0.2 * atr;
    if (touch && held && first < 0) first = k;
    if (!held) return [];
  }
  if (first < 0) return [];
  const r = ind.rsi[i];
  if (d === "LONG" ? !(r >= 40 && r <= 65) : !(r <= 60 && r >= 35)) return [];
  // reanudación en M5: histograma MACD cruza a favor en las últimas 3 velas
  const h = v5.a.ind.macdHist, i5 = v5.i;
  const nowOk = s * h[i5] > 0;
  const wasAgainst = [1, 2, 3].some((j) => s * h[i5 - j] <= 0);
  if (!(nowOk && wasAgainst)) return [];
  let ext = d === "LONG" ? Infinity : -Infinity;
  for (let k = first - 2; k <= i; k++) ext = d === "LONG" ? Math.min(ext, c[k].low) : Math.max(ext, c[k].high);
  const entry = ctx.price;
  return [
    {
      strategy: "B_TREND",
      direction: d,
      entry,
      stop: ext,
      target: liquidityTarget(ctx, d, entry, Math.abs(entry - ext) * 1.5)?.price,
      timeframe: "M5",
      reasons: [
        `Tendencia H1 ${h1.trend} (ADX ${h1.a.ind.adx[h1.i].toFixed(1)})`,
        `Pullback a EMA20/50 en M15, RSI ${r.toFixed(0)}`,
        `MACD M5 reanuda a favor`,
      ],
      key: `B|${d}|${c[first].time}`,
      invalidation: `Cierre M15 ${d === "LONG" ? "bajo" : "sobre"} EMA50 (${fmtPrice(ind.ema50[i])})`,
    },
  ];
}

// ───────────────────────── C: Price Action ─────────────────────────
export function strategyPriceAction(ctx: EngineContext): Setup[] {
  const v15 = ctx.tf.M15, h1 = ctx.tf.H1;
  if (!v15) return [];
  const c = v15.a.candles, i = v15.i, atr = ctx.atrM15;
  if (i < 2 || !Number.isFinite(atr)) return [];
  const x = c[i], p = c[i - 1];
  const levels = [
    ...m15LevelsBefore(ctx, i),
    ...(h1 ? swingLiquidity(h1.a.structure, h1.a.candles, h1.i + 1, 3) : []),
    ...(h1 && Number.isFinite(h1.a.ind.ema50[h1.i]) ? [{ name: "EMA50_H1", price: h1.a.ind.ema50[h1.i] }] : []),
  ];
  const out: Setup[] = [];
  for (const d of DIRS) {
    if (h1 && trendToDir(h1.trend) === opposite(d)) continue;
    const lowerW = Math.min(x.open, x.close) - x.low;
    const upperW = x.high - Math.max(x.open, x.close);
    let pattern = "";
    if (d === "LONG") {
      if (x.close > x.open && p.close < p.open && x.close >= p.open && x.open <= p.close && body(x) >= 0.5 * atr) pattern = "Envolvente alcista";
      else if (lowerW >= 2 * body(x) && lowerW >= 0.55 * range(x) && range(x) >= 0.6 * atr) pattern = "Pin bar alcista";
    } else {
      if (x.close < x.open && p.close > p.open && x.close <= p.open && x.open >= p.close && body(x) >= 0.5 * atr) pattern = "Envolvente bajista";
      else if (upperW >= 2 * body(x) && upperW >= 0.55 * range(x) && range(x) >= 0.6 * atr) pattern = "Pin bar bajista";
    }
    if (!pattern) continue;
    const ext = d === "LONG" ? Math.min(x.low, p.low) : Math.max(x.high, p.high);
    const lvl = levels.find((l) => Math.abs((d === "LONG" ? x.low : x.high) - l.price) <= 0.3 * atr || (d === "LONG" ? x.low < l.price && x.close > l.price : x.high > l.price && x.close < l.price));
    if (!lvl) continue;
    const entry = ctx.price;
    out.push({
      strategy: "C_PRICE_ACTION",
      direction: d,
      entry,
      stop: ext,
      target: liquidityTarget(ctx, d, entry, Math.abs(entry - ext) * 1.5)?.price,
      timeframe: "M15",
      reasons: [`${pattern} en M15`, `Rechazo de ${lvl.name} (${fmtPrice(lvl.price)})`],
      key: `C|${d}|${x.time}`,
      invalidation: `Ruptura de ${fmtPrice(ext)}`,
    });
  }
  return out;
}

// ───────────────────────── D: Liquidity Trading ─────────────────────────
const SESSION_LEVELS = new Set(["ASIA_H", "ASIA_L", "PDH", "PDL", "LON_H", "LON_L"]);
const OPPOSITE_LEVEL: Record<string, string> = { ASIA_L: "ASIA_H", ASIA_H: "ASIA_L", PDL: "PDH", PDH: "PDL", LON_L: "LON_H", LON_H: "LON_L" };

export function strategyLiquidity(ctx: EngineContext): Setup[] {
  const v15 = ctx.tf.M15, v5 = ctx.tf.M5;
  if (!v15 || !v5) return [];
  if (!isSessionActive("LONDON", ctx.time - 1) && !isSessionActive("NEW_YORK", ctx.time - 1)) return [];
  const c15 = v15.a.candles;
  const out: Setup[] = [];
  for (const d of DIRS) {
    const sw: Sweep | null = recentSweep(c15, v15.i, 3, (k) => sessionLiquidityBefore(ctx.m15Levels, k).filter((l) => SESSION_LEVELS.has(l.name)), d);
    if (!sw) continue;
    const shift = m5ShiftAfter(ctx, d, c15[sw.index].time);
    if (!shift) continue;
    const L = ctx.m15Levels[v15.i];
    const oppName = OPPOSITE_LEVEL[sw.levelName];
    const oppMap: Record<string, number | null> = { ASIA_H: L.asiaH, ASIA_L: L.asiaL, PDH: L.pdh, PDL: L.pdl, LON_H: L.lonH, LON_L: L.lonL };
    const entry = ctx.price;
    const opp = oppMap[oppName];
    const target = opp !== null && opp !== undefined && (d === "LONG" ? opp > entry : opp < entry) ? opp : liquidityTarget(ctx, d, entry, Math.abs(entry - sw.extreme))?.price;
    out.push({
      strategy: "D_LIQUIDITY",
      direction: d,
      entry,
      stop: sw.extreme,
      target,
      timeframe: "M5",
      reasons: [
        `Stop hunt de ${sw.levelName} (${fmtPrice(sw.level)}) y cierre de vuelta dentro`,
        `${shift.type} M5 confirma el rechazo`,
        target ? `Objetivo: liquidez opuesta ${fmtPrice(target)}` : "Sin objetivo de liquidez claro",
      ],
      key: `D|${d}|${sw.levelName}|${tradingDayKey(ctx.time)}`,
      invalidation: `Nuevo extremo más allá de ${fmtPrice(sw.extreme)}`,
      usedSweep: true,
    });
  }
  return out;
}

// ───────────────────────── E: Volatility Breakout ─────────────────────────
export function strategyBreakout(ctx: EngineContext): Setup[] {
  const v15 = ctx.tf.M15, d1 = ctx.tf.D1, h1 = ctx.tf.H1;
  if (!v15) return [];
  const c = v15.a.candles, i = v15.i, atr = ctx.atrM15;
  if (!Number.isFinite(atr) || i < 10) return [];
  const t = c[i].time;
  const lon = localParts("Europe/London", t).minutes;
  const ny = localParts("America/New_York", t).minutes;
  let hi: number | null = null, lo: number | null = null, label = "";
  if (lon >= 8 * 60 && lon < 10 * 60 + 30) {
    const L = ctx.m15Levels[i - 1];
    if (!L?.asiaComplete || L.asiaH === null || L.asiaL === null) return [];
    hi = L.asiaH; lo = L.asiaL; label = "rango asiático";
    const atrD = d1 ? d1.a.ind.atr[d1.i] : NaN;
    if (Number.isFinite(atrD) && (hi - lo) / atrD > 0.6) return []; // no hubo compresión
  } else if (ny >= 8 * 60 && ny < 10 * 60 + 30) {
    hi = -Infinity; lo = Infinity;
    for (let k = i - 8; k < i; k++) { hi = Math.max(hi, c[k].high); lo = Math.min(lo, c[k].low); }
    label = "rango pre-NY (2h)";
    const atrH = h1 ? h1.a.ind.atr[h1.i] : NaN;
    if (Number.isFinite(atrH) && (hi - lo) / atrH > 2) return [];
  } else return [];
  const width = hi - lo;
  const x = c[i];
  const out: Setup[] = [];
  const expansion = range(x) >= 1.2 * atr;
  // primera ruptura: ninguna vela previa del tramo cerró fuera
  const firstBreak = (above: boolean) => {
    for (let k = i - 1; k >= Math.max(0, i - 10); k--) if (above ? c[k].close > hi! : c[k].close < lo!) return false;
    return true;
  };
  if (expansion && x.close > hi + 0.1 * atr && firstBreak(true)) {
    const entry = Math.max(hi + 0.1 * atr, Math.min(ctx.price, x.close));
    out.push(mkBreak("LONG", entry, (hi + lo) / 2, hi + width, label, hi, x.time));
  }
  if (expansion && x.close < lo - 0.1 * atr && firstBreak(false)) {
    const entry = Math.min(lo - 0.1 * atr, Math.max(ctx.price, x.close));
    out.push(mkBreak("SHORT", entry, (hi + lo) / 2, lo - width, label, lo, x.time));
  }
  return out;

  function mkBreak(d: Direction, entry: number, stop: number, target: number, lbl: string, lvl: number, time: number): Setup {
    return {
      strategy: "E_BREAKOUT",
      direction: d,
      entry,
      stop,
      target,
      timeframe: "M15",
      reasons: [`Compresión y ruptura del ${lbl} (${fmtPrice(lvl)})`, `Vela de expansión ${(range(x) / atr).toFixed(1)}× ATR M15`],
      key: `E|${d}|${time}`,
      invalidation: `Cierre M15 de vuelta dentro del rango (${fmtPrice(lvl)})`,
    };
  }
}

export const STRATEGIES = [strategySMC, strategyTrend, strategyPriceAction, strategyLiquidity, strategyBreakout];

export function runStrategies(ctx: EngineContext): Setup[] {
  const out: Setup[] = [];
  for (const s of STRATEGIES) {
    try {
      out.push(...s(ctx));
    } catch (e) {
      // una estrategia con error no debe tumbar el ciclo
      console.error(`[strategy] ${s.name}`, e);
    }
  }
  // descarta setups con stop del lado equivocado
  return out.filter((s) => (s.direction === "LONG" ? s.stop < s.entry : s.stop > s.entry));
}
