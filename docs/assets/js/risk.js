/* ---------------------------------------------------------------------
 * risk.js — Module 3: risk & stress dashboard.
 * VaR / Expected Shortfall (historical + parametric), rolling VaR backtest
 * with the Kupiec POF test and Basel traffic light, drawdowns, risk
 * contributions, correlation heatmap, historical and custom stress tests.
 * ------------------------------------------------------------------- */

const TAIL_COLOR = '#e66767';         // categorical slot 8 (red, dark step) — loss tail
const BREACH_COLOR = '#e66767';

/** Complementary error function (Numerical Recipes erfcc, |rel err| < 1.2e-7). */
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
    t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/** Kupiec proportion-of-failures likelihood ratio and χ²(1) p-value. */
function kupiec(T, x, p) {
  const ll = (q) => (T - x) * Math.log(1 - q) + (x > 0 ? x * Math.log(q) : 0);
  const phat = x / T;
  const llHat = x === 0 ? T * Math.log(1) : x === T ? T * Math.log(1) : ll(phat);
  const LR = Math.max(0, -2 * (ll(p) - llHat));
  return { LR, pValue: erfc(Math.sqrt(LR / 2)) };
}

const Risk = {
  corrMode: 'weekly',
  custom: { IN_EQ: -0.25, IN_GOLD: 0.08, IN_DEBT: -0.02, GL_EQ: -0.2, GL_BOND: 0.02 },

  init() {
    ['risk-port', 'risk-value'].forEach((id) => $(id).addEventListener('change', () => this.render()));
    ['risk-conf', 'risk-h'].forEach((id) => $(id).addEventListener('input', () => this.render()));
    document.querySelectorAll('#panel-risk [data-corr]').forEach((b) => b.addEventListener('click', () => {
      this.corrMode = b.dataset.corr;
      this.renderHeatmap();
    }));
    $('risk-custom-sliders').innerHTML = KEYS.map((k) => `
      <div>
        <div class="control-label"><span><span class="swatch" style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:${SERIES_COLORS[k]}"></span>${esc(ASSET[k].short)}</span><span class="value" id="cs-${k}-val"></span></div>
        <input type="range" min="-0.6" max="0.6" step="0.01" id="cs-${k}" value="${this.custom[k]}" aria-label="Shock to ${esc(ASSET[k].name)}" />
      </div>`).join('');
    KEYS.forEach((k) => $('cs-' + k).addEventListener('input', (e) => {
      this.custom[k] = +e.target.value;
      this.renderCustom(this.selected());
    }));
  },

  /** The portfolio currently selected in the dropdown. */
  selected() {
    const which = $('risk-port').value;
    const m = Portfolio.model();
    const zero = KEYS.map(() => 0);
    if (which === 'client') {
      const c = Portfolio.client();
      const spread = c.regime === 'borrow' ? Store.state.borrowSpread : 0;
      return { label: 'Client portfolio', w: c.w, cash: c.cash, spread, daily: Portfolio.clientDaily() };
    }
    if (which === 'orp' || which === 'mvp') {
      const w = m[which].w;
      return { label: which.toUpperCase(), w, cash: 0, spread: 0, daily: Portfolio.dailyReturns(w) };
    }
    if (which === 'policy') {
      const w = KEYS.map((k) => DATA.policy_benchmark[k] || 0);
      // Stress / custom shocks apply sleeve returns; history uses the Nifty 50 for the equity segment.
      return { label: 'Policy benchmark', w, cash: 0, spread: 0, daily: Portfolio.policyDaily(), niftyEquity: true };
    }
    return { label: 'Nifty 50', w: null, cash: 0, spread: 0, daily: DATA.series.returns.BENCH.slice(), wBench: zero };
  },

  params() {
    return {
      conf: +$('risk-conf').value / 100,
      h: +$('risk-h').value,
      value: Math.max(0, +$('risk-value').value || 0),
    };
  },

  /** Overlapping compounded h-day returns. */
  horizonReturns(daily, h) {
    if (h === 1) return daily;
    const out = [];
    for (let t = 0; t + h <= daily.length; t++) {
      let g = 1;
      for (let j = t; j < t + h; j++) g *= 1 + daily[j];
      out.push(g - 1);
    }
    return out;
  },

  varEs(daily, conf, h) {
    const rh = this.horizonReturns(daily, h);
    const q = quantile(rh, 1 - conf);
    const tail = rh.filter((x) => x <= q);
    const mu = mean(daily) * h, sd = stdDev(daily) * Math.sqrt(h);
    const z = normInv(1 - conf);
    return {
      rh, varH: -q, esH: -mean(tail),
      varP: -(mu + z * sd), esP: -(mu - sd * normPdf(z) / (1 - conf)),
      mu, sd,
    };
  },

  renderStats(sel, p, v) {
    const box = (label, pct, sub, color) => `<div class="stat-box" style="border-left:3px solid ${color}">
      <div class="stat-label">${label}</div><div class="stat-value">${fmtCompactINR(pct * p.value)}</div>
      <div class="stat-sub">${fmtPct(pct, 2)} ${sub}</div></div>`;
    const hl = `${p.h}-day`;
    $('risk-stats').innerHTML = [
      box(`Historical VaR ${fmtPct(p.conf, 1)}`, v.varH, `· ${hl}`, INK.primary),
      box(`Parametric VaR ${fmtPct(p.conf, 1)}`, v.varP, `· ${hl} normal`, INK.secondary),
      box(`Historical ES / CVaR`, v.esH, `· mean loss beyond VaR`, INK.primary),
      box(`Parametric ES / CVaR`, v.esP, `· ${hl} normal`, INK.secondary),
      `<div class="stat-box" style="border-left:3px solid ${INK.muted}"><div class="stat-label">Annual volatility</div>
        <div class="stat-value">${fmtPct(stdDev(sel.daily) * Math.sqrt(TRADING_DAYS), 1)}</div><div class="stat-sub">realized, daily ×√252</div></div>`,
      `<div class="stat-box" style="border-left:3px solid ${TAIL_COLOR}"><div class="stat-label">Maximum drawdown</div>
        <div class="stat-value">${fmtPct(maxDrawdown(sel.daily), 1)}</div><div class="stat-sub">peak-to-trough, in window</div></div>`,
    ].join('');
  },

  renderHistogram(p, v) {
    const rh = v.rh;
    const lo = quantile(rh, 0.001), hi = quantile(rh, 0.999);
    const nb = 60, bw = (hi - lo) / nb;
    const counts = new Array(nb).fill(0);
    rh.forEach((x) => {
      const i = Math.min(nb - 1, Math.max(0, Math.floor((x - lo) / bw)));
      counts[i] += 1;
    });
    const centers = counts.map((_, i) => lo + (i + 0.5) * bw);
    const normal = centers.map((x) => rh.length * bw * normPdf((x - v.mu) / v.sd) / v.sd);
    upsertChart('chart-risk-hist', {
      data: {
        datasets: [
          { type: 'bar', label: 'Observed', data: centers.map((x, i) => ({ x, y: counts[i] })),
            backgroundColor: centers.map((x) => (x <= -v.varH ? TAIL_COLOR : alpha(INK.secondary, 0.55))),
            borderRadius: 2, barPercentage: 1, categoryPercentage: 0.9, order: 2 },
          { type: 'line', label: 'Normal fit', data: centers.map((x, i) => ({ x, y: normal[i] })),
            borderColor: INK.primary, borderWidth: 1.5, borderDash: [4, 3], pointRadius: 0, order: 1 },
        ],
      },
      options: {
        animation: false,
        interaction: { mode: 'nearest', intersect: false, axis: 'x' },
        scales: {
          x: { type: 'linear', min: lo, max: hi, ticks: { callback: pctTick(1), maxTicksLimit: 8 }, title: { display: true, text: `${p.h}-day return` }, grid: { color: INK.grid } },
          y: { title: { display: true, text: 'Frequency' }, grid: { color: INK.grid } },
        },
        plugins: {
          vLines: { lines: [
            { x: -v.varH, color: INK.primary, label: `Hist VaR ${fmtPct(v.varH, 2)}` },
            { x: -v.varP, color: INK.secondary, dash: [5, 4], label: `Param VaR ${fmtPct(v.varP, 2)}`, row: 1 },
          ] },
          tooltip: { callbacks: {
            title: (items) => `Return ≈ ${fmtPct(items[0].parsed.x, 2)}`,
            label: (item) => `${item.dataset.label}: ${item.parsed.y.toFixed(item.datasetIndex ? 1 : 0)} obs`,
          } },
        },
      },
      plugins: [vLinePlugin],
    });
    $('risk-hist-legend').innerHTML = `<span><span class="swatch" style="background:${alpha(INK.secondary, 0.55)}"></span>Observed returns</span>
      <span><span class="swatch" style="background:${TAIL_COLOR}"></span>Beyond historical VaR</span>
      <span><span class="line-key dashed" style="border-color:${INK.primary}"></span>Normal with same μ, σ</span>`;
    const ex = (mean(rh.map((x) => ((x - mean(rh)) / stdDev(rh)) ** 4))) - 3;
    $('risk-tail-note').textContent = `Excess kurtosis ${fmtNum(ex, 2)} — ${ex > 0.5 ? 'fatter tails than normal, so parametric ES understates the historical tail' : 'close to normal tails'}. ` +
      `Historical ES / parametric ES = ${fmtNum(v.esH / v.esP, 2)}×.`;
  },

  renderContrib(sel) {
    if (!sel.w) {
      upsertChart('chart-risk-contrib', { type: 'bar', data: { labels: ['Nifty 50'], datasets: [{ data: [1], backgroundColor: INK.muted }] },
        options: { indexAxis: 'y', scales: { x: { max: 1, ticks: { callback: pctTick(0) } } } } });
      return;
    }
    const w = sel.w;
    const Sw = COV.map((row) => dot(row, w));
    const varP = dot(w, Sw);
    const rc = w.map((x, i) => (x * Sw[i]) / varP);
    const labels = [...KEYS.map((k) => ASSET[k].short), 'Risk-free'];
    const capital = [...w, sel.cash];
    upsertChart('chart-risk-contrib', {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Capital weight', data: capital, backgroundColor: INK.muted, borderRadius: 4, barPercentage: 0.8, categoryPercentage: 0.7 },
          { label: 'Risk contribution', data: [...rc, 0], backgroundColor: INK.primary, borderRadius: 4, barPercentage: 0.8, categoryPercentage: 0.7 },
        ],
      },
      options: {
        animation: false,
        indexAxis: 'y',
        scales: {
          x: { ticks: { callback: pctTick(0) }, grid: { color: INK.grid } },
          y: { grid: { display: false } },
        },
        plugins: { tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${fmtPct(item.parsed.x, 1)}` } } },
      },
    });
  },

  renderBacktest(sel, p) {
    const r = sel.daily;
    const dates = DATA.series.dates;
    const win = 250;
    const run = (conf) => {
      const vars = [], breaches = [];
      for (let t = win; t < r.length; t++) {
        const v = -quantile(r.slice(t - win, t), 1 - conf);
        vars.push(v);
        breaches.push(r[t] < -v);
      }
      return { vars, breaches };
    };
    const bt = run(p.conf);
    const T = bt.breaches.length;
    const x = bt.breaches.filter(Boolean).length;
    const k = kupiec(T, x, 1 - p.conf);
    const b99 = run(0.99);
    const last250 = b99.breaches.slice(-250).filter(Boolean).length;
    const zone = last250 <= 4 ? ['good', 'Green zone'] : last250 <= 9 ? ['warning', 'Yellow zone'] : ['critical', 'Red zone'];
    const icon = { good: '✓', warning: '!', critical: '✕' }[zone[0]];
    const reject = k.pValue < 0.05;
    $('risk-bt-stats').innerHTML = `
      <div class="stat-box"><div class="stat-label">Breaches at ${fmtPct(p.conf, 1)}</div><div class="stat-value">${x} / ${T}</div><div class="stat-sub">observed ${fmtPct(x / T, 2)} vs expected ${fmtPct(1 - p.conf, 2)}</div></div>
      <div class="stat-box"><div class="stat-label">Kupiec POF test</div><div class="stat-value">p = ${k.pValue.toFixed(3)}</div><div class="stat-sub">LR ${fmtNum(k.LR, 2)} · ${reject ? 'reject model at 5%' : 'cannot reject at 5%'}</div></div>
      <div class="stat-box"><div class="stat-label">Basel traffic light (99%, last 250d)</div><div style="margin-top:6px"><span class="status-chip ${zone[0]}">${icon} ${zone[1]} · ${last250} breaches</span></div></div>`;
    const tDates = dates.slice(win);
    const realized = r.slice(win);
    upsertChart('chart-risk-bt', {
      type: 'line',
      data: {
        labels: tDates,
        datasets: [
          { label: 'Daily return', data: realized, borderColor: alpha(INK.secondary, 0.55), borderWidth: 1, pointRadius: 0, order: 3 },
          { label: `−VaR ${fmtPct(p.conf, 1)}`, data: bt.vars.map((v) => -v), borderColor: INK.primary, borderWidth: 1.5, pointRadius: 0, order: 2 },
          { label: 'Breach', data: realized.map((v, i) => (bt.breaches[i] ? v : null)), showLine: false, pointRadius: 3.5, pointHoverRadius: 5,
            pointBackgroundColor: BREACH_COLOR, pointBorderColor: INK.surface, pointBorderWidth: 1, order: 1 },
        ],
      },
      options: {
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { maxTicksLimit: 8, callback(v) { return this.getLabelForValue(v).slice(0, 7); } }, grid: { display: false } },
          y: { ticks: { callback: pctTick(1) }, grid: { color: INK.grid } },
        },
        plugins: { tooltip: { callbacks: {
          title: (items) => fmtDate(items[0].label),
          label: (item) => (item.raw == null ? null : `${item.dataset.label}: ${fmtPct(item.raw, 2)}`),
        } } },
      },
    });
    $('risk-bt-legend').innerHTML = `<span><span class="line-key" style="border-color:${alpha(INK.secondary, 0.55)}"></span>Realized daily return</span>
      <span><span class="line-key" style="border-color:${INK.primary}"></span>−VaR (rolling)</span>
      <span><span class="swatch" style="background:${BREACH_COLOR};border-radius:50%"></span>Breach</span>`;
  },

  renderDrawdown(sel) {
    const dates = ['', ...DATA.series.dates];
    const ddP = drawdownSeries(wealthPath(sel.daily));
    const ddB = drawdownSeries(wealthPath(DATA.series.returns.BENCH));
    const datasets = [{ label: sel.label, data: ddP, borderColor: INK.primary, backgroundColor: alpha(INK.primary, 0.08), fill: 'origin', pointRadius: 0, borderWidth: 1.5 }];
    if (sel.w) datasets.push({ label: 'Nifty 50', data: ddB, borderColor: INK.muted, pointRadius: 0, borderWidth: 1.5 });
    upsertChart('chart-risk-dd', {
      type: 'line',
      data: { labels: dates, datasets },
      options: {
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { maxTicksLimit: 8, callback(v) { return this.getLabelForValue(v).slice(0, 7); } }, grid: { display: false } },
          y: { max: 0, ticks: { callback: pctTick(0) }, grid: { color: INK.grid } },
        },
        plugins: { tooltip: { callbacks: { title: (items) => (items[0].label ? fmtDate(items[0].label) : 'Start'), label: (item) => `${item.dataset.label}: ${fmtPct(item.raw, 1)}` } } },
      },
    });
    $('risk-dd-legend').innerHTML = `<span><span class="line-key" style="border-color:${INK.primary}"></span>${esc(sel.label)} (max ${fmtPct(Math.min(...ddP), 1)})</span>` +
      (sel.w ? `<span><span class="line-key" style="border-color:${INK.muted}"></span>Nifty 50 (max ${fmtPct(Math.min(...ddB), 1)})</span>` : '');
  },

  renderHeatmap() {
    const M = this.corrMode === 'weekly' ? DATA.estimation.corr_weekly : DATA.estimation.corr_daily;
    document.querySelectorAll('#panel-risk [data-corr]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.corr === this.corrMode)));
    const names = KEYS.map((k) => ASSET[k].short);
    $('risk-heatmap').innerHTML = `<thead><tr><th></th>${names.map((n) => `<th>${esc(n)}</th>`).join('')}</tr></thead><tbody>` +
      M.map((row, i) => `<tr><th class="row-h">${esc(names[i])}</th>${row.map((v, j) =>
        i === j ? '<td class="diag" style="background:#1f2430">1.00</td>'
          : `<td style="background:${divergingColor(v)}" title="${esc(names[i])} vs ${esc(names[j])}: ${v.toFixed(3)}">${v.toFixed(2)}</td>`).join('')}</tr>`).join('') + '</tbody>';
    const iE = KEYS.indexOf('IN_EQ'), gE = KEYS.indexOf('GL_EQ');
    $('risk-corr-note').innerHTML = `Blue = negative, gray = zero, red = positive correlation. India Eq ↔ Global Eq: <strong style="color:var(--text-primary)">${DATA.estimation.corr_daily[iE][gE].toFixed(2)} daily vs ${DATA.estimation.corr_weekly[iE][gE].toFixed(2)} weekly</strong> — ` +
      'the daily figure is depressed by non-synchronous market closes, which is why the optimizer uses weekly data.';
  },

  scenarioImpact(sel, rets, cashRet, days) {
    if (!sel.w) return null;
    let r = 0;
    KEYS.forEach((k, i) => { r += sel.w[i] * rets[k]; });
    const financing = sel.cash < 0 ? cashRet + sel.spread * days / 365 : cashRet;
    return r + sel.cash * financing;
  },

  renderStress(sel, p) {
    const scs = DATA.stress;
    const days = (sc) => (new Date(sc.end) - new Date(sc.start)) / 864e5;
    const head = `<thead><tr><th>Sleeve</th><th>Weight</th>${scs.map((s) => `<th title="${esc(s.blurb)}">${esc(s.name)}<br><span style="text-transform:none;letter-spacing:0;font-weight:400">${esc(fmtDate(s.start))} → ${esc(fmtDate(s.end))}</span></th>`).join('')}</tr></thead>`;
    const rows = KEYS.map((k, i) => `<tr><td><span class="swatch" style="background:${SERIES_COLORS[k]}"></span>${esc(ASSET[k].name)}</td>
      <td>${sel.w ? fmtPct(sel.w[i], 1) : '—'}</td>
      ${scs.map((s) => {
        const e = k === 'IN_EQ' && sel.niftyEquity ? { ret: s.benchmark.ret, source: 'actual', detail: s.benchmark.source } : s.returns[k];
        return `<td class="${e.ret < 0 ? 'neg' : 'pos'}" title="${esc(e.detail)}">${fmtSignedPct(e.ret, 1)}<span class="src ${e.source}">${e.source}</span></td>`;
      }).join('')}</tr>`).join('');
    const cashRow = `<tr><td><span class="swatch" style="background:${SERIES_COLORS.CASH}"></span>Risk-free / financing</td><td>${sel.w ? fmtPct(sel.cash, 1) : '—'}</td>
      ${scs.map((s) => `<td title="${esc(s.cash.source)}">${fmtSignedPct(s.cash.ret, 2)}<span class="src ${s.cash.source.startsWith('assumption') ? 'assumption' : 'actual'}">${s.cash.source.startsWith('assumption') ? 'assumption' : 'actual'}</span></td>`).join('')}</tr>`;
    const scenRets = (s) => Object.fromEntries(KEYS.map((k) => [k, k === 'IN_EQ' && sel.niftyEquity ? s.benchmark.ret : s.returns[k].ret]));
    const impacts = scs.map((s) => (sel.w ? this.scenarioImpact(sel, scenRets(s), s.cash.ret, days(s)) : s.benchmark.ret));
    const totRow = `<tr class="total"><td>${esc(sel.label)}</td><td>${sel.w ? fmtPct(sel.w.reduce((a, x) => a + x, 0) + sel.cash, 0) : ''}</td>
      ${impacts.map((v) => `<td class="${v < 0 ? 'neg' : 'pos'}">${fmtSignedPct(v, 1)}<br><span style="font-weight:400;color:var(--text-muted)">${fmtCompactINR(v * p.value)}</span></td>`).join('')}</tr>`;
    const benchRow = `<tr><td>Nifty 50</td><td></td>${scs.map((s) => `<td class="${s.benchmark.ret < 0 ? 'neg' : 'pos'}" title="${esc(s.benchmark.source)}">${fmtSignedPct(s.benchmark.ret, 1)}</td>`).join('')}</tr>`;
    $('risk-stress-table').innerHTML = head + '<tbody>' + rows + cashRow + '</tbody><tfoot>' + totRow + benchRow + '</tfoot>';

    upsertChart('chart-risk-stress', {
      type: 'bar',
      data: {
        labels: scs.map((s) => s.name),
        datasets: [
          { label: sel.label, data: impacts, backgroundColor: INK.primary, borderRadius: 4, barPercentage: 0.8, categoryPercentage: 0.6 },
          { label: 'Nifty 50', data: scs.map((s) => s.benchmark.ret), backgroundColor: INK.muted, borderRadius: 4, barPercentage: 0.8, categoryPercentage: 0.6 },
        ],
      },
      options: {
        animation: false,
        scales: { y: { ticks: { callback: pctTick(0) }, grid: { color: INK.grid } }, x: { grid: { display: false } } },
        plugins: { tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${fmtSignedPct(item.raw, 1)}` } } },
      },
    });
  },

  renderCustom(sel) {
    KEYS.forEach((k) => { $(`cs-${k}-val`).textContent = fmtSignedPct(this.custom[k], 0); });
    const p = this.params();
    if (!sel.w) {
      $('risk-custom-out').innerHTML = 'Select a multi-asset portfolio to apply a custom shock (Nifty 50 maps one-to-one to the India Eq shock).';
      return;
    }
    const r = this.scenarioImpact(sel, this.custom, 0, 0);
    const contrib = KEYS.map((k, i) => ({ k, c: sel.w[i] * this.custom[k] })).sort((a, b) => a.c - b.c);
    $('risk-custom-out').innerHTML = `<strong>${esc(sel.label)}: ${fmtSignedPct(r, 1)} (${fmtCompactINR(r * p.value)})</strong> on ${fmtCompactINR(p.value)}.
      Largest drag: ${esc(ASSET[contrib[0].k].name)} (${fmtSignedPct(contrib[0].c, 1)} of portfolio).
      Equivalent to ${fmtNum(Math.abs(r) / Math.max(this.varEs(sel.daily, 0.99, 1).varH, 1e-9), 1)}× the 1-day 99% historical VaR.`;
  },

  renderParity() {
    const name = Store.state.model;
    const ref = DATA.crosscheck[`${name}_orp`];
    const R = DATA.series.returns;
    const daily = Portfolio.dailyReturns(ref.weights);
    const js = riskMetrics(daily, R.RF, R.BENCH, 0.95);
    const keys = ['var_hist_1d', 'cvar_hist_1d', 'var_param_1d', 'cvar_param_1d', 'vol_ann', 'max_drawdown', 'sharpe', 'sortino', 'beta', 'jensen_alpha', 'tracking_error'];
    let worst = 0;
    const rows = keys.map((k) => {
      const d = Math.abs(js[k] - ref[k]) / Math.max(1e-6, Math.abs(ref[k]));
      worst = Math.max(worst, d);
      return `<tr><td>${k.replace(/_/g, ' ')}</td><td>${ref[k].toFixed(5)}</td><td>${js[k].toFixed(5)}</td></tr>`;
    }).join('');
    const ok = worst < 1e-3;
    $('risk-parity').innerHTML = `<div style="margin-bottom:10px"><span class="status-chip ${ok ? 'good' : 'critical'}">${ok ? '✓ Match' : '✕ Mismatch'} · max rel. Δ ${worst.toExponential(1)}</span></div>
      <div class="table-scroll"><table class="data-table"><thead><tr><th>${esc(name)} ORP metric</th><th>Python</th><th>Browser</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    this.parityWorst = worst;
  },

  render() {
    const sel = this.selected();
    const p = this.params();
    $('risk-conf-val').textContent = fmtPct(p.conf, 1);
    $('risk-h-val').textContent = p.h === 1 ? '1 day' : `${p.h} days`;
    const v = this.varEs(sel.daily, p.conf, p.h);
    this.renderStats(sel, p, v);
    this.renderHistogram(p, v);
    this.renderContrib(sel);
    this.renderBacktest(sel, p);
    this.renderDrawdown(sel);
    this.renderHeatmap();
    this.renderStress(sel, p);
    this.renderCustom(sel);
    this.renderParity();
  },
};
