import { PIP, type BrokerConfig, type RiskConfig, type SignalConfig } from "../config";
import type { Direction, ScoreBreakdown, Setup, Signal, StrategyId } from "./types";
import type { EngineContext } from "./context";
import { sign } from "./context";
import { classify, isCounterTrend, scoreDirection, type NewsState } from "./scoring";
import { positionSize, roundTripCostPips, riskGate, type RiskState } from "./risk";
import { runStrategies } from "../strategies";
import { localParts } from "./sessions";
import { fmtPrice } from "../format";

const PRIORITY: StrategyId[] = ["A_SMC", "D_LIQUIDITY", "E_BREAKOUT", "B_TREND", "C_PRICE_ACTION"];

export interface DirectionEval {
  direction: Direction;
  setups: Setup[];
  score: ScoreBreakdown;
}

export interface EvaluationResult {
  time: number;
  evals: DirectionEval[];
  signal: Signal | null; // mejor candidata (puede venir BLOCKED con motivos)
  rejected: { key: string; reasons: string[] }[];
}

export interface EvalInputs {
  ctx: EngineContext;
  news: NewsState;
  signalCfg: SignalConfig;
  broker: BrokerConfig;
  riskCfg: RiskConfig;
  riskState: RiskState | null; // null en backtest de señales puras
  recentKeys: Map<string, number>; // clave → instante de última emisión (dedupe)
  live: boolean; // en vivo exige datos LIVE
  dataLive: boolean;
}

export function evaluate(inp: EvalInputs): EvaluationResult {
  const { ctx, news, signalCfg: cfg } = inp;
  const setups = runStrategies(ctx);
  const evals: DirectionEval[] = (["LONG", "SHORT"] as Direction[]).map((d) => ({
    direction: d,
    setups: setups.filter((s) => s.direction === d).sort((a, b) => PRIORITY.indexOf(a.strategy) - PRIORITY.indexOf(b.strategy)),
    score: scoreDirection(ctx, d, setups, news),
  }));
  const rejected: EvaluationResult["rejected"] = [];
  const withSetups = evals.filter((e) => e.setups.length).sort((a, b) => b.score.total - a.score.total);
  if (!withSetups.length) return { time: ctx.time, evals, signal: null, rejected };

  // si ambas direcciones tienen setup y scores cercanos → conflicto, no operar
  if (withSetups.length === 2 && withSetups[0].score.total - withSetups[1].score.total < 10) {
    rejected.push({ key: "CONFLICT", reasons: ["Setups LONG y SHORT simultáneos con score similar"] });
    return { time: ctx.time, evals, signal: null, rejected };
  }
  const best = withSetups[0];
  const sig = buildSignal(inp, best);
  if (sig.blockedReasons?.length) rejected.push({ key: sig.key, reasons: sig.blockedReasons });
  return { time: ctx.time, evals, signal: sig, rejected };
}

export function buildSignal(inp: EvalInputs, ev: DirectionEval): Signal {
  const { ctx, signalCfg: cfg, broker, riskCfg } = inp;
  const d = ev.direction;
  const s = sign(d);
  const primary = ev.setups[0];
  const atr = ctx.atrM15;
  const blocked: string[] = [];

  // ── niveles ──
  const entry = primary.entry;
  const structStop = primary.stop - s * cfg.stopBufferAtr * atr;
  const minDist = Math.max(cfg.minStopAtr * atr, cfg.minStopPips * PIP);
  let stop = s > 0 ? Math.min(structStop, entry - minDist) : Math.max(structStop, entry + minDist);
  stop = Number(stop.toFixed(3));
  const R = Math.abs(entry - stop);
  const stopPips = R / PIP;
  if (stopPips > cfg.maxStopPips) blocked.push(`SL de ${stopPips.toFixed(1)} pips supera el máximo (${cfg.maxStopPips})`);

  const [r1, r2, r3] = cfg.tpR;
  const tp1 = entry + s * r1 * R;
  const tp2 = entry + s * r2 * R;
  let tp3 = entry + s * r3 * R;
  // TP3 se extiende a la liquidez estructural si está más lejos (máx. 6R)
  const tgts = ev.setups.map((x) => x.target).filter((x): x is number => x !== undefined && Number.isFinite(x));
  for (const t of tgts) {
    const rr = (s * (t - entry)) / R;
    if (rr > r3 && rr <= 6) tp3 = t;
  }

  const cost = roundTripCostPips(entry, broker, riskCfg, ctx.spreadPips) * PIP;
  const net = (tp: number) => (s * (tp - entry) - cost) / (R + cost);
  const rr = { tp1: r1, tp2: r2, tp3: Number(((s * (tp3 - entry)) / R).toFixed(2)), netTp2: Number(net(tp2).toFixed(2)) };
  if (rr.netTp2 < cfg.minRR - 1e-9) blocked.push(`R:R neto al TP2 ${rr.netTp2} < ${cfg.minRR} tras costos`);

  // ── distancia a la entrada óptima ──
  const drift = s * (ctx.price - entry); // >0 = el precio ya avanzó a favor
  if (drift > cfg.maxEntryDriftAtr * atr) blocked.push(`Precio ya se alejó ${(drift / PIP).toFixed(1)} pips de la entrada óptima`);
  if (s * (ctx.price - stop) <= 0) blocked.push("El precio ya está más allá del SL");
  const orderType: Signal["orderType"] = Math.abs(ctx.price - entry) <= cfg.marketOrderToleranceAtr * atr ? "MARKET" : "LIMIT";

  // ── filtros de contexto ──
  const score = ev.score.total;
  const cls = classify(score);
  if (inp.live && !inp.dataLive) blocked.push("Datos no están en estado LIVE");
  if (inp.news.blocked) blocked.push(`Bloqueo por noticia: ${inp.news.next?.title ?? "alto impacto"}`);
  if (ctx.spreadPips > broker.maxSpreadPips) blocked.push(`Spread ${ctx.spreadPips} > máx ${broker.maxSpreadPips}`);
  const a = ctx.session.active;
  if (cfg.tradeOnlySessions && !(a.includes("TOKYO") || a.includes("LONDON") || a.includes("NEW_YORK"))) blocked.push("Fuera de sesiones operables");
  const ny = localParts("America/New_York", ctx.time).minutes;
  const [eh, em] = cfg.eodCloseNy.split(":").map(Number);
  if (ny >= eh * 60 + em - 90 && ny < 17 * 60) blocked.push("Muy cerca del cierre intradía (NY)");
  if (isCounterTrend(ctx, d) && (!cfg.allowCounterTrend || score < cfg.counterTrendMinScore))
    blocked.push(`Contra tendencia D1+H4 requiere score ≥ ${cfg.counterTrendMinScore}`);
  if (ctx.marketState === "HIGH_VOLATILITY" && score < 90) blocked.push("Volatilidad extrema");
  if (score < cfg.minScoreToShow) blocked.push(`Score ${score} < ${cfg.minScoreToShow}`);

  // ── duplicados ──
  const key = primary.key;
  const lastAt = inp.recentKeys.get(key);
  if (lastAt !== undefined && ctx.time - lastAt < cfg.cooldownMinutes * 60) blocked.push("Señal duplicada (misma oportunidad)");

  // ── riesgo ──
  let sizing;
  if (inp.riskState) {
    blocked.push(...riskGate(inp.riskState, riskCfg, ctx.time));
    sizing = positionSize(entry, stop, broker, riskCfg);
    if (sizing.lots <= 0) blocked.push("Tamaño de posición menor al lote mínimo");
  }

  const strategies = [...new Set(ev.setups.map((x) => x.strategy))];
  const reasons = [...new Set(ev.setups.flatMap((x) => x.reasons))];
  return {
    id: `${key}|${ctx.time}`,
    symbol: "USD/JPY",
    direction: d,
    entry: Number(entry.toFixed(3)),
    stop,
    tp1: Number(tp1.toFixed(3)),
    tp2: Number(tp2.toFixed(3)),
    tp3: Number(tp3.toFixed(3)),
    rr,
    score,
    scoreBreakdown: ev.score,
    classification: cls.label,
    action: blocked.length ? "NO OPERAR" : cls.action,
    confirmationTf: primary.timeframe,
    strategies,
    reasons,
    createdAt: ctx.time,
    validUntil: ctx.time + cfg.validityMinutes * 60,
    invalidation: `${primary.invalidation}; o SL ${fmtPrice(stop)} antes de activarse; o expira en ${cfg.validityMinutes} min`,
    invalidationPrice: stop,
    key,
    status: blocked.length ? "BLOCKED" : "PENDING",
    orderType,
    session: ctx.session.label,
    sizing,
    blockedReasons: blocked,
  };
}
