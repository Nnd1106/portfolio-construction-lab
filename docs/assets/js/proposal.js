/* ---------------------------------------------------------------------
 * proposal.js — one-page client investment proposal.
 * Assembles the client's current state from every module (profile,
 * allocation with real tickers and latest closes, ex-ante risk/return,
 * VaR in rupees, worst historical stress, goal probability) into a
 * printable document. Print / Save as PDF uses the browser's dialog; a
 * light print stylesheet hides the dashboard.
 * ------------------------------------------------------------------- */

const Proposal = {
  init() {
    $('open-proposal').addEventListener('click', () => this.open());
    $('proposal-close').addEventListener('click', () => this.close());
    $('proposal-print').addEventListener('click', () => window.print());
    $('proposal-amount').addEventListener('change', () => this.build());
    $('proposal').addEventListener('click', (e) => { if (e.target.id === 'proposal') this.close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('proposal').hidden) this.close(); });
  },

  open() {
    this.lastFocus = document.activeElement;
    if ($('explain')) $('explain').hidden = true;
    $('proposal').hidden = false;
    document.body.classList.add('proposal-open');
    this.build();
    $('proposal-close').focus();
  },

  close() {
    $('proposal').hidden = true;
    document.body.classList.remove('proposal-open');
    if (this.lastFocus) this.lastFocus.focus();
  },

  build() {
    const amt = Math.max(0, +$('proposal-amount').value || 0);
    const res = Profile.result();
    const c = Portfolio.client();
    const m = Portfolio.model();
    const daily = Portfolio.clientDaily();
    const var95 = -quantile(daily, 0.05);
    const tail = daily.filter((x) => x <= -var95);
    const es95 = -mean(tail);
    const mdd = maxDrawdown(daily);
    const mkt = DATA.market;
    const inst = (k) => (mkt ? mkt.instruments.find((i) => i.key === k) : null);

    // worst historical stress on today's weights
    const sel = { w: c.w, cash: c.cash, spread: c.regime === 'borrow' ? Store.state.borrowSpread : 0 };
    const stress = DATA.stress.map((s) => {
      const days = (new Date(s.end) - new Date(s.start)) / 864e5;
      const r = Risk.scenarioImpact(sel, Object.fromEntries(KEYS.map((k) => [k, s.returns[k].ret])), s.cash.ret, days);
      return { name: s.name, r, nifty: s.benchmark.ret };
    }).sort((a, b) => a.r - b.r);

    // goal: make sure the Monte Carlo has run with current settings
    let goal = null;
    try { Goals.render(); goal = { prob: Goals.prob, inp: Goals.inp, req: Goals.reqSip }; } catch (e) { goal = null; }

    const wm = Portfolio.weightMap(c);
    const rows = [...KEYS, 'CASH'].filter((k) => Math.abs(wm[k]) > 0.0005).map((k) => {
      const a = ASSET[k];
      const i = inst(k);
      const vehicle = k === 'CASH' ? DATA.risk_free.source : a.vehicle;
      const ticker = k === 'CASH' ? DATA.risk_free.ticker : k === 'IN_EQ' ? '12 NSE stocks' : a.ticker;
      const last = i && k !== 'IN_EQ' ? `${i.ccy === 'USD' ? '$' : '₹'}${i.last.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—';
      return `<tr><td><span class="swatch" style="background:${SERIES_COLORS[k]}"></span>${esc(k === 'CASH' ? 'Risk-free / liquid' : a.name)}</td>
        <td>${esc(vehicle)}</td><td class="mono">${esc(ticker)}</td><td>${last}</td>
        <td class="num">${fmtPct(wm[k], 1)}</td><td class="num">${fmtCompactINR(wm[k] * amt)}</td></tr>`;
    }).join('');
    const stocks = mkt ? mkt.instruments.filter((i) => i.role === 'stock').map((i) => i.ticker.replace('.NS', '')).join(', ') : '';
    const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const regime = c.regime === 'lend'
      ? `${fmtPct(c.y, 0)} in the optimal risky portfolio and ${fmtPct(c.cash, 0)} in the risk-free asset`
      : c.regime === 'frontier' ? 'fully invested, positioned above the optimal risky portfolio on the efficient frontier (no leverage)'
        : `${fmtPct(c.y, 0)} exposure using ${fmtPct(-c.cash, 0)} borrowing`;

    $('proposal-body').innerHTML = `
      <header class="pp-head">
        <div>
          <div class="pp-kicker">Investment Proposal · Strategic Asset Allocation</div>
          <h2>Portfolio Construction Lab</h2>
          <div class="pp-meta">Prepared ${esc(today)} · market data as of ${esc(fmtDate(DATA.meta.as_of))} · ${esc(m.label)}</div>
        </div>
        <div class="pp-amount"><span>Investment</span><b>${fmtCompactINR(amt)}</b></div>
      </header>

      <section class="pp-grid4">
        <div><span>Risk profile</span><b>${esc(Store.state.aOverride != null ? 'Custom (manual A)' : res.label)}</b><em>A = ${c.A.toFixed(1)} · willingness ${fmtPct(res.willingness, 0)} · capacity ${fmtPct(res.capacity, 0)}</em></div>
        <div><span>Expected return</span><b>${fmtPct(c.ret, 1)} p.a.</b><em>${fmtCompactINR(c.ret * amt)} a year on average</em></div>
        <div><span>Volatility</span><b>${fmtPct(c.vol, 1)} p.a.</b><em>Sharpe ${fmtNum(c.sharpe, 2)} vs rf ${fmtPct(RF, 2)}</em></div>
        <div><span>Horizon</span><b>${res.horizonYears} years</b><em>from the questionnaire</em></div>
      </section>

      <h3>Recommended allocation</h3>
      <p class="pp-text">The client is ${regime}. Weights come from mean-variance optimization across five sleeves in INR, with each sleeve held within a 5–50% policy range.</p>
      <div class="alloc-bar pp-bar">${[...KEYS, 'CASH'].filter((k) => wm[k] > 0.0005).map((k) => `<div style="width:${(wm[k] / Math.max(1, Object.values(wm).filter((x) => x > 0).reduce((a, x) => a + x, 0)) * 100).toFixed(2)}%;background:${SERIES_COLORS[k]}"></div>`).join('')}</div>
      <table class="pp-table">
        <thead><tr><th>Sleeve</th><th>Vehicle</th><th>Ticker</th><th>Last close</th><th class="num">Weight</th><th class="num">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${stocks ? `<p class="pp-small">Indian equity basket (equal weight, monthly rebalanced): ${esc(stocks)}.</p>` : ''}

      <h3>Risk</h3>
      <section class="pp-grid4">
        <div><span>1-day VaR 95%</span><b>${fmtCompactINR(var95 * amt)}</b><em>${fmtPct(var95, 2)} · historical simulation</em></div>
        <div><span>1-day Expected Shortfall</span><b>${fmtCompactINR(es95 * amt)}</b><em>average loss on the worst 5% of days</em></div>
        <div><span>Max drawdown (backtest)</span><b>${fmtPct(mdd, 1)}</b><em>${esc(fmtDate(DATA.series.dates[0]))} → ${esc(fmtDate(DATA.meta.as_of))}</em></div>
        <div><span>Worst stress scenario</span><b>${fmtSignedPct(stress[0].r, 1)}</b><em>${esc(stress[0].name)} · Nifty ${fmtSignedPct(stress[0].nifty, 1)}</em></div>
      </section>
      <table class="pp-table compact">
        <thead><tr><th>Historical scenario replayed on this allocation</th><th class="num">Portfolio</th><th class="num">Impact</th><th class="num">Nifty 50</th></tr></thead>
        <tbody>${stress.map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${fmtSignedPct(s.r, 1)}</td><td class="num">${fmtCompactINR(s.r * amt)}</td><td class="num">${fmtSignedPct(s.nifty, 1)}</td></tr>`).join('')}</tbody>
      </table>

      ${goal ? `<h3>Goal</h3>
      <p class="pp-text">Target <b>${fmtCompactINR(goal.inp.goal)}</b> in today's money in <b>${goal.inp.years} years</b> (inflation ${fmtPct(goal.inp.infl, 1)}), starting with ${fmtCompactINR(goal.inp.initial)} and a monthly SIP of ${fmtINR(goal.inp.sip)} stepping up ${fmtPct(goal.inp.step, 0)} a year.
      Across 5,000 simulated paths the plan reaches the goal with <b>${fmtPct(goal.prob, 0)} probability</b>; a SIP of <b>${fmtINR(Math.ceil(goal.req / 100) * 100)}</b> would reach it with ${fmtPct(goal.inp.conf, 0)} confidence.</p>` : ''}

      <h3>Implementation &amp; review</h3>
      <ul class="pp-list">
        <li>Rebalance back to target when any sleeve drifts more than 5 percentage points; review the risk profile annually or after a major life event.</li>
        <li>Global sleeves are unhedged: rupee depreciation adds to returns, appreciation subtracts.</li>
        <li>The Indian debt sleeve is a target-maturity fund (April 2030) and will need to be rolled before maturity.</li>
      </ul>

      <h3>Important assumptions</h3>
      <ul class="pp-list small">
        <li>Expected returns are shrunk historical estimates (Bayes-Stein) from ${esc(fmtDate(DATA.data_quality.window.start))} onward — not forecasts. Backtested figures are in-sample.</li>
        <li>Volatility and VaR assume the future resembles the sample period; tail events can exceed historical extremes.</li>
        <li>Taxes, advisory fees and fund expense ratios beyond those embedded in ETF prices are not modeled.</li>
        <li>An independent educational project using real market data from Yahoo Finance; it is not investment advice.</li>
      </ul>`;
  },
};
