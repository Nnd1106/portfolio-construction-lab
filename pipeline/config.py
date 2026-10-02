"""
config.py — asset universe, fallbacks, and modeling parameters.

Every ticker here was verified against yfinance (keyless) before being
locked in. Each sleeve lists a primary ticker and ordered fallbacks; the
fetcher walks the list and records which one actually resolved so the
frontend can surface any substitution.
"""

# ---------------------------------------------------------------------------
# Risky asset sleeves (the optimizer universe)
# ---------------------------------------------------------------------------
# "ccy": currency the ticker is quoted in. USD sleeves are converted to INR
# (unhedged) using USDINR — the client is an Indian investor.
SLEEVES = [
    {
        "key": "IN_EQ",
        "name": "Indian Equity",
        "short": "India Eq",
        "vehicle": "Equal-weight basket of 12 Nifty 50 large caps",
        "kind": "basket",          # built from BASKET below, not a single ticker
        "ccy": "INR",
    },
    {
        "key": "IN_GOLD",
        "name": "Indian Gold",
        "short": "Gold",
        "vehicle": "Nippon India ETF Gold BeES",
        "tickers": ["GOLDBEES.NS"],
        "ccy": "INR",
    },
    {
        "key": "IN_DEBT",
        "name": "Indian Debt",
        "short": "India Debt",
        "vehicle": "Bharat Bond ETF Apr-2030 (AAA PSU, target maturity)",
        # LIQUIDBEES is NOT usable: its price is pinned at ~1000 and yield is
        # paid as extra units, so the price series shows ~0 return.
        # GILT5YBEES only has history from Apr-2021 (kept as a fallback).
        "tickers": ["EBBETF0430.NS", "GILT5YBEES.NS"],
        "ccy": "INR",
    },
    {
        "key": "GL_EQ",
        "name": "Global Equity",
        "short": "Global Eq",
        "vehicle": "iShares MSCI World (developed markets, ex-India)",
        "tickers": ["URTH", "VT", "ACWI"],
        "ccy": "USD",
    },
    {
        "key": "GL_BOND",
        "name": "Global Bonds",
        "short": "Global Bonds",
        "vehicle": "Vanguard Total International Bond (USD-hedged)",
        "tickers": ["BNDX", "BND", "AGG"],
        "ccy": "USD",
    },
]

# Indian equity sleeve: sector-diversified basket of liquid Nifty 50 names,
# equal-weighted and rebalanced monthly. NOTE: selected from today's large
# caps, so its history carries survivorship bias (flagged in the UI).
BASKET = [
    {"ticker": "HDFCBANK.NS",   "name": "HDFC Bank",          "sector": "Financials"},
    {"ticker": "ICICIBANK.NS",  "name": "ICICI Bank",         "sector": "Financials"},
    {"ticker": "TCS.NS",        "name": "Tata Consultancy",   "sector": "IT"},
    {"ticker": "INFY.NS",       "name": "Infosys",            "sector": "IT"},
    {"ticker": "RELIANCE.NS",   "name": "Reliance Industries","sector": "Energy"},
    {"ticker": "NTPC.NS",       "name": "NTPC",               "sector": "Utilities"},
    {"ticker": "ITC.NS",        "name": "ITC",                "sector": "Consumer Staples"},
    {"ticker": "HINDUNILVR.NS", "name": "Hindustan Unilever", "sector": "Consumer Staples"},
    {"ticker": "MARUTI.NS",     "name": "Maruti Suzuki",      "sector": "Autos"},
    {"ticker": "LT.NS",         "name": "Larsen & Toubro",    "sector": "Industrials"},
    {"ticker": "BHARTIARTL.NS", "name": "Bharti Airtel",      "sector": "Telecom"},
    {"ticker": "SUNPHARMA.NS",  "name": "Sun Pharma",         "sector": "Healthcare"},
]
BASKET_MIN_NAMES = 10  # pipeline fails loudly if fewer constituents resolve

BENCHMARK = {"key": "NIFTY50", "name": "Nifty 50",
             "tickers": ["NIFTYBEES.NS", "^NSEI"]}  # BeES ~ total return; ^NSEI is price-only

FX_TICKERS = ["USDINR=X", "INR=X"]

# Risk-free: growth-option liquid fund NAV (tracks 91-day T-bill rates).
RISK_FREE = {
    "tickers": ["0P00005UPP.BO", "LIQUIDCASE.NS"],
    "name": "Nippon India Liquid Fund (Growth) NAV",
    "fallback_annual": 0.055,   # used only if every ticker fails
}

# ---------------------------------------------------------------------------
# Modeling parameters
# ---------------------------------------------------------------------------
MIN_YEARS_HISTORY = 5.0          # common window must cover at least this
WEEKS_PER_YEAR = 52
TRADING_DAYS = 252

# Policy ranges for the "policy" model (IPS-style min/max per sleeve)
POLICY_MIN = 0.05
POLICY_MAX = 0.50

FRONTIER_POINTS = 120

# Strategic policy benchmark used for Brinson attribution
POLICY_BENCHMARK = {"IN_EQ": 0.50, "IN_DEBT": 0.30, "IN_GOLD": 0.10, "GL_EQ": 0.10, "GL_BOND": 0.00}

# Historical stress windows. "proxies" map sleeve -> substitute ticker used
# when the live vehicle did not exist yet; None = explicit assumption shock.
STRESS_SCENARIOS = [
    {
        "id": "gfc2008",
        "name": "Global Financial Crisis",
        "start": "2008-09-01", "end": "2009-03-09",
        "blurb": "Lehman collapse to the global equity trough.",
        "proxies": {
            "IN_GOLD": "GC=F*FX",      # gold futures converted to INR
            "IN_DEBT": None,           # no Indian bond series pre-2010 -> assumption
            "GL_EQ": "ACWI",
            "GL_BOND": "BND",
        },
        "assumptions": {"IN_DEBT": 0.0},
    },
    {
        "id": "covid2020",
        "name": "COVID-19 Crash",
        "start": "2020-02-19", "end": "2020-03-23",
        "blurb": "Pre-pandemic peak to the March 2020 trough.",
        "proxies": {},
    },
    {
        "id": "rates2022",
        "name": "2022 Rate Shock",
        "start": "2022-01-03", "end": "2022-10-12",
        "blurb": "Fed hiking cycle: stocks and bonds fall together.",
        "proxies": {},
    },
]

SPIKE_THRESHOLD = 0.25  # single-day spike-and-reversal filter (bad ticks)
