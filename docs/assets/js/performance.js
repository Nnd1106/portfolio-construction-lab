/* ---------------------------------------------------------------------
 * performance.js — Module 5: performance & attribution.
 * Monthly-rebalanced backtest of the selected allocation, risk-adjusted
 * ratios vs the Nifty 50, and Brinson-Fachler attribution against the
 * policy benchmark with Carino multi-period linking.
 * ------------------------------------------------------------------- */

const EFFECT_COLORS = { allocation: INK.primary, selection: '#9085e9', interaction: INK.muted };

/**
 * Daily returns of a portfolio rebalanced to target weights at the first
 * session of each month (weights drift in between). `wAll` covers the
 * five sleeves plus cash; `segRet(t)` returns the per-segment daily
 * returns for day t in the same order.
 */
function monthlyRebalancedReturns(dates, wAll, segRet) {
  const n = dates.length;
  const out = new Array(n);
  let h = null, V = 1, month = null;
  for (let t = 0; t < n; t++) {
    const m = dates[t].slice(0, 7);
    if (m !== month) { h = wAll.map((w) => w * V); month = m; }
    const r = segRet(t);
    let Vn = 0;
    for (let i = 0; i < h.length; i++) { h[i] *= 1 + r[i]; Vn += h[i]; }
    out[t] = Vn / V - 1;
    V = Vn;
  }
  return out;
}

const Performance = {
  period: 'all',

  init() {
    $('perf-port').addEventListener('change', () => this.render());
    document.querySelectorAll('#panel-performance [data-period]').forEach((b) => b.addEventListener('click', () => {
      this.period = b.dataset.period;
      this.render();
    }));
  },

  selection() {
    const which = $('perf-port').value;
    const m = Portfolio.model();
    if (which === 'client') {
      const c = Portfolio.client();
      return { label: 'Client portfolio', w: c.w, cash: c.cash, spread: c.regime === 'borrow' ? Store.state.borrowSpread : 0 };
    }
    return { label: which.toUpperCase(), w: m[which].w, cash: 0, spread: 0 };
  },

  /** Index range [s, n) of the evaluation period. */
  range() {
    const d = DATA.series.dates;
    if (this.period === 'all') return 0;
    const last = new Date(d[d.length - 1]);
    last.setFullYear(last.getFullYear() - +this.period);
    const iso = last.toISOString().slice(0, 10);
    return d.findIndex((x) => x > iso);
  },

  compute() {
    const s = this.range();
    const R = DATA.series.returns;
    const dates = DATA.series.dates.slice(s);
    const sel = this.selection();
    const spreadD = sel.cash < 0 ? sel.spread / TRADING_DAYS : 0;
    const segP = (t) => [...KEYS.map((k) => R[k][s + t]), R.RF[s + t] + spreadD];
    const segB = (t) => [...KEYS.map((k) => (k === 'IN_EQ' ? R.BENCH[s + t] : R[k][s + t])), R.RF[s + t]];
    const wP = [...sel.w, sel.cash];
    const wB = [...KEYS.map((k) => DATA.policy_benchmark[k] || 0), 0];
    const port = monthlyRebalancedReturns(dates, wP, segP);
    // Policy benchmark holds the Nifty 50 (not the stock basket) in its Indian-equity segment.
    const policy = monthlyRebalancedReturns(dates, wB, segB);
    const bench = R.BENCH.slice(s);
    const rf = R.RF.slice(s);
    return { s, dates, sel, wP, wB, segP, segB, port, policy, bench, rf };
  },

  metricsRow(r, rf, b, dates) {
    const m = riskMetrics(r, rf, b, 0.95);
    const mo = monthlyReturns(dates, { r }).returns.r;
    return { ...m, best: Math.max(...mo), worst: Math.min(...mo), posShare: mo.filter((x) => x > 0).length / mo.length };
  },

  renderTable(C) {
    const P = this.metricsRow(C.port, C.rf, C.bench, C.dates);
    const N = this.metricsRow(C.bench, C.rf, C.bench, C.dates);
    const B = this.metricsRow(C.policy, C.rf, C.bench, C.dates);
    const f = (v, fmt) => (Number.isFinite(v) ? fmt(v) : '—');
    const rows = [
      ['CAGR', 'cagr', (v) => fmtPct(v, 2)],
      ['Annual volatility', 'vol_ann', (v) => fmtPct(v, 2)],
      ['Sharpe ratio', 'sharpe', (v) => fmtNum(v, 2)],
      ['Sortino ratio', 'sortino', (v) => fmtNum(v, 2)],
      ['Beta vs Nifty 50', 'beta', (v) => fmtNum(v, 2)],
      ['Treynor ratio', 'treynor', (v) => fmtPct(v, 2)],
      ["Jensen's alpha", 'jensen_alpha', (v) => fmtSignedPct(v, 2)],
      ['Tracking error', 'tracking_error', (v) => fmtPct(v, 2)],
      ['Information ratio', 'information_ratio', (v) => fmtNum(v, 2)],
      ['Maximum drawdown', 'max_drawdown', (v) => fmtPct(v, 1)],
      ['Best month', 'best', (v) => fmtSignedPct(v, 1)],
      ['Worst month', 'worst', (v) => fmtSignedPct(v, 1)],
      ['Positive months', 'posShare', (v) => fmtPct(v, 0)],
    ];
    N.tracking_error = NaN; N.information_ratio = NaN; N.jensen_alpha = 0;
    $('perf-table').innerHTML = `<thead><tr><th>Metric</th><th>${esc(C.sel.label)}</th><th>Nifty 50</th><th>Policy benchmark</th></tr></thead><tbody>` +
      rows.map(([label, k, fmt]) => `<tr><td>${label}</td><td style="color:var(--text-primary)">${f(P[k], fmt)}</td><td>${f(N[k], fmt)}</td><td>${f(B[k], fmt)}</td></tr>`).join('') + '</tbody>';
    this._P = P;
    $('perf-table-note').innerHTML = P.beta < 0.5
      ? `<strong style="color:var(--text-secondary)">Interpret Treynor and Jensen's α with care:</strong> with β = ${fmtNum(P.beta, 2)} most of this portfolio's risk is not Nifty 50 market risk (gold, global assets, debt), so a single-index measure attributes that diversifying return to "alpha" and divides by a small β. Sharpe and Sortino, which use total risk, are the appropriate ratios for a multi-asset portfolio.`
      : '';
  },

  renderGrowth(C) {
    const labels = ['', ...C.dates];
    const scale = (r) => wealthPath(r, 1e6);
    const P = scale(C.port), N = scale(C.bench), B = scale(C.policy);
    upsertChart('chart-perf-growth', {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: C.sel.label, data: P, borderColor: INK.primary, pointRadius: 0 },
          { label: 'Nifty 50', data: N, borderColor: INK.muted, pointRadius: 0 },
          { label: 'Policy benchmark', data: B, borderColor: INK.secondary, borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5 },
        ],
      },
      options: {
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { maxTicksLimit: 7, callback(v) { return this.getLabelForValue(v).slice(0, 7); } }, grid: { display: false } },
          y: { ticks: { callback: (v) => fmtCompactINR(v) }, grid: { color: INK.grid } },
        },
        plugins: { tooltip: { callbacks: { title: (it) => (it[0].label ? fmtDate(it[0].label) : 'Start'), label: (it) => `${it.dataset.label}: ${fmtCompactINR(it.raw)}` } } },
      },
    });
    const end = (arr) => fmtCompactINR(arr[arr.length - 1]);
    $('perf-growth-legend').innerHTML = `<span><span class="line-key" style="border-color:${INK.primary}"></span>${esc(C.sel.label)} ${end(P)}</span>
      <span><span class="line-key" style="border-color:${INK.muted}"></span>Nifty 50 ${end(N)}</span>
      <span><span class="line-key dashed" style="border-color:${INK.secondary}"></span>Policy benchmark ${end(B)}</span>`;
  },

  rollingSharpe(r, rf, win = 252) {
    const out = new Array(r.length).fill(null);
    const ex = r.map((x, i) => x - rf[i]);
    for (let t = win; t <= r.length; t++) {
      const w = ex.slice(t - win, t);
      const raw = r.slice(t - win, t);
      out[t - 1] = (mean(w) * TRADING_DAYS) / (stdDev(raw) * Math.sqrt(TRADING_DAYS));
    }
    return out;
  },

  renderRolling(C) {
    if (C.dates.length < 300) {
      upsertChart('chart-perf-roll', { type: 'line', data: { labels: [], datasets: [] } });
      $('perf-roll-legend').innerHTML = '<span>Needs more than one year of data — choose the 3Y or Full period.</span>';
      return;
    }
    const P = this.rollingSharpe(C.port, C.rf);
    const N = this.rollingSharpe(C.bench, C.rf);
    upsertChart('chart-perf-roll', {
      type: 'line',
      data: {
        labels: C.dates,
        datasets: [
          { label: C.sel.label, data: P, borderColor: INK.primary, pointRadius: 0, spanGaps: false },
          { label: 'Nifty 50', data: N, borderColor: INK.muted, pointRadius: 0, spanGaps: false },
        ],
      },
      options: {
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { maxTicksLimit: 7, callback(v) { return this.getLabelForValue(v).slice(0, 7); } }, grid: { display: false } },
          y: { grid: { color: (ctx) => (ctx.tick.value === 0 ? alpha(INK.secondary, 0.5) : INK.grid) } },
        },
        plugins: { tooltip: { callbacks: { title: (it) => fmtDate(it[0].label), label: (it) => (it.raw == null ? null : `${it.dataset.label}: ${fmtNum(it.raw, 2)}`) } } },
      },
    });
    $('perf-roll-legend').innerHTML = `<span><span class="line-key" style="border-color:${INK.primary}"></span>${esc(C.sel.label)}</span><span><span class="line-key" style="border-color:${INK.muted}"></span>Nifty 50</span>`;
  },

  /** Brinson-Fachler per month, Carino-linked over the period. */
  brinson(C) {
    const segs = [...KEYS, 'CASH'];
    const n = segs.length;
    const P = {}, B = {};
    segs.forEach((k, i) => {
      P[k] = C.dates.map((_, t) => C.segP(t)[i]);
      B[k] = C.dates.map((_, t) => C.segB(t)[i]);
    });
    const mP = monthlyReturns(C.dates, P).returns;
    const mB = monthlyReturns(C.dates, B).returns;
    const months = monthlyReturns(C.dates, { x: C.port }).months;
    const T = months.length;
    const wp = C.wP, wb = C.wB;

    const perMonth = [];
    let gP = 1, gB = 1;
    for (let t = 0; t < T; t++) {
      const rp = segs.map((k) => mP[k][t]);
      const rb = segs.map((k) => mB[k][t]);
      const Rp = dot(wp, rp), Rb = dot(wb, rb);
      const eff = segs.map((_, i) => ({
        allocation: (wp[i] - wb[i]) * (rb[i] - Rb),
        selection: wb[i] * (rp[i] - rb[i]),
        interaction: (wp[i] - wb[i]) * (rp[i] - rb[i]),
      }));
      perMonth.push({ Rp, Rb, eff, rp, rb });
      gP *= 1 + Rp; gB *= 1 + Rb;
    }
    const RpT = gP - 1, RbT = gB - 1;
    const carino = (a, b) => (Math.abs(a - b) < 1e-12 ? 1 / (1 + a) : (Math.log(1 + a) - Math.log(1 + b)) / (a - b));
    const K = carino(RpT, RbT);
    const linked = segs.map(() => ({ allocation: 0, selection: 0, interaction: 0 }));
    perMonth.forEach((pm) => {
      const k = carino(pm.Rp, pm.Rb) / K;
      pm.eff.forEach((e, i) => {
        linked[i].allocation += k * e.allocation;
        linked[i].selection += k * e.selection;
        linked[i].interaction += k * e.interaction;
      });
    });
    const cum = (arr) => arr.reduce((g, x) => g * (1 + x), 1) - 1;
    const segCumP = segs.map((k) => cum(mP[k]));
    const segCumB = segs.map((k) => cum(mB[k]));
    return { segs, linked, RpT, RbT, months: T, segCumP, segCumB, wp, wb };
  },

  renderBrinson(C) {
    const A = this.brinson(C);
    const names = A.segs.map((k) => (k === 'CASH' ? 'Cash / financing' : ASSET[k].short));
    const tot = (key) => A.linked.reduce((s, e) => s + e[key], 0);
    const tA = tot('allocation'), tS = tot('selection'), tI = tot('interaction');
    const active = A.RpT - A.RbT;
    const yrs = C.dates.length / TRADING_DAYS;

    $('perf-brinson-desc').innerHTML = `Over ${A.months} months the ${esc(C.sel.label.toLowerCase())} returned <strong style="color:var(--text-primary)">${fmtPct(A.RpT, 1)}</strong>
      vs <strong style="color:var(--text-primary)">${fmtPct(A.RbT, 1)}</strong> for the 50/30/10/10 policy benchmark —
      ${fmtSignedPct(active, 1)} cumulative active return (≈ ${fmtSignedPct(Math.pow(1 + A.RpT, 1 / yrs) - Math.pow(1 + A.RbT, 1 / yrs), 2)} a year).`;

    upsertChart('chart-perf-brinson', {
      type: 'bar',
      data: {
        labels: names,
        datasets: ['allocation', 'selection', 'interaction'].map((k) => ({
          label: k[0].toUpperCase() + k.slice(1), data: A.linked.map((e) => e[k]), backgroundColor: EFFECT_COLORS[k],
          borderRadius: 3, barPercentage: 0.85, categoryPercentage: 0.75,
        })),
      },
      options: {
        animation: false,
        indexAxis: 'y',
        scales: { x: { ticks: { callback: pctTick(1) }, grid: { color: (ctx) => (ctx.tick.value === 0 ? alpha(INK.secondary, 0.5) : INK.grid) } }, y: { grid: { display: false } } },
        plugins: { tooltip: { callbacks: { label: (it) => `${it.dataset.label}: ${fmtSignedPct(it.raw, 2)}` } } },
      },
    });

    const steps = [
      { label: 'Policy bmk', from: 0, to: A.RbT, color: INK.secondary },
      { label: 'Allocation', from: A.RbT, to: A.RbT + tA, color: EFFECT_COLORS.allocation },
      { label: 'Selection', from: A.RbT + tA, to: A.RbT + tA + tS, color: EFFECT_COLORS.selection },
      { label: 'Interaction', from: A.RbT + tA + tS, to: A.RbT + tA + tS + tI, color: EFFECT_COLORS.interaction },
      { label: 'Portfolio', from: 0, to: A.RpT, color: INK.secondary },
    ];
    upsertChart('chart-perf-waterfall', {
      type: 'bar',
      data: {
        labels: steps.map((s) => s.label),
        datasets: [{ data: steps.map((s) => [s.from, s.to]), backgroundColor: steps.map((s) => s.color), borderRadius: 3, barPercentage: 0.7, borderSkipped: false }],
      },
      options: {
        animation: false,
        scales: { y: { ticks: { callback: pctTick(0) }, grid: { color: INK.grid } }, x: { grid: { display: false } } },
        plugins: { tooltip: { callbacks: { label: (it) => {
          const s = steps[it.dataIndex];
          return s.label === 'Policy bmk' || s.label === 'Portfolio' ? `Cumulative return: ${fmtPct(s.to, 2)}` : `Effect: ${fmtSignedPct(s.to - s.from, 2)}`;
        } } } },
      },
    });

    const cell = (v) => `<td class="${v < -1e-6 ? 'neg' : v > 1e-6 ? 'pos' : ''}">${fmtSignedPct(v, 2)}</td>`;
    $('perf-brinson-table').innerHTML = `<thead><tr><th>Segment</th><th>w<sub>p</sub></th><th>w<sub>b</sub></th><th>R<sub>p</sub> (cum)</th><th>R<sub>b</sub> (cum)</th><th>Allocation</th><th>Selection</th><th>Interaction</th><th>Total</th></tr></thead><tbody>` +
      A.segs.map((k, i) => {
        const e = A.linked[i];
        return `<tr><td><span class="swatch" style="background:${SERIES_COLORS[k]}"></span>${esc(names[i])}${k === 'IN_EQ' ? ' <span style="color:var(--text-muted)">(basket vs Nifty 50)</span>' : ''}</td>
          <td>${fmtPct(A.wp[i], 1)}</td><td>${fmtPct(A.wb[i], 1)}</td><td>${fmtPct(A.segCumP[i], 1)}</td><td>${fmtPct(A.segCumB[i], 1)}</td>
          ${cell(e.allocation)}${cell(e.selection)}${cell(e.interaction)}${cell(e.allocation + e.selection + e.interaction)}</tr>`;
      }).join('') +
      `</tbody><tfoot><tr class="total"><td>Total</td><td>${fmtPct(A.wp.reduce((a, x) => a + x, 0), 0)}</td><td>${fmtPct(A.wb.reduce((a, x) => a + x, 0), 0)}</td>
        <td>${fmtPct(A.RpT, 1)}</td><td>${fmtPct(A.RbT, 1)}</td>${cell(tA)}${cell(tS)}${cell(tI)}${cell(tA + tS + tI)}</tr></tfoot>`;

    // Reconciliation: linked effects must equal the active return, and the monthly
    // attribution portfolio must reproduce the daily backtest exactly.
    const wealthDaily = C.port.reduce((g, x) => g * (1 + x), 1) - 1;
    const wealthPolicy = C.policy.reduce((g, x) => g * (1 + x), 1) - 1;
    const err1 = Math.abs(tA + tS + tI - active);
    const err2 = Math.max(Math.abs(wealthDaily - A.RpT), Math.abs(wealthPolicy - A.RbT));
    const ok = err1 < 1e-9 && err2 < 1e-9;
    const top = A.linked.map((e, i) => ({ n: names[i], v: e.allocation })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0];
    $('perf-brinson-check').innerHTML = `<span class="status-chip ${ok ? 'good' : 'critical'}">${ok ? '✓' : '✕'} Reconciled</span>
      &nbsp;Allocation + selection + interaction = ${fmtSignedPct(tA + tS + tI, 4)} vs active return ${fmtSignedPct(active, 4)} (|Δ| ${err1.toExponential(1)});
      monthly attribution reproduces the daily backtest (|Δ| ${err2.toExponential(1)}).
      Largest single driver: <strong>${esc(top.n)} allocation (${fmtSignedPct(top.v, 1)})</strong>.
      Selection comes only from the stock basket vs Nifty 50 and is inflated by survivorship bias.`;
    this.lastBrinson = { tA, tS, tI, active, err1, err2 };
  },

  render() {
    document.querySelectorAll('#panel-performance [data-period]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.period === this.period)));
    const C = this.compute();
    $('perf-period-note').textContent = `${fmtDate(C.dates[0])} → ${fmtDate(C.dates[C.dates.length - 1])} · ${C.dates.length} sessions`;
    this.renderTable(C);
    this.renderGrowth(C);
    this.renderRolling(C);
    this.renderBrinson(C);
  },
};
