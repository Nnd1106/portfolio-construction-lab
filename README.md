# Portfolio Construction Lab

A multi-asset portfolio construction platform for an Indian (INR) investor that runs end to end, as a wealth manager would work: **profile the client → inspect the real asset universe → build the strategic allocation → stress the risk → evaluate and attribute performance → plan the rebalancing discipline → test whether the plan reaches the client's goal → hand over a one-page proposal.**

It combines investment-analysis theory (N-asset Markowitz optimization, the efficient frontier, the Capital Allocation Line), financial risk management (VaR / Expected Shortfall, backtesting, stress testing) and wealth-management client tools (risk profiling, goals-based Monte Carlo planning). I built it independently, out of interest in investment banking and wealth management, applying MBA coursework in Investment Analysis & Portfolio Management and Financial Risk Management to real market data.

**Live:** https://nnd1106.github.io/portfolio-construction-lab/

Dark, finance-terminal UI in vanilla HTML/CSS/JS + [Chart.js](https://www.chartjs.org/). No framework, no build step, no backend, and **no API keys anywhere**: market data is fetched server-side by a scheduled GitHub Action and shipped as a static data file.

---

## The seven modules

| # | Module | What it does |
|---|---|---|
| 01 | **Client Profile** | 8-question onboarding scored on two IPS dimensions: *willingness* (attitude) and *capacity* (ability) to bear risk. The lower one governs, and the score maps to the risk-aversion coefficient **A** in `U = E[r] − ½Aσ²`. Rule-based suitability notes and a recommended allocation. |
| 02 | **Market Data** | Full transparency on the real instruments behind the platform: data freshness (last NSE/US close, pipeline run, next scheduled refresh), a card for every sleeve vehicle plus the benchmark, USD/INR and the risk-free NAV (last close, weekly change, 1-year sparkline, 52-week range, returns, volatility, expense ratio/AUM/P-E where available), relative performance rebased to 100, the **12-stock basket** (sortable table with latest closes, returns, 52-week range, beta, market cap, P/E, dividend yield; a stock selector driving a close-vs-Nifty line chart and a **candlestick (OHLC) chart** (daily candles for 3M/1Y, weekly for 3Y/All) plus per-stock tiles; 12×12 correlation matrix; sector mix), rolling 52-week cross-asset correlations, macro & rates, and CSV/JSON downloads of every number. |
| 03 | **Allocation** | N-asset **efficient frontier** (SciPy SLSQP, long-only), **Minimum Variance Portfolio**, tangency **Optimal Risky Portfolio**, and the **Capital Allocation Line** from the risk-free rate. The client's optimal complete portfolio `y* = (E[r_P] − r_f)/(Aσ_P²)` is plotted with their indifference curve. If y* > 1 and leverage is off, the client moves up the frontier past the ORP; an optional kinked CAL handles borrowing at r_f + spread. Includes a frontier transition map and a Policy vs Textbook estimation toggle. |
| 04 | **Risk & Stress** | Historical-simulation and parametric **VaR / CVaR** (any confidence, 1–20 day horizon), a rolling **VaR backtest** with the Kupiec POF test and Basel traffic light, Euler **risk contributions**, an underwater **drawdown** chart, a weekly/daily **correlation heatmap**, three **historical stress scenarios** (GFC 2008, COVID-19 2020, 2022 rate shock) applied to today's weights, and a custom shock builder. |
| 05 | **Performance** | **Sharpe, Sortino, Treynor, Jensen's α, beta, tracking error, information ratio** vs the Nifty 50, plus a **Brinson-Fachler attribution** (allocation / selection / interaction) against a 50/30/10/10 policy benchmark, linked across months with Carino smoothing so the effects sum exactly to the active return. |
| 06 | **Rebalancing** | Daily weight drift on real prices: **buy-and-hold vs tolerance bands** (absolute pp or relative %, monitored daily/weekly/monthly) **vs calendar rebalancing**, net of transaction costs, with turnover, drift and risk comparisons. |
| 07 | **Goals** | Client-side **Monte Carlo**: 5,000 lognormal monthly paths, moment-matched to the client portfolio's μ and σ. Inputs are a lump sum plus a stepped-up SIP against an inflation-adjusted target. Outputs are the probability of success, a fan chart, success probability by year, and the **exact SIP needed for a chosen confidence level**. |

Every module reads the same client state, so changing one questionnaire answer re-flows through the allocation, risk numbers, attribution, rebalancing and goal probability.

**Explain My Portfolio.** A second report, written for a client with no finance background. It is a narrative in short sentences with everyday analogies, and it defines any unavoidable term in brackets on first use. It covers who the plan is for (willingness vs capacity in plain words), where the money goes (real fund and company names, in rupees, with an allocation donut), what could go wrong (a "1 bad month in 20" figure and the 2008 / COVID / 2022 crashes replayed on the client's actual amount vs the Nifty 50), how the approach did historically (without ratio jargon, plus an honest hindsight caveat), rebalancing as re-measuring a recipe, and "out of 100 simulated futures, about N reached your goal" with a fan chart. It reads the same live client state. Both report charts are rendered by Chart.js in a light print palette and embedded as PNGs, so they print crisply. Verified as a real A4 PDF: 5 pages with clean breaks; the Client Proposal fits on 1 page. `?report=explain` or `?report=proposal` opens a report directly.

**Client Proposal.** A header button assembles the client's current state into a one-page investment proposal: profile, recommended allocation with real tickers, latest closes and rupee amounts, expected return and volatility, VaR/ES, historical stress results, goal probability and the required SIP, implementation notes and assumptions. It has a light print layout for *Print / Save as PDF*.

---

## Asset universe

All tickers were verified against yfinance (keyless) before being locked in, and each sleeve has ordered fallbacks.

| Sleeve | Vehicle | Ticker | Notes |
|---|---|---|---|
| Indian equity | Equal-weight, monthly-rebalanced basket of 12 Nifty 50 large caps across 9 sectors | HDFCBANK, ICICIBANK, TCS, INFY, RELIANCE, NTPC, ITC, HINDUNILVR, MARUTI, LT, BHARTIARTL, SUNPHARMA (`.NS`) | A stock basket rather than an index ETF, so the Brinson selection effect is non-trivial |
| Indian gold | Nippon India ETF Gold BeES | `GOLDBEES.NS` | |
| Indian debt | Bharat Bond ETF Apr-2030 (AAA PSU) | `EBBETF0430.NS` → `GILT5YBEES.NS` | **Substituted for LIQUIDBEES**, whose price is pinned near ₹1,000 (yield is paid as extra units), so its price series shows ~0% return |
| Global equity | iShares MSCI World | `URTH` → `VT` → `ACWI` | Developed markets only, so no double-counting of India |
| Global bonds | Vanguard Total International Bond (USD-hedged) | `BNDX` → `BND` → `AGG` | |
| FX | USD/INR | `USDINR=X` | USD sleeves converted to INR, unhedged |
| Risk-free | Nippon India Liquid Fund (Growth) NAV | `0P00005UPP.BO` → `LIQUIDCASE.NS` | Tracks 91-day T-bill yields and gives a time-varying historical r_f |
| Benchmark | Nifty 50 BeES (dividends reinvested by the fund) | `NIFTYBEES.NS` → `^NSEI` | |

The common window starts at the Bharat Bond ETF's listing (Dec 2019), so it covers 6.7+ years of daily data including the COVID crash.

---

## Visual identity

The tool shares its signature look with its flagship card on the portfolio homepage. The cyan → indigo → magenta gradient (`#00f0ff → #8b7bff → #ff2ec4`) runs along the header edge and the active-tab indicator, the report buttons use the same signature style as the homepage's "Open platform" button, and a small efficient-frontier mark (MVP · ORP · CAL from rf) serves as the logo, favicon and loading animation. It's applied to chrome only: charts, tables and every surface behind data keep the plain dark theme for readability.

## Architecture

```
GitHub Actions (weekly, Sat 08:00 IST — after the US Friday close)
  └─ pipeline/build_data.py
       ├─ fetch.py      yfinance download → bad-tick filter → fallbacks → INR conversion
       │                → daily panel on the NSE calendar (as-of alignment for US assets)
       ├─ market.py     per-instrument snapshot: last close, period returns, 52W range, vol, beta,
       │                optional fundamentals, daily close history, basket correlations, rolling correlations,
       │                OHLC candles for the 12 stocks (400 days daily + full-window weekly, validated)
       ├─ analytics.py  weekly returns → Bayes-Stein means → SLSQP frontier / MVP / ORP
       │                → stress windows (live vehicle, documented proxy, or explicit assumption)
       │                → reference risk metrics for browser parity checks
       └─ validation gates (fail the run → nothing committed, last good data stays live)
  └─ commits docs/data/portfolio-data.{json,js}

GitHub Pages serves /docs  →  vanilla JS modules read window.PCL_DATA
                              (no network calls from the browser besides the Chart.js CDN)
```

Optimization runs only in Python. The browser just selects the utility-maximizing point on curves the pipeline has already solved, and computes path-dependent analytics (VaR on the client's weights, backtests, rebalancing, Monte Carlo) from the shipped daily returns.

### Key modeling choices

- **Weekly returns for estimation.** NSE closes around 10:00 UTC and US markets around 20:00 UTC, so daily cross-market correlations are biased toward zero (India-vs-global equity correlation is roughly 0.30 daily vs 0.54 weekly). Means and covariances are therefore estimated from Friday-close weekly returns.
- **Two estimation models.** *Policy* (default): Bayes-Stein shrunk means (Jorion, 1986) and a 5–50% range per sleeve, like an IPS. *Textbook*: raw sample means, long-only. The UI overlays both frontiers so the effect of estimation error is visible rather than hidden.
- **Risk-aversion mapping.** `A = 12 · (1.5/12)^s` for a governing score `s ∈ [0, 1]`. It is log-linear because y* ∝ 1/A. This is a design calibration, not an empirically estimated scale.

### Validation built in

- **Pipeline gates:** the run fails if frontier weights don't sum to 1 (±1e-6), if any weight breaks its bounds, if the frontier is non-monotone or non-concave, if a frontier point beats the ORP's Sharpe ratio, if the MVP isn't the minimum-volatility point, if VaR/CVaR are mis-ordered, if parametric VaR is inconsistent with volatility, if Sharpe ratios are implausible, or if the covariance matrix isn't positive definite.
- **Browser-vs-Python parity** (Risk tab): the browser recomputes the ORP's VaR, ES, volatility, drawdown, Sharpe, Sortino, beta, α and tracking error from the shipped returns and compares them to the pipeline's values. Maximum relative difference is about 5e-5, from 6-decimal rounding.
- **Reconciliations:** Brinson effects sum to the active return (error < 1e-14). The monthly attribution reproduces the daily backtest. Monthly calendar rebalancing reproduces the Performance backtest. Buy-and-hold matches its closed form. The Monte Carlo's required SIP yields exactly the target probability.

---

## Assumptions and limitations

These are stated in the UI next to the numbers they affect:

- **In-sample backtests.** ORP weights are estimated on the same window they are evaluated on, so the backtest flatters optimized portfolios, especially Jensen's α.
- **Survivorship bias.** The equity basket was picked from today's large caps, which inflates its history and the Brinson selection effect.
- **Stress inputs.** The GFC 2008 scenario uses documented proxies for vehicles that didn't exist yet: gold futures × USDINR, ACWI and BND, all in INR. The Indian-debt shock is an **explicit 0% assumption**, because no investable Indian bond series exists for 2008.
- **Target-maturity debt.** EBBETF0430's duration shrinks as it approaches maturity in April 2030. The Indian-debt sleeve needs a ticker update before then.
- **Risk-free rate.** It is a regular-plan liquid-fund NAV, so it is understated by the fund's expense ratio (roughly 0.2–0.3%).
- **What isn't modeled.** No taxes on rebalancing, no fees beyond a proportional trading cost, i.i.d. returns in the Monte Carlo, and a 5% default inflation rate (adjustable).
- **Not investment advice.** Historical estimates are not forecasts, and nothing here is investment advice.

---

## Running locally

```bash
pip install -r pipeline/requirements.txt
python pipeline/build_data.py          # refresh docs/data/ (exits non-zero if a gate fails)
python -m http.server 8080 --directory docs
# open http://localhost:8080
```

The page also works when `docs/index.html` is opened directly from disk, because the data ships as a `.js` file as well as `.json`.

## Stack

Python (yfinance, pandas, NumPy, SciPy) in GitHub Actions · vanilla HTML/CSS/JS + Chart.js 4 on GitHub Pages · no frameworks, no bundler, no backend, no API keys.
