import { FETCH_PLAN, ENGINE_WINDOW_UTC, PIP } from "../config";
import { TF_SECONDS, type Candle, type DataStatus, type Signal, type Timeframe } from "../engine/types";
import { fetchCandles } from "../data/twelvedata";
import { validateCandles, dataStatus, type QualityReport } from "../data/quality";
import { prepare, contextAt, trendToDir, type EngineContext } from "../engine/context";
import { evaluate, type EvaluationResult } from "../engine/signals";
import { applyClosedTrade, emptyRiskState, riskGate, type RiskState } from "../engine/risk";
import { newTrade, stepTrade, type TradeState } from "../engine/tradeSim";
import { isMarketClosed, localParts, sessionInfo, sessionScheduleCdmx, tradingDayKey, nextLocalTimeUtc } from "../engine/sessions";
import { lastEventAsOf } from "../engine/structure";
import { db, must } from "./db";
import { loadSettings, type Settings } from "./settings";
import { loadNews, newsStateAt, refreshNews } from "./news";
import { loadMacro } from "./macro";
import { sendTelegram, signalMessage, eventMessage, plainMessage } from "./telegram";

const ALL_TF: Timeframe[] = ["D1", "H4", "H1", "M15", "M5", "M1"];

export interface CycleResult {
  status: DataStatus;
  creditsUsed: number;
  signalsCreated: number;
  errors: string[];
  durationMs: number;
}

const weekKey = (t: number) => {
  const p = localParts("America/New_York", t + 7 * 3600);
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // lunes
  return d.toISOString().slice(0, 10);
};

/** Fin del día de trading (17:00 NY) para pausas. */
const endOfTradingDay = (t: number) => nextLocalTimeUtc("America/New_York", 17 * 60, t);

export async function runCycle(opts: { force?: boolean } = {}): Promise<CycleResult> {
  const t0 = Date.now();
  const now = Math.floor(t0 / 1000);
  const errors: string[] = [];
  let credits = 0;
  let signalsCreated = 0;
  const apiKey = process.env.TWELVEDATA_API_KEY;
  const settings = await loadSettings();

  // ── 0. Mercado cerrado → snapshot ligero, sin gastar créditos
  const hourUtc = new Date(t0).getUTCHours();
  const inWindow = hourUtc >= ENGINE_WINDOW_UTC.start && hourUtc < ENGINE_WINDOW_UTC.end;
  if (isMarketClosed(now) || (!inWindow && !opts.force)) {
    const st: DataStatus = isMarketClosed(now) ? "MARKET_CLOSED" : "HISTORICAL";
    await saveSnapshot(st, { status: st, generatedAt: now, session: sessionInfo(now), schedule: sessionScheduleCdmx(now), note: st === "MARKET_CLOSED" ? "Mercado FX cerrado" : "Fuera de la ventana operativa del motor" });
    return finish(st);
  }
  if (!apiKey) {
    errors.push("Falta TWELVEDATA_API_KEY");
    await saveSnapshot("NO_DATA", { status: "NO_DATA", generatedAt: now, errors });
    return finish("NO_DATA");
  }

  // ── 1. Datos (caché compartido; sólo se piden las TF vencidas)
  const cacheRows = must(await db().from("candles_cache").select("*"), "candles_cache") as { tf: Timeframe; candles: Candle[]; fetched_at: string }[];
  const cache = new Map(cacheRows.map((r) => [r.tf, r]));
  const candles: Partial<Record<Timeframe, Candle[]>> = {};
  const reports: QualityReport[] = [];
  for (const tf of ALL_TF) {
    const plan = FETCH_PLAN[tf];
    const c = cache.get(tf);
    const age = c ? now - Date.parse(c.fetched_at) / 1000 : Infinity;
    const dayChanged = c && tf === "D1" && tradingDayKey(Date.parse(c.fetched_at) / 1000) !== tradingDayKey(now);
    let raw: Candle[] | null = null;
    if (!c || age >= plan.refreshSec || dayChanged) {
      try {
        raw = await fetchCandles(tf, plan.outputsize, apiKey);
        credits++;
      } catch (e) {
        errors.push(`${tf}: ${(e as Error).message}`);
      }
    }
    const src = raw ?? c?.candles ?? [];
    const v = validateCandles(tf, src, now);
    reports.push(v.report);
    candles[tf] = v.candles;
    if (raw && v.candles.length) {
      await db().from("candles_cache").upsert({ tf, candles: v.candles, fetched_at: new Date(t0).toISOString(), last_close: v.report.lastClose });
    }
  }
  const status = dataStatus(reports.find((r) => r.tf === "M1")?.lastClose ?? null, now);
  if (!candles.M5?.length || !candles.M15?.length) {
    await saveSnapshot("NO_DATA", { status: "NO_DATA", generatedAt: now, errors, quality: reports });
    return finish("NO_DATA");
  }

  // ── 2. Noticias y macro
  const nr = await refreshNews(settings.news);
  if (nr.error) errors.push(`Calendario: ${nr.error}`);
  const news = await loadNews(now - 6 * 3600, now + 48 * 3600).catch((e) => (errors.push(`news: ${e.message}`), []));
  const newsState = newsStateAt(news, now, settings.news);
  const macro = await loadMacro().catch(() => null);

  // ── 3. Análisis
  const m1 = candles.M1 ?? [];
  const livePrice = m1.length ? m1[m1.length - 1].close : undefined;
  const spread = settings.broker.typicalSpreadPips;
  const prepared = prepare(candles);
  const i5 = candles.M5.length - 1;
  const ctx = contextAt(prepared, i5, spread, livePrice);
  if (!ctx) {
    errors.push("Contexto incompleto");
    await saveSnapshot(status, { status, generatedAt: now, errors });
    return finish(status);
  }

  // ── 4. Riesgo: reset diario/semanal
  const dKey = tradingDayKey(now), wKey = weekKey(now);
  const rsRow = (await db().from("risk_state").select("state").eq("id", 1).maybeSingle()).data;
  let risk: RiskState = rsRow?.state ?? emptyRiskState(dKey, wKey);
  const prevPause = risk.pausedUntil;
  if (risk.dayKey !== dKey) risk = { ...risk, dayKey: dKey, realizedDayPct: 0, tradesToday: 0, pausedUntil: null, pauseReason: null, consecutiveLosses: 0 }; // la pausa por racha dura el resto del día
  if (risk.weekKey !== wKey) risk = { ...risk, weekKey: wKey, realizedWeekPct: 0 };

  // ── 5. Seguimiento de paper trades abiertos con velas M1
  const openTrades = must(await db().from("paper_trades").select("*").in("status", ["PENDING", "ACTIVE"]), "paper_trades") as { signal_id: string; state: TradeState; strategy: string; session: string }[];
  const simCandles = m1.length ? m1 : candles.M5;
  const simTf = m1.length ? 60 : 300;
  for (const row of openTrades) {
    const before = row.state;
    const sigRow = (await db().from("signals").select("*").eq("id", row.signal_id).maybeSingle()).data;
    const after = stepTrade(before, simCandles, { broker: settings.broker, cfg: settings.signal, spreadPips: spread, tfSec: simTf, atr: ctx.atrM15 });
    const newEvents = after.events.slice(before.events.length);
    for (const ev of newEvents) {
      await db().from("signal_events").insert({ signal_id: row.signal_id, type: ev.type, price: ev.price, created_at: new Date(ev.time * 1000).toISOString() });
      await sendTelegram(eventMessage(ev.type, { direction: after.direction, entry: after.entry, id: row.signal_id }, ev.price, after.resultR !== null && after.status === "CLOSED" ? `Resultado: ${after.resultR.toFixed(2)} R` : ""));
    }
    const riskAmt = sigRow?.sizing?.riskAmount ?? (settings.risk.equity * settings.risk.riskPerTradePct) / 100;
    const done = ["CLOSED", "EXPIRED", "INVALIDATED"].includes(after.status);
    await db().from("paper_trades").update({
      state: after,
      status: after.status,
      result_r: after.resultR,
      pnl_amount: after.resultR !== null ? after.resultR * riskAmt : null,
      slippage_pips: settings.broker.slippagePips,
      spread_pips: spread,
      duration_min: after.filledAt ? ((after.fills.at(-1)?.time ?? now) - after.filledAt) / 60 : null,
      updated_at: new Date().toISOString(),
    }).eq("signal_id", row.signal_id);
    await db().from("signals").update({ status: after.status, result_r: after.resultR, closed_at: done ? new Date().toISOString() : null }).eq("id", row.signal_id);
    if (after.status === "CLOSED" && before.status !== "CLOSED" && after.resultR !== null) {
      const pct = (after.resultR * riskAmt * 100) / settings.risk.equity;
      risk = applyClosedTrade(risk, pct, settings.risk, now, endOfTradingDay(now));
    }
  }
  const stillOpen = must(await db().from("paper_trades").select("signal_id,status").in("status", ["PENDING", "ACTIVE"]), "paper_trades") as { status: string }[];
  risk.openPositions = stillOpen.length;
  risk.openRiskPct = stillOpen.length * settings.risk.riskPerTradePct;
  if (risk.pausedUntil && risk.pausedUntil !== prevPause) {
    await sendTelegram(plainMessage("⚠️ USD/JPY — Límite de riesgo alcanzado", `${risk.pauseReason}. Nuevas entradas suspendidas hasta ${new Date(risk.pausedUntil * 1000).toISOString().slice(11, 16)} UTC.`));
  }

  // ── 6. Señales
  const recent = must(await db().from("signals").select("key,created_at").gte("created_at", new Date((now - 6 * 3600) * 1000).toISOString()), "signals") as { key: string; created_at: string }[];
  const recentKeys = new Map<string, number>();
  for (const r of recent) recentKeys.set(r.key, Math.max(recentKeys.get(r.key) ?? 0, Math.floor(Date.parse(r.created_at) / 1000)));
  const result = evaluate({
    ctx, news: newsState, signalCfg: settings.signal, broker: settings.broker, riskCfg: settings.risk,
    riskState: risk, recentKeys, live: true, dataLive: status === "LIVE",
  });
  const sig = result.signal;
  if (sig && sig.status === "PENDING" && sig.score >= settings.signal.minScoreToAlert) {
    await db().from("signals").insert(signalRow(sig));
    await db().from("signal_events").insert({ signal_id: sig.id, type: "CREATED", price: sig.entry, payload: { score: sig.score, strategies: sig.strategies } });
    await db().from("paper_trades").insert({ signal_id: sig.id, state: newTrade(sig, settings.signal), status: "PENDING", strategy: sig.strategies[0], session: sig.session });
    risk.tradesToday += 1;
    risk.openPositions += 1;
    risk.openRiskPct += settings.risk.riskPerTradePct;
    signalsCreated++;
    await sendTelegram(signalMessage(sig, { structure: ctx.tf.H1?.trend ?? "—", momentum: momentumLabel(ctx), dashboardUrl: process.env.PUBLIC_URL }));
  }
  await db().from("risk_state").upsert({ id: 1, state: risk, updated_at: new Date().toISOString() });

  // ── 7. Alertas de contexto: cambio de tendencia H1, noticias próximas
  const prev = (await db().from("engine_snapshots").select("snapshot").order("created_at", { ascending: false }).limit(1).maybeSingle()).data?.snapshot;
  const h1Trend = ctx.tf.H1?.trend;
  if (prev?.trends?.H1 && h1Trend && prev.trends.H1 !== h1Trend && h1Trend !== "NEUTRAL") {
    await sendTelegram(plainMessage("🔄 USD/JPY — Cambio de tendencia H1", `${prev.trends.H1} → ${h1Trend} · precio ${ctx.price.toFixed(3)}`));
  }
  for (const e of news.filter((x) => x.impact === "HIGH" && !x.alerted && x.time > now && x.time - now <= 35 * 60)) {
    const ok = await sendTelegram(plainMessage(`📰 Noticia de alto impacto (${e.currency})`, `${e.title} a las ${new Date(e.time * 1000).toLocaleTimeString("es-MX", { timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit" })} CDMX · previsión ${e.forecast ?? "—"} · anterior ${e.previous ?? "—"}\nNuevas entradas bloqueadas ${settings.news.blockBeforeMin} min antes y ${settings.news.blockAfterMin} después. Fuente: ${e.source}`));
    if (ok) await db().from("news_events").update({ alerted: true }).eq("id", e.id);
  }

  // ── 8. Snapshot para el dashboard
  const snap = buildSnapshot({ now, status, ctx, result, settings, risk, newsState, news, macro, reports, errors, candles, gate: riskGate(risk, settings.risk, now) });
  await saveSnapshot(status, snap);
  return finish(status);

  async function finish(st: DataStatus): Promise<CycleResult> {
    const durationMs = Date.now() - t0;
    await db().from("engine_runs").insert({ duration_ms: durationMs, data_status: st, credits_used: credits, signals_created: signalsCreated, errors }).then(() => undefined, () => undefined);
    return { status: st, creditsUsed: credits, signalsCreated, errors, durationMs };
  }
}

async function saveSnapshot(status: DataStatus, snapshot: unknown) {
  await db().from("engine_snapshots").insert({ data_status: status, snapshot });
}

function signalRow(s: Signal) {
  return {
    id: s.id, key: s.key, created_at: new Date(s.createdAt * 1000).toISOString(), direction: s.direction,
    entry: s.entry, stop: s.stop, tp1: s.tp1, tp2: s.tp2, tp3: s.tp3, rr: s.rr, score: s.score,
    score_breakdown: s.scoreBreakdown, strategies: s.strategies, reasons: s.reasons, confirmation_tf: s.confirmationTf,
    order_type: s.orderType, session: s.session, valid_until: new Date(s.validUntil * 1000).toISOString(),
    invalidation: s.invalidation, status: s.status, sizing: s.sizing ?? null,
  };
}

function momentumLabel(ctx: EngineContext) {
  const v = ctx.tf.M15!;
  const h = v.a.ind.macdHist[v.i], r = v.a.ind.rsi[v.i];
  if (h > 0 && r > 55) return "STRONG BULLISH";
  if (h < 0 && r < 45) return "STRONG BEARISH";
  if (h > 0) return "BULLISH";
  if (h < 0) return "BEARISH";
  return "NEUTRAL";
}

/** Estadística de sesiones con las últimas velas H1 (≈12 días): rango medio y dirección dominante. */
function sessionStats(h1: Candle[]) {
  const names = ["TOKYO", "LONDON", "NEW_YORK"] as const;
  const out: Record<string, { avgRangePips: number; bullishPct: number; days: number }> = {};
  for (const n of names) {
    const byDay = new Map<string, { o: number; c: number; h: number; l: number }>();
    for (const c of h1) {
      if (!sessionInfo(c.time, false).active.includes(n)) continue;
      const k = tradingDayKey(c.time);
      const d = byDay.get(k);
      if (!d) byDay.set(k, { o: c.open, c: c.close, h: c.high, l: c.low });
      else { d.c = c.close; d.h = Math.max(d.h, c.high); d.l = Math.min(d.l, c.low); }
    }
    const days = [...byDay.values()];
    out[n] = {
      avgRangePips: days.length ? days.reduce((a, d) => a + (d.h - d.l), 0) / days.length / PIP : 0,
      bullishPct: days.length ? (100 * days.filter((d) => d.c > d.o).length) / days.length : 0,
      days: days.length,
    };
  }
  return out;
}

export function buildSnapshot(x: {
  now: number; status: DataStatus; ctx: EngineContext; result: EvaluationResult; settings: Settings; risk: RiskState;
  newsState: ReturnType<typeof newsStateAt>; news: Awaited<ReturnType<typeof loadNews>>; macro: Awaited<ReturnType<typeof loadMacro>>;
  reports: QualityReport[]; errors: string[]; candles: Partial<Record<Timeframe, Candle[]>>; gate: string[];
}) {
  const { ctx, result } = x;
  const L = ctx.m15Levels[ctx.tf.M15!.i];
  const d1 = x.candles.D1 ?? [];
  const prevClose = d1.length >= 1 ? d1[d1.length - 1].close : null; // última D1 cerrada
  const v15 = ctx.tf.M15!;
  const trends = Object.fromEntries(ALL_TF.filter((tf) => ctx.tf[tf]).map((tf) => [tf, ctx.tf[tf]!.trend]));
  const htf = [ctx.tf.D1, ctx.tf.H4, ctx.tf.H1].map((v) => (v ? trendToDir(v.trend) : null));
  const bias = htf.filter((d) => d === "LONG").length >= 2 ? "ALCISTA" : htf.filter((d) => d === "SHORT").length >= 2 ? "BAJISTA" : "NEUTRAL";
  const ev5 = lastEventAsOf(ctx.tf.M5!.a.structure, ctx.tf.M5!.i, 48);
  const conditions = [
    { label: "Datos en vivo", ok: x.status === "LIVE", detail: x.status },
    { label: "Sesión operable", ok: ctx.session.active.some((s) => s !== "SYDNEY"), detail: ctx.session.label },
    { label: "Sin bloqueo por noticias", ok: !x.newsState.blocked, detail: x.newsState.next ? `${x.newsState.next.title}` : "—" },
    { label: "Volatilidad normal", ok: ctx.marketState !== "HIGH_VOLATILITY", detail: `ATR pct ${Number.isFinite(ctx.atrPctM15) ? ctx.atrPctM15.toFixed(0) : "—"}` },
    { label: "Spread aceptable", ok: ctx.spreadPips <= x.settings.broker.maxSpreadPips, detail: `${ctx.spreadPips} pips (config. broker)` },
    { label: "Límites de riesgo", ok: x.gate.length === 0, detail: x.gate[0] ?? "OK" },
  ];
  return {
    status: x.status,
    generatedAt: x.now,
    evaluatedBarClose: ctx.time,
    price: ctx.price,
    dailyChange: prevClose ? { abs: ctx.price - prevClose, pct: (100 * (ctx.price - prevClose)) / prevClose } : null,
    spread: { pips: ctx.spreadPips, source: `Configurado (${x.settings.broker.name}); TwelveData no entrega bid/ask` },
    trends,
    bias,
    session: sessionInfo(x.now),
    schedule: sessionScheduleCdmx(x.now),
    sessionStats: sessionStats(x.candles.H1 ?? []),
    sessionLevels: L,
    atr: { m15Pips: ctx.atrM15 / PIP, m5Pips: ctx.atrM5 / PIP, h1Pips: ctx.tf.H1 ? ctx.tf.H1.a.ind.atr[ctx.tf.H1.i] / PIP : null, pctM15: ctx.atrPctM15 },
    momentum: { label: momentumLabel(ctx), rsiM15: v15.a.ind.rsi[v15.i], macdHistM15: v15.a.ind.macdHist[v15.i], adxM15: v15.a.ind.adx[v15.i], adxH1: ctx.tf.H1 ? ctx.tf.H1.a.ind.adx[ctx.tf.H1.i] : null },
    marketState: ctx.marketState,
    lastStructureM5: ev5,
    liquidity: ctx.liquidity.sort((a, b) => b.price - a.price),
    evaluation: result.evals.map((e) => ({ direction: e.direction, score: e.score, setups: e.setups.map((s) => ({ strategy: s.strategy, entry: s.entry, stop: s.stop, reasons: s.reasons })) })),
    candidate: result.signal,
    rejected: result.rejected,
    news: { state: x.newsState, upcoming: x.news.filter((n) => n.time >= x.now - 1800).slice(0, 12) },
    macro: x.macro,
    risk: { state: x.risk, config: x.settings.risk, gate: x.gate },
    broker: x.settings.broker,
    conditions,
    quality: x.reports,
    errors: x.errors,
  };
}
