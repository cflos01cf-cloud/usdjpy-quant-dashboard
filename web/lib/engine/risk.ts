import { PIP, type BrokerConfig, type RiskConfig } from "../config";
import type { PositionSize } from "./types";

/**
 * Valor del pip de USD/JPY por lote estándar:
 *   1 pip = 0.01 JPY × 100,000 = 1,000 JPY → en USD = 1,000 / precio.
 * Si la cuenta está en MXN se convierte con usdToAccountRate.
 */
export function pipValuePerLot(price: number, broker: BrokerConfig, risk: RiskConfig): number {
  const jpy = PIP * broker.contractSize;
  return (jpy / price) * risk.usdToAccountRate;
}

/** Costo total ida y vuelta en pips: spread + slippage (2 lados) + comisión. */
export function roundTripCostPips(price: number, broker: BrokerConfig, risk: RiskConfig, spreadPips = broker.typicalSpreadPips): number {
  const commission = (2 * broker.commissionPerLotPerSide * risk.usdToAccountRate) / pipValuePerLot(price, broker, risk);
  return spreadPips + 2 * broker.slippagePips + commission;
}

export function positionSize(entry: number, stop: number, broker: BrokerConfig, risk: RiskConfig, riskPctOverride?: number): PositionSize {
  const stopPips = Math.abs(entry - stop) / PIP;
  const pv = pipValuePerLot(entry, broker, risk);
  const riskPct = riskPctOverride ?? risk.riskPerTradePct;
  const riskAmount = (risk.equity * riskPct) / 100;
  const costPips = roundTripCostPips(entry, broker, risk);
  // el riesgo efectivo incluye costos: (stop + costos) × valor pip × lotes = riesgo
  const raw = riskAmount / ((stopPips + costPips) * pv);
  const lots = Math.max(0, Math.floor(raw / broker.lotStep + 1e-9) * broker.lotStep);
  const finalLots = lots >= broker.minLot ? Number(lots.toFixed(2)) : 0;
  return {
    lots: finalLots,
    units: Math.round(finalLots * broker.contractSize),
    riskAmount: finalLots * (stopPips + costPips) * pv,
    riskPct,
    stopPips,
    pipValuePerLot: pv,
    costPips,
  };
}

export interface RiskState {
  dayKey: string;
  weekKey: string;
  realizedDayPct: number; // P&L realizado hoy en % (negativo = pérdida)
  realizedWeekPct: number;
  openRiskPct: number; // riesgo abierto en posiciones activas/pendientes
  tradesToday: number;
  openPositions: number;
  consecutiveLosses: number;
  killSwitch: boolean;
  pausedUntil: number | null;
  pauseReason: string | null;
}

export const emptyRiskState = (dayKey: string, weekKey: string): RiskState => ({
  dayKey,
  weekKey,
  realizedDayPct: 0,
  realizedWeekPct: 0,
  openRiskPct: 0,
  tradesToday: 0,
  openPositions: 0,
  consecutiveLosses: 0,
  killSwitch: false,
  pausedUntil: null,
  pauseReason: null,
});

/** Filtros duros de riesgo. Devuelve motivos de bloqueo (vacío = se puede operar). */
export function riskGate(state: RiskState, cfg: RiskConfig, now: number): string[] {
  const r: string[] = [];
  if (cfg.killSwitch || state.killSwitch) r.push("Kill switch activo");
  if (state.pausedUntil && now < state.pausedUntil) r.push(`Pausa: ${state.pauseReason ?? "límite alcanzado"}`);
  if (-state.realizedDayPct + state.openRiskPct + cfg.riskPerTradePct > cfg.maxDailyRiskPct + 1e-9)
    r.push(`Riesgo diario: pérdida ${(-state.realizedDayPct).toFixed(2)}% + abierto ${state.openRiskPct.toFixed(2)}% excede ${cfg.maxDailyRiskPct}%`);
  if (-state.realizedWeekPct >= cfg.maxWeeklyLossPct) r.push(`Pérdida semanal ${(-state.realizedWeekPct).toFixed(2)}% ≥ ${cfg.maxWeeklyLossPct}%`);
  if (state.tradesToday >= cfg.maxTradesPerDay) r.push(`Máximo de operaciones diarias (${cfg.maxTradesPerDay})`);
  if (state.openPositions >= cfg.maxOpenPositions) r.push(`Máximo de posiciones simultáneas (${cfg.maxOpenPositions})`);
  if (state.consecutiveLosses >= cfg.maxConsecutiveLosses) r.push(`${state.consecutiveLosses} pérdidas consecutivas`);
  return r;
}

/** Aplica el resultado de una operación cerrada al estado de riesgo. */
export function applyClosedTrade(state: RiskState, pnlPct: number, cfg: RiskConfig, now: number, endOfDay: number): RiskState {
  const s = { ...state };
  s.realizedDayPct += pnlPct;
  s.realizedWeekPct += pnlPct;
  s.consecutiveLosses = pnlPct < 0 ? s.consecutiveLosses + 1 : 0;
  if (-s.realizedDayPct >= cfg.maxDailyRiskPct) {
    s.pausedUntil = endOfDay;
    s.pauseReason = "Límite de pérdida diaria alcanzado";
  } else if (s.consecutiveLosses >= cfg.maxConsecutiveLosses) {
    s.pausedUntil = endOfDay;
    s.pauseReason = `${s.consecutiveLosses} pérdidas consecutivas`;
  }
  void now;
  return s;
}
