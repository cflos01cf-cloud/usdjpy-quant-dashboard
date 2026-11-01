"""Walk-forward con embargo, selección robusta, Monte Carlo y meta-labeling (ML) sin look-ahead."""
from __future__ import annotations

import itertools
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.mixture import GaussianMixture

from .evaluation import Config, metrics, simulate_portfolio, trade_metrics, grouped

THRESHOLDS = (70, 75, 80, 85, 90)
VARIANTS = ("base", "tp_1_2_3", "tp_15_25_4", "no_be", "full_tp2")
DAY = 86400


@dataclass
class Fold:
    is_start: int
    is_end: int
    oos_start: int
    oos_end: int


def make_folds(t0: int, t1: int, is_days: int = 180, oos_days: int = 60, embargo_days: int = 1) -> list[Fold]:
    """Ventanas rodantes: [IS][embargo][OOS] → avanza OOS. El OOS nunca se solapa con el IS."""
    folds = []
    s = t0
    while True:
        is_end = s + is_days * DAY
        oos_start = is_end + embargo_days * DAY
        oos_end = oos_start + oos_days * DAY
        if oos_start >= t1:
            break
        folds.append(Fold(s, is_end, oos_start, min(oos_end, t1)))
        if oos_end >= t1:
            break
        s += oos_days * DAY
    return folds


def objective(t: pd.DataFrame, min_trades: int = 20) -> float:
    """Expectativa con penalización: E[R]·√n − 0.05·MaxDD. Requiere muestra mínima."""
    m = trade_metrics(t)
    if m["trades"] < min_trades:
        return -np.inf
    return m["expectancyR"] * np.sqrt(m["trades"]) - 0.05 * m["maxDrawdownR"]


def strategy_sets(c: pd.DataFrame) -> list[tuple[str, ...] | None]:
    strats = sorted(c["primary"].dropna().unique())
    return [None] + [tuple(s for s in strats if s != x) for x in strats]  # todas, o todas menos una


def select_config(c: pd.DataFrame, mask: pd.Series, min_trades: int = 20) -> tuple[Config, dict]:
    """Elige la configuración con mejor objetivo SUAVIZADO por vecindad de umbral (evita picos sobreoptimizados)."""
    grid: dict[tuple, float] = {}
    for th, var, ss in itertools.product(THRESHOLDS, VARIANTS, strategy_sets(c)):
        grid[(th, var, ss)] = objective(simulate_portfolio(c, Config(th, var, ss), mask), min_trades)
    smooth = {}
    for (th, var, ss), v in grid.items():
        neigh = [grid.get((th + d, var, ss)) for d in (-5, 0, 5)]
        neigh = [x for x in neigh if x is not None]
        smooth[(th, var, ss)] = np.mean(neigh) if all(np.isfinite(neigh)) else -np.inf
    best = max(smooth, key=smooth.get)
    return Config(*best), {"objective": grid[best], "smoothed": smooth[best]}


def walk_forward(c: pd.DataFrame, is_days=180, oos_days=60, embargo_days=1, min_trades=20) -> dict:
    folds = make_folds(int(c["time"].min()), int(c["time"].max()), is_days, oos_days, embargo_days)
    oos_trades, report = [], []
    for f in folds:
        is_mask = (c["time"] >= f.is_start) & (c["time"] < f.is_end)
        oos_mask = (c["time"] >= f.oos_start) & (c["time"] < f.oos_end)
        cfg, info = select_config(c, is_mask, min_trades)
        if not np.isfinite(info["smoothed"]):
            report.append({"fold": fmt(f), "config": None, "note": "muestra IS insuficiente"})
            continue
        t = simulate_portfolio(c, cfg, oos_mask)
        if not t.empty:
            t["fold"] = len(report)
            oos_trades.append(t)
        report.append({"fold": fmt(f), "config": cfg.label(), "is": trade_metrics(simulate_portfolio(c, cfg, is_mask)), "oos": trade_metrics(t)})
    allt = pd.concat(oos_trades, ignore_index=True) if oos_trades else pd.DataFrame()
    return {"folds": report, "trades": allt}


def fmt(f: Fold) -> dict:
    d = lambda x: pd.to_datetime(x, unit="s").strftime("%Y-%m-%d")
    return {"is": [d(f.is_start), d(f.is_end)], "oos": [d(f.oos_start), d(f.oos_end)]}


def monte_carlo(r: np.ndarray, runs: int = 5000, seed: int = 42, ruin_r: float = 20.0) -> dict:
    """Bootstrap de la secuencia de R: distribución de resultado final y drawdown."""
    r = np.asarray(r, float)
    if len(r) < 10:
        return {"runs": 0, "note": "menos de 10 operaciones"}
    rng = np.random.default_rng(seed)
    paths = rng.choice(r, size=(runs, len(r)), replace=True)
    eq = np.cumsum(paths, axis=1)
    peak = np.maximum.accumulate(np.concatenate([np.zeros((runs, 1)), eq], axis=1), axis=1)[:, 1:]
    dd = (peak - eq).max(axis=1)
    final = eq[:, -1]
    return {
        "runs": runs, "trades": len(r),
        "finalP5": float(np.percentile(final, 5)), "finalP50": float(np.percentile(final, 50)), "finalP95": float(np.percentile(final, 95)),
        "ddP50": float(np.percentile(dd, 50)), "ddP95": float(np.percentile(dd, 95)), "ddP99": float(np.percentile(dd, 99)),
        "probNegative": float((final < 0).mean()),
        "probDD_over": {"R": ruin_r, "p": float((dd >= ruin_r).mean())},
    }


def score_bands(t: pd.DataFrame) -> dict:
    if t.empty:
        return {}
    f = t[t["filled"]].copy()
    f["band"] = pd.cut(f["score"], [0, 70, 80, 90, 101], right=False, labels=["<70", "70-79", "80-89", "90+"])
    return {str(k): metrics(g["r"].values) for k, g in f.groupby("band", observed=True)}


# ───────────────────────── ML: meta-labeling ─────────────────────────
FEATURES = ["score", "sc_trendStructure", "sc_smc", "sc_technical", "sc_liquidity", "sc_momentum", "sc_volatility", "sc_sessionNews",
            "atrPct", "adxM15", "adxH1", "rsiM15", "hourNy", "weekday", "ema50SlopeH1", "rrNet", "stopPips", "dir", "trend_align", "is_A", "is_B", "is_C", "is_D", "is_E"]


def ml_frame(c: pd.DataFrame, variant: str) -> pd.DataFrame:
    """Candidatas ejecutables con etiqueta y = 1 si la operación cerró con R > 0."""
    x = ml_frame_like(c[c["hard"].map(len).eq(0)])
    o = x["outcomes"].map(lambda d: d.get(variant) or {})
    x["status"] = o.map(lambda d: d.get("status"))
    x["r"] = o.map(lambda d: d.get("r"))
    x["exitAt"] = o.map(lambda d: d.get("exitAt"))
    x = x[x["status"] == "CLOSED"].copy()
    x["y"] = (x["r"].astype(float) > 0).astype(int)
    return x


def meta_labeling(c: pd.DataFrame, cfg: Config, folds: list[Fold], embargo_days: int = 1, p_min: float = 0.5) -> dict:
    """Entrena con todo lo anterior al OOS (purgando operaciones cuyo desenlace cae después del corte)
    y filtra las señales OOS. Compara la expectativa OOS con y sin filtro bajo las mismas reglas de cartera."""
    data = ml_frame(c, cfg.variant)
    base_tr, ml_tr, folds_out = [], [], []
    for f in folds:
        cutoff = f.oos_start - embargo_days * DAY
        train = data[(data["time"] < cutoff) & (data["exitAt"].fillna(np.inf) < cutoff)]
        if len(train) < 150 or train["y"].nunique() < 2:
            continue
        model = GradientBoostingClassifier(n_estimators=150, max_depth=2, learning_rate=0.05, subsample=0.8, random_state=0)
        model.fit(train[FEATURES], train["y"])
        oos_mask = (c["time"] >= f.oos_start) & (c["time"] < f.oos_end)
        cand = c[oos_mask & c["hard"].map(len).eq(0)]
        if cand.empty:
            continue
        cf = ml_frame_like(cand)
        keep = pd.Series(False, index=c.index)
        keep.loc[cand.index] = model.predict_proba(cf[FEATURES])[:, 1] >= p_min
        b = simulate_portfolio(c, cfg, oos_mask)
        m = simulate_portfolio(c, cfg, oos_mask & keep)
        base_tr.append(b); ml_tr.append(m)
        folds_out.append({"fold": fmt(f), "train": len(train), "base": trade_metrics(b), "ml": trade_metrics(m)})
    cat = lambda xs: pd.concat(xs, ignore_index=True) if xs else pd.DataFrame()
    b, m = cat(base_tr), cat(ml_tr)
    bm, mm = trade_metrics(b), trade_metrics(m)
    return {"folds": folds_out, "base": bm, "ml": mm,
            "recommendation": "ACTIVAR filtro ML" if mm["trades"] >= 30 and mm["expectancyR"] > bm["expectancyR"] + 0.05 else "NO activar: no mejora OOS de forma consistente"}


def ml_frame_like(cand: pd.DataFrame) -> pd.DataFrame:
    x = cand.copy()
    x["dir"] = (x["direction"] == "LONG").astype(int)
    sg = np.where(x["direction"] == "LONG", "LONG", "SHORT")
    x["trend_align"] = (x["d1"] == sg).astype(int) + (x["h4"] == sg).astype(int) + (x["h1"] == sg).astype(int)
    for k, s in zip("ABCDE", ["A_SMC", "B_TREND", "C_PRICE_ACTION", "D_LIQUIDITY", "E_BREAKOUT"]):
        x[f"is_{k}"] = x["strategies"].map(lambda v, s=s: int(s in v))
    x[FEATURES] = x[FEATURES].astype(float).fillna(0.0)
    return x


def regimes(c: pd.DataFrame, oos_trades: pd.DataFrame, folds: list[Fold], k: int = 3) -> dict:
    """Detección de régimen (GMM sobre volatilidad/tendencia) ajustada SÓLO con datos previos a cada OOS."""
    if oos_trades.empty:
        return {}
    feats = ["atrPct", "adxH1", "ema50SlopeH1"]
    X = c[feats].astype(float).fillna(0.0).copy()
    X["ema50SlopeH1"] = X["ema50SlopeH1"].abs()
    labels = pd.Series(index=oos_trades.index, dtype="object")
    for i, f in enumerate(folds):
        tr = X[c["time"] < f.oos_start]
        sel = oos_trades["time"].between(f.oos_start, f.oos_end - 1)
        if len(tr) < 200 or not sel.any():
            continue
        g = GaussianMixture(k, random_state=0).fit(tr.values)
        order = np.argsort(g.means_[:, 0])  # ordenar por volatilidad
        name = {int(order[j]): ["baja vol", "media vol", "alta vol"][j] for j in range(k)}
        idx = oos_trades.loc[sel, "idx"].astype(int).values
        labels.loc[sel] = [name[int(z)] for z in g.predict(X.loc[idx].values)]
    t = oos_trades.assign(regime=labels)
    return grouped(t.dropna(subset=["regime"]), "regime")
