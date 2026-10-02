/* ---------------------------------------------------------------------
 * state.js — shared client state and the complete-portfolio engine.
 *
 * Every module reads the same "client portfolio": the investor's optimal
 * complete portfolio given risk aversion A, the selected estimation model,
 * and the borrowing rule. Precomputed frontiers come from the pipeline;
 * nothing is optimized from scratch in the browser — we only pick the
 * utility-maximizing point on curves the pipeline already solved.
 * ------------------------------------------------------------------- */

const DATA = window.PCL_DATA;
const KEYS = DATA.assets.map((a) => a.key);
const ASSET = Object.fromEntries(DATA.assets.map((a) => [a.key, a]));
const RF = DATA.risk_free.current_annual;
const COV = DATA.estimation.cov;

const DEFAULT_STATE = {
  model: 'policy',            // 'policy' | 'textbook'
  answers: null,              // questionnaire answers (index per question) — set by profile.js
  aOverride: null,            // manual A (number) or null to use the questionnaire
  borrowing: false,           // allow borrowing (kinked CAL)
  borrowSpread: 0.02,         // borrowing rate = rf + spread
  maxLeverage: 1.5,           // cap on risky exposure when borrowing
};

const STORE_KEY = 'pcl-state-v1';

const Store = {
  state: { ...DEFAULT_STATE },
  listeners: [],

  load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) Object.assign(this.state, JSON.parse(raw));
    } catch (e) { /* storage unavailable — defaults are fine */ }
    if (!DATA.models[this.state.model]) this.state.model = 'policy';
  },

  save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.state)); } catch (e) { /* ignore */ }
  },

  set(patch) {
    Object.assign(this.state, patch);
    this.save();
    Portfolio.invalidate();
    this.listeners.forEach((fn) => fn(this.state));
  },

  subscribe(fn) { this.listeners.push(fn); },
};

/* ---------------------------------------------------------------------
 * Complete-portfolio construction
 * ------------------------------------------------------------------- */

const Portfolio = {
  _cache: null,

  invalidate() { this._cache = null; },

  model() { return DATA.models[Store.state.model]; },

  /** Effective risk-aversion coefficient (manual override wins). */
  riskAversion() {
    if (Store.state.aOverride != null) return Store.state.aOverride;
    return Profile.result().A;
  },

  point(w, mu) {
    return { w, ret: dot(w, mu), vol: Math.sqrt(quadForm(w, COV)) };
  },

  /**
   * Dense grid along the efficient frontier from the ORP to the max-return
   * portfolio. Weights are linearly interpolated between the pipeline's
   * solved points (120 per frontier), so every grid portfolio is feasible.
   */
  upperGrid(m) {
    const mu = m.mu;
    const orp = this.point(m.orp.w, mu);
    const pts = m.frontier.filter((p) => p.ret > orp.ret + 1e-12).map((p) => p.w);
    const nodes = [orp.w, ...pts];
    const grid = [orp];
    for (let i = 1; i < nodes.length; i++) {
      for (let s = 1; s <= 8; s++) {
        const t = s / 8;
        const w = nodes[i - 1].map((x, j) => x * (1 - t) + nodes[i][j] * t);
        grid.push(this.point(w, mu));
      }
    }
    return grid;
  },

  /**
   * Optimal complete portfolio (Bodie-Kane-Marcus):
   *   y* = (E[rP] − rf) / (A σP²)   on the CAL through the ORP.
   * If y* > 1 and borrowing is off, the investor moves up the efficient
   * frontier past the ORP to the utility-maximizing risky portfolio.
   * If borrowing is on at rB = rf + spread, the efficient set is the lending
   * CAL → frontier → borrowing line tangent from rB (kinked CAL).
   */
  build() {
    const st = Store.state;
    const m = this.model();
    const A = this.riskAversion();
    const P = this.point(m.orp.w, m.mu);
    const U = (ret, vol) => ret - 0.5 * A * vol * vol;
    const yStar = (P.ret - RF) / (A * P.vol * P.vol);

    let out;
    if (yStar <= 1) {
      const y = Math.max(0, yStar);
      out = {
        regime: 'lend', y, yStar, risky: P,
        w: P.w.map((x) => x * y), cash: 1 - y,
        ret: RF + y * (P.ret - RF), vol: y * P.vol, financeRate: RF,
      };
    } else {
      const grid = this.upperGrid(m);
      let best = null;
      let search = grid;
      let tangentB = null;
      const rB = RF + st.borrowSpread;
      if (st.borrowing) {
        tangentB = grid.reduce((a, g) => ((g.ret - rB) / g.vol > (a.ret - rB) / a.vol ? g : a), grid[0]);
        search = grid.filter((g) => g.ret <= tangentB.ret + 1e-12);
      }
      for (const g of search) {
        const u = U(g.ret, g.vol);
        if (!best || u > best.u) best = { ...g, u };
      }
      out = {
        regime: 'frontier', y: 1, yStar, risky: best,
        w: best.w.slice(), cash: 0, ret: best.ret, vol: best.vol, financeRate: RF,
      };
      if (st.borrowing && tangentB) {
        let yB = (tangentB.ret - rB) / (A * tangentB.vol * tangentB.vol);
        if (yB > 1) {
          yB = Math.min(yB, st.maxLeverage);
          const ret = rB + yB * (tangentB.ret - rB);
          const vol = yB * tangentB.vol;
          if (U(ret, vol) > U(out.ret, out.vol)) {
            out = {
              regime: 'borrow', y: yB, yStar, risky: tangentB,
              w: tangentB.w.map((x) => x * yB), cash: 1 - yB, ret, vol, financeRate: rB,
            };
          }
        }
      }
      out.tangentB = tangentB;
    }
    out.A = A;
    out.orp = P;
    out.utility = U(out.ret, out.vol);
    out.certaintyEquivalent = out.utility;
    out.sharpe = out.vol > 0 ? (out.ret - RF) / out.vol : 0;
    return out;
  },

  client() {
    if (!this._cache) this._cache = this.build();
    return this._cache;
  },

  /**
   * Daily historical return series of a constant-weight portfolio (weights
   * over the 5 sleeves + a cash leg). Positive cash earns the liquid-fund
   * return; negative cash (borrowing) pays it plus the borrowing spread.
   */
  dailyReturns(w, cash = 0, spread = 0) {
    const R = DATA.series.returns;
    const n = DATA.series.dates.length;
    const out = new Array(n);
    const sp = cash < 0 ? spread / TRADING_DAYS : 0;
    for (let t = 0; t < n; t++) {
      let r = cash * (R.RF[t] + sp);
      for (let i = 0; i < KEYS.length; i++) r += w[i] * R[KEYS[i]][t];
      out[t] = r;
    }
    return out;
  },

  /** Policy benchmark (constant weights) — its Indian-equity segment is the Nifty 50, not the basket. */
  policyDaily() {
    const R = DATA.series.returns;
    const w = KEYS.map((k) => DATA.policy_benchmark[k] || 0);
    return DATA.series.dates.map((_, t) => KEYS.reduce((s, k, i) => s + w[i] * (k === 'IN_EQ' ? R.BENCH[t] : R[k][t]), 0));
  },

  clientDaily() {
    const c = this.client();
    return this.dailyReturns(c.w, c.cash, c.regime === 'borrow' ? Store.state.borrowSpread : 0);
  },

  /** Weights incl. cash as {key: weight}. */
  weightMap(c = this.client()) {
    const m = Object.fromEntries(KEYS.map((k, i) => [k, c.w[i]]));
    m.CASH = c.cash;
    return m;
  },
};
