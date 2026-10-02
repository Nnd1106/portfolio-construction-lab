/* ---------------------------------------------------------------------
 * rebalance.js — Module 6: rebalancing simulator.
 * Buy-and-hold vs tolerance-band vs calendar rebalancing on real daily
 * INR returns, with proportional transaction costs.
 * ------------------------------------------------------------------- */

const STRAT_STYLE = {
  bh: { label: 'Buy & hold', color: INK.muted, dash: [] },
  band: { label: 'Band rebalancing', color: INK.primary, dash: [] },
  cal: { label: 'Calendar rebalancing', color: '#9085e9', dash: [5, 4] },
};

const Rebalance = {
  bandType: 'abs',
  wView: 'bh',

  init() {
    ['rb-band', 'rb-cost'].forEach((id) => $(id).addEventListener('input', () => this.render()));
    ['rb-check', 'rb-cal', 'rb-value'].forEach((id) => $(id).addEventListener('change', () => this.render()));
    document.querySelectorAll('#panel-rebalance [data-bandtype]').forEach((b) => b.addEventListener('click', () => {
      this.bandType = b.dataset.bandtype;
      $('rb-band').max = this.bandType === 'abs' ? 15 : 60;   // set max first so the value isn't clamped
      $('rb-band').value = this.bandType === 'abs' ? 5 : 25;
      this.render();
    }));
    document.querySelectorAll('#panel-rebalance [data-wview]').forEach((b) => b.addEventListener('click', () => {
      this.wView = b.dataset.wview;
      this.renderWeights();
    }));
  },

  params() {
    return {
      band: +$('rb-band').value / 100,
      check: $('rb-check').value,
      cal: $('rb-cal').value,
      cost: +$('rb-cost').value / 10000,
      value: Math.max(1, +$('rb-value').value || 1e7),
    };
  },

  /** True if date index t starts a new period of the given frequency. */
  periodStart(dates, t, freq) {
    if (t === 0) return false;
    const a = dates[t - 1], b = dates[t];
    if (freq === 'daily') return true;
    if (freq === 'monthly') return a.slice(0, 7) !== b.slice(0, 7);
    if (freq === 'quarterly') return a.slice(0, 4) !== b.slice(0, 4) || Math.floor((+a.slice(5, 7) - 1) / 3) !== Math.floor((+b.slice(5, 7) - 1) / 3);
    if (freq === 'annual') return a.slice(0, 4) !== b.slice(0, 4);
    if (freq === 'weekly') {
      const da = new Date(a + 'T00:00:00'), db = new Date(b + 'T00:00:00');
      return db.getDay() < da.getDay() || (db - da) / 864e5 >= 7;
    }
    return false;
  },

  /**
   * Simulate one strategy. mode: 'bh' | 'band' | 'cal'.
   * Rebalancing happens at the close of a trigger day, after that day's returns.
   */
  simulate(mode, target, p) {
    const R = DATA.series.returns;
    const dates = DATA.series.dates;
    const n = dates.length;
    const segs = [...KEYS, 'CASH'];
    const c = Portfolio.client();
    const spreadD = c.cash < 0 && c.regime === 'borrow' ? Store.state.borrowSpread / TRADING_DAYS : 0;
    let h = target.map((w) => w * p.value);
    const values = new Array(n + 1);
    const weights = [];
    const devs = new Array(n + 1);
    values[0] = p.value;
    devs[0] = 0;
    weights.push(target.slice());
    const events = [];
    let turnover = 0, costs = 0, devSum = 0;

    for (let t = 0; t < n; t++) {
      for (let i = 0; i < segs.length; i++) {
        const r = segs[i] === 'CASH' ? R.RF[t] + (h[i] < 0 ? spreadD : 0) : R[segs[i]][t];
        h[i] *= 1 + r;
      }
      let V = h.reduce((a, x) => a + x, 0);
      let w = h.map((x) => x / V);
      let dev = Math.max(...w.map((x, i) => Math.abs(x - target[i])));

      // Monitoring / calendar dates are the close of each period's last session
      // (same convention as the monthly-rebalanced backtest in Module 5).
      const periodEnd = (freq) => t + 1 < n && this.periodStart(dates, t + 1, freq);
      let trigger = false;
      if (mode === 'band' && periodEnd(p.check)) {
        trigger = w.some((x, i) => {
          const d = Math.abs(x - target[i]);
          if (this.bandType === 'abs') return d > p.band;
          // relative band; a zero-target sleeve falls back to a 1 pp absolute band
          return Math.abs(target[i]) > 1e-9 ? d / Math.abs(target[i]) > p.band : d > 0.01;
        });
      } else if (mode === 'cal') {
        trigger = periodEnd(p.cal);
      }
      if (trigger) {
        const traded = h.reduce((a, x, i) => a + Math.abs(x - target[i] * V), 0);
        const cost = p.cost * traded;
        V -= cost;
        h = target.map((tw) => tw * V);
        turnover += traded / V;
        costs += cost;
        events.push({ t: t + 1, date: dates[t], dev });
        w = target.slice();
        dev = 0;
      }
      values[t + 1] = V;
      devs[t + 1] = dev;
      devSum += dev;
      weights.push(w);
    }
    const rets = values.slice(1).map((v, i) => v / values[i] - 1);
    const years = n / TRADING_DAYS;
    const ex = rets.map((r, i) => r - R.RF[i]);
    return {
      mode, values, weights, devs, events, rets,
      final: values[n],
      cagr: Math.pow(values[n] / values[0], 1 / years) - 1,
      vol: stdDev(rets) * Math.sqrt(TRADING_DAYS),
      sharpe: (mean(ex) * TRADING_DAYS) / (stdDev(rets) * Math.sqrt(TRADING_DAYS)),
      mdd: maxDrawdown(rets),
      turnover, costs,
      avgDev: devSum / n,
      maxDev: Math.max(...devs),
      endWeights: weights[weights.length - 1],
    };
  },

  render() {
    const p = this.params();
    document.querySelectorAll('#panel-rebalance [data-bandtype]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.bandtype === this.bandType)));
    $('rb-band-val').textContent = this.bandType === 'abs' ? `±${(p.band * 100).toFixed(1)} pp` : `±${(p.band * 100).toFixed(0)}% of target`;
    $('rb-band-note').textContent = this.bandType === 'abs'
      ? 'e.g. a 50% target with a 5 pp band trades back when it leaves 45–55%.'
      : 'e.g. a 50% target with a 25% relative band trades back when it leaves 37.5–62.5%; small sleeves get proportionally tighter bands.';
    $('rb-band-max').textContent = this.bandType === 'abs' ? '15 pp' : '60%';
    $('rb-band-min').textContent = this.bandType === 'abs' ? '1 pp' : '1%';
    $('rb-cost-val').textContent = `${(p.cost * 10000).toFixed(0)} bp`;

    const c = Portfolio.client();
    const target = [...c.w, c.cash];
    this.target = target;
    this.res = {
      bh: this.simulate('bh', target, p),
      band: this.simulate('band', target, p),
      cal: this.simulate('cal', target, p),
    };
    this.renderTable(p);
    this.renderValue();
    this.renderWeights();
    this.renderDeviation(p);
  },

  renderTable(p) {
    const S = this.res;
    const calName = { monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual' }[p.cal];
    const cols = [['bh', 'Buy &amp; hold'], ['band', 'Band'], ['cal', `${calName} calendar`]];
    const row = (label, fn) => `<tr><td>${label}</td>${cols.map(([k]) => `<td${k === 'band' ? ' style="color:var(--text-primary)"' : ''}>${fn(S[k])}</td>`).join('')}</tr>`;
    const eqIdx = KEYS.indexOf('IN_GOLD');
    $('rb-table').innerHTML = `<thead><tr><th>Metric</th>${cols.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>` +
      row('Ending value', (s) => fmtCompactINR(s.final)) +
      row('CAGR (net of costs)', (s) => fmtPct(s.cagr, 2)) +
      row('Annual volatility', (s) => fmtPct(s.vol, 2)) +
      row('Sharpe ratio', (s) => fmtNum(s.sharpe, 2)) +
      row('Maximum drawdown', (s) => fmtPct(s.mdd, 1)) +
      row('Rebalances', (s) => String(s.events.length)) +
      row('Cumulative turnover', (s) => `${(s.turnover * 100).toFixed(0)}%`) +
      row('Transaction costs paid', (s) => fmtCompactINR(s.costs)) +
      row('Avg. largest deviation', (s) => `${(s.avgDev * 100).toFixed(1)} pp`) +
      row(`Ending ${ASSET.IN_GOLD.short} weight (target ${fmtPct(this.target[eqIdx], 0)})`, (s) => fmtPct(s.endWeights[eqIdx], 1)) +
      '</tbody>';

    const b = S.band, h = S.bh;
    const diff = b.cagr - h.cagr;
    const volDiff = b.vol - h.vol;
    const biggest = KEYS.map((k, i) => ({ k, d: h.endWeights[i] - this.target[i] })).sort((x, y) => Math.abs(y.d) - Math.abs(x.d))[0];
    $('rb-insight').innerHTML = `<strong>Band rebalancing ${diff >= 0 ? 'added' : 'cost'} ${fmtBp(diff).replace(/^[+−]/, '')} a year</strong> versus buy-and-hold
      (${b.events.length} rebalances, ${fmtCompactINR(b.costs)} in costs), with volatility ${volDiff <= 0 ? 'lower' : 'higher'} by
      ${Math.abs(volDiff * 100).toFixed(2)} pp and max drawdown ${fmtPct(b.mdd, 1)} vs ${fmtPct(h.mdd, 1)}.
      Left alone, the portfolio drifted furthest in <strong>${esc(ASSET[biggest.k].name)}</strong> (${fmtSignedPct(biggest.d, 1)} vs target), so
      buy-and-hold ended up carrying a different risk profile than the one the client signed off on. ${diff < 0
        ? 'Over this window, trending winners rewarded letting weights run — rebalancing is primarily a <strong>risk-control discipline</strong>, not a guaranteed return enhancer.'
        : 'Here, systematically trimming winners and adding to laggards harvested mean reversion between sleeves.'}`;
  },

  renderValue() {
    const labels = ['', ...DATA.series.dates];
    const datasets = ['bh', 'band', 'cal'].map((k) => ({
      label: STRAT_STYLE[k].label, data: this.res[k].values, borderColor: STRAT_STYLE[k].color, borderDash: STRAT_STYLE[k].dash,
      borderWidth: k === 'band' ? 2 : 1.5, pointRadius: 0,
    }));
    upsertChart('chart-rb-value', {
      type: 'line',
      data: { labels, datasets },
      options: {
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { maxTicksLimit: 8, callback(v) { return this.getLabelForValue(v).slice(0, 7); } }, grid: { display: false } },
          y: { ticks: { callback: (v) => fmtCompactINR(v) }, grid: { color: INK.grid } },
        },
        plugins: { tooltip: { callbacks: { title: (it) => (it[0].label ? fmtDate(it[0].label) : 'Start'), label: (it) => `${it.dataset.label}: ${fmtCompactINR(it.raw)}` } } },
      },
    });
    $('rb-value-legend').innerHTML = ['bh', 'band', 'cal'].map((k) =>
      `<span><span class="line-key${STRAT_STYLE[k].dash.length ? ' dashed' : ''}" style="border-color:${STRAT_STYLE[k].color}"></span>${STRAT_STYLE[k].label} ${fmtCompactINR(this.res[k].final)}</span>`).join('');
  },

  renderWeights() {
    document.querySelectorAll('#panel-rebalance [data-wview]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.wview === this.wView)));
    const s = this.res[this.wView];
    const step = 5; // weekly sampling keeps the stacked area light
    const idx = [];
    for (let t = 0; t < s.weights.length; t += step) idx.push(t);
    const labels = idx.map((t) => (t === 0 ? DATA.series.dates[0] : DATA.series.dates[t - 1]));
    const segs = [...KEYS, 'CASH'];
    const datasets = segs.map((k, i) => ({
      label: k === 'CASH' ? 'Risk-free' : ASSET[k].short,
      data: idx.map((t) => s.weights[t][i]),
      backgroundColor: alpha(SERIES_COLORS[k], 0.85),
      borderColor: INK.surface,
      borderWidth: 1,
      fill: i === 0 ? 'origin' : '-1',
      pointRadius: 0,
      hidden: Math.abs(this.target[i]) < 1e-9 && Math.max(...idx.map((t) => Math.abs(s.weights[t][i]))) < 1e-6,
    }));
    upsertChart('chart-rb-weights', {
      type: 'line',
      data: { labels, datasets },
      options: {
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { maxTicksLimit: 7, callback(v) { return this.getLabelForValue(v).slice(0, 7); } }, grid: { display: false } },
          y: { stacked: true, min: Math.min(0, ...this.target), max: Math.max(1, this.target.reduce((a, x) => a + Math.max(x, 0), 0)), ticks: { callback: pctTick(0) }, grid: { color: INK.grid } },
        },
        plugins: { tooltip: { callbacks: { title: (it) => fmtDate(it[0].label), label: (it) => `${it.dataset.label}: ${fmtPct(it.raw, 1)} (target ${fmtPct(this.target[it.datasetIndex], 1)})` } } },
      },
    });
    $('rb-w-legend').innerHTML = segs.filter((k, i) => Math.abs(this.target[i]) > 1e-9).map((k) =>
      `<span><span class="swatch" style="background:${SERIES_COLORS[k]}"></span>${esc(k === 'CASH' ? 'Risk-free' : ASSET[k].short)}</span>`).join('');
  },

  renderDeviation(p) {
    const labels = ['', ...DATA.series.dates];
    const bandLine = this.bandType === 'abs' ? labels.map(() => p.band) : null;
    const datasets = [
      { label: 'Buy & hold', data: this.res.bh.devs, borderColor: INK.muted, borderWidth: 1.5, pointRadius: 0 },
      { label: 'Band strategy', data: this.res.band.devs, borderColor: INK.primary, borderWidth: 1.5, pointRadius: 0 },
    ];
    if (bandLine) datasets.push({ label: 'Band', data: bandLine, borderColor: TAIL_COLOR, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0 });
    upsertChart('chart-rb-dev', {
      type: 'line',
      data: { labels, datasets },
      options: {
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { maxTicksLimit: 7, callback(v) { return this.getLabelForValue(v).slice(0, 7); } }, grid: { display: false } },
          y: { min: 0, ticks: { callback: pctTick(0) }, grid: { color: INK.grid } },
        },
        plugins: { tooltip: { callbacks: { title: (it) => (it[0].label ? fmtDate(it[0].label) : 'Start'), label: (it) => `${it.dataset.label}: ${(it.raw * 100).toFixed(1)} pp` } } },
      },
    });
    $('rb-dev-legend').innerHTML = `<span><span class="line-key" style="border-color:${INK.muted}"></span>Buy &amp; hold</span>
      <span><span class="line-key" style="border-color:${INK.primary}"></span>Band strategy (resets on rebalance)</span>` +
      (bandLine ? `<span><span class="line-key dashed" style="border-color:${TAIL_COLOR}"></span>Band ±${(p.band * 100).toFixed(1)} pp</span>` : '<span>Relative bands differ by sleeve — no single threshold line.</span>');
  },
};
