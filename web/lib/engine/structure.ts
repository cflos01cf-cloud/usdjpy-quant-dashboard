import type { Candle, Direction, StructureEvent, StructureState, SwingPoint, Trend, Zone, Sweep } from "./types";

/**
 * Smart Money Concepts — implementación causal.
 * Un swing con `lookback` velas a cada lado sólo se conoce en index + lookback.
 */
export function findSwings(c: Candle[], lookback: number): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = lookback; i < c.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      // estricto a la izquierda, >= a la derecha → en empates se queda el primero
      if (!(c[i].high > c[i - j].high && c[i].high >= c[i + j].high)) isHigh = false;
      if (!(c[i].low < c[i - j].low && c[i].low <= c[i + j].low)) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ index: i, confirmedAt: i + lookback, price: c[i].high, kind: "HIGH" });
    if (isLow) out.push({ index: i, confirmedAt: i + lookback, price: c[i].low, kind: "LOW" });
  }
  return out.sort((a, b) => a.confirmedAt - b.confirmedAt || a.index - b.index);
}

export function computeStructure(c: Candle[], atr: number[], lookback = 3, fvgMinAtr = 0.1): StructureState {
  const swings = findSwings(c, lookback);
  const events: StructureEvent[] = [];
  const trend: Trend[] = new Array(c.length).fill("NEUTRAL");
  const zones: Zone[] = [];

  let cur: Trend = "NEUTRAL";
  let lastHigh: SwingPoint | null = null;
  let lastLow: SwingPoint | null = null;
  let highBroken = true;
  let lowBroken = true;
  let si = 0;

  for (let k = 0; k < c.length; k++) {
    while (si < swings.length && swings[si].confirmedAt <= k) {
      const s = swings[si++];
      if (s.kind === "HIGH") {
        lastHigh = s;
        highBroken = false;
      } else {
        lastLow = s;
        lowBroken = false;
      }
    }
    if (lastHigh && !highBroken && c[k].close > lastHigh.price) {
      const type = cur === "BEARISH" ? "CHOCH" : "BOS";
      events.push({ index: k, type, direction: "LONG", level: lastHigh.price, swingIndex: lastHigh.index });
      highBroken = true;
      cur = "BULLISH";
      const ob = findOrderBlock(c, k, "LONG", lastLow?.index ?? Math.max(0, k - 30));
      if (ob) zones.push(ob);
    } else if (lastLow && !lowBroken && c[k].close < lastLow.price) {
      const type = cur === "BULLISH" ? "CHOCH" : "BOS";
      events.push({ index: k, type, direction: "SHORT", level: lastLow.price, swingIndex: lastLow.index });
      lowBroken = true;
      cur = "BEARISH";
      const ob = findOrderBlock(c, k, "SHORT", lastHigh?.index ?? Math.max(0, k - 30));
      if (ob) zones.push(ob);
    }
    trend[k] = cur;
  }

  // Fair Value Gaps (3 velas). Conocido al cierre de la tercera vela.
  for (let i = 2; i < c.length; i++) {
    const a = atr[i];
    const minGap = Number.isFinite(a) ? a * fvgMinAtr : 0;
    if (c[i].low > c[i - 2].high && c[i].low - c[i - 2].high >= minGap) {
      zones.push(mkZone("FVG", "LONG", c[i].low, c[i - 2].high, i, i - 1));
    }
    if (c[i].high < c[i - 2].low && c[i - 2].low - c[i].high >= minGap) {
      zones.push(mkZone("FVG", "SHORT", c[i - 2].low, c[i].high, i, i - 1));
    }
  }

  // Mitigación / toque — causal porque se registra el índice y se compara al consultar.
  for (const z of zones) {
    for (let k = z.createdAt + 1; k < c.length; k++) {
      if (z.touchedAt === null && (z.direction === "LONG" ? c[k].low <= z.top : c[k].high >= z.bottom)) z.touchedAt = k;
      if (z.direction === "LONG" ? c[k].close < z.bottom : c[k].close > z.top) {
        z.mitigatedAt = k;
        break;
      }
    }
  }
  return { swings, events, zones, trend };
}

function mkZone(kind: Zone["kind"], direction: Direction, top: number, bottom: number, createdAt: number, originIndex: number): Zone {
  return { kind, direction, top, bottom, createdAt, originIndex, mitigatedAt: null, touchedAt: null };
}

/** Última vela opuesta antes del desplazamiento que produjo la ruptura. */
function findOrderBlock(c: Candle[], breakIdx: number, dir: Direction, fromIdx: number): Zone | null {
  for (let j = breakIdx - 1; j >= Math.max(fromIdx, breakIdx - 30); j--) {
    const bearish = c[j].close < c[j].open;
    const bullish = c[j].close > c[j].open;
    if (dir === "LONG" && bearish) return mkZone("OB", "LONG", c[j].high, c[j].low, breakIdx, j);
    if (dir === "SHORT" && bullish) return mkZone("OB", "SHORT", c[j].high, c[j].low, breakIdx, j);
  }
  return null;
}

// ───────────────────────── Consultas "as-of" ─────────────────────────

export function swingsAsOf(s: StructureState, t: number): SwingPoint[] {
  return s.swings.filter((x) => x.confirmedAt <= t);
}

export function lastEventAsOf(s: StructureState, t: number, withinBars = Infinity): StructureEvent | null {
  for (let i = s.events.length - 1; i >= 0; i--) {
    const e = s.events[i];
    if (e.index <= t) return t - e.index <= withinBars ? e : null;
  }
  return null;
}

export function activeZonesAsOf(s: StructureState, t: number, dir?: Direction, maxAge = 60): Zone[] {
  return s.zones.filter(
    (z) =>
      z.createdAt <= t &&
      t - z.createdAt <= maxAge &&
      (z.mitigatedAt === null || z.mitigatedAt > t) &&
      (!dir || z.direction === dir),
  );
}

/** ¿La vela t está dentro (o tocó) una zona activa en la dirección dada? */
export function priceInZone(s: StructureState, c: Candle[], t: number, dir: Direction): Zone | null {
  const zs = activeZonesAsOf(s, t, dir).filter((z) => z.createdAt < t);
  // preferir la más reciente
  for (let i = zs.length - 1; i >= 0; i--) {
    const z = zs[i];
    if (dir === "LONG" ? c[t].low <= z.top && c[t].close >= z.bottom : c[t].high >= z.bottom && c[t].close <= z.top) return z;
  }
  return null;
}

/** Rango de negociación vigente: último swing high y low confirmados. */
export function dealingRange(s: StructureState, t: number): { high: number; low: number; mid: number } | null {
  const sw = swingsAsOf(s, t);
  let h: SwingPoint | undefined;
  let l: SwingPoint | undefined;
  for (let i = sw.length - 1; i >= 0 && (!h || !l); i--) {
    if (!h && sw[i].kind === "HIGH") h = sw[i];
    if (!l && sw[i].kind === "LOW") l = sw[i];
  }
  if (!h || !l || h.price <= l.price) return null;
  return { high: h.price, low: l.price, mid: (h.price + l.price) / 2 };
}

/** 0 = en el mínimo del rango, 1 = en el máximo. <0.5 discount, >0.5 premium. */
export function rangePosition(s: StructureState, t: number, price: number): number | null {
  const r = dealingRange(s, t);
  if (!r) return null;
  return (price - r.low) / (r.high - r.low);
}

/** Equal highs/lows: dos swings confirmados dentro de `tol` y aún no superados. */
export function equalLevels(s: StructureState, c: Candle[], t: number, tol: number, lookbackSwings = 12) {
  const sw = swingsAsOf(s, t).slice(-lookbackSwings * 2);
  const out: { kind: "EQH" | "EQL"; price: number }[] = [];
  const highs = sw.filter((x) => x.kind === "HIGH");
  const lows = sw.filter((x) => x.kind === "LOW");
  const maxSince = (from: number, f: (k: Candle) => number, cmp: (a: number, b: number) => number) => {
    let m = f(c[from]);
    for (let k = from; k <= t; k++) m = cmp(m, f(c[k]));
    return m;
  };
  for (let i = 0; i < highs.length; i++)
    for (let j = i + 1; j < highs.length; j++) {
      if (Math.abs(highs[i].price - highs[j].price) <= tol) {
        const lvl = Math.max(highs[i].price, highs[j].price);
        if (maxSince(highs[j].index + 1, (k) => k.high, Math.max) <= lvl) out.push({ kind: "EQH", price: lvl });
      }
    }
  for (let i = 0; i < lows.length; i++)
    for (let j = i + 1; j < lows.length; j++) {
      if (Math.abs(lows[i].price - lows[j].price) <= tol) {
        const lvl = Math.min(lows[i].price, lows[j].price);
        if (maxSince(lows[j].index + 1, (k) => k.low, Math.min) >= lvl) out.push({ kind: "EQL", price: lvl });
      }
    }
  return out;
}

/**
 * Barrido de liquidez en la vela t: mecha atraviesa el nivel y el cierre vuelve dentro.
 * LONG = barrió mínimos (sell-side) → sesgo alcista.
 */
export function detectSweep(candle: Candle, levels: { name: string; price: number }[], index: number): Sweep | null {
  let best: Sweep | null = null;
  for (const l of levels) {
    if (candle.low < l.price && candle.close > l.price) {
      const s: Sweep = { index, direction: "LONG", level: l.price, levelName: l.name, extreme: candle.low };
      if (!best || l.price - candle.low > Math.abs(best.level - best.extreme)) best = s;
    }
    if (candle.high > l.price && candle.close < l.price) {
      const s: Sweep = { index, direction: "SHORT", level: l.price, levelName: l.name, extreme: candle.high };
      if (!best || candle.high - l.price > Math.abs(best.level - best.extreme)) best = s;
    }
  }
  return best;
}

/** Barrido reciente: busca en las últimas `within` velas hasta t. */
export function recentSweep(
  c: Candle[],
  t: number,
  within: number,
  levelsAt: (k: number) => { name: string; price: number }[],
  dir?: Direction,
): Sweep | null {
  for (let k = t; k >= Math.max(0, t - within + 1); k--) {
    const s = detectSweep(c[k], levelsAt(k), k);
    if (s && (!dir || s.direction === dir)) return s;
  }
  return null;
}

/** Swings recientes como niveles de liquidez (as-of t, sin romper). */
export function swingLiquidity(s: StructureState, c: Candle[], t: number, count = 4) {
  const sw = swingsAsOf(s, t).slice(-count * 3);
  const out: { name: string; price: number }[] = [];
  for (const x of sw) {
    let intact = true;
    for (let k = x.index + 1; k < t; k++) {
      if (x.kind === "HIGH" ? c[k].high > x.price : c[k].low < x.price) {
        intact = false;
        break;
      }
    }
    if (intact) out.push({ name: x.kind === "HIGH" ? "SWING_H" : "SWING_L", price: x.price });
  }
  return out.slice(-count * 2);
}
