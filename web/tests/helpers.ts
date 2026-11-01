import type { Candle } from "../lib/engine/types";

/** Generador determinista SÓLO para pruebas unitarias (nunca se usa en vivo). */
export function synthCandles(n: number, tfSec: number, start = Date.UTC(2026, 0, 5, 0, 0) / 1000, seed = 7, p0 = 150): Candle[] {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const out: Candle[] = [];
  let p = p0;
  let drift = 0;
  for (let i = 0; i < n; i++) {
    if (i % 120 === 0) drift = (rnd() - 0.5) * 0.004;
    const o = p;
    const c = o + drift + (rnd() - 0.5) * 0.06;
    const h = Math.max(o, c) + rnd() * 0.03;
    const l = Math.min(o, c) - rnd() * 0.03;
    out.push({ time: start + i * tfSec, open: o, high: h, low: l, close: c });
    p = c;
  }
  return out;
}

export function fromCloses(closes: number[], tfSec = 900, start = Date.UTC(2026, 0, 5) / 1000, wick = 0.01): Candle[] {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { time: start + i * tfSec, open: o, close: c, high: Math.max(o, c) + wick, low: Math.min(o, c) - wick };
  });
}
