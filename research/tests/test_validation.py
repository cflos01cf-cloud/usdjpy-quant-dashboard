import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from usdjpy_research.evaluation import Config, RiskRules, metrics, simulate_portfolio  # noqa: E402
from usdjpy_research.validation import make_folds, monte_carlo, DAY  # noqa: E402


def cands(rows):
    df = pd.DataFrame(rows)
    df["dt"] = pd.to_datetime(df["time"], unit="s", utc=True)
    df["day"] = df["dt"].dt.strftime("%Y-%m-%d")
    df["week"] = "w"
    for k in ("primary", "session", "direction", "weekday", "hourNy", "atrPct", "marketState"):
        df[k] = df.get(k, "A_SMC" if k == "primary" else 0)
    return df


def row(t, key, r, exit_after=600, status="CLOSED", score=85):
    return {"time": t, "key": key, "thresholds": [80], "hard": [], "score": score,
            "outcomes": {"base": {"status": status, "r": r, "exitAt": t + exit_after}}}


def test_metrics_basic():
    m = metrics(np.array([2.0, -1.0, -1.0, 3.0]))
    assert m["trades"] == 4 and m["winRate"] == 50
    assert m["profitFactor"] == 2.5 and m["expectancyR"] == 0.75
    assert m["maxDrawdownR"] == 2.0 and m["maxLossStreak"] == 2


def test_folds_never_overlap_and_have_embargo():
    folds = make_folds(0, 400 * DAY, 180, 60, 1)
    assert len(folds) >= 3
    for f in folds:
        assert f.oos_start >= f.is_end + DAY
        assert f.oos_end > f.oos_start


def test_one_position_and_unique_keys():
    base = 1_700_000_000
    c = cands([row(base, "a", 1.0, exit_after=3600), row(base + 600, "b", 1.0), row(base + 4000, "a", 1.0), row(base + 5000, "c", -1.0)])
    t = simulate_portfolio(c, Config(80, "base"))
    assert list(t["key"]) == ["a", "c"]  # b ocupado, a duplicada


def test_daily_loss_pause():
    base = 1_700_000_000
    rows = [row(base + i * 500, f"k{i}", -1.0, exit_after=300) for i in range(8)]  # mismo día
    t = simulate_portfolio(cands(rows), Config(80, "base", rules=RiskRules(max_consecutive_losses=3)))
    assert len(t) == 3  # pausa tras 3 pérdidas consecutivas en el día


def test_monte_carlo_shapes():
    mc = monte_carlo(np.array([1.0, -1.0] * 30), runs=500)
    assert mc["runs"] == 500 and mc["ddP95"] >= mc["ddP50"] >= 0
