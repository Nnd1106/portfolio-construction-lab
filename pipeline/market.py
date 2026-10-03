"""
market.py — the transparency layer: a snapshot of every instrument behind
the platform (sleeve vehicles, the 12 basket stocks, the benchmark, FX and
the risk-free NAV) with last closes, period returns, 52-week ranges,
volatility, beta, optional fundamentals, daily close history, the basket's
correlation matrix and rolling cross-asset correlations.

Fundamentals come from yfinance's keyless quote summary. They are strictly
optional: if Yahoo throttles the call, the field is simply omitted and the
UI shows "—". Nothing here can fail the pipeline.
"""

import numpy as np
import pandas as pd
import yfinance as yf

import config as C
import fetch as F

PERIODS = {"1W": 7, "1M": 30, "3M": 91, "6M": 182, "1Y": 365}

# One-line rationale shown on each universe card.
RATIONALE = {
    "IN_EQ": "Core growth engine: domestic large-cap equity, held as a stock basket so selection skill is measurable.",
    "IN_GOLD": "Crisis hedge and INR-depreciation hedge; historically low correlation with Indian equity.",
    "IN_DEBT": "Ballast: AAA-rated PSU bonds held to a fixed 2030 maturity — low volatility, predictable yield.",
    "GL_EQ": "Diversification beyond India: developed-market equity, with USD exposure as a natural INR hedge.",
    "GL_BOND": "Global fixed income, hedged to USD — low-volatility diversifier with INR currency exposure.",
    "BENCH": "Benchmark for beta, Treynor, Jensen's alpha and tracking error.",
    "FX": "Converts every USD-quoted sleeve into rupees (unhedged).",
    "RF": "Risk-free rate proxy: a liquid fund's NAV tracks 91-day T-bill yields.",
}


def _asof(s, date):
    s = s[s.index <= date]
    return None if s.empty else float(s.iloc[-1])


def period_returns(s):
    """Simple returns over calendar look-backs ending at the series' last close."""
    last_d, last = s.index[-1], float(s.iloc[-1])
    out = {}
    for k, days in PERIODS.items():
        base = _asof(s, last_d - pd.Timedelta(days=days))
        out[k] = None if base is None else last / base - 1
    prev_ye = _asof(s, pd.Timestamp(year=last_d.year, month=1, day=1) - pd.Timedelta(days=1))
    out["YTD"] = None if prev_ye is None else last / prev_ye - 1
    base3 = _asof(s, last_d - pd.Timedelta(days=round(365.25 * 3)))
    out["3Y_ann"] = None if base3 is None or s.index[0] > last_d - pd.Timedelta(days=round(365.25 * 3)) else (last / base3) ** (1 / 3) - 1
    return out


def fundamentals(ticker):
    try:
        i = yf.Ticker(ticker).info or {}
    except Exception as exc:  # throttled / network — optional data
        print(f"  ~ info unavailable for {ticker}: {exc}")
        return {}
    pick = {
        "long_name": i.get("longName"),
        "sector": i.get("sector"),
        "industry": i.get("industry"),
        "market_cap": i.get("marketCap"),
        "pe": i.get("trailingPE"),
        "pb": i.get("priceToBook"),
        "div_yield": (i["dividendYield"] / 100) if isinstance(i.get("dividendYield"), (int, float)) else None,
        "expense_ratio": (i["netExpenseRatio"] / 100) if isinstance(i.get("netExpenseRatio"), (int, float)) else None,
        "aum": i.get("totalAssets"),
        "category": i.get("category"),
        "fund_family": i.get("fundFamily"),
    }
    return {k: v for k, v in pick.items() if v is not None and not (isinstance(v, float) and not np.isfinite(v))}


def describe(series, bench_daily=None, fetch_info=None):
    """Snapshot statistics for one raw (native-currency) close series."""
    s = series.dropna()
    last_d = s.index[-1]
    yr = s[s.index > last_d - pd.Timedelta(days=365)]
    r1y = yr.pct_change().dropna()
    out = {
        "last": float(s.iloc[-1]),
        "last_date": last_d.date().isoformat(),
        "prev_close": float(s.iloc[-2]),
        "chg_1d": float(s.iloc[-1] / s.iloc[-2] - 1),
        "ret": period_returns(s),
        "hi52": float(yr.max()), "lo52": float(yr.min()),
        "from_hi52": float(s.iloc[-1] / yr.max() - 1),
        "vol_1y": float(r1y.std(ddof=1) * np.sqrt(C.TRADING_DAYS)) if len(r1y) > 20 else None,
        "max_dd_1y": float((yr / yr.cummax() - 1).min()),
        "first_date": s.index[0].date().isoformat(),
    }
    if bench_daily is not None:
        a = r1y.to_frame("x").join(bench_daily.rename("b"), how="inner").dropna()
        if len(a) > 60:
            out["beta_1y"] = float(np.cov(a["x"], a["b"], ddof=1)[0, 1] / np.var(a["b"], ddof=1))
            out["corr_1y"] = float(a["x"].corr(a["b"]))
    if fetch_info:
        out["info"] = fundamentals(fetch_info)
    return out


def ohlc_block(basket_meta, start):
    """
    Candlestick data for the basket stocks, column-oriented with one shared
    date array per resolution:
      daily  — last C.OHLC_DAILY_DAYS calendar days (3M / 1Y views)
      weekly — Friday-ending weeks over the common window (3Y / All views)
    Rows on dates the close-series bad-tick filter removed are dropped, and
    any candle violating low <= min(open, close) <= max(open, close) <= high
    (or with a non-positive price) is nulled and counted, never repaired.
    """
    frames, checks = {}, {"invalid_daily": 0, "invalid_weekly": 0, "max_close_mismatch": 0.0}
    for b in basket_meta:
        t = b["ticker"]
        df = F.history_ohlc(t)
        if df.empty:
            print(f"  ! no OHLC for {t}")
            continue
        _, dropped = F.remove_bad_ticks(df["Close"])
        df = df.drop(index=pd.to_datetime(dropped), errors="ignore")
        df = df[df.index >= start]
        # the candle close must be the same adjusted close the rest of the platform uses
        close = F.history(t)
        common = df.index.intersection(close.index)
        if len(common):
            mism = float((df.loc[common, "Close"] / close.loc[common] - 1).abs().max())
            checks["max_close_mismatch"] = max(checks["max_close_mismatch"], mism)
        frames[t] = df

    def valid(d):
        lo, hi = d[["Open", "Close"]].min(axis=1), d[["Open", "Close"]].max(axis=1)
        return (d["Low"] <= lo + 1e-9) & (hi <= d["High"] + 1e-9) & (d > 0).all(axis=1)

    def pack(per_stock, key):
        dates = sorted(set().union(*[set(d.index) for d in per_stock.values()]))
        idx = pd.DatetimeIndex(dates)
        series = {}
        for t, d in per_stock.items():
            ok = valid(d)
            checks[key] += int((~ok).sum())
            d = d.where(ok).reindex(idx)
            def col(c):
                return [None if not np.isfinite(v) else round(float(v), 2) for v in d[c].values]
            series[t] = {"o": col("Open"), "h": col("High"), "l": col("Low"), "c": col("Close")}
        return {"dates": [x.date().isoformat() for x in idx], "series": series}

    last = max(d.index[-1] for d in frames.values())
    daily = {t: d[d.index > last - pd.Timedelta(days=C.OHLC_DAILY_DAYS)] for t, d in frames.items()}
    weekly = {t: d.resample("W-FRI").agg({"Open": "first", "High": "max", "Low": "min", "Close": "last"}).dropna()
              for t, d in frames.items()}
    out = {"daily_days": C.OHLC_DAILY_DAYS, "daily": pack(daily, "invalid_daily"), "weekly": pack(weekly, "invalid_weekly")}
    out["checks"] = checks
    print(f"  OHLC: {len(frames)} stocks, {len(out['daily']['dates'])} daily / {len(out['weekly']['dates'])} weekly candles, "
          f"invalid {checks['invalid_daily']}/{checks['invalid_weekly']}, max close mismatch {checks['max_close_mismatch']:.2e}")
    return out


def build_market(panel, basket_px, basket_meta, log):
    print("Market snapshot")
    cal = panel.index
    bench_raw = F.history(log["benchmark"]["ticker"])
    bench_daily = bench_raw.pct_change().dropna()

    instruments, raw_closes = [], {}

    def add(key, role, ticker, name, ccy, extra=None, info=True, beta=False):
        raw = F.history(ticker)
        clean, _ = F.remove_bad_ticks(raw)
        d = describe(clean, bench_daily if beta else None, ticker if info else None)
        d.update({"key": key, "role": role, "ticker": ticker, "name": name, "ccy": ccy})
        if extra:
            d.update(extra)
        instruments.append(d)
        raw_closes[key] = clean

    for sl in C.SLEEVES:
        if sl.get("kind") == "basket":
            continue
        t = log["sleeves"][sl["key"]]["ticker"]
        add(sl["key"], "sleeve", t, sl["name"], sl["ccy"],
            {"vehicle": sl["vehicle"], "rationale": RATIONALE[sl["key"]]}, beta=sl["ccy"] == "INR")
    add("BENCH", "benchmark", log["benchmark"]["ticker"], "Nifty 50 (BeES ETF)", "INR",
        {"rationale": RATIONALE["BENCH"]})
    add("NSEI", "index", "^NSEI", "Nifty 50 Index", "INR", info=False)
    add("FX", "fx", log["fx"]["ticker"], "US Dollar / Indian Rupee", "INR",
        {"rationale": RATIONALE["FX"]}, info=False)
    if log["risk_free"]["ticker"]:
        add("RF", "rf", log["risk_free"]["ticker"], C.RISK_FREE["name"], "INR",
            {"rationale": RATIONALE["RF"]})

    for b in basket_meta:
        add(b["ticker"], "stock", b["ticker"], b["name"], "INR",
            {"sector": b["sector"], "weight": 1 / len(basket_meta)}, beta=True)

    # Close history is charted on the union of every instrument's trading dates, so each
    # chart runs to that instrument's own latest close (the models stop at the last date
    # on which every series has a close — DATA.meta.as_of).
    union = cal
    for s_ in raw_closes.values():
        union = union.union(s_.index[s_.index >= cal[0]])
    closes = {k: s_.reindex(s_.index.union(union)).ffill().reindex(union) for k, s_ in raw_closes.items()}
    cal_closes = union

    # Basket index itself (equal-weight, monthly rebalanced) as a pseudo-instrument
    basket_level = panel["IN_EQ"]
    d = describe(basket_level, bench_daily)
    d.update({"key": "IN_EQ", "role": "sleeve", "ticker": "BASKET", "name": "Indian Equity",
              "ccy": "INR", "vehicle": "Equal-weight basket of 12 Nifty 50 large caps (index, base 1.0)",
              "rationale": RATIONALE["IN_EQ"], "is_index": True})
    instruments.insert(0, d)

    # Basket correlation matrix (weekly) and each stock's correlation with the Nifty
    tick = [b["ticker"] for b in basket_meta]
    wk = basket_px[tick].resample("W-FRI").last().pct_change().dropna()
    bw = panel["BENCH"].resample("W-FRI").last().pct_change().dropna()
    corr = wk.corr().values
    corr_nifty = [float(wk[t].corr(bw.loc[wk.index])) for t in tick]

    # Rolling 52-week correlations between sleeves (weekly INR returns)
    W = panel[[s["key"] for s in C.SLEEVES]].resample("W-FRI").last().pct_change().dropna()
    pairs = [("IN_EQ", "GL_EQ"), ("IN_EQ", "IN_GOLD"), ("IN_EQ", "IN_DEBT"), ("IN_GOLD", "GL_EQ")]
    roll = {}
    for a, b in pairs:
        rc = W[a].rolling(52).corr(W[b]).dropna()
        roll[f"{a}|{b}"] = [round(float(x), 4) for x in rc.values]
    roll_dates = [d.date().isoformat() for d in W[a].rolling(52).corr(W[b]).dropna().index]

    sectors = {}
    for b in basket_meta:
        sectors[b["sector"]] = sectors.get(b["sector"], 0) + 1 / len(basket_meta)

    n_ok = len(instruments)
    with_info = sum(1 for i in instruments if i.get("info"))
    print(f"  {n_ok} instruments, fundamentals for {with_info}")

    return {
        "instruments": instruments,
        "closes": {
            "dates": [d.date().isoformat() for d in cal_closes],
            # 2 dp for prices >= 100, 4 dp below (FX, basket index, small prices) keeps the file lean
            "series": {k: [None if not np.isfinite(v) else round(float(v), 2 if abs(v) >= 100 else 4) for v in s.values]
                       for k, s in closes.items()},
        },
        "basket": {"tickers": tick, "corr_weekly": corr.tolist(), "corr_nifty": corr_nifty, "sectors": sectors},
        "rolling_corr": {"window_weeks": 52, "dates": roll_dates, "pairs": roll},
        "ohlc": ohlc_block(basket_meta, cal[0]),
        "source": "Yahoo Finance via yfinance (keyless), fetched server-side by GitHub Actions",
        "schedule": {"cron_utc": "30 2 * * 6", "label": "Every Saturday 08:00 IST"},
    }
