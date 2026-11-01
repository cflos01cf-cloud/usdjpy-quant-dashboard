export type Timeframe = "D1" | "H4" | "H1" | "M15" | "M5" | "M1";
export type Direction = "LONG" | "SHORT";
export type Trend = "BULLISH" | "BEARISH" | "NEUTRAL";
export type DataStatus = "LIVE" | "DELAYED" | "HISTORICAL" | "MARKET_CLOSED" | "NO_DATA";
export type MarketState = "TRENDING" | "RANGING" | "HIGH_VOLATILITY";
export type SessionName = "SYDNEY" | "TOKYO" | "LONDON" | "NEW_YORK";
export type StrategyId = "A_SMC" | "B_TREND" | "C_PRICE_ACTION" | "D_LIQUIDITY" | "E_BREAKOUT";

/** Vela OHLC. `time` = apertura en segundos UNIX (UTC). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export const TF_SECONDS: Record<Timeframe, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  H1: 3600,
  H4: 14400,
  D1: 86400,
};

export interface IndicatorSet {
  ema20: number[];
  ema50: number[];
  ema200: number[];
  rsi: number[];
  macd: number[];
  macdSignal: number[];
  macdHist: number[];
  atr: number[];
  adx: number[];
  plusDI: number[];
  minusDI: number[];
}

export interface SwingPoint {
  index: number; // vela del extremo
  confirmedAt: number; // primera vela en la que el swing es conocido (index + lookback)
  price: number;
  kind: "HIGH" | "LOW";
}

export interface StructureEvent {
  index: number; // vela de cierre que rompe
  type: "BOS" | "CHOCH";
  direction: Direction; // dirección de la ruptura
  level: number; // nivel roto
  swingIndex: number;
}

export interface Zone {
  kind: "FVG" | "OB";
  direction: Direction; // LONG = zona alcista (soporte)
  top: number;
  bottom: number;
  createdAt: number; // índice en que la zona es conocida
  originIndex: number;
  mitigatedAt: number | null; // índice en que el precio la invalidó (cierre a través)
  touchedAt: number | null; // primer retorno del precio a la zona
}

export interface Sweep {
  index: number;
  direction: Direction; // LONG = barrida de mínimos (sesgo alcista posterior)
  level: number;
  levelName: string;
  extreme: number; // mecha más allá del nivel
}

export interface StructureState {
  swings: SwingPoint[];
  events: StructureEvent[];
  zones: Zone[];
  /** tendencia estructural en cada vela (causal) */
  trend: Trend[];
}

export interface SessionInfo {
  active: SessionName[];
  overlapLondonNY: boolean;
  label: string;
  nextChangeUtc: number | null;
}

export interface SessionRange {
  name: SessionName | "ASIA";
  dayKey: string;
  high: number;
  low: number;
  startTime: number;
  endTime: number;
  complete: boolean;
}

export interface LiquidityLevel {
  name: string; // PDH, PDL, ASIA_H, ASIA_L, LON_H, LON_L, NY_H, NY_L, EQH, EQL, SWING_H, SWING_L
  price: number;
  side: "BUY_SIDE" | "SELL_SIDE"; // buy-side = encima del precio (stops de cortos)
  swept: boolean;
}

export interface NewsEvent {
  id: string;
  time: number; // UTC segundos
  currency: string;
  title: string;
  impact: "HIGH" | "MEDIUM" | "LOW";
  source: string;
  fetchedAt: number;
  forecast?: string | null;
  previous?: string | null;
  actual?: string | null;
}

export interface ScoreBreakdown {
  trendStructure: number;
  smc: number;
  technical: number;
  liquidity: number;
  momentum: number;
  volatility: number;
  sessionNews: number;
  total: number;
  notes: string[];
}

export interface Setup {
  strategy: StrategyId;
  direction: Direction;
  entry: number;
  stop: number; // stop estructural (antes de aplicar mínimos de ATR)
  target?: number; // objetivo estructural (liquidez opuesta)
  timeframe: Timeframe;
  reasons: string[];
  key: string; // clave de oportunidad para deduplicar
  invalidation: string;
  usedSweep?: boolean;
  usedZone?: boolean;
}

export type SignalStatus = "PENDING" | "ACTIVE" | "CLOSED" | "EXPIRED" | "INVALIDATED" | "BLOCKED";

export interface Signal {
  id: string;
  symbol: "USD/JPY";
  direction: Direction;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp3: number;
  rr: { tp1: number; tp2: number; tp3: number; netTp2: number };
  score: number;
  scoreBreakdown: ScoreBreakdown;
  classification: string;
  action: string;
  confirmationTf: Timeframe;
  strategies: StrategyId[];
  reasons: string[];
  createdAt: number;
  validUntil: number;
  invalidation: string;
  invalidationPrice: number;
  key: string;
  status: SignalStatus;
  orderType: "MARKET" | "LIMIT";
  session: string;
  sizing?: PositionSize;
  blockedReasons?: string[];
}

export interface PositionSize {
  lots: number;
  units: number;
  riskAmount: number;
  riskPct: number;
  stopPips: number;
  pipValuePerLot: number; // en divisa de la cuenta
  costPips: number;
}

export interface TfAnalysis {
  tf: Timeframe;
  candles: Candle[];
  ind: IndicatorSet;
  structure: StructureState;
  trend: Trend; // combinado EMA + estructura, en la última vela cerrada
  emaTrend: Trend;
  structureTrend: Trend;
}
