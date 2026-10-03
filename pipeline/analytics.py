"""
analytics.py — estimation, mean-variance optimization, and reference risk metrics.

Conventions (mirrored exactly in docs/assets/js/utils.js so the browser and
the pipeline can be cross-checked):
  * Optimization inputs use WEEKLY (Fri-close) simple returns, annualized x52.
    Weekly sampling avoids the non-synchronous close problem between NSE
    (10:00 UTC) and US markets (20:00 UTC) that biases daily correlations down.
  * Expected returns are arithmetic means; the "policy" model shrinks them with
    the Bayes-Stein estimator of Jorion (1986) toward the minimum-variance
    portfolio's mean, the "textbook" model uses raw sample means.
  * Risk metrics use DAILY returns of a constant-weight portfolio.
"""

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from scipy.stats import norm

import config as C

KEYS = [s["key"] for s in C.SLEEVES]


# ---------------------------------------------------------------------------
# Estimation
# ---------------------------------------------------------------------------

def complete_weeks(df, today=None):
    """
    Friday-close weekly levels using completed weeks only. The pipeline runs every
    weekday, so mid-week the last W-FRI bucket is a partial week (e.g. Fri→Wed);
    it is dropped until its Friday has passed, keeping the optimizer's inputs on
    true Friday-to-Friday weeks and stable through the week.
    """
    w = df.resample("W-FRI").last()
    today = pd.Timestamp(today or pd.Timestamp.now(tz="Asia/Kolkata").date())
    # complete only once its Friday has passed in IST: on a Friday-evening run the
    # US Friday session (closes ~01:30 IST Saturday) is still missing
    if len(w) and w.index[-1].normalize() >= today:
        w = w.iloc[:-1]
    return w


def weekly_returns(panel):
    return complete_weeks(panel[KEYS]).pct_change().dropna()


def bayes_stein(R):
    """
    Jorion (1986) Bayes-Stein shrinkage of the (per-period) sample mean toward
    the mean of the global minimum-variance portfolio.
      phi = (N+2) / ((N+2) + T (mu - mu0 1)' S^-1 (mu - mu0 1))
    with S the unbiased-scaled covariance (T-1)/(T-N-2) * sample cov.
    """
    T, N = R.shape
    mu = R.mean().values
    S = R.cov().values * (T - 1) / (T - N - 2)
    Si = np.linalg.inv(S)
    one = np.ones(N)
    w_min = Si @ one / (one @ Si @ one)
    mu0 = float(w_min @ mu)
    d = mu - mu0 * one
    phi = (N + 2) / ((N + 2) + T * float(d @ Si @ d))
    mu_bs = (1 - phi) * mu + phi * mu0
    return mu_bs, phi, mu0


def current_risk_free(rf_nav):
    """Trailing 12-month (365 calendar days) effective return of the liquid-fund NAV."""
    s = rf_nav.dropna()
    past = s[s.index <= s.index[-1] - pd.Timedelta(days=365)]
    if past.empty:
        return None
    return float(s.iloc[-1] / past.iloc[-1] - 1)


# ---------------------------------------------------------------------------
# Optimization
# ---------------------------------------------------------------------------

def _solve(obj, n, bounds, cons, starts=6, seed=7):
    rng = np.random.default_rng(seed)
    best = None
    lo = np.array([b[0] for b in bounds])
    hi = np.array([b[1] for b in bounds])
    x0s = [np.clip(np.ones(n) / n, lo, hi)]
    for _ in range(starts - 1):
        x = rng.dirichlet(np.ones(n))
        x0s.append(np.clip(x, lo, hi))
    for x0 in x0s:
        res = minimize(obj, x0, method="SLSQP", bounds=bounds, constraints=cons,
                       options={"ftol": 1e-12, "maxiter": 500})
        if res.success and (best is None or res.fun < best.fun):
            best = res
    if best is None:
        raise RuntimeError("Optimizer failed to converge from every start")
    w = np.clip(best.x, 0, None)
    return w / w.sum()


def portfolio_stats(w, mu, cov, rf):
    r = float(w @ mu)
    v = float(np.sqrt(w @ cov @ w))
    return r, v, (r - rf) / v


def efficient_set(mu, cov, bounds, rf, n_pts=C.FRONTIER_POINTS):
    n = len(mu)
    budget = {"type": "eq", "fun": lambda w: w.sum() - 1}

    w_mvp = _solve(lambda w: w @ cov @ w, n, bounds, [budget])
    w_maxr = _solve(lambda w: -(w @ mu), n, bounds, [budget])
    w_minr = _solve(lambda w: (w @ mu), n, bounds, [budget])
    w_orp = _solve(lambda w: -((w @ mu - rf) / np.sqrt(w @ cov @ w)), n, bounds, [budget], starts=12)

    def min_var_at(target):
        cons = [budget, {"type": "eq", "fun": lambda w, t=target: w @ mu - t}]
        return _solve(lambda w: w @ cov @ w, n, bounds, cons, starts=3)

    def pack(w):
        r, v, s = portfolio_stats(w, mu, cov, rf)
        return {"ret": r, "vol": v, "sharpe": s, "w": [float(x) for x in w]}

    r_mvp, r_max, r_min = float(w_mvp @ mu), float(w_maxr @ mu), float(w_minr @ mu)
    upper = [pack(w_mvp)]
    for t in np.linspace(r_mvp, r_max, n_pts)[1:-1]:
        upper.append(pack(min_var_at(t)))
    upper.append(pack(w_maxr))
    lower = [pack(w_minr)]
    for t in np.linspace(r_min, r_mvp, 30)[1:-1]:
        lower.append(pack(min_var_at(t)))
    lower.append(pack(w_mvp))

    return {"mvp": pack(w_mvp), "orp": pack(w_orp), "max_ret": pack(w_maxr),
            "frontier": upper, "lower": lower}


def frontier_checks(es, rf):
    """Sanity checks on a computed efficient set; returns dict of booleans/values."""
    f = es["frontier"]
    rets = np.array([p["ret"] for p in f])
    vols = np.array([p["vol"] for p in f])
    wsum_err = max(abs(sum(p["w"]) - 1) for p in f + es["lower"] + [es["orp"]])
    # efficient branch: vol increasing in return, and concave in (vol, ret) space,
    # i.e. slope dRet/dVol non-increasing
    mono = bool(np.all(np.diff(vols) > -1e-9))
    slopes = np.diff(rets) / np.maximum(np.diff(vols), 1e-12)
    concave = bool(np.all(np.diff(slopes) < 1e-6 * np.maximum(1, np.abs(slopes[1:]))))
    max_frontier_sharpe = max((p["ret"] - rf) / p["vol"] for p in f)
    return {
        "weights_sum_max_abs_error": float(wsum_err),
        "vol_monotone_increasing": mono,
        "concave": concave,
        "orp_sharpe": es["orp"]["sharpe"],
        "max_sharpe_on_frontier_grid": float(max_frontier_sharpe),
        "orp_dominates_grid": bool(es["orp"]["sharpe"] >= max_frontier_sharpe - 1e-6),
        "mvp_is_min_vol": bool(es["mvp"]["vol"] <= vols.min() + 1e-9),
    }


# ---------------------------------------------------------------------------
# Daily risk / performance metrics (reference implementation for JS parity)
# ---------------------------------------------------------------------------

def risk_metrics(r, rf_d, b, conf=0.95):
    r = np.asarray(r, float)
    rf_d = np.asarray(rf_d, float)
    b = np.asarray(b, float)
    ex = r - rf_d
    q = np.quantile(r, 1 - conf)                       # numpy 'linear' (type 7)
    var_h = -q
    cvar_h = -r[r <= q].mean()
    mu_d, sd_d = r.mean(), r.std(ddof=1)
    z = norm.ppf(1 - conf)
    var_p = -(mu_d + z * sd_d)
    cvar_p = -(mu_d - sd_d * norm.pdf(z) / (1 - conf))
    wealth = np.cumprod(1 + r)
    peak = np.maximum.accumulate(wealth)
    mdd = float((wealth / peak - 1).min())
    dd = np.sqrt(np.mean(np.minimum(ex, 0) ** 2))
    bex = b - rf_d
    beta = np.cov(ex, bex, ddof=1)[0, 1] / np.var(bex, ddof=1)
    te = np.std(r - b, ddof=1) * np.sqrt(C.TRADING_DAYS)
    return {
        "var_hist_1d": float(var_h), "cvar_hist_1d": float(cvar_h),
        "var_param_1d": float(var_p), "cvar_param_1d": float(cvar_p),
        "vol_ann": float(sd_d * np.sqrt(C.TRADING_DAYS)),
        "max_drawdown": mdd,
        "sharpe": float(ex.mean() * C.TRADING_DAYS / (sd_d * np.sqrt(C.TRADING_DAYS))),
        "sortino": float(ex.mean() * C.TRADING_DAYS / (dd * np.sqrt(C.TRADING_DAYS))),
        "beta": float(beta),
        "treynor": float(ex.mean() * C.TRADING_DAYS / beta),
        "jensen_alpha": float((ex.mean() - beta * bex.mean()) * C.TRADING_DAYS),
        "tracking_error": float(te),
        "information_ratio": float((r - b).mean() * C.TRADING_DAYS / te),
    }


# ---------------------------------------------------------------------------
# Stress scenarios
# ---------------------------------------------------------------------------

def _asof(s, date):
    s = s[s.index <= pd.Timestamp(date)]
    return None if s.empty else float(s.iloc[-1])


def _window_return(s, start, end, slack_days=10):
    """Return over [start, end] if the series covers the start (within slack)."""
    if s is None or s.empty or s.index[0] > pd.Timestamp(start) + pd.Timedelta(days=slack_days):
        return None
    a, b = _asof(s, start), _asof(s, end)
    if a is None or b is None:
        return None
    return b / a - 1


def stress_scenarios(series_inr, history_fn, fx, bench_series, nsei, rf_nav):
    """
    series_inr: dict sleeve -> full-history INR price series of the live vehicle.
    history_fn: ticker -> raw USD/INR price series (for proxies).
    """
    out = []
    for sc in C.STRESS_SCENARIOS:
        st, en = sc["start"], sc["end"]
        rets = {}
        for k in KEYS:
            r = _window_return(series_inr[k], st, en)
            if r is not None:
                rets[k] = {"ret": r, "source": "actual", "detail": "live vehicle"}
                continue
            proxy = sc["proxies"].get(k, "missing")
            if proxy is None or proxy == "missing":
                a = sc.get("assumptions", {}).get(k)
                if a is None:
                    raise RuntimeError(f"Scenario {sc['id']}: no data or assumption for {k}")
                rets[k] = {"ret": a, "source": "assumption",
                           "detail": "no investable series existed; flat shock assumed"}
                continue
            if proxy.endswith("*FX"):
                tk = proxy.split("*")[0]
                s = history_fn(tk)
                s_inr = (s * fx.reindex(s.index.union(fx.index)).ffill().reindex(s.index)).dropna()
                r = _window_return(s_inr, st, en)
                detail = f"{tk} converted to INR"
            else:
                s = history_fn(proxy)
                s_inr = (s * fx.reindex(s.index.union(fx.index)).ffill().reindex(s.index)).dropna()
                r = _window_return(s_inr, st, en)
                detail = f"{proxy} (INR)"
            if r is None:
                raise RuntimeError(f"Scenario {sc['id']}: proxy {proxy} has no data")
            rets[k] = {"ret": r, "source": "proxy", "detail": detail}

        b = _window_return(bench_series, st, en)
        bsrc = "Nifty 50 BeES"
        if b is None:
            b = _window_return(nsei, st, en)
            bsrc = "^NSEI (price index)"
        cash = _window_return(rf_nav, st, en)
        csrc = "liquid-fund NAV"
        if cash is None:
            cash, csrc = 0.0, "assumption: 0% (no NAV history)"
        out.append({"id": sc["id"], "name": sc["name"], "start": st, "end": en,
                    "blurb": sc["blurb"], "returns": rets,
                    "benchmark": {"ret": b, "source": bsrc},
                    "cash": {"ret": cash, "source": csrc}})
    return out
