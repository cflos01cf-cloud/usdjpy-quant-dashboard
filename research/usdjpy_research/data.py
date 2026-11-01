"""Descarga e importación de histórico USD/JPY.

- TwelveData: paginación hacia atrás con end_date (5000 velas por llamada; respeta 8 req/min del plan gratuito).
- Dukascopy / CSV genérico: columnas time|timestamp|datetime, open, high, low, close.
Salida: JSON [{time, open, high, low, close}] (time = apertura en segundos UTC), el formato que lee el exportador TS.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pandas as pd
import requests

TD_URL = "https://api.twelvedata.com/time_series"
INTERVAL = {"M1": "1min", "M5": "5min", "M15": "15min", "H1": "1h"}


def download_twelvedata(tf: str, start: str, api_key: str, end: str | None = None, sleep_s: float = 8.0) -> pd.DataFrame:
    frames: list[pd.DataFrame] = []
    end_date = end
    start_ts = pd.Timestamp(start, tz="UTC")
    while True:
        params = {"symbol": "USD/JPY", "interval": INTERVAL[tf], "outputsize": 5000, "timezone": "UTC", "order": "DESC", "apikey": api_key}
        if end_date:
            params["end_date"] = end_date
        j = requests.get(TD_URL, params=params, timeout=30).json()
        if j.get("status") == "error":
            if frames:
                break  # se llegó al límite de historia del plan
            raise RuntimeError(j.get("message"))
        df = pd.DataFrame(j["values"])
        df["datetime"] = pd.to_datetime(df["datetime"], utc=True)
        frames.append(df)
        oldest = df["datetime"].min()
        print(f"  {tf}: {len(df)} velas hasta {oldest}")
        if oldest <= start_ts or len(df) < 5000:
            break
        end_date = (oldest - pd.Timedelta(seconds=1)).strftime("%Y-%m-%d %H:%M:%S")
        time.sleep(sleep_s)
    out = pd.concat(frames).drop_duplicates("datetime").sort_values("datetime")
    out = out[out["datetime"] >= start_ts]
    return normalize(out.rename(columns={"datetime": "time"}))


def load_csv(path: str | Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    df.columns = [c.strip().lower() for c in df.columns]
    tcol = next(c for c in ("time", "timestamp", "datetime", "gmt time", "date") if c in df.columns)
    t = df[tcol]
    if pd.api.types.is_numeric_dtype(t):
        df["time"] = pd.to_datetime(t, unit="ms" if t.iloc[0] > 1e11 else "s", utc=True)
    else:
        df["time"] = pd.to_datetime(t, utc=True, dayfirst=True)
    return normalize(df)


def normalize(df: pd.DataFrame) -> pd.DataFrame:
    df = df[["time", "open", "high", "low", "close"]].copy()
    for c in ("open", "high", "low", "close"):
        df[c] = df[c].astype(float)
    df = df.dropna().drop_duplicates("time").sort_values("time")
    ok = (df.high >= df[["open", "close"]].max(axis=1) - 1e-9) & (df.low <= df[["open", "close"]].min(axis=1) + 1e-9)
    df = df[ok]
    if pd.api.types.is_datetime64_any_dtype(df["time"]):
        df["time"] = (df["time"] - pd.Timestamp("1970-01-01", tz="UTC")) // pd.Timedelta(seconds=1)
    return df.reset_index(drop=True)


def resample(df: pd.DataFrame, minutes: int) -> pd.DataFrame:
    x = df.copy()
    x["bucket"] = x["time"] - x["time"] % (minutes * 60)
    g = x.groupby("bucket")
    return pd.DataFrame({"time": g["time"].first().index, "open": g["open"].first().values, "high": g["high"].max().values,
                         "low": g["low"].min().values, "close": g["close"].last().values})


def save_json(df: pd.DataFrame, path: str | Path) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    recs = [{"time": int(r.time), "open": r.open, "high": r.high, "low": r.low, "close": r.close} for r in df.itertuples()]
    Path(path).write_text(json.dumps(recs))
