#!/usr/bin/env python3
"""Genera un histórico SINTÉTICO M5 (GARCH-ish con regímenes y fines de semana) SÓLO para probar el pipeline.
Nunca usar sus resultados para decidir nada."""
import json, sys
import numpy as np
import pandas as pd

days = int(sys.argv[1]) if len(sys.argv) > 1 else 420
out = sys.argv[2] if len(sys.argv) > 2 else "data/synthetic_m5.json"
rng = np.random.default_rng(1)
idx = pd.date_range("2025-01-06", periods=days * 288, freq="5min", tz="UTC")
ny = idx.tz_convert("America/New_York")
open_mkt = ~((ny.weekday == 5) | ((ny.weekday == 4) & (ny.hour >= 17)) | ((ny.weekday == 6) & (ny.hour < 17)))
idx = idx[open_mkt]
n = len(idx)
hour = idx.hour.values
sess_vol = np.where((hour >= 7) & (hour < 16), 1.6, np.where((hour >= 0) & (hour < 7), 0.9, 0.6))
regime = np.repeat(rng.choice([-1, 0, 1], size=n // 2000 + 1, p=[0.3, 0.4, 0.3]), 2000)[:n]
vol = np.empty(n); v = 0.02
ret = np.empty(n)
for i in range(n):
    v = 0.000002 + 0.9 * v + 0.08 * (ret[i - 1] if i else 0) ** 2 / max(v, 1e-6) * 0.01
    v = min(max(v, 0.008), 0.06)
    ret[i] = (regime[i] * 0.0012 + rng.standard_t(4) * v * 0.6) * sess_vol[i]
close = 150 + np.cumsum(ret)
open_ = np.concatenate([[150], close[:-1]])
hi = np.maximum(open_, close) + np.abs(rng.normal(0, 0.012, n)) * sess_vol
lo = np.minimum(open_, close) - np.abs(rng.normal(0, 0.012, n)) * sess_vol
recs = [{"time": int(t.timestamp()), "open": float(o), "high": float(h), "low": float(l), "close": float(c)} for t, o, h, l, c in zip(idx, open_, hi, lo, close)]
import pathlib; pathlib.Path(out).parent.mkdir(parents=True, exist_ok=True)
pathlib.Path(out).write_text(json.dumps(recs))
print(f"{len(recs)} velas sintéticas → {out} (rango {close.min():.2f}–{close.max():.2f})")
