/**
 * SÓLO desarrollo: genera respuestas de API a partir del motor real sobre un histórico local
 * para revisar la interfaz sin Supabase. Uso: npx tsx scripts/ui-fixtures.ts <m5.json> <outDir>
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { prepare, contextAt, analyzeTf } from "../lib/engine/context";
import { evaluate } from "../lib/engine/signals";
import { buildSnapshot } from "../lib/services/cycle";
import { BROKER_PRESETS, DEFAULT_NEWS, DEFAULT_RISK, DEFAULT_SIGNAL } from "../lib/config";
import { emptyRiskState, riskGate } from "../lib/engine/risk";
import { detectSweep, swingLiquidity } from "../lib/engine/structure";
import { computeSessionLevels, sessionLiquidityBefore } from "../lib/engine/sessions";
import type { Candle, Timeframe } from "../lib/engine/types";

const [, , src, outDir] = process.argv;
const m5all: Candle[] = JSON.parse(readFileSync(src, "utf8"));
const agg = (s: Candle[], tf: number) => { const r: Candle[] = []; for (const c of s) { const t = c.time - (c.time % tf); const l = r.at(-1); if (l && l.time === t) { l.high = Math.max(l.high, c.high); l.low = Math.min(l.low, c.low); l.close = c.close; } else r.push({ ...c, time: t }); } return r; };
// buscar un punto con una candidata de score alto para que la UI muestre todo
let end = m5all.length;
const settings = { brokerPreset: "EXNESS_STANDARD", broker: BROKER_PRESETS.EXNESS_STANDARD, risk: DEFAULT_RISK, signal: DEFAULT_SIGNAL, news: DEFAULT_NEWS };
let best: { end: number; score: number } = { end, score: -1 };
const full = { M5: m5all, M15: agg(m5all, 900), H1: agg(m5all, 3600), H4: agg(m5all, 14400), D1: agg(m5all, 86400) };
const P = prepare(full);
for (let i = m5all.length - 1; i > m5all.length - 6000; i--) {
  const ctx = contextAt(P, i, 1.1)!;
  const r = evaluate({ ctx, news: { blocked: false, nearHighImpact: false }, signalCfg: DEFAULT_SIGNAL, broker: settings.broker, riskCfg: DEFAULT_RISK, riskState: null, recentKeys: new Map(), live: false, dataLive: true });
  if (r.signal && !r.signal.blockedReasons?.length && r.signal.score > best.score) best = { end: i + 1, score: r.signal.score };
  if (best.score >= 85) break;
}
end = best.end;
const m5 = m5all.slice(0, end);
const endT = m5.at(-1)!.time + 300;
const cut = (tf: number) => agg(m5, tf).filter((c) => c.time + tf <= endT);
const candles: Partial<Record<Timeframe, Candle[]>> = { M5: m5, M15: cut(900), H1: cut(3600), H4: cut(14400), D1: cut(86400), M1: m5.slice(-60) };
const prepared = prepare(candles);
const ctx = contextAt(prepared, m5.length - 1, 1.1)!;
const risk = emptyRiskState("d", "w");
const result = evaluate({ ctx, news: { blocked: false, nearHighImpact: false }, signalCfg: DEFAULT_SIGNAL, broker: settings.broker, riskCfg: DEFAULT_RISK, riskState: risk, recentKeys: new Map(), live: true, dataLive: true });
const news = [{ id: "n1", time: endT + 5400, currency: "USD", title: "(fixture) Evento de ejemplo", impact: "HIGH" as const, source: "fixture", fetchedAt: endT, alerted: false }];
const snap = buildSnapshot({ now: endT + 20, status: "LIVE", ctx, result, settings, risk, newsState: { blocked: false, nearHighImpact: false, next: { title: news[0].title, time: news[0].time, impact: "HIGH", currency: "USD" } }, news, macro: null, reports: [], errors: [], candles, gate: riskGate(risk, DEFAULT_RISK, endT) });
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/state.json`, JSON.stringify({ snapshot: snap, savedAt: new Date().toISOString(), activeSignals: [], lastRun: { credits_used: 3 } }));
for (const tf of ["M15", "M5", "H1"] as Timeframe[]) {
  const cs = candles[tf]!; const a = analyzeTf(tf, cs); const n = cs.length; const s0 = Math.max(0, n - 250);
  const ser = (arr: number[]) => arr.slice(s0).map((v, k) => ({ time: cs[s0 + k].time, value: Number.isFinite(v) ? v : null }));
  const lv = computeSessionLevels(cs); const sweeps = [];
  for (let k = s0; k < n; k++) { const sw = detectSweep(cs[k], [...sessionLiquidityBefore(lv, k), ...swingLiquidity(a.structure, cs, k, 4)], k); if (sw) sweeps.push({ ...sw, time: cs[k].time }); }
  writeFileSync(`${outDir}/chart-${tf}.json`, JSON.stringify({ tf, fetchedAt: null, candles: cs.slice(s0), sweeps, ema20: ser(a.ind.ema20), ema50: ser(a.ind.ema50), ema200: ser(a.ind.ema200), rsi: ser(a.ind.rsi), macd: ser(a.ind.macd), macdSignal: ser(a.ind.macdSignal), macdHist: ser(a.ind.macdHist), atr: ser(a.ind.atr), events: a.structure.events.filter((e) => e.index >= s0).map((e) => ({ ...e, time: cs[e.index].time })), zones: a.structure.zones.filter((z) => z.createdAt >= s0 && z.mitigatedAt === null && n - 1 - z.createdAt <= 120).slice(-14).map((z) => ({ ...z, fromTime: cs[z.originIndex].time })), trend: a.trend }));
}
console.log("fixtures listos · score", result.signal?.score, result.signal?.direction, result.signal?.blockedReasons);
