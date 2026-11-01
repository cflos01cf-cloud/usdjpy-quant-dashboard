/** Métricas de rendimiento sobre una lista de resultados en R (y opcionalmente fecha/estrategia/sesión). */
export interface TradeResult { r: number; time: number; strategy?: string; session?: string }

export interface Metrics {
  trades: number;
  winRate: number;
  profitFactor: number;
  netR: number;
  expectancyR: number;
  avgWinR: number;
  avgLossR: number;
  maxDrawdownR: number;
  sharpe: number | null; // diario, anualizado √252
  sortino: number | null;
  maxWinStreak: number;
  maxLossStreak: number;
}

export function computeMetrics(rs: TradeResult[]): Metrics {
  const n = rs.length;
  const wins = rs.filter((x) => x.r > 0), losses = rs.filter((x) => x.r <= 0);
  const gw = wins.reduce((a, x) => a + x.r, 0), gl = -losses.reduce((a, x) => a + x.r, 0);
  let eq = 0, peak = 0, mdd = 0, ws = 0, ls = 0, mws = 0, mls = 0;
  for (const x of [...rs].sort((a, b) => a.time - b.time)) {
    eq += x.r; peak = Math.max(peak, eq); mdd = Math.max(mdd, peak - eq);
    if (x.r > 0) { ws++; ls = 0; } else { ls++; ws = 0; }
    mws = Math.max(mws, ws); mls = Math.max(mls, ls);
  }
  const byDay = new Map<string, number>();
  for (const x of rs) { const k = new Date(x.time * 1000).toISOString().slice(0, 10); byDay.set(k, (byDay.get(k) ?? 0) + x.r); }
  const d = [...byDay.values()];
  const mean = d.reduce((a, b) => a + b, 0) / (d.length || 1);
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, d.length - 1));
  const dd = Math.sqrt(d.reduce((a, b) => a + Math.min(0, b) ** 2, 0) / Math.max(1, d.length));
  return {
    trades: n,
    winRate: n ? (100 * wins.length) / n : 0,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    netR: gw - gl,
    expectancyR: n ? (gw - gl) / n : 0,
    avgWinR: wins.length ? gw / wins.length : 0,
    avgLossR: losses.length ? -gl / losses.length : 0,
    maxDrawdownR: mdd,
    sharpe: d.length > 5 && sd > 0 ? (mean / sd) * Math.sqrt(252) : null,
    sortino: d.length > 5 && dd > 0 ? (mean / dd) * Math.sqrt(252) : null,
    maxWinStreak: mws,
    maxLossStreak: mls,
  };
}

export function groupMetrics(rs: TradeResult[], key: (x: TradeResult) => string | undefined) {
  const g = new Map<string, TradeResult[]>();
  for (const x of rs) { const k = key(x) ?? "—"; g.set(k, [...(g.get(k) ?? []), x]); }
  return Object.fromEntries([...g.entries()].map(([k, v]) => [k, computeMetrics(v)]));
}
