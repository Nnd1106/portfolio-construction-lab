"""
fetch.py — download, clean, and align price history via yfinance (keyless).

Outputs a daily INR price panel on the NSE trading calendar for every
risky sleeve, the Nifty 50 benchmark, and the risk-free NAV, plus a data-
quality log describing which ticker resolved for each sleeve and which bad
ticks were removed.
"""

import time
import warnings

import numpy as np
import pandas as pd
import yfinance as yf

import config as C

warnings.filterwarnings("ignore")

_cache = {}


def history(ticker, retries=3):
    """Full daily adjusted-close history as a tz-naive Series (empty on failure)."""
    if ticker in _cache:
        return _cache[ticker]
    s = pd.Series(dtype=float)
    for attempt in range(retries):
        try:
            df = yf.Ticker(ticker).history(period="max", auto_adjust=True)
            if df is not None and not df.empty:
                s = df["Close"].dropna()
                s.index = pd.to_datetime(s.index).tz_localize(None).normalize()
                s = s[~s.index.duplicated(keep="last")].sort_index()
                s = s[s > 0]
                break
        except Exception as exc:  # network hiccup — back off and retry
            print(f"  ! {ticker} attempt {attempt + 1} failed: {exc}")
        time.sleep(1.5 * (attempt + 1))
    _cache[ticker] = s
    return s


def remove_bad_ticks(s, thr=C.SPIKE_THRESHOLD, max_len=5):
    """
    Drop spike-and-reversal glitches: a jump of more than `thr` that reverts
    to within thr/2 of the pre-jump level within `max_len` sessions. Genuine
    crashes (no reversal) are kept. Returns (clean series, list of dropped dates).
    """
    vals = s.values.copy()
    keep = np.ones(len(vals), dtype=bool)
    dropped = []
    i = 1
    while i < len(vals):
        prev = vals[i - 1]
        if abs(vals[i] / prev - 1) > thr:
            for j in range(i + 1, min(i + 1 + max_len, len(vals))):
                if abs(vals[j] / prev - 1) < thr / 2:
                    keep[i:j] = False
                    dropped += [d.date().isoformat() for d in s.index[i:j]]
                    i = j
                    break
        i += 1
    return s[keep], dropped


def resolve(tickers, min_start=None):
    """Return (ticker, clean series, dropped) for the first ticker that resolves."""
    for t in tickers:
        raw = history(t)
        if raw.empty or len(raw) < 250:
            print(f"  - {t}: no usable data")
            continue
        if min_start is not None and raw.index[0] > pd.Timestamp(min_start):
            print(f"  - {t}: history starts {raw.index[0].date()}, after required {min_start}")
            continue
        clean, dropped = remove_bad_ticks(raw)
        return t, clean, dropped
    return None, pd.Series(dtype=float), []


def build_basket(calendar_start="2005-01-01"):
    """
    Equal-weight, monthly-rebalanced index of the BASKET constituents (INR).
    Within a month weights drift with prices; at each month start they reset.
    """
    closes, meta, dropped_all = {}, [], {}
    for b in C.BASKET:
        t, s, dropped = resolve([b["ticker"]])
        if t is None:
            print(f"  ! basket constituent {b['ticker']} failed — excluded")
            continue
        closes[b["ticker"]] = s
        meta.append(b)
        if dropped:
            dropped_all[b["ticker"]] = dropped
    if len(closes) < C.BASKET_MIN_NAMES:
        raise RuntimeError(f"Only {len(closes)} basket names resolved (< {C.BASKET_MIN_NAMES})")

    P = pd.DataFrame(closes)
    P = P[P.index >= calendar_start]
    # start once every constituent trades
    P = P.loc[P.dropna().index[0]:].ffill()
    R = P.pct_change().fillna(0.0)

    level = [1.0]
    w = np.ones(P.shape[1]) / P.shape[1]
    months = P.index.to_period("M")
    for k in range(1, len(P)):
        if months[k] != months[k - 1]:
            w = np.ones(P.shape[1]) / P.shape[1]          # monthly reset
        r = R.iloc[k].values
        port_r = float(w @ r)
        level.append(level[-1] * (1 + port_r))
        w = w * (1 + r)
        w = w / w.sum()
    idx = pd.Series(level, index=P.index, name="IN_EQ")
    return idx, P, meta, dropped_all


def build_panel():
    log = {"sleeves": {}, "basket": {}, "benchmark": {}, "risk_free": {}, "fx": {}}

    print("FX")
    fx_t, fx, fx_drop = resolve(C.FX_TICKERS)
    if fx_t is None:
        raise RuntimeError("USDINR could not be resolved")
    log["fx"] = {"ticker": fx_t, "first": fx.index[0].date().isoformat(), "dropped": fx_drop}

    print("Benchmark")
    bm_t, bm, bm_drop = resolve(C.BENCHMARK["tickers"])
    if bm_t is None:
        raise RuntimeError("Benchmark could not be resolved")
    log["benchmark"] = {"ticker": bm_t, "fallback_used": bm_t != C.BENCHMARK["tickers"][0],
                        "first": bm.index[0].date().isoformat(), "dropped": bm_drop}

    print("Basket")
    basket, basket_px, basket_meta, basket_drop = build_basket()
    log["basket"] = {"constituents": [m["ticker"] for m in basket_meta],
                     "first": basket.index[0].date().isoformat(), "dropped": basket_drop}

    series = {"IN_EQ": basket}
    for sl in C.SLEEVES:
        if sl.get("kind") == "basket":
            log["sleeves"][sl["key"]] = {"ticker": "BASKET", "fallback_used": False,
                                         "first": basket.index[0].date().isoformat(), "dropped": []}
            continue
        print(sl["key"])
        # require at least MIN_YEARS of history from the primary; fall back otherwise
        min_start = (pd.Timestamp.today() - pd.Timedelta(days=int(365.25 * C.MIN_YEARS_HISTORY))).date().isoformat()
        t, s, dropped = resolve(sl["tickers"], min_start=min_start)
        if t is None:
            raise RuntimeError(f"No ticker resolved for sleeve {sl['key']}")
        log["sleeves"][sl["key"]] = {"ticker": t, "fallback_used": t != sl["tickers"][0],
                                     "first": s.index[0].date().isoformat(), "dropped": dropped}
        series[sl["key"]] = s

    print("Risk-free")
    rf_t, rf, rf_drop = resolve(C.RISK_FREE["tickers"])
    log["risk_free"] = {"ticker": rf_t, "fallback_used": rf_t != C.RISK_FREE["tickers"][0],
                        "first": rf.index[0].date().isoformat() if rf_t else None, "dropped": rf_drop}

    # ---- align on the NSE calendar (benchmark trading days) -------------
    keys = [sl["key"] for sl in C.SLEEVES]
    start = max(series[k].index[0] for k in keys)
    if rf_t is not None:
        start = max(start, rf.index[0])
    cal = bm.index[bm.index >= start]

    def on_cal(s):
        # as-of alignment: last available close on or before each NSE date
        return s.reindex(s.index.union(cal)).ffill().reindex(cal)

    fx_c = on_cal(fx)
    panel = pd.DataFrame(index=cal)
    for sl in C.SLEEVES:
        s = on_cal(series[sl["key"]])
        if sl["ccy"] == "USD":
            s = s * fx_c
        panel[sl["key"]] = s
    panel["BENCH"] = on_cal(bm)
    if rf_t is not None:
        panel["RF"] = on_cal(rf)
    else:  # constant accrual fallback
        daily = (1 + C.RISK_FREE["fallback_annual"]) ** (1 / C.TRADING_DAYS) - 1
        panel["RF"] = (1 + daily) ** np.arange(len(cal))
    panel = panel.dropna()

    years = (panel.index[-1] - panel.index[0]).days / 365.25
    if years < C.MIN_YEARS_HISTORY:
        raise RuntimeError(f"Common window only {years:.2f}y (< {C.MIN_YEARS_HISTORY})")

    # stale-price diagnostics: share of zero daily moves per series in window
    zero_share = (panel.pct_change().iloc[1:] == 0).mean().round(4).to_dict()
    for k in keys:
        log["sleeves"][k]["zero_return_share"] = zero_share[k]

    log["window"] = {"start": panel.index[0].date().isoformat(),
                     "end": panel.index[-1].date().isoformat(),
                     "years": round(years, 2), "sessions": int(len(panel))}

    # full-history INR series of each live vehicle (used for stress windows)
    full = {}
    for sl in C.SLEEVES:
        s = series[sl["key"]]
        if sl["ccy"] == "USD":
            s = (s * fx.reindex(s.index.union(fx.index)).ffill().reindex(s.index)).dropna()
        full[sl["key"]] = s

    basket_px = basket_px.reindex(basket_px.index.union(cal)).ffill().reindex(cal).loc[panel.index]
    return panel, basket_px, basket_meta, fx, bm, rf, full, log
