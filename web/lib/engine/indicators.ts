import type { Candle, IndicatorSet } from "./types";

/** Todas las funciones son causales: out[i] depende sólo de datos ≤ i. NaN durante el calentamiento. */

export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** EMA que tolera NaN iniciales (para la señal del MACD). */
function emaFromFirstValid(values: number[], period: number): number[] {
  const first = values.findIndex((v) => !Number.isNaN(v));
  const out = new Array<number>(values.length).fill(NaN);
  if (first < 0) return out;
  const sub = ema(values.slice(first), period);
  for (let i = 0; i < sub.length; i++) out[first + i] = sub[i];
  return out;
}

/** Suavizado de Wilder (RMA) iniciado con media simple. */
function rma(values: number[], period: number, start = 0): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length - start < period) return out;
  let sum = 0;
  for (let i = start; i < start + period; i++) sum += values[i];
  let prev = sum / period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function rsi(closes: number[], period = 14): number[] {
  const n = closes.length;
  const out = new Array<number>(n).fill(NaN);
  if (n <= period) return out;
  const gains = new Array<number>(n).fill(0);
  const losses = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    gains[i] = d > 0 ? d : 0;
    losses[i] = d < 0 ? -d : 0;
  }
  const ag = rma(gains, period, 1);
  const al = rma(losses, period, 1);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(ag[i])) continue;
    out[i] = al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i]);
  }
  return out;
}

export function trueRange(c: Candle[]): number[] {
  return c.map((x, i) =>
    i === 0
      ? x.high - x.low
      : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)),
  );
}

export function atr(c: Candle[], period = 14): number[] {
  return rma(trueRange(c), period, 1);
}

export function macd(closes: number[], fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = closes.map((_, i) => ef[i] - es[i]);
  const sig = emaFromFirstValid(line, signal);
  const hist = line.map((v, i) => v - sig[i]);
  return { line, signal: sig, hist };
}

export function adx(c: Candle[], period = 14) {
  const n = c.length;
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = c[i].high - c[i - 1].high;
    const down = c[i - 1].low - c[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = trueRange(c);
  const atrS = rma(tr, period, 1);
  const pS = rma(plusDM, period, 1);
  const mS = rma(minusDM, period, 1);
  const plusDI = new Array<number>(n).fill(NaN);
  const minusDI = new Array<number>(n).fill(NaN);
  const dx = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(atrS[i]) || atrS[i] === 0) continue;
    plusDI[i] = (100 * pS[i]) / atrS[i];
    minusDI[i] = (100 * mS[i]) / atrS[i];
    const s = plusDI[i] + minusDI[i];
    dx[i] = s === 0 ? 0 : (100 * Math.abs(plusDI[i] - minusDI[i])) / s;
  }
  const firstDx = dx.findIndex((v) => !Number.isNaN(v));
  const adxS = firstDx < 0 ? new Array<number>(n).fill(NaN) : rma(dx.map((v) => (Number.isNaN(v) ? 0 : v)), period, firstDx);
  return { adx: adxS, plusDI, minusDI };
}

/** Percentil (0–100) del valor actual dentro de una ventana móvil — causal. */
export function rollingPercentile(values: number[], window: number): number[] {
  return values.map((v, i) => {
    if (Number.isNaN(v) || i < window - 1) return NaN;
    let below = 0;
    let count = 0;
    for (let j = i - window + 1; j <= i; j++) {
      if (Number.isNaN(values[j])) continue;
      count++;
      if (values[j] <= v) below++;
    }
    return count ? (100 * below) / count : NaN;
  });
}

export function computeIndicators(c: Candle[]): IndicatorSet {
  const closes = c.map((x) => x.close);
  const m = macd(closes);
  const a = adx(c);
  return {
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi: rsi(closes),
    macd: m.line,
    macdSignal: m.signal,
    macdHist: m.hist,
    atr: atr(c),
    adx: a.adx,
    plusDI: a.plusDI,
    minusDI: a.minusDI,
  };
}

export const last = <T,>(a: T[]): T => a[a.length - 1];
export const isNum = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);
