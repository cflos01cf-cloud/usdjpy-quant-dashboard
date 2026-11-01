"use client";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { Levels } from "./PriceChart";

const PriceChart = dynamic(() => import("./PriceChart"), { ssr: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const p3 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : Number(v).toFixed(3));
const p1 = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : Number(v).toFixed(d));
const cdmx = (t: number | null | undefined, date = false) =>
  t ? new Date(t * 1000).toLocaleString("es-MX", { timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit", hour12: false, ...(date ? { day: "2-digit", month: "short" } : {}) }) : "—";
const trendCls = (t?: string) => (t === "BULLISH" ? "long" : t === "BEARISH" ? "short" : "muted");
const trendEs = (t?: string) => (t === "BULLISH" ? "ALCISTA" : t === "BEARISH" ? "BAJISTA" : "NEUTRAL");
const STRAT: Record<string, string> = { A_SMC: "A · SMC", B_TREND: "B · Tendencia", C_PRICE_ACTION: "C · Price Action", D_LIQUIDITY: "D · Liquidez", E_BREAKOUT: "E · Breakout" };
const SES: Record<string, string> = { SYDNEY: "Sídney", TOKYO: "Tokio", LONDON: "Londres", NEW_YORK: "Nueva York" };

export default function Dashboard() {
  const [state, setState] = useState<Any>(null);
  const [paper, setPaper] = useState<Any>(null);
  const [bt, setBt] = useState<Any>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/state", { cache: "no-store" });
        const j = await r.json();
        if (!alive) return;
        if (j.error) setErr(j.error); else { setState(j); setErr(null); }
      } catch (e) { if (alive) setErr((e as Error).message); }
    };
    const loadPaper = () => fetch("/api/paper").then((r) => r.json()).then((j) => alive && setPaper(j)).catch(() => {});
    load(); loadPaper();
    fetch("/api/backtest").then((r) => r.json()).then((j) => alive && setBt(j)).catch(() => {});
    const a = setInterval(load, 30_000), b = setInterval(loadPaper, 120_000);
    return () => { alive = false; clearInterval(a); clearInterval(b); };
  }, []);

  const s = state?.snapshot;
  const active = state?.activeSignals?.[0];
  const cand = s?.candidate;
  const levels: Levels | null = useMemo(() => {
    const x = active ?? (cand && cand.score >= 70 ? cand : null);
    if (!x) return null;
    return { direction: x.direction, entry: +x.entry, stop: +x.stop, tp1: +x.tp1, tp2: +x.tp2, tp3: +x.tp3, label: active ? x.status : "CANDIDATA" };
  }, [active, cand]);

  const status = s?.status ?? "NO_DATA";

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <h1>USD/JPY Quant Engine</h1>
          <span>intradía · Exness · TwelveData</span>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className="muted" style={{ fontSize: 12 }}>
            Actualizado {cdmx(s?.generatedAt, true)} CDMX{state?.lastRun ? ` · ${state.lastRun.credits_used ?? 0} créditos último ciclo` : ""}
          </span>
          <span className={`status ${status}`}><i />{status.replace("_", " ")}</span>
          <KillSwitch on={!!s?.risk?.config?.killSwitch || !!s?.risk?.state?.killSwitch} />
        </div>
      </div>

      {err && <div className="panel body warn" style={{ marginBottom: 14 }}>Error al leer el estado: {err}</div>}
      {s?.note && <div className="panel body muted" style={{ marginBottom: 14 }}>{s.note}</div>}

      <div className="kpis">
        <div className="kpi price"><label>USD/JPY</label><b className="num">{p3(s?.price)}</b><small>vela M5 {cdmx(s?.evaluatedBarClose)}</small></div>
        <div className="kpi"><label>Variación diaria</label><b className={`num ${s?.dailyChange?.abs >= 0 ? "long" : "short"}`}>{s?.dailyChange ? `${s.dailyChange.abs >= 0 ? "+" : ""}${p1(s.dailyChange.abs / 0.01)} p` : "—"}</b><small className="num">{s?.dailyChange ? `${p1(s.dailyChange.pct, 2)}%` : ""}</small></div>
        <div className="kpi"><label>Spread</label><b className="num">{p1(s?.spread?.pips)} p</b><small title={s?.spread?.source}>configurado</small></div>
        <div className="kpi"><label>Tendencia (sesgo HTF)</label><b className={s?.bias === "ALCISTA" ? "long" : s?.bias === "BAJISTA" ? "short" : "muted"}>{s?.bias ?? "—"}</b><small>D1 {trendEs(s?.trends?.D1)}</small></div>
        <div className="kpi"><label>Sesión</label><b style={{ fontSize: 13 }}>{s?.session?.label ?? "—"}</b><small>{s?.session?.nextChangeUtc ? `cambia ${cdmx(s.session.nextChangeUtc)}` : ""}</small></div>
        <div className="kpi"><label>ATR M15</label><b className="num">{p1(s?.atr?.m15Pips)} p</b><small className="num">H1 {p1(s?.atr?.h1Pips)} p · pct {p1(s?.atr?.pctM15, 0)}</small></div>
        <div className="kpi"><label>Momentum</label><b className={s?.momentum?.label?.includes("BULL") ? "long" : s?.momentum?.label?.includes("BEAR") ? "short" : "muted"} style={{ fontSize: 13 }}>{s?.momentum?.label ?? "—"}</b><small className="num">RSI {p1(s?.momentum?.rsiM15, 0)} · ADX {p1(s?.momentum?.adxM15, 0)}</small></div>
        <div className="kpi"><label>Señal actual</label><b className={(active ?? cand)?.direction === "LONG" ? "long" : (active ?? cand)?.direction === "SHORT" ? "short" : "muted"}>{active ? `${active.direction} · ${active.status}` : cand && cand.score >= 70 ? `${cand.direction} · ${cand.status === "BLOCKED" ? "BLOQ." : "VIGILAR"}` : "SIN SEÑAL"}</b><small>{(active ?? cand)?.strategies?.map((x: string) => x[0]).join(" + ") ?? ""}</small></div>
        <div className="kpi"><label>Score</label><b className="num">{(active ?? cand)?.score ?? "—"}<span className="muted" style={{ fontSize: 12 }}>/100</span></b><small>{(active ?? cand)?.classification ?? ""}</small></div>
        <div className="kpi"><label>Estado del mercado</label><b className={s?.marketState === "HIGH_VOLATILITY" ? "warn" : ""} style={{ fontSize: 13 }}>{s?.marketState?.replace("_", " ") ?? "—"}</b><small>ADX H1 {p1(s?.momentum?.adxH1, 0)}</small></div>
      </div>

      <div className="grid">
        <div className="col">
          <PriceChart levels={levels} />
          <div className="row2">
            <Opportunities active={state?.activeSignals ?? []} recent={paper?.signals ?? []} />
            <Paper paper={paper} />
          </div>
          <Backtest bt={bt} />
        </div>
        <div className="col">
          <SignalCard sig={active ?? cand} isActive={!!active} />
          <Market s={s} />
          <Sessions s={s} />
          <News s={s} />
          <Risk s={s} />
          <Macro m={s?.macro} />
          <Quality s={s} />
        </div>
      </div>
      <p className="disclaimer">
        Herramienta de análisis. El score no es una probabilidad de ganar y los resultados de backtest o paper trading no garantizan resultados futuros.
        El spread mostrado es el configurado para el broker (TwelveData no entrega bid/ask). Sin conexión, el panel lo indica: nunca se simulan precios.
      </p>
    </div>
  );
}

function KillSwitch({ on }: { on: boolean }) {
  const toggle = async () => {
    let token = "";
    try { token = sessionStorage.getItem("adminToken") ?? ""; } catch {}
    if (!token) { token = prompt("ADMIN_TOKEN") ?? ""; try { sessionStorage.setItem("adminToken", token); } catch {} }
    if (!token) return;
    const r = await fetch("/api/killswitch", { method: "POST", headers: { "Content-Type": "application/json", "x-admin-token": token }, body: JSON.stringify({ on: !on }) });
    if (r.status === 401) { try { sessionStorage.removeItem("adminToken"); } catch {} alert("Token inválido"); }
    else location.reload();
  };
  return <button className={`btn ${on ? "" : "danger"}`} onClick={toggle}>{on ? "Reactivar motor" : "Kill switch"}</button>;
}

function SignalCard({ sig, isActive }: { sig: Any; isActive: boolean }) {
  return (
    <section className="panel">
      <header><h2>{isActive ? "Operación activa" : "Mejor oportunidad"}</h2>{sig && <span className="pill">{sig.orderType}</span>}</header>
      <div className="body">
        {!sig ? <div className="empty">Ningún motor detecta un setup ahora. No se fuerzan operaciones.</div> : (
          <div className={`signal ${sig.direction}`}>
            <h3><span className={sig.direction === "LONG" ? "long" : "short"}>{sig.direction}</span><span className="muted" style={{ fontSize: 12 }}>{cdmx(typeof sig.createdAt === "number" ? sig.createdAt : Date.parse(sig.created_at) / 1000)} · TF {sig.confirmationTf ?? sig.confirmation_tf}</span></h3>
            <div className="score"><b className="num">{sig.score}</b><div className="bar"><i style={{ width: `${sig.score}%`, background: sig.score >= 80 ? "var(--long)" : sig.score >= 70 ? "var(--warn)" : "var(--faint)" }} /></div><span className="muted" style={{ fontSize: 12 }}>{sig.classification ?? ""}</span></div>
            <div className="levels num">
              <div><label>Entry</label>{p3(+sig.entry)}</div>
              <div><label>SL</label><span className="short">{p3(+sig.stop)}</span></div>
              <div><label>R:R neto TP2</label>1:{sig.rr?.netTp2}</div>
              <div><label>TP1 · {sig.rr?.tp1}R</label><span className="long">{p3(+sig.tp1)}</span></div>
              <div><label>TP2 · {sig.rr?.tp2}R</label><span className="long">{p3(+sig.tp2)}</span></div>
              <div><label>TP3 · {sig.rr?.tp3}R</label><span className="long">{p3(+sig.tp3)}</span></div>
            </div>
            {sig.sizing && <div className="muted num" style={{ fontSize: 12 }}>{sig.sizing.lots} lotes · riesgo {sig.sizing.riskPct}% ({p1(sig.sizing.riskAmount, 2)}) · SL {p1(sig.sizing.stopPips)} p · costos {p1(sig.sizing.costPips)} p</div>}
            <div style={{ marginTop: 8 }}>{(sig.strategies ?? []).map((x: string) => <span key={x} className="pill">{STRAT[x] ?? x}</span>)}</div>
            <ul className="reasons">{(sig.reasons ?? []).map((r: string) => <li key={r}>{r}</li>)}</ul>
            {(sig.scoreBreakdown ?? sig.score_breakdown) && <Breakdown b={sig.scoreBreakdown ?? sig.score_breakdown} />}
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Invalidación: {sig.invalidation}</div>
            {sig.blockedReasons?.length > 0 && <div className="blocked">No operar: {sig.blockedReasons.join(" · ")}</div>}
            {!isActive && !sig.blockedReasons?.length && sig.score < 80 && <div className="blocked">Score moderado: esperar confirmación</div>}
          </div>
        )}
      </div>
    </section>
  );
}

function Breakdown({ b }: { b: Any }) {
  const rows: [string, number, number][] = [["Tendencia y estructura", b.trendStructure, 20], ["Smart Money Concepts", b.smc, 20], ["Confirmación técnica", b.technical, 15], ["Liquidez", b.liquidity, 15], ["Momentum", b.momentum, 10], ["Volatilidad", b.volatility, 10], ["Sesión y noticias", b.sessionNews, 10]];
  return <div className="breakdown num">{rows.map(([l, v, m]) => [<span key={l} className="muted">{l}</span>, <span key={l + "v"}>{v}/{m}</span>])}</div>;
}

function Market({ s }: { s: Any }) {
  const up = (s?.liquidity ?? []).filter((l: Any) => l.side === "BUY_SIDE" && !l.swept).slice(-3);
  const down = (s?.liquidity ?? []).filter((l: Any) => l.side === "SELL_SIDE" && !l.swept).slice(0, 3);
  return (
    <section className="panel">
      <header><h2>Mercado</h2></header>
      <div className="body">
        <table className="kv num"><tbody>
          {["H4", "H1", "M15", "M5"].map((tf) => <tr key={tf}><td className="muted">Tendencia {tf}</td><td className={trendCls(s?.trends?.[tf])}>{trendEs(s?.trends?.[tf])}</td></tr>)}
          <tr><td className="muted">Sesgo institucional</td><td className={s?.bias === "ALCISTA" ? "long" : s?.bias === "BAJISTA" ? "short" : ""}>{s?.bias ?? "—"}</td></tr>
          <tr><td className="muted">Última estructura M5</td><td>{s?.lastStructureM5 ? `${s.lastStructureM5.type} ${s.lastStructureM5.direction}` : "—"}</td></tr>
          <tr><td className="muted">Liquidez arriba</td><td>{up.map((l: Any) => `${l.name} ${p3(l.price)}`).join(" · ") || "—"}</td></tr>
          <tr><td className="muted">Liquidez abajo</td><td>{down.map((l: Any) => `${l.name} ${p3(l.price)}`).join(" · ") || "—"}</td></tr>
          <tr><td className="muted">Próxima noticia</td><td>{s?.news?.state?.next ? `${s.news.state.next.currency} ${s.news.state.next.title} ${cdmx(s.news.state.next.time)}` : "—"}</td></tr>
        </tbody></table>
        <div style={{ marginTop: 10 }}>
          {(s?.conditions ?? []).map((c: Any) => <div key={c.label} className="cond"><span><span className={`dot ${c.ok ? "ok" : "no"}`} />{c.label}</span><span className="muted">{c.detail}</span></div>)}
        </div>
      </div>
    </section>
  );
}

function Sessions({ s }: { s: Any }) {
  const st = s?.sessionStats ?? {};
  const L = s?.sessionLevels;
  return (
    <section className="panel">
      <header><h2>Sesiones (hora CDMX)</h2></header>
      <div className="body">
        <table className="data num"><thead><tr><th>Sesión</th><th>Horario</th><th>Rango medio</th><th>% alcista</th></tr></thead><tbody>
          {(s?.schedule ?? []).map((x: Any) => (
            <tr key={x.name}><td className={x.active ? "long" : ""}>{x.active ? "● " : ""}{SES[x.name]}</td><td>{x.openCdmx}–{x.closeCdmx}</td><td>{st[x.name] ? `${p1(st[x.name].avgRangePips)} p` : "—"}</td><td>{st[x.name] ? `${p1(st[x.name].bullishPct, 0)}%` : "—"}</td></tr>
          ))}
        </tbody></table>
        {L && <div className="muted num" style={{ fontSize: 12, marginTop: 8 }}>Asia {p3(L.asiaH)} / {p3(L.asiaL)} · Londres {p3(L.lonH)} / {p3(L.lonL)} · PDH {p3(L.pdh)} · PDL {p3(L.pdl)}</div>}
        <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>Rango medio y dirección: últimas ~12 jornadas (H1). Rentabilidad por sesión: ver Paper trading y Backtest.</div>
      </div>
    </section>
  );
}

function News({ s }: { s: Any }) {
  const up = s?.news?.upcoming ?? [];
  return (
    <section className="panel">
      <header><h2>Calendario USD · JPY</h2>{s?.news?.state?.blocked && <span className="pill warn">BLOQUEO ACTIVO</span>}</header>
      <div className="body">
        {!up.length ? <div className="empty">Sin eventos próximos verificados.</div> : (
          <table className="data"><tbody>
            {up.map((e: Any) => <tr key={e.id}><td className="num">{cdmx(e.time, true)}</td><td><span className={e.impact === "HIGH" ? "short" : e.impact === "MEDIUM" ? "warn" : "muted"}>●</span> {e.currency}</td><td>{e.title}</td><td className="muted num">{e.forecast ?? ""}</td></tr>)}
          </tbody></table>
        )}
        <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>Fuente: {up[0]?.source ?? "forexfactory / manual"} · obtenido {cdmx(up[0]?.fetchedAt, true)}</div>
      </div>
    </section>
  );
}

function Risk({ s }: { s: Any }) {
  const st = s?.risk?.state, cfg = s?.risk?.config;
  return (
    <section className="panel">
      <header><h2>Gestión de riesgo</h2></header>
      <div className="body">
        <table className="kv num"><tbody>
          <tr><td className="muted">Capital</td><td>{cfg ? `${cfg.equity.toLocaleString()} ${cfg.accountCurrency}` : "—"}</td></tr>
          <tr><td className="muted">Riesgo por operación</td><td>{cfg?.riskPerTradePct}%</td></tr>
          <tr><td className="muted">P&L hoy / límite</td><td className={st?.realizedDayPct < 0 ? "short" : ""}>{p1(st?.realizedDayPct, 2)}% / −{cfg?.maxDailyRiskPct}%</td></tr>
          <tr><td className="muted">P&L semana / límite</td><td className={st?.realizedWeekPct < 0 ? "short" : ""}>{p1(st?.realizedWeekPct, 2)}% / −{cfg?.maxWeeklyLossPct}%</td></tr>
          <tr><td className="muted">Operaciones hoy</td><td>{st?.tradesToday ?? 0} / {cfg?.maxTradesPerDay}</td></tr>
          <tr><td className="muted">Posiciones abiertas</td><td>{st?.openPositions ?? 0} / {cfg?.maxOpenPositions}</td></tr>
          <tr><td className="muted">Pérdidas consecutivas</td><td>{st?.consecutiveLosses ?? 0} / {cfg?.maxConsecutiveLosses}</td></tr>
          <tr><td className="muted">Broker</td><td>{s?.broker?.name}</td></tr>
        </tbody></table>
        {(s?.risk?.gate ?? []).length > 0 && <div className="blocked">{s.risk.gate.join(" · ")}</div>}
      </div>
    </section>
  );
}

function Macro({ m }: { m: Any }) {
  return (
    <section className="panel">
      <header><h2>Macro EE. UU. – Japón</h2></header>
      <div className="body">
        {!m ? <div className="empty">Configura FRED_API_KEY para ver rendimientos y diferencial de tasas.</div> : (
          <table className="kv num"><tbody>
            <tr><td className="muted">UST 2Y</td><td>{p1(m.us2y?.value, 2)}% <span className="faint">{m.us2y?.date}</span></td></tr>
            <tr><td className="muted">UST 10Y</td><td>{p1(m.us10y?.value, 2)}% <span className="faint">{m.us10y?.date}</span></td></tr>
            <tr><td className="muted">JGB 10Y (mensual)</td><td>{p1(m.jp10y?.value, 2)}% <span className="faint">{m.jp10y?.date}</span></td></tr>
            <tr><td className="muted">Diferencial 10Y</td><td>{p1(m.diff10y, 2)} pp</td></tr>
            <tr><td className="muted">Δ UST 10Y (20 días)</td><td className={m.us10yChange20d > 0 ? "long" : "short"}>{p1(m.us10yChange20d, 2)} pp</td></tr>
          </tbody></table>
        )}
      </div>
    </section>
  );
}

function Quality({ s }: { s: Any }) {
  if (!s?.quality && !s?.errors?.length) return null;
  return (
    <section className="panel">
      <header><h2>Integridad de datos</h2></header>
      <div className="body">
        <table className="data num"><tbody>
          {(s?.quality ?? []).map((q: Any) => <tr key={q.tf}><td>{q.tf}</td><td>{q.kept} velas</td><td className="muted">cierre {cdmx(q.lastClose)}</td><td className={q.issues.length ? "warn" : "muted"}>{q.issues[0] ?? "OK"}</td></tr>)}
        </tbody></table>
        {(s?.errors ?? []).map((e: string) => <div key={e} className="blocked">{e}</div>)}
      </div>
    </section>
  );
}

function Opportunities({ active, recent }: { active: Any[]; recent: Any[] }) {
  const rows = [...active, ...recent.filter((r) => !active.some((a) => a.id === r.id))].slice(0, 12);
  const est = (st: string) => (st === "PENDING" ? "Esperando" : st === "ACTIVE" ? "Activa" : st === "CLOSED" ? "Cerrada" : st === "EXPIRED" ? "Expirada" : st === "INVALIDATED" ? "Invalidada" : st);
  return (
    <section className="panel">
      <header><h2>Oportunidades</h2></header>
      <div className="body" style={{ overflowX: "auto" }}>
        {!rows.length ? <div className="empty">Sin señales registradas todavía.</div> : (
          <table className="data num"><thead><tr><th>Hora</th><th>Dir.</th><th>Entry</th><th>SL</th><th>TP1</th><th>TP2</th><th>TP3</th><th>Score</th><th>R:R</th><th>Estado</th><th>R</th></tr></thead><tbody>
            {rows.map((r) => (
              <tr key={r.id}><td>{cdmx(Date.parse(r.created_at) / 1000, true)}</td><td className={r.direction === "LONG" ? "long" : "short"}>{r.direction}</td><td>{p3(+r.entry)}</td><td>{p3(+r.stop)}</td><td>{p3(+r.tp1)}</td><td>{p3(+r.tp2)}</td><td>{p3(+r.tp3)}</td><td>{r.score}</td><td>1:{r.rr?.netTp2}</td><td>{est(r.status)}</td><td className={r.result_r > 0 ? "long" : r.result_r < 0 ? "short" : ""}>{r.result_r !== null && r.result_r !== undefined ? p1(+r.result_r, 2) : ""}</td></tr>
            ))}
          </tbody></table>
        )}
      </div>
    </section>
  );
}

function MetricsTable({ m }: { m: Any }) {
  if (!m) return null;
  const pf = m.profitFactor === null || m.profitFactor === undefined ? "—" : Number.isFinite(m.profitFactor) ? p1(m.profitFactor, 2) : "∞";
  return (
    <table className="kv num"><tbody>
      <tr><td className="muted">Operaciones</td><td>{m.trades}</td></tr>
      <tr><td className="muted">Win rate</td><td>{p1(m.winRate)}%</td></tr>
      <tr><td className="muted">Profit factor</td><td>{pf}</td></tr>
      <tr><td className="muted">Expectativa neta</td><td className={m.expectancyR > 0 ? "long" : "short"}>{p1(m.expectancyR, 3)} R</td></tr>
      <tr><td className="muted">Resultado neto</td><td>{p1(m.netR, 2)} R</td></tr>
      <tr><td className="muted">Máx. drawdown</td><td>{p1(m.maxDrawdownR, 2)} R</td></tr>
      <tr><td className="muted">Sharpe / Sortino</td><td>{p1(m.sharpe, 2)} / {p1(m.sortino, 2)}</td></tr>
      <tr><td className="muted">Rachas G / P</td><td>{m.maxWinStreak} / {m.maxLossStreak}</td></tr>
    </tbody></table>
  );
}

function Paper({ paper }: { paper: Any }) {
  return (
    <section className="panel">
      <header><h2>Paper trading</h2><span className="muted num" style={{ fontSize: 12 }}>{paper?.counts ? `${paper.counts.closed} cerradas · ${paper.counts.expired} expiradas · ${paper.counts.open} abiertas` : ""}</span></header>
      <div className="body">
        {!paper?.metrics?.trades ? <div className="empty">Aún no hay operaciones cerradas. Meta antes de capital real: ≥ 50 señales cerradas con expectativa neta positiva.</div> : (
          <>
            <MetricsTable m={paper.metrics} />
            <div style={{ marginTop: 10 }}>
              {Object.entries(paper.byStrategy ?? {}).map(([k, v]: Any) => <span key={k} className="pill num">{STRAT[k] ?? k}: {v.trades} · {p1(v.expectancyR, 2)}R</span>)}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Backtest({ bt }: { bt: Any }) {
  return (
    <section className="panel">
      <header><h2>Backtest · Walk-forward · Monte Carlo</h2>{bt?.generatedAt && <span className="muted" style={{ fontSize: 12 }}>{bt.dataRange} · generado {bt.generatedAt?.slice(0, 10)}</span>}</header>
      <div className="body">
        {bt?.synthetic && <div className="blocked" style={{ marginBottom: 8 }}>⚠️ Resultados sobre datos SINTÉTICOS: sólo prueban el pipeline, no dicen nada del mercado real.</div>}
        {!bt?.available ? <div className="empty">{bt?.note ?? "Sin resultados."}</div> : (
          <div className="row2">
            <div>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>FUERA DE MUESTRA (walk-forward, configuración recomendada)</div>
              <MetricsTable m={bt.oos} />
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>POR ESTRATEGIA (OOS)</div>
              <table className="data num"><tbody>
                {Object.entries(bt.byStrategy ?? {}).map(([k, v]: Any) => <tr key={k}><td>{STRAT[k] ?? k}</td><td>{v.trades}</td><td className={v.expectancyR > 0 ? "long" : "short"}>{p1(v.expectancyR, 3)}R</td><td>PF {Number.isFinite(v.profitFactor) ? p1(v.profitFactor, 2) : "∞"}</td></tr>)}
              </tbody></table>
              {bt.monteCarlo && <div className="muted num" style={{ fontSize: 12, marginTop: 8 }}>Monte Carlo ({bt.monteCarlo.runs} sims): DD p95 {p1(bt.monteCarlo.ddP95, 1)}R · prob. resultado negativo {p1(bt.monteCarlo.probNegative * 100, 1)}%</div>}
              {bt.recommended && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Recomendada: {JSON.stringify(bt.recommended)}</div>}
              {bt.ml && <div className="muted num" style={{ fontSize: 12, marginTop: 6 }}>Filtro ML (meta-labeling): {p1(bt.ml.base?.expectancyR, 3)}R → {p1(bt.ml.ml?.expectancyR, 3)}R · {bt.ml.recommendation}</div>}
              {bt.scoreBands && <div className="muted num" style={{ fontSize: 12, marginTop: 6 }}>Por banda de score: {Object.entries(bt.scoreBands).map(([k, v]: Any) => `${k}: ${p1(v.expectancyR, 2)}R (${v.trades})`).join(" · ")}</div>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
