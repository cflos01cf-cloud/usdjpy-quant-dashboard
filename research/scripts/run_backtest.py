#!/usr/bin/env python3
"""Backtest completo del motor USD/JPY.

  python scripts/run_backtest.py --m5 data/usdjpy_m5.json [--m1 data/usdjpy_m1.json] [--spread 1.1]
  python scripts/run_backtest.py --download --start 2024-01-01      # descarga M5 de TwelveData (TWELVEDATA_API_KEY)
  python scripts/run_backtest.py --csv dukascopy_m1.csv             # importa CSV (M1 o M5) y remuestrea

Genera research/output/report.md y web/data/backtest/latest.json (lo lee el dashboard).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "research"))

from usdjpy_research import data as D  # noqa: E402
from usdjpy_research.evaluation import Config, load_candidates, simulate_portfolio, trade_metrics, grouped  # noqa: E402
from usdjpy_research.validation import walk_forward, select_config, monte_carlo, score_bands, meta_labeling, regimes, make_folds  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--m5"); ap.add_argument("--m1"); ap.add_argument("--csv")
    ap.add_argument("--download", action="store_true"); ap.add_argument("--start", default="2024-01-01")
    ap.add_argument("--spread", type=float, default=1.1); ap.add_argument("--broker", default="EXNESS_STANDARD")
    ap.add_argument("--is-days", type=int, default=180); ap.add_argument("--oos-days", type=int, default=60)
    ap.add_argument("--min-trades", type=int, default=20)
    ap.add_argument("--label", default=None, help="Etiqueta del origen de datos (aparece en el reporte)")
    ap.add_argument("--no-dashboard", action="store_true", help="No escribir web/data/backtest/latest.json")
    a = ap.parse_args()

    work = ROOT / "research" / "data"; work.mkdir(parents=True, exist_ok=True)
    out_dir = ROOT / "research" / "output"; out_dir.mkdir(parents=True, exist_ok=True)
    m5_path, m1_path = a.m5, a.m1
    if a.download:
        key = os.environ["TWELVEDATA_API_KEY"]
        df = D.download_twelvedata("M5", a.start, key); m5_path = str(work / "usdjpy_m5.json"); D.save_json(df, m5_path)
    if a.csv:
        df = D.load_csv(a.csv)
        step = int(np.median(np.diff(df["time"].values[:1000])))
        if step == 60:
            m1_path = str(work / "usdjpy_m1.json"); D.save_json(df, m1_path)
        m5_path = str(work / "usdjpy_m5.json"); D.save_json(D.resample(df, 5) if step < 300 else df, m5_path)
    if not m5_path:
        ap.error("indica --m5, --csv o --download")

    cand_path = work / "candidates.jsonl"
    cmd = ["npx", "tsx", "scripts/backtest-export.ts", "--m5", str(Path(m5_path).resolve()), "--out", str(cand_path), "--spread", str(a.spread), "--broker", a.broker]
    if m1_path:
        cmd += ["--m1", str(Path(m1_path).resolve())]
    print("» Exportando candidatas con el motor TS…")
    subprocess.run(cmd, cwd=ROOT / "web", check=True)

    c = load_candidates(cand_path)
    if c.empty:
        sys.exit("Sin candidatas: revisa el histórico (¿suficientes días?).")
    t0, t1 = int(c["time"].min()), int(c["time"].max())
    rng = f"{pd.to_datetime(t0, unit='s'):%Y-%m-%d} → {pd.to_datetime(t1, unit='s'):%Y-%m-%d}"
    print(f"» {len(c)} candidatas · {rng}")

    print("» Walk-forward…")
    wf = walk_forward(c, a.is_days, a.oos_days, 1, a.min_trades)
    oos = wf["trades"]
    folds = make_folds(t0, t1, a.is_days, a.oos_days, 1)

    print("» Configuración recomendada (últimos IS días, selección suavizada)…")
    recent = c["time"] >= t1 - a.is_days * 86400
    rec_cfg, rec_info = select_config(c, recent, a.min_trades)
    if not np.isfinite(rec_info["smoothed"]):
        rec_cfg = Config()

    filled = oos[oos["filled"]] if not oos.empty else oos
    print("» Monte Carlo, bandas de score, ML y regímenes…")
    mc = monte_carlo(filled["r"].values if not filled.empty else np.array([]))
    ml = meta_labeling(c, rec_cfg, folds)
    reg = regimes(c, oos, folds)
    if not oos.empty:
        oos["volTercile"] = pd.qcut(oos["atrPct"].astype(float), 3, labels=["baja", "media", "alta"], duplicates="drop")

    # comparación de las 5 estrategias por separado sobre todo el periodo (sólo informativo, IS+OOS)
    solo = {s: trade_metrics(simulate_portfolio(c, Config(rec_cfg.threshold, rec_cfg.variant, (s,)))) for s in sorted(c["primary"].dropna().unique())}

    rep = {
        "available": True,
        "synthetic": bool(a.label and "SINT" in a.label.upper()),
        "dataLabel": a.label or Path(m5_path).name,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "dataRange": rng,
        "simulationTf": "M1" if m1_path else "M5",
        "spreadPips": a.spread, "broker": a.broker,
        "candidates": int(len(c)),
        "oos": trade_metrics(oos) if not oos.empty else trade_metrics(pd.DataFrame(columns=["filled", "r", "time"])),
        "oosSignals": int(len(oos)), "oosUnfilled": int((~oos["filled"]).sum()) if not oos.empty else 0,
        "byStrategy": grouped(oos, "strategy"), "bySession": grouped(oos, "session"), "byWeekday": grouped(oos, "weekday"),
        "byHourNy": grouped(oos, "hourNy"), "byVolatility": grouped(oos, "volTercile") if not oos.empty else {},
        "byMarketState": grouped(oos, "marketState"), "byDirection": grouped(oos, "direction"),
        "scoreBands": score_bands(oos), "monteCarlo": mc, "folds": wf["folds"],
        "recommended": rec_cfg.label(), "recommendedInfo": {k: float(v) for k, v in rec_info.items()},
        "strategiesStandalone": solo, "ml": ml, "regimes": reg,
        "caveats": [
            "Sin bloqueo histórico de noticias (no hay calendario histórico verificable en el pipeline); el motor en vivo sí bloquea.",
            "Spread fijo; el real se amplía en rollover y noticias.",
            "Resultados pasados no garantizan resultados futuros; el score no es una probabilidad.",
        ],
    }
    clean = json.loads(json.dumps(rep, default=_json_default).replace("Infinity", "null").replace("NaN", "null"))
    (out_dir / "report.json").write_text(json.dumps(clean, indent=1, ensure_ascii=False))
    (out_dir / "report.md").write_text(markdown(clean), encoding="utf-8")
    if not a.no_dashboard:
        (ROOT / "web" / "data" / "backtest" / "latest.json").write_text(json.dumps(clean, ensure_ascii=False))
    print(markdown(clean)[:3000])


def _json_default(o):
    if isinstance(o, (np.integer,)): return int(o)
    if isinstance(o, (np.floating,)): return None if not np.isfinite(o) else float(o)
    if isinstance(o, float) and not np.isfinite(o): return None
    return str(o)


def markdown(r: dict) -> str:
    m = r["oos"]
    f = lambda v, d=2: "—" if v is None else f"{v:.{d}f}"
    L = [f"# Backtest USD/JPY — {r['dataLabel']}", "", f"Periodo {r['dataRange']} · simulación {r['simulationTf']} · spread {r['spreadPips']} pips · {r['broker']}", ""]
    if r.get("synthetic"):
        L += ["> ⚠️ DATOS SINTÉTICOS: sólo validan que el pipeline funciona. Estas cifras no dicen nada del mercado real.", ""]
    L += ["## Fuera de muestra (walk-forward concatenado)", "",
          f"| Trades | Win rate | PF | Expectativa | Neto | MaxDD | Sharpe | Sortino |", "|---|---|---|---|---|---|---|---|",
          f"| {m['trades']} | {f(m['winRate'],1)}% | {f(m['profitFactor'])} | {f(m['expectancyR'],3)} R | {f(m['netR'])} R | {f(m['maxDrawdownR'])} R | {f(m['sharpe'])} | {f(m['sortino'])} |", "",
          f"Configuración recomendada: `{r['recommended']}`", "", "## Por estrategia (OOS)", "", "| Estrategia | Trades | Win% | PF | E[R] |", "|---|---|---|---|---|"]
    for k, v in r["byStrategy"].items():
        L.append(f"| {k} | {v['trades']} | {f(v['winRate'],1)} | {f(v['profitFactor'])} | {f(v['expectancyR'],3)} |")
    L += ["", "## Por sesión (OOS)", "", "| Sesión | Trades | E[R] |", "|---|---|---|"]
    for k, v in r["bySession"].items():
        L.append(f"| {k} | {v['trades']} | {f(v['expectancyR'],3)} |")
    L += ["", "## Bandas de score (OOS)", "", "| Score | Trades | E[R] |", "|---|---|---|"]
    for k, v in r["scoreBands"].items():
        L.append(f"| {k} | {v['trades']} | {f(v['expectancyR'],3)} |")
    mc = r["monteCarlo"]
    if mc.get("runs"):
        L += ["", "## Monte Carlo", "", f"{mc['runs']} simulaciones de {mc['trades']} trades: resultado p5/p50/p95 = {f(mc['finalP5'],1)} / {f(mc['finalP50'],1)} / {f(mc['finalP95'],1)} R · MaxDD p95 {f(mc['ddP95'],1)} R · P(resultado < 0) = {f(100*mc['probNegative'],1)}%"]
    ml = r["ml"]
    L += ["", "## Meta-labeling ML (OOS, purgado + embargo)", "", f"Sin filtro: {ml['base']['trades']} trades, E[R] {f(ml['base']['expectancyR'],3)} · Con filtro: {ml['ml']['trades']} trades, E[R] {f(ml['ml']['expectancyR'],3)} → **{ml['recommendation']}**"]
    L += ["", "## Folds", ""] + [f"- IS {x['fold']['is'][0]}→{x['fold']['is'][1]} | OOS {x['fold']['oos'][0]}→{x['fold']['oos'][1]} | {x.get('config')} | OOS E[R] {f(x.get('oos',{}).get('expectancyR'),3)} ({x.get('oos',{}).get('trades',0)})" for x in r["folds"]]
    L += ["", "## Advertencias", ""] + [f"- {c}" for c in r["caveats"]]
    return "\n".join(L)


if __name__ == "__main__":
    main()
