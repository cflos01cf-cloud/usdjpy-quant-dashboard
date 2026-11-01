import type { Candle, Timeframe } from "../engine/types";

const INTERVAL: Record<Timeframe, string> = { M1: "1min", M5: "5min", M15: "15min", H1: "1h", H4: "4h", D1: "1day" };
const BASE = "https://api.twelvedata.com";

export class DataProviderError extends Error {
  constructor(msg: string, public code?: number) {
    super(msg);
  }
}

interface TdValue { datetime: string; open: string; high: string; low: string; close: string; volume?: string }

/** Velas OHLC de TwelveData en UTC, orden ascendente. Lanza error si no hay datos: nunca simula. */
export async function fetchCandles(tf: Timeframe, outputsize: number, apiKey: string, opts: { endDate?: string; signal?: AbortSignal } = {}): Promise<Candle[]> {
  const u = new URL(`${BASE}/time_series`);
  u.searchParams.set("symbol", "USD/JPY");
  u.searchParams.set("interval", INTERVAL[tf]);
  u.searchParams.set("outputsize", String(outputsize));
  u.searchParams.set("timezone", "UTC");
  u.searchParams.set("order", "ASC");
  u.searchParams.set("apikey", apiKey);
  if (opts.endDate) u.searchParams.set("end_date", opts.endDate);
  const res = await fetchWithRetry(u.toString(), opts.signal);
  const j = await res.json();
  if (j.status === "error") throw new DataProviderError(`TwelveData ${tf}: ${j.message}`, j.code);
  const vals: TdValue[] = j.values ?? [];
  if (!vals.length) throw new DataProviderError(`TwelveData ${tf}: respuesta sin velas`);
  return vals.map((v) => ({
    time: Math.floor(Date.parse(v.datetime.replace(" ", "T") + (v.datetime.length <= 10 ? "T00:00:00Z" : "Z")) / 1000),
    open: +v.open,
    high: +v.high,
    low: +v.low,
    close: +v.close,
    volume: v.volume ? +v.volume : undefined,
  }));
}

/** Reintento con backoff para errores de red y 429 (reconexión automática). */
async function fetchWithRetry(url: string, signal?: AbortSignal, attempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal, cache: "no-store" });
      if (res.status === 429) throw new DataProviderError("Límite de créditos TwelveData (429)", 429);
      if (!res.ok) throw new DataProviderError(`HTTP ${res.status}`, res.status);
      return res;
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) break;
      await new Promise((r) => setTimeout(r, 800 * 2 ** i));
    }
  }
  throw lastErr instanceof Error ? lastErr : new DataProviderError(String(lastErr));
}
