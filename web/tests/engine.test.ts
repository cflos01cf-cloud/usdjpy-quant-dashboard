import { describe, it, expect } from "vitest";
import { ema, rsi, atr, computeIndicators } from "../lib/engine/indicators";
import { computeStructure, findSwings } from "../lib/engine/structure";
import { isSessionActive, sessionInfo, tradingDayKey, computeSessionLevels } from "../lib/engine/sessions";
import { positionSize, pipValuePerLot, riskGate, emptyRiskState } from "../lib/engine/risk";
import { BROKER_PRESETS, DEFAULT_RISK, DEFAULT_SIGNAL } from "../lib/config";
import { newTrade, stepTrade } from "../lib/engine/tradeSim";
import { prepare, contextAt } from "../lib/engine/context";
import { evaluate } from "../lib/engine/signals";
import { synthCandles, fromCloses } from "./helpers";
import type { Signal } from "../lib/engine/types";

const utc = (y: number, m: number, d: number, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi) / 1000;

describe("indicadores", () => {
  it("EMA de serie constante es la constante", () => {
    const e = ema(new Array(50).fill(150), 20);
    expect(e[18]).toBeNaN();
    expect(e[49]).toBeCloseTo(150, 10);
  });
  it("RSI de serie sólo alcista = 100", () => {
    const r = rsi(Array.from({ length: 40 }, (_, i) => 150 + i * 0.01));
    expect(r[39]).toBe(100);
  });
  it("ATR con rango fijo converge al rango", () => {
    const c = Array.from({ length: 60 }, (_, i) => ({ time: i * 60, open: 150, close: 150, high: 150.1, low: 149.9 }));
    expect(atr(c)[59]).toBeCloseTo(0.2, 6);
  });
  it("indicadores son causales (prefijo = serie completa)", () => {
    const c = synthCandles(400, 900);
    const full = computeIndicators(c);
    const pre = computeIndicators(c.slice(0, 300));
    for (const k of ["ema20", "ema200", "rsi", "macdHist", "atr", "adx"] as const) expect(pre[k][299]).toBeCloseTo(full[k][299], 10);
  });
});

describe("estructura SMC", () => {
  it("detecta BOS alcista y luego CHoCH bajista", () => {
    // sube a 150.5 (swing high), retrocede, rompe arriba (BOS), forma swing low y lo rompe (CHoCH)
    const closes = [150, 150.1, 150.2, 150.3, 150.5, 150.4, 150.3, 150.2, 150.1, 150.25, 150.35, 150.45, 150.6, 150.7, 150.8, 150.75, 150.6, 150.5, 150.4, 150.45, 150.55, 150.5, 150.3, 150.1, 149.9];
    const c = fromCloses(closes);
    const s = computeStructure(c, new Array(c.length).fill(0.1), 2, 0);
    const types = s.events.map((e) => `${e.type}:${e.direction}`);
    expect(types).toContain("BOS:LONG");
    expect(types[types.length - 1]).toBe("CHOCH:SHORT");
  });
  it("los swings sólo se confirman lookback velas después", () => {
    const c = synthCandles(200, 900);
    for (const sw of findSwings(c, 3)) expect(sw.confirmedAt).toBe(sw.index + 3);
  });
  it("estructura causal: eventos del prefijo coinciden con los de la serie completa", () => {
    const c = synthCandles(800, 900, undefined, 11);
    const a = computeIndicators(c).atr;
    const full = computeStructure(c, a, 3);
    const pre = computeStructure(c.slice(0, 500), a.slice(0, 500), 3);
    const f = full.events.filter((e) => e.index < 500).map((e) => `${e.index}${e.type}${e.direction}`);
    expect(pre.events.map((e) => `${e.index}${e.type}${e.direction}`)).toEqual(f);
    expect(pre.trend.slice(0, 500)).toEqual(full.trend.slice(0, 500));
  });
  it("detecta FVG alcista", () => {
    const c = [
      { time: 0, open: 150, high: 150.05, low: 149.95, close: 150.02 },
      { time: 900, open: 150.02, high: 150.4, low: 150.0, close: 150.38 },
      { time: 1800, open: 150.38, high: 150.5, low: 150.2, close: 150.45 },
    ];
    const s = computeStructure(c, [0.1, 0.1, 0.1], 1, 0);
    const fvg = s.zones.find((z) => z.kind === "FVG");
    expect(fvg?.direction).toBe("LONG");
    expect(fvg?.bottom).toBeCloseTo(150.05);
    expect(fvg?.top).toBeCloseTo(150.2);
  });
});

describe("sesiones con horario de verano", () => {
  it("Londres abre 07:00 UTC en julio y 08:00 UTC en enero", () => {
    expect(isSessionActive("LONDON", utc(2026, 7, 15, 7, 0))).toBe(true);
    expect(isSessionActive("LONDON", utc(2026, 7, 15, 6, 59))).toBe(false);
    expect(isSessionActive("LONDON", utc(2026, 1, 15, 7, 30))).toBe(false);
    expect(isSessionActive("LONDON", utc(2026, 1, 15, 8, 0))).toBe(true);
  });
  it("Nueva York 08:00 local = 12:00 UTC en verano / 13:00 UTC en invierno", () => {
    expect(isSessionActive("NEW_YORK", utc(2026, 7, 15, 12, 0))).toBe(true);
    expect(isSessionActive("NEW_YORK", utc(2026, 12, 15, 12, 30))).toBe(false);
  });
  it("sábado = mercado cerrado", () => {
    expect(sessionInfo(utc(2026, 10, 31, 15)).label).toBe("MERCADO CERRADO");
  });
  it("rollover del día de trading a las 17:00 NY", () => {
    // 2026-11-02 lunes: 21:59 UTC = 16:59 NY (EST)
    expect(tradingDayKey(utc(2026, 11, 2, 21, 59))).toBe("2026-11-02");
    expect(tradingDayKey(utc(2026, 11, 2, 22, 0))).toBe("2026-11-03");
  });
  it("niveles de sesión: PDH/PDL disponibles desde el segundo día", () => {
    const c = synthCandles(24 * 12 * 3, 300, utc(2026, 1, 5, 0));
    const L = computeSessionLevels(c);
    expect(L[10].pdh).toBeNull();
    expect(L[L.length - 1].pdh).not.toBeNull();
  });
});

describe("riesgo", () => {
  const broker = BROKER_PRESETS.EXNESS_STANDARD;
  it("valor del pip USD/JPY = 1000/precio USD por lote", () => {
    expect(pipValuePerLot(150, broker, DEFAULT_RISK)).toBeCloseTo(6.6667, 3);
  });
  it("tamaño de posición incluye costos y redondea hacia abajo", () => {
    const ps = positionSize(150, 149.8, broker, DEFAULT_RISK); // 20 pips
    // 50 USD / ((20 + 1.1 + 0.6) × 6.667) = 0.3456 → 0.34
    expect(ps.lots).toBe(0.34);
    expect(ps.riskAmount).toBeLessThanOrEqual(50);
  });
  it("bloquea al alcanzar límites", () => {
    const st = { ...emptyRiskState("d", "w"), realizedDayPct: -1.8 };
    expect(riskGate(st, DEFAULT_RISK, 0).join()).toMatch(/Riesgo diario/);
    expect(riskGate({ ...emptyRiskState("d", "w"), openPositions: 1 }, DEFAULT_RISK, 0).join()).toMatch(/simultáneas/);
    expect(riskGate(emptyRiskState("d", "w"), { ...DEFAULT_RISK, killSwitch: true }, 0).join()).toMatch(/Kill/);
  });
});

describe("simulación de operaciones", () => {
  const base = utc(2026, 3, 10, 13, 0); // martes, NY abierto
  const sig = { id: "x", direction: "LONG", entry: 150, stop: 149.8, tp1: 150.4, tp2: 150.6, tp3: 150.8, createdAt: base, validUntil: base + 3600 } as unknown as Signal;
  const params = { broker: BROKER_PRESETS.EXNESS_RAW, cfg: DEFAULT_SIGNAL, spreadPips: 0, tfSec: 60, atr: 0.15 };
  const bar = (i: number, o: number, h: number, l: number, c: number) => ({ time: base + i * 60, open: o, high: h, low: l, close: c });
  it("TP1 → BE: el resto sale en break-even", () => {
    let t = newTrade(sig, DEFAULT_SIGNAL);
    t = stepTrade(t, [bar(0, 150.05, 150.06, 149.99, 150.02), bar(1, 150.02, 150.45, 150.0, 150.4), bar(2, 150.4, 150.41, 149.9, 149.95)], params);
    expect(t.status).toBe("CLOSED");
    expect(t.fills.map((f) => f.reason)).toEqual(["TP1", "BE"]);
    expect(t.resultR!).toBeGreaterThan(0.9); // 0.5 × 2R menos slippage/comisión
  });
  it("SL y TP en la misma vela → SL primero", () => {
    let t = newTrade(sig, DEFAULT_SIGNAL);
    t = stepTrade(t, [bar(0, 150.05, 150.06, 149.99, 150.02), bar(1, 150.0, 150.9, 149.7, 150.5)], params);
    expect(t.fills[0].reason).toBe("SL");
    expect(t.resultR!).toBeLessThan(-1);
  });
  it("expira si no se llena", () => {
    let t = newTrade(sig, DEFAULT_SIGNAL);
    t = stepTrade(t, [bar(0, 150.2, 150.3, 150.1, 150.2), bar(61, 150.2, 150.3, 150.1, 150.2)], params);
    expect(t.status).toBe("EXPIRED");
  });
});

describe("motor completo", () => {
  it("evalúa sin errores y es causal (mismo resultado con datos futuros añadidos)", () => {
    const start = utc(2025, 6, 2, 0);
    const m5 = synthCandles(12 * 24 * 40, 300, start, 3);
    const agg = (tf: number) => {
      const out: typeof m5 = [];
      for (const c of m5) {
        const t = c.time - (c.time % tf);
        const l = out[out.length - 1];
        if (l && l.time === t) { l.high = Math.max(l.high, c.high); l.low = Math.min(l.low, c.low); l.close = c.close; }
        else out.push({ ...c, time: t });
      }
      return out;
    };
    const cut = m5.length - 500;
    const mk = (end: number) => {
      const sub = m5.slice(0, end);
      const endT = sub[sub.length - 1].time + 300;
      const f = (tf: number) => agg(tf).filter((c) => c.time + tf <= endT);
      return prepare({ M5: sub, M15: f(900), H1: f(3600), H4: f(14400), D1: f(86400) });
    };
    const full = mk(m5.length), pre = mk(cut);
    let produced = 0;
    for (let i = cut - 300; i < cut; i += 3) {
      const a = contextAt(full, i, 1.0)!, b = contextAt(pre, i, 1.0)!;
      const opts = { news: { blocked: false, nearHighImpact: false }, signalCfg: DEFAULT_SIGNAL, broker: BROKER_PRESETS.EXNESS_STANDARD, riskCfg: DEFAULT_RISK, riskState: null, recentKeys: new Map(), live: false, dataLive: true };
      const ea = evaluate({ ctx: a, ...opts }), eb = evaluate({ ctx: b, ...opts });
      expect(ea.evals.map((e) => e.score.total)).toEqual(eb.evals.map((e) => e.score.total));
      expect(ea.signal?.id ?? null).toEqual(eb.signal?.id ?? null);
      if (ea.signal) produced++;
    }
    expect(produced).toBeGreaterThanOrEqual(0);
  });
});
