/**
 * Configuración central. Todo lo que dependa del broker o del criterio del trader vive aquí
 * y puede sobrescribirse desde la tabla `settings` de Supabase (ver services/settings.ts).
 */
export const SYMBOL = "USD/JPY" as const;
export const PIP = 0.01; // 1 pip en USD/JPY
export const POINT = 0.001; // 1 punto (precio a 3 decimales)

export interface BrokerConfig {
  name: string;
  accountType: "STANDARD" | "RAW_SPREAD" | "ZERO" | "PRO";
  contractSize: number; // unidades por lote
  minLot: number;
  lotStep: number;
  /** spread típico en pips; TwelveData no entrega bid/ask, así que se usa este valor declarado */
  typicalSpreadPips: number;
  maxSpreadPips: number;
  /** comisión por lote, por lado, en USD */
  commissionPerLotPerSide: number;
  slippagePips: number;
}

/**
 * Valores de referencia para Exness. VERIFICA en tu terminal los de tu tipo de cuenta
 * (Especificaciones del contrato): cambian por cuenta y por horario.
 */
export const BROKER_PRESETS: Record<string, BrokerConfig> = {
  EXNESS_STANDARD: {
    name: "Exness Standard",
    accountType: "STANDARD",
    contractSize: 100_000,
    minLot: 0.01,
    lotStep: 0.01,
    typicalSpreadPips: 1.1,
    maxSpreadPips: 2.5,
    commissionPerLotPerSide: 0,
    slippagePips: 0.3,
  },
  EXNESS_RAW: {
    name: "Exness Raw Spread",
    accountType: "RAW_SPREAD",
    contractSize: 100_000,
    minLot: 0.01,
    lotStep: 0.01,
    typicalSpreadPips: 0.1,
    maxSpreadPips: 1.5,
    commissionPerLotPerSide: 3.5,
    slippagePips: 0.3,
  },
};

export interface RiskConfig {
  accountCurrency: "USD" | "MXN";
  /** USD→MXN si la cuenta está en MXN */
  usdToAccountRate: number;
  equity: number;
  riskPerTradePct: number;
  maxDailyRiskPct: number;
  maxWeeklyLossPct: number;
  maxTradesPerDay: number;
  maxOpenPositions: number;
  maxConsecutiveLosses: number;
  killSwitch: boolean;
}

export const DEFAULT_RISK: RiskConfig = {
  accountCurrency: "USD",
  usdToAccountRate: 1,
  equity: 10_000,
  riskPerTradePct: 0.5,
  maxDailyRiskPct: 2,
  maxWeeklyLossPct: 5,
  maxTradesPerDay: 5,
  maxOpenPositions: 1,
  maxConsecutiveLosses: 3,
  killSwitch: false,
};

export interface SignalConfig {
  minScoreToAlert: number; // 80 = "alta calidad"
  minScoreToShow: number; // 70 = moderada, esperando confirmación
  minRR: number; // R:R mínimo neto al TP2
  tpR: [number, number, number]; // múltiplos de R para TP1/TP2/TP3 (TP3 puede extenderse a liquidez)
  partials: [number, number, number]; // % a cerrar en TP1/TP2/TP3
  minStopAtr: number; // SL mínimo en múltiplos de ATR M15
  minStopPips: number;
  maxStopPips: number;
  stopBufferAtr: number; // colchón más allá del nivel estructural
  maxEntryDriftAtr: number; // si el precio se alejó más que esto de la entrada óptima → no entrar
  marketOrderToleranceAtr: number; // si está a menos de esto → orden a mercado
  validityMinutes: number;
  cooldownMinutes: number; // dedupe de oportunidad
  trailingAtr: number; // trailing del runner tras TP2
  moveToBreakevenAt: "TP1" | "NONE";
  eodCloseNy: string; // hora NY de cierre forzado (intradía)
  tradeOnlySessions: boolean;
  allowCounterTrend: boolean; // contra D1/H4 sólo con score >= counterTrendMinScore
  counterTrendMinScore: number;
}

export const DEFAULT_SIGNAL: SignalConfig = {
  minScoreToAlert: 80,
  minScoreToShow: 70,
  minRR: 2,
  tpR: [2, 3, 4],
  partials: [50, 30, 20],
  minStopAtr: 1.0,
  minStopPips: 10,
  maxStopPips: 45,
  stopBufferAtr: 0.25,
  maxEntryDriftAtr: 0.35,
  marketOrderToleranceAtr: 0.1,
  validityMinutes: 60,
  cooldownMinutes: 45,
  trailingAtr: 1.0,
  moveToBreakevenAt: "TP1",
  eodCloseNy: "16:45",
  tradeOnlySessions: true,
  allowCounterTrend: true,
  counterTrendMinScore: 90,
};

export interface NewsConfig {
  currencies: string[];
  blockBeforeMin: number;
  blockAfterMin: number;
  mediumImpactBlocks: boolean;
}

export const DEFAULT_NEWS: NewsConfig = {
  currencies: ["USD", "JPY"],
  blockBeforeMin: 30,
  blockAfterMin: 30,
  mediumImpactBlocks: false,
};

/**
 * Horarios de sesión en hora LOCAL de cada plaza; la conversión a UTC/CDMX
 * se hace con la base de zonas IANA, así el horario de verano se respeta solo.
 * CDMX no tiene horario de verano desde 2022 (UTC-6 todo el año).
 */
export const SESSIONS = {
  SYDNEY: { tz: "Australia/Sydney", open: "07:00", close: "16:00" },
  TOKYO: { tz: "Asia/Tokyo", open: "09:00", close: "18:00" },
  LONDON: { tz: "Europe/London", open: "08:00", close: "17:00" },
  NEW_YORK: { tz: "America/New_York", open: "08:00", close: "17:00" },
} as const;

export const DISPLAY_TZ = "America/Mexico_City";

/** Velas a pedir por temporalidad (EMA200 necesita historia) y vigencia del caché. */
export const FETCH_PLAN = {
  D1: { outputsize: 300, refreshSec: 6 * 3600 },
  H4: { outputsize: 300, refreshSec: 3600 },
  H1: { outputsize: 300, refreshSec: 900 },
  M15: { outputsize: 300, refreshSec: 0 },
  M5: { outputsize: 300, refreshSec: 0 },
  M1: { outputsize: 180, refreshSec: 0 },
} as const;

/** Ventana en la que corre el ciclo (UTC). Fuera de ella sólo se hace seguimiento barato. */
export const ENGINE_WINDOW_UTC = { start: 6, end: 21 };
