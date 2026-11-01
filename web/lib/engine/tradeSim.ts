import { PIP, type BrokerConfig, type SignalConfig } from "../config";
import type { Candle, Signal } from "./types";
import { localParts } from "./sessions";

/**
 * Simulación de ejecución sobre velas (mid). Convención de precios:
 *   LONG entra en ASK (= mid + spread/2) y sale en BID (= mid − spread/2); SHORT al revés.
 * Por eso los disparos se ajustan medio spread y el costo extra sólo es slippage + comisión.
 * Si una vela toca SL y TP a la vez se asume SL primero (conservador).
 */
export type TradeStatus = "PENDING" | "ACTIVE" | "CLOSED" | "EXPIRED" | "INVALIDATED";

export interface Fill {
  time: number;
  price: number;
  fraction: number;
  reason: "TP1" | "TP2" | "TP3" | "SL" | "BE" | "TRAIL" | "EOD" | "MANUAL";
}

export interface TradeState {
  signalId: string;
  direction: "LONG" | "SHORT";
  status: TradeStatus;
  entry: number;
  initialStop: number;
  stop: number;
  tp: [number, number, number];
  partials: [number, number, number];
  filledAt: number | null;
  fillPrice: number | null;
  remaining: number; // fracción abierta 0–1
  fills: Fill[];
  tpHit: [boolean, boolean, boolean];
  best: number | null; // mejor precio a favor desde la entrada
  validUntil: number;
  lastProcessed: number; // tiempo de apertura de la última vela procesada
  resultR: number | null;
  mfeR: number;
  maeR: number;
  events: { time: number; type: string; price: number }[];
}

export function newTrade(sig: Signal, cfg: SignalConfig): TradeState {
  return {
    signalId: sig.id,
    direction: sig.direction,
    status: "PENDING",
    entry: sig.entry,
    initialStop: sig.stop,
    stop: sig.stop,
    tp: [sig.tp1, sig.tp2, sig.tp3],
    partials: cfg.partials.map((p) => p / 100) as [number, number, number],
    filledAt: null,
    fillPrice: null,
    remaining: 1,
    fills: [],
    tpHit: [false, false, false],
    best: null,
    validUntil: sig.validUntil,
    lastProcessed: sig.createdAt - 1,
    resultR: null,
    mfeR: 0,
    maeR: 0,
    events: [],
  };
}

export interface SimParams {
  broker: BrokerConfig;
  cfg: SignalConfig;
  spreadPips: number;
  tfSec: number; // duración de las velas recibidas
  atr: number; // ATR M15 para trailing
}

export function stepTrade(t0: TradeState, candles: Candle[], p: SimParams): TradeState {
  const t: TradeState = structuredClone(t0);
  const s = t.direction === "LONG" ? 1 : -1;
  const half = (p.spreadPips * PIP) / 2;
  const slip = p.broker.slippagePips * PIP;
  const R = Math.abs(t.entry - t.initialStop);
  const [eh, em] = p.cfg.eodCloseNy.split(":").map(Number);

  for (const c of candles) {
    if (c.time <= t.lastProcessed) continue;
    if (t.status === "CLOSED" || t.status === "EXPIRED" || t.status === "INVALIDATED") break;
    t.lastProcessed = c.time;
    // precios ejecutables del lado de salida (BID para LONG, ASK para SHORT) y de entrada
    const exitHigh = c.high - s * half, exitLow = c.low - s * half;
    const entryLow = c.low + s * half, entryHigh = c.high + s * half;
    const favorable = s > 0 ? exitHigh : exitLow; // mejor precio de salida en la vela
    const adverse = s > 0 ? exitLow : exitHigh;

    if (t.status === "PENDING") {
      if (c.time >= t.validUntil) { t.status = "EXPIRED"; t.events.push({ time: c.time, type: "EXPIRED", price: c.open }); break; }
      // invalidación: el precio toca el SL antes de activarse
      if (s > 0 ? adverse <= t.stop : adverse >= t.stop) { t.status = "INVALIDATED"; t.events.push({ time: c.time, type: "INVALIDATED", price: t.stop }); break; }
      const touched = s > 0 ? entryLow <= t.entry : entryHigh >= t.entry;
      if (!touched) continue;
      t.status = "ACTIVE";
      t.filledAt = c.time;
      // conservador: se llena en el precio de entrada + slippage (sin mejora por gaps)
      t.fillPrice = t.entry + s * slip;
      t.best = t.fillPrice;
      t.events.push({ time: c.time, type: "FILLED", price: t.fillPrice });
      // en la vela de llenado sólo se evalúa el SL (no sabemos el orden intra-vela)
      if (s > 0 ? adverse <= t.stop : adverse >= t.stop) close(c.time, t.stop - s * slip, "SL", t.remaining);
      continue;
    }

    // ACTIVE ─ SL primero
    if (s > 0 ? adverse <= t.stop : adverse >= t.stop) {
      const reason = t.tpHit[1] ? "TRAIL" : t.tpHit[0] ? "BE" : "SL";
      const gapPx = s > 0 ? Math.min(t.stop, c.open - s * half) : Math.max(t.stop, c.open - s * half);
      close(c.time, gapPx - s * slip, reason, t.remaining);
      break;
    }
    t.best = s > 0 ? Math.max(t.best ?? favorable, favorable) : Math.min(t.best ?? favorable, favorable);
    t.mfeR = Math.max(t.mfeR, (s * (t.best - t.fillPrice!)) / R);
    t.maeR = Math.min(t.maeR, (s * (adverse - t.fillPrice!)) / R);
    for (let k = 0; k < 3; k++) {
      if (t.tpHit[k] || t.remaining <= 1e-9) continue;
      if (s > 0 ? favorable >= t.tp[k] : favorable <= t.tp[k]) {
        t.tpHit[k] = true;
        const frac = k === 2 ? t.remaining : Math.min(t.remaining, t.partials[k]);
        close(c.time, t.tp[k], (["TP1", "TP2", "TP3"] as const)[k], frac);
        if (k === 0 && p.cfg.moveToBreakevenAt === "TP1") t.stop = t.fillPrice!;
      }
    }
    if (t.tpHit[1] && t.remaining > 1e-9 && Number.isFinite(p.atr)) {
      const trail = t.best! - s * p.cfg.trailingAtr * p.atr;
      if (s * (trail - t.stop) > 0) t.stop = trail;
    }
    // cierre intradía forzado
    const ny = localParts("America/New_York", c.time + p.tfSec).minutes;
    if (t.remaining > 1e-9 && ny >= eh * 60 + em && ny < 17 * 60 + 30) close(c.time + p.tfSec, c.close - s * half - s * slip, "EOD", t.remaining);
    if (t.remaining <= 1e-9) break;
  }
  if (t.status === "CLOSED") t.resultR = realizedR(t, p);
  return t;

  function close(time: number, price: number, reason: Fill["reason"], frac: number) {
    t.fills.push({ time, price, fraction: frac, reason });
    t.remaining = Math.max(0, t.remaining - frac);
    t.events.push({ time, type: reason, price });
    if (t.remaining <= 1e-9) t.status = "CLOSED";
  }
}

/** R neto: P&L ponderado por fracción, menos comisión expresada en R. */
export function realizedR(t: TradeState, p: SimParams): number {
  if (!t.fillPrice) return 0;
  const s = t.direction === "LONG" ? 1 : -1;
  const R = Math.abs(t.entry - t.initialStop);
  const gross = t.fills.reduce((acc, f) => acc + f.fraction * s * (f.price - t.fillPrice!), 0);
  const commissionPx = ((2 * p.broker.commissionPerLotPerSide) / ((PIP * p.broker.contractSize) / t.fillPrice)) * PIP;
  return (gross - commissionPx) / R;
}
