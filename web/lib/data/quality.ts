import { TF_SECONDS, type Candle, type DataStatus, type Timeframe } from "../engine/types";
import { isMarketClosed } from "../engine/sessions";

export interface QualityReport {
  tf: Timeframe;
  received: number;
  kept: number;
  droppedInvalid: number;
  droppedDuplicates: number;
  droppedForming: number;
  gaps: number; // huecos > 1 vela fuera de fin de semana
  lastClose: number | null; // hora de cierre de la última vela cerrada
  issues: string[];
}

/** Limpia y valida velas. Elimina la vela en formación (cierre > ahora). */
export function validateCandles(tf: Timeframe, raw: Candle[], now: number): { candles: Candle[]; report: QualityReport } {
  const sec = TF_SECONDS[tf];
  const issues: string[] = [];
  let invalid = 0, dups = 0, forming = 0, gaps = 0;
  const sorted = [...raw].sort((a, b) => a.time - b.time);
  const out: Candle[] = [];
  for (const c of sorted) {
    const ok = [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 50 && v < 400) &&
      c.high >= Math.max(c.open, c.close) - 1e-9 && c.low <= Math.min(c.open, c.close) + 1e-9;
    if (!ok) { invalid++; continue; }
    if (out.length && out[out.length - 1].time === c.time) { dups++; out[out.length - 1] = c; continue; }
    if (c.time + sec > now) { forming++; continue; }
    if (out.length && tf !== "D1") {
      const prev = out[out.length - 1];
      const missing = Math.round((c.time - prev.time) / sec) - 1;
      if (missing > 0 && !isMarketClosed(prev.time + sec)) gaps++;
    }
    out.push(c);
  }
  if (invalid) issues.push(`${invalid} velas con OHLC inválido descartadas`);
  if (dups) issues.push(`${dups} duplicados`);
  if (gaps > 3) issues.push(`${gaps} huecos en la serie`);
  // salto de precio anómalo (> 2% en una vela intradía) → posible dato corrupto
  for (let i = 1; i < out.length; i++) {
    if (tf !== "D1" && Math.abs(out[i].close / out[i - 1].close - 1) > 0.02) {
      issues.push(`Salto anómalo ${new Date(out[i].time * 1000).toISOString()}`);
      break;
    }
  }
  const lastC = out.length ? out[out.length - 1].time + sec : null;
  return {
    candles: out,
    report: { tf, received: raw.length, kept: out.length, droppedInvalid: invalid, droppedDuplicates: dups, droppedForming: forming, gaps, lastClose: lastC, issues },
  };
}

/**
 * LIVE: la última vela M1 cerrada terminó hace ≤ 150 s.
 * DELAYED: hay datos pero con retraso. MARKET_CLOSED: fin de semana FX.
 */
export function dataStatus(m1LastClose: number | null, now: number): DataStatus {
  if (isMarketClosed(now)) return "MARKET_CLOSED";
  if (m1LastClose === null) return "NO_DATA";
  const lag = now - m1LastClose;
  if (lag <= 150) return "LIVE";
  return "DELAYED";
}
