/**
 * Exportador de candidatas para el backtest.
 * Recorre el histórico vela M5 a vela M5 con EL MISMO motor que corre en vivo (sin port a Python → sin divergencias),
 * registra cada candidata por umbral de score y simula su ejecución con varias variantes de salida.
 * Python (research/) aplica umbrales, límites de riesgo, walk-forward, Monte Carlo y ML sobre este archivo.
 *
 * Uso: npx tsx scripts/backtest-export.ts --m5 m5.json [--m1 m1.json] --out candidates.jsonl [--spread 1.1] [--broker EXNESS_STANDARD]
 * Formato de entrada: JSON [{time,open,high,low,close}] con time en segundos UTC (apertura de la vela).
 */
import { readFileSync, createWriteStream } from "node:fs";
import { prepare, contextAt, trendToDir } from "../lib/engine/context";
import { evaluate } from "../lib/engine/signals";
import { newTrade, stepTrade } from "../lib/engine/tradeSim";
import { BROKER_PRESETS, DEFAULT_RISK, DEFAULT_SIGNAL, type SignalConfig } from "../lib/config";
import { TF_SECONDS, type Candle } from "../lib/engine/types";
import { localParts } from "../lib/engine/sessions";

const args = Object.fromEntries(process.argv.slice(2).reduce<[string, string][]>((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []));
const m5: Candle[] = JSON.parse(readFileSync(args.m5, "utf8"));
const m1: Candle[] | null = args.m1 ? JSON.parse(readFileSync(args.m1, "utf8")) : null;
const spread = Number(args.spread ?? 1.1);
const broker = BROKER_PRESETS[args.broker ?? "EXNESS_STANDARD"];
const out = createWriteStream(args.out);

function aggregate(src: Candle[], tf: number, offset = 0): Candle[] {
  const res: Candle[] = [];
  for (const c of src) {
    const t = c.time - ((c.time - offset) % tf + tf) % tf;
    const l = res[res.length - 1];
    if (l && l.time === t) { l.high = Math.max(l.high, c.high); l.low = Math.min(l.low, c.low); l.close = c.close; }
    else res.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close });
  }
  return res;
}

// Serie completa precomputada una vez: todo es causal y contextAt sólo mira velas cerradas a la hora de evaluación.
const all = { M5: m5, M15: aggregate(m5, 900), H1: aggregate(m5, 3600), H4: aggregate(m5, 14400), D1: aggregate(m5, 86400) };
const prepared = prepare(all);
const sim = m1 ?? m5;
const simTf = m1 ? 60 : 300;
const simIdx = (t: number) => { let lo = 0, hi = sim.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sim[m].time < t) lo = m + 1; else hi = m; } return lo; };

/** Variantes de salida a evaluar sin re-correr el motor. */
const EXIT_VARIANTS: Record<string, Partial<SignalConfig>> = {
  base: {},
  tp_1_2_3: { tpR: [1, 2, 3] },
  tp_15_25_4: { tpR: [1.5, 2.5, 4] },
  no_be: { moveToBreakevenAt: "NONE" },
  full_tp2: { partials: [0, 100, 0] },
};
const THRESHOLDS = [60, 65, 70, 75, 80, 85, 90];

// permisivo: el umbral, el duplicado y el riesgo se aplican después en Python
const permissive: SignalConfig = { ...DEFAULT_SIGNAL, minScoreToShow: 0, cooldownMinutes: 0 };
const emitted = new Map<string, Set<number>>();
const warm = 220 * 12; // ~EMA200 H1 de calentamiento en velas M5
let n = 0;
const t0 = Date.now();

for (let i = warm; i < m5.length; i++) {
  const ctx = contextAt(prepared, i, spread);
  if (!ctx || !ctx.tf.D1 || !ctx.tf.H4) continue;
  const res = evaluate({ ctx, news: { blocked: false, nearHighImpact: false }, signalCfg: permissive, broker, riskCfg: DEFAULT_RISK, riskState: null, recentKeys: new Map(), live: false, dataLive: true });
  const s = res.signal;
  if (!s) continue;
  const hard = (s.blockedReasons ?? []).filter((r) => !r.startsWith("Score"));
  const done = emitted.get(s.key) ?? new Set<number>();
  const newTh = THRESHOLDS.filter((t) => s.score >= t && !done.has(t));
  if (!newTh.length) continue;
  newTh.forEach((t) => done.add(t));
  emitted.set(s.key, done);

  // simulación por variante
  const j0 = simIdx(s.createdAt);
  const window = sim.slice(j0, j0 + Math.ceil((24 * 3600) / simTf));
  const outcomes: Record<string, unknown> = {};
  if (!hard.length) {
    for (const [name, v] of Object.entries(EXIT_VARIANTS)) {
      const cfg = { ...DEFAULT_SIGNAL, ...v };
      const R = Math.abs(s.entry - s.stop), sg = s.direction === "LONG" ? 1 : -1;
      const sig2 = { ...s, tp1: s.entry + sg * cfg.tpR[0] * R, tp2: s.entry + sg * cfg.tpR[1] * R, tp3: v.tpR ? s.entry + sg * cfg.tpR[2] * R : s.tp3 };
      const tr = stepTrade(newTrade(sig2, cfg), window, { broker, cfg, spreadPips: spread, tfSec: simTf, atr: ctx.atrM15 });
      outcomes[name] = { status: tr.status, r: tr.resultR, filledAt: tr.filledAt, exitAt: tr.fills.at(-1)?.time ?? null, mfeR: tr.mfeR, maeR: tr.maeR, exits: tr.fills.map((f) => f.reason) };
    }
  }
  const v15 = ctx.tf.M15!;
  const lp = localParts("America/New_York", s.createdAt);
  const rec = {
    key: s.key, time: s.createdAt, thresholds: newTh, direction: s.direction, score: s.score, breakdown: s.scoreBreakdown,
    strategies: s.strategies, entry: s.entry, stop: s.stop, tp3: s.tp3, rrNet: s.rr.netTp2, stopPips: s.sizing?.stopPips ?? Math.abs(s.entry - s.stop) / 0.01,
    orderType: s.orderType, session: ctx.session.label, hard,
    features: {
      atrPct: ctx.atrPctM15, atrM15: ctx.atrM15, adxM15: v15.a.ind.adx[v15.i], adxH1: ctx.tf.H1?.a.ind.adx[ctx.tf.H1.i] ?? null, rsiM15: v15.a.ind.rsi[v15.i],
      macdHistM15: v15.a.ind.macdHist[v15.i], marketState: ctx.marketState, hourNy: lp.hh, weekday: lp.wd,
      d1: trendToDir(ctx.tf.D1!.trend), h4: trendToDir(ctx.tf.H4!.trend), h1: ctx.tf.H1 ? trendToDir(ctx.tf.H1.trend) : null,
      ema50SlopeH1: ctx.tf.H1 ? (ctx.tf.H1.a.ind.ema50[ctx.tf.H1.i] - ctx.tf.H1.a.ind.ema50[ctx.tf.H1.i - 5]) / ctx.atrM15 : null,
    },
    outcomes,
  };
  out.write(JSON.stringify(rec) + "\n");
  n++;
  if (i % 20000 === 0) process.stderr.write(`  ${i}/${m5.length} velas · ${n} candidatas · ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
}
out.end();
process.stderr.write(`listo: ${n} candidatas en ${((Date.now() - t0) / 1000).toFixed(1)} s (sim en ${m1 ? "M1" : "M5"})\n`);
void TF_SECONDS;
