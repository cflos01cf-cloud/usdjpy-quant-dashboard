"""Aplicación de reglas de cartera/riesgo sobre candidatas y métricas de rendimiento."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

NY = ZoneInfo("America/New_York")


def load_candidates(path: str | Path) -> pd.DataFrame:
    rows = [json.loads(l) for l in Path(path).read_text().splitlines() if l.strip()]
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["dt"] = pd.to_datetime(df["time"], unit="s", utc=True)
    # día de trading FX: rollover 17:00 NY
    ny = df["dt"].dt.tz_convert(NY) + pd.Timedelta(hours=7)
    df["day"] = ny.dt.strftime("%Y-%m-%d")
    df["week"] = (ny - pd.to_timedelta(ny.dt.weekday, unit="D")).dt.strftime("%Y-%m-%d")
    df["primary"] = df["strategies"].map(lambda s: s[0] if s else None)
    for k in ("atrPct", "adxM15", "adxH1", "rsiM15", "macdHistM15", "hourNy", "weekday", "ema50SlopeH1", "marketState", "d1", "h4", "h1"):
        df[k] = df["features"].map(lambda f, k=k: f.get(k))
    for k in ("trendStructure", "smc", "technical", "liquidity", "momentum", "volatility", "sessionNews"):
        df[f"sc_{k}"] = df["breakdown"].map(lambda b, k=k: b.get(k))
    return df.sort_values("time").reset_index(drop=True)


@dataclass
class RiskRules:
    risk_per_trade_pct: float = 0.5
    max_daily_risk_pct: float = 2.0
    max_weekly_loss_pct: float = 5.0
    max_trades_per_day: int = 5
    max_consecutive_losses: int = 3
    pending_busy_s: int = 3600  # una señal no llenada ocupa el slot hasta expirar


@dataclass
class Config:
    threshold: int = 80
    variant: str = "base"
    strategies: tuple[str, ...] | None = None  # None = todas
    rules: RiskRules = field(default_factory=RiskRules)

    def label(self) -> dict:
        return {"threshold": self.threshold, "variant": self.variant, "strategies": list(self.strategies) if self.strategies else "todas"}


def simulate_portfolio(c: pd.DataFrame, cfg: Config, mask: pd.Series | None = None) -> pd.DataFrame:
    """Reproduce las reglas del motor en vivo: 1 posición, límites diarios/semanales, racha, sin duplicar clave."""
    if c.empty:
        return pd.DataFrame()
    sel = c["thresholds"].map(lambda t: cfg.threshold in t) & c["hard"].map(len).eq(0)
    if cfg.strategies:
        sel &= c["primary"].isin(cfg.strategies)
    if mask is not None:
        sel &= mask
    rr = cfg.rules
    trades = []
    busy_until = -1
    used_keys: set[str] = set()
    day, week = None, None
    day_r = week_r = 0.0
    day_n = streak = 0
    paused = False
    for row in c[sel].itertuples():
        if row.day != day:
            day, day_r, day_n, streak, paused = row.day, 0.0, 0, 0, False
        if row.week != week:
            week, week_r = row.week, 0.0
        if row.time < busy_until or row.key in used_keys or paused:
            continue
        if day_n >= rr.max_trades_per_day:
            continue
        if -day_r * rr.risk_per_trade_pct + rr.risk_per_trade_pct > rr.max_daily_risk_pct + 1e-9:
            continue
        if -week_r * rr.risk_per_trade_pct >= rr.max_weekly_loss_pct:
            continue
        o = row.outcomes.get(cfg.variant)
        if not o or o["status"] not in ("CLOSED", "EXPIRED", "INVALIDATED"):
            continue  # sin desenlace dentro del histórico
        used_keys.add(row.key)
        day_n += 1
        filled = o["status"] == "CLOSED"
        r = float(o["r"]) if filled and o["r"] is not None else 0.0
        busy_until = int(o["exitAt"]) if filled and o["exitAt"] else row.time + rr.pending_busy_s
        if filled:
            day_r += r
            week_r += r
            streak = streak + 1 if r < 0 else 0
            if -day_r * rr.risk_per_trade_pct >= rr.max_daily_risk_pct or streak >= rr.max_consecutive_losses:
                paused = True
        trades.append({"time": row.time, "key": row.key, "filled": filled, "r": r, "score": row.score, "strategy": row.primary,
                       "session": row.session, "direction": row.direction, "weekday": row.weekday, "hourNy": row.hourNy,
                       "atrPct": row.atrPct, "marketState": row.marketState, "exits": o.get("exits"), "idx": row.Index})
    return pd.DataFrame(trades)


def metrics(r: np.ndarray | pd.Series, times: np.ndarray | pd.Series | None = None) -> dict:
    r = np.asarray(r, dtype=float)
    n = len(r)
    if n == 0:
        return {"trades": 0, "winRate": 0, "profitFactor": 0, "netR": 0, "expectancyR": 0, "avgWinR": 0, "avgLossR": 0,
                "maxDrawdownR": 0, "sharpe": None, "sortino": None, "maxWinStreak": 0, "maxLossStreak": 0}
    wins, losses = r[r > 0], r[r <= 0]
    gw, gl = wins.sum(), -losses.sum()
    eq = np.cumsum(r)
    mdd = float(np.max(np.maximum.accumulate(np.concatenate([[0], eq]))[1:] - eq)) if n else 0.0
    mdd = max(mdd, 0.0)

    def streak(cond):
        best = cur = 0
        for x in cond:
            cur = cur + 1 if x else 0
            best = max(best, cur)
        return best

    sharpe = sortino = None
    if times is not None:
        d = pd.Series(r, index=pd.to_datetime(np.asarray(times), unit="s", utc=True)).groupby(lambda t: t.date()).sum()
        if len(d) > 5 and d.std() > 0:
            sharpe = float(d.mean() / d.std() * np.sqrt(252))
            dd = np.sqrt(np.mean(np.minimum(d.values, 0) ** 2))
            sortino = float(d.mean() / dd * np.sqrt(252)) if dd > 0 else None
    return {
        "trades": n,
        "winRate": float(100 * len(wins) / n),
        "profitFactor": float(gw / gl) if gl > 0 else (float("inf") if gw > 0 else 0.0),
        "netR": float(r.sum()),
        "expectancyR": float(r.mean()),
        "avgWinR": float(wins.mean()) if len(wins) else 0.0,
        "avgLossR": float(losses.mean()) if len(losses) else 0.0,
        "maxDrawdownR": mdd,
        "sharpe": sharpe,
        "sortino": sortino,
        "maxWinStreak": streak(r > 0),
        "maxLossStreak": streak(r <= 0),
    }


def trade_metrics(t: pd.DataFrame) -> dict:
    f = t[t["filled"]] if not t.empty else t
    return metrics(f["r"].values if not f.empty else [], f["time"].values if not f.empty else None)


def grouped(t: pd.DataFrame, col: str) -> dict:
    if t.empty:
        return {}
    f = t[t["filled"]]
    return {str(k): metrics(g["r"].values, g["time"].values) for k, g in f.groupby(col)}
