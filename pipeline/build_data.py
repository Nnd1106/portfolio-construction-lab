"""
build_data.py — run the full pipeline and write docs/data/portfolio-data.{json,js}.

    python pipeline/build_data.py

Fails loudly (non-zero exit) if any sanity check fails, so the scheduled
GitHub Action never commits broken analytics.
"""

import datetime as dt
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
import analytics as A   # noqa: E402
import config as C      # noqa: E402
import fetch as F       # noqa: E402
import market as M      # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_DIR = os.path.join(ROOT, "docs", "data")
SCHEMA_VERSION = 2


def r6(x):
    return None if x is None or (isinstance(x, float) and not np.isfinite(x)) else round(float(x), 6)


def round_tree(obj):
    if isinstance(obj, dict):
        return {k: round_tree(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [round_tree(v) for v in obj]
    if isinstance(obj, (float, np.floating)):
        return r6(obj)
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, np.bool_):
        return bool(obj)
    return obj


def cagr(level):
    yrs = (level.index[-1] - level.index[0]).days / 365.25
    return float((level.iloc[-1] / level.iloc[0]) ** (1 / yrs) - 1)


def main():
    panel, basket_px, basket_meta, fx, bench_full, rf_full, full, log = F.build_panel()
    keys = A.KEYS
    print(f"\nWindow {log['window']}")

    # ---------------- risk-free ----------------
    rf_now = A.current_risk_free(panel["RF"]) if log["risk_free"]["ticker"] else None
    rf_source = C.RISK_FREE["name"] if rf_now is not None else "constant fallback"
    if rf_now is None:
        rf_now = C.RISK_FREE["fallback_annual"]
    rf_years = panel["RF"].resample("YE").last()
    rf_by_year = {str(d.year): r6(v) for d, v in rf_years.pct_change().dropna().items()}

    # ---------------- estimation ----------------
    W = A.weekly_returns(panel)
    T = len(W)
    mu_raw_w = W.mean().values
    cov_w = W.cov().values
    mu_bs_w, phi, mu0 = A.bayes_stein(W)
    ann = C.WEEKS_PER_YEAR
    mu_raw, mu_bs, cov = mu_raw_w * ann, mu_bs_w * ann, cov_w * ann

    D = panel.pct_change().dropna()
    corr_daily = D[keys].corr().values
    corr_weekly = W.corr().values

    # ---------------- optimization ----------------
    models = {}
    specs = {
        "policy": {"label": "Policy (Bayes-Stein + 5–50% ranges)", "mu": mu_bs,
                   "bounds": [(C.POLICY_MIN, C.POLICY_MAX)] * len(keys)},
        "textbook": {"label": "Textbook (sample means, long-only)", "mu": mu_raw,
                     "bounds": [(0.0, 1.0)] * len(keys)},
    }
    checks = {}
    for name, sp in specs.items():
        es = A.efficient_set(sp["mu"], cov, sp["bounds"], rf_now)
        checks[name] = A.frontier_checks(es, rf_now)
        models[name] = {"label": sp["label"], "mu": list(sp["mu"]),
                        "bounds": [list(b) for b in sp["bounds"]], **es}
        print(f"{name}: ORP w={np.round(es['orp']['w'], 3)} ret={es['orp']['ret']:.4f} "
              f"vol={es['orp']['vol']:.4f} SR={es['orp']['sharpe']:.3f} | checks {checks[name]}")

    # ---------------- per-asset stats ----------------
    assets = []
    for i, sl in enumerate(C.SLEEVES):
        k = sl["key"]
        lv = panel[k]
        d = D[k]
        assets.append({
            "key": k, "name": sl["name"], "short": sl["short"], "vehicle": sl["vehicle"],
            "ticker": log["sleeves"][k]["ticker"], "ccy": sl["ccy"],
            "mu_raw": mu_raw[i], "mu_bs": mu_bs[i], "vol": float(np.sqrt(cov[i, i])),
            "vol_daily": float(d.std(ddof=1) * np.sqrt(C.TRADING_DAYS)),
            "cagr": cagr(lv),
            "max_drawdown": float((lv / lv.cummax() - 1).min()),
        })

    # ---------------- basket ----------------
    bR = basket_px.pct_change().dropna()
    bench_d = D["BENCH"]
    cons = []
    for m in basket_meta:
        s = basket_px[m["ticker"]]
        r = bR[m["ticker"]]
        beta = np.cov(r, bench_d.loc[r.index])[0, 1] / np.var(bench_d.loc[r.index], ddof=1)
        cons.append({**m, "weight": 1 / len(basket_meta), "cagr": cagr(s),
                     "vol": float(r.std(ddof=1) * np.sqrt(C.TRADING_DAYS)), "beta": float(beta)})

    # ---------------- stress ----------------
    nsei = F.history("^NSEI")
    stress = A.stress_scenarios(full, F.history, fx, bench_full, nsei, rf_full)
    for sc in stress:
        print(f"stress {sc['id']}: " + ", ".join(f"{k}={v['ret']*100:.1f}%({v['source']})"
                                               for k, v in sc["returns"].items())
              + f" | bench={sc['benchmark']['ret']*100:.1f}% cash={sc['cash']['ret']*100:.2f}%")

    # ---------------- cross-check metrics (JS parity) ----------------
    cross = {}
    for name in models:
        w = np.array(models[name]["orp"]["w"])
        pr = D[keys].values @ w
        cross[f"{name}_orp"] = {"weights": list(w), **A.risk_metrics(pr, D["RF"].values, D["BENCH"].values)}
    bm = A.risk_metrics(D["BENCH"].values, D["RF"].values, D["BENCH"].values)
    cross["benchmark"] = bm
    print("crosscheck policy ORP:", {k: round(v, 4) for k, v in cross["policy_orp"].items() if k != "weights"})

    # ---------------- validation gates ----------------
    problems = []
    for name, ck in checks.items():
        if ck["weights_sum_max_abs_error"] > 1e-6:
            problems.append(f"{name}: weights do not sum to 1")
        if not ck["vol_monotone_increasing"] or not ck["concave"]:
            problems.append(f"{name}: frontier not monotone/concave")
        if not ck["orp_dominates_grid"]:
            problems.append(f"{name}: ORP Sharpe below a frontier grid point")
        if not ck["mvp_is_min_vol"]:
            problems.append(f"{name}: MVP is not the minimum-vol point")
        lo, hi = specs[name]["bounds"][0]
        for p in models[name]["frontier"]:
            if min(p["w"]) < lo - 1e-6 or max(p["w"]) > hi + 1e-6:
                problems.append(f"{name}: frontier weight outside bounds")
                break
    for name in models:
        m = cross[f"{name}_orp"]
        if not (0 < m["var_hist_1d"] < m["cvar_hist_1d"]):
            problems.append(f"{name}: hist VaR/CVaR ordering wrong")
        if not (0 < m["var_param_1d"] < m["cvar_param_1d"]):
            problems.append(f"{name}: param VaR/CVaR ordering wrong")
        daily_sd = m["vol_ann"] / np.sqrt(C.TRADING_DAYS)
        if not (0.8 < m["var_param_1d"] / (1.645 * daily_sd) < 1.2):
            problems.append(f"{name}: parametric VaR inconsistent with vol")
        if not (-1 < m["sharpe"] < 5 and np.isfinite(m["sortino"])):
            problems.append(f"{name}: implausible Sharpe/Sortino")
    eig = np.linalg.eigvalsh(cov)
    if eig.min() <= 0:
        problems.append("covariance not positive definite")
    if problems:
        print("\nVALIDATION FAILED:\n  " + "\n  ".join(problems))
        sys.exit(1)

    # ---------------- market snapshot (transparency layer; never fatal) ----------------
    try:
        market = M.build_market(panel, basket_px, basket_meta, log)
    except Exception as exc:
        print(f"  ! market snapshot skipped: {exc}")
        market = None

    # ---------------- assemble ----------------
    out = {
        "schema_version": SCHEMA_VERSION,
        "meta": {
            "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "as_of": log["window"]["end"],
            "currency": "INR",
            "fx_treatment": "USD-quoted sleeves converted to INR at USDINR (unhedged)",
            "estimation_frequency": "weekly",
            "risk_frequency": "daily",
        },
        "data_quality": log,
        "assets": assets,
        "basket": {"constituents": cons, "rebalance": "monthly, equal weight",
                   "note": "Constituents chosen from current Nifty 50 large caps — history carries survivorship bias."},
        "benchmark": {"name": C.BENCHMARK["name"], "ticker": log["benchmark"]["ticker"],
                      "cagr": cagr(panel["BENCH"]),
                      "vol": float(D["BENCH"].std(ddof=1) * np.sqrt(C.TRADING_DAYS))},
        "risk_free": {"current_annual": rf_now, "source": rf_source,
                      "ticker": log["risk_free"]["ticker"], "by_year": rf_by_year},
        "estimation": {"weeks": T, "bayes_stein": {"phi": phi, "mu0_annual": mu0 * ann},
                       "cov": cov.tolist(), "corr_weekly": corr_weekly.tolist(),
                       "corr_daily": corr_daily.tolist()},
        "models": models,
        "checks": checks,
        "policy_benchmark": C.POLICY_BENCHMARK,
        "stress": stress,
        "crosscheck": cross,
        "market": market,
        "series": {
            "dates": [d.date().isoformat() for d in D.index],
            "returns": {k: [r6(x) for x in D[k].values] for k in keys + ["BENCH", "RF"]},
        },
    }
    out = round_tree(out)

    os.makedirs(OUT_DIR, exist_ok=True)
    js = json.dumps(out, separators=(",", ":"), allow_nan=False)
    with open(os.path.join(OUT_DIR, "portfolio-data.json"), "w", encoding="utf-8") as fh:
        fh.write(js)
    with open(os.path.join(OUT_DIR, "portfolio-data.js"), "w", encoding="utf-8") as fh:
        fh.write("/* Generated by pipeline/build_data.py — do not edit by hand. */\n")
        fh.write("window.PCL_DATA = " + js + ";\n")
    print(f"\nWrote {OUT_DIR} ({len(js) / 1024:.0f} KB). All validation gates passed.")


if __name__ == "__main__":
    main()
