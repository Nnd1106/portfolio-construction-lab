/* ---------------------------------------------------------------------
 * allocation.js — Module 3: strategic asset allocation engine.
 * Plots the pipeline's precomputed efficient frontiers, the MVP, the ORP,
 * the Capital Allocation Line, the client's indifference curve and their
 * optimal complete portfolio.
 * ------------------------------------------------------------------- */

const CAL_COLOR = '#9085e9';          // categorical slot 7 (violet) — not used by any sleeve
const FRONTIER_COLOR = INK.secondary;

/** Draws short direct labels next to points flagged with `labelText`. */
const pointLabelPlugin = {
  id: 'pointLabels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    ctx.save();
    ctx.font = '600 10px -apple-system, "Segoe UI", system-ui, sans-serif';
    chart.data.datasets.forEach((ds, di) => {
      if (!ds.labelText) return;
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) return;
      meta.data.forEach((el, i) => {
        const text = Array.isArray(ds.labelText) ? ds.labelText[i] : ds.labelText;
        if (!text) return;
        const off = ds.labelOffset || [8, -8];
        ctx.fillStyle = INK.primary;
        ctx.textAlign = off[0] < 0 ? 'right' : 'left';
        ctx.fillText(text, el.x + off[0], el.y + off[1]);
      });
    });
    ctx.restore();
  },
};

/** Vertical guide lines on a linear x-axis (used on the transition map). */
const vLinePlugin = {
  id: 'vLines',
  afterDatasetsDraw(chart, args, opts) {
    if (!opts || !opts.lines) return;
    const { ctx, chartArea, scales } = chart;
    ctx.save();
    opts.lines.forEach((l) => {
      const x = scales.x.getPixelForValue(l.x);
      if (x < chartArea.left || x > chartArea.right) return;
      ctx.strokeStyle = l.color;
      ctx.setLineDash(l.dash || []);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = INK.primary;
      ctx.font = '600 10px -apple-system, "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(l.label, x + 4, chartArea.top + 10 + (l.row || 0) * 12);
    });
    ctx.restore();
  },
};

const Allocation = {
  init() {
    document.querySelectorAll('#panel-allocation [data-model]').forEach((b) =>
      b.addEventListener('click', () => Store.set({ model: b.dataset.model })));
    $('alloc-A').addEventListener('input', (e) => Store.set({ aOverride: +e.target.value }));
    $('alloc-borrow').addEventListener('change', (e) => Store.set({ borrowing: e.target.checked }));
    $('alloc-spread').addEventListener('input', (e) => Store.set({ borrowSpread: +e.target.value }));
    $('alloc-compare').addEventListener('change', () => this.render());
    $('panel-allocation').addEventListener('click', (e) => {
      if (e.target.id === 'alloc-use-q') Store.set({ aOverride: null });
    });
  },

  weightsTooltip(w) {
    return KEYS.map((k, i) => `  ${ASSET[k].short}: ${fmtPct(w[i], 1)}`);
  },

  renderControls(c) {
    const st = Store.state;
    document.querySelectorAll('#panel-allocation [data-model]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.model === st.model)));
    $('alloc-model-note').textContent = DATA.models[st.model].label;
    $('alloc-A').value = c.A;
    $('alloc-A-val').textContent = c.A.toFixed(1);
    $('alloc-A-src').innerHTML = st.aOverride != null
      ? `Manual override (questionnaire gives A = ${Profile.result().A.toFixed(1)}). <button type="button" class="btn" id="alloc-use-q">Use questionnaire A</button>`
      : `From the Client Profile questionnaire (${esc(Profile.result().label)}). Drag to override.`;
    $('alloc-borrow').checked = st.borrowing;
    $('alloc-spread').value = st.borrowSpread;
    $('alloc-spread').disabled = !st.borrowing;
    $('alloc-spread-wrap').style.opacity = st.borrowing ? 1 : 0.45;
    $('alloc-spread-val').textContent = fmtPct(st.borrowSpread, 2) + ` → rB ${fmtPct(RF + st.borrowSpread, 2)}`;
  },

  renderStats(m, c) {
    const calSlope = (m.orp.ret - RF) / m.orp.vol;
    const regimeText = c.regime === 'lend'
      ? `y* = ${fmtNum(c.yStar, 2)} → ${fmtPct(c.y, 0)} ORP + ${fmtPct(c.cash, 0)} risk-free`
      : c.regime === 'frontier'
        ? `y* = ${fmtNum(c.yStar, 2)} > 1, no leverage → frontier point beyond ORP`
        : `${fmtPct(c.y, 0)} exposure, ${fmtPct(-c.cash, 0)} borrowed at ${fmtPct(c.financeRate, 2)}`;
    const box = (cls, label, value, sub) => `<div class="stat-box" style="border-left:3px solid ${cls}">
      <div class="stat-label">${label}</div><div class="stat-value" style="font-size:16px">${value}</div><div class="stat-sub">${sub}</div></div>`;
    $('alloc-stats').innerHTML = [
      box(INK.secondary, 'Minimum Variance Portfolio', `${fmtPct(m.mvp.ret, 1)} · σ ${fmtPct(m.mvp.vol, 1)}`, `Sharpe ${fmtNum((m.mvp.ret - RF) / m.mvp.vol, 2)}`),
      box(CAL_COLOR, 'Optimal Risky Portfolio', `${fmtPct(m.orp.ret, 1)} · σ ${fmtPct(m.orp.vol, 1)}`, `Sharpe ${fmtNum(m.orp.sharpe, 3)} = CAL slope`),
      box(INK.primary, 'Client Complete Portfolio', `${fmtPct(c.ret, 1)} · σ ${fmtPct(c.vol, 1)}`, regimeText),
      box(INK.muted, 'Certainty Equivalent', fmtPct(c.certaintyEquivalent, 2), `U = E[r] − ½·${c.A.toFixed(1)}·σ² vs rf ${fmtPct(RF, 2)}`),
    ].join('');
    this._calSlope = calSlope;
  },

  renderFrontier(m, c) {
    const st = Store.state;
    const other = DATA.models[st.model === 'policy' ? 'textbook' : 'policy'];
    const showCompare = $('alloc-compare').checked;
    const maxVol = Math.max(...DATA.assets.map((a) => a.vol)) * 1.12;
    const toPts = (arr) => arr.map((p) => ({ x: p.vol, y: p.ret, w: p.w }));

    // CAL through the ORP: solid (feasible) up to the ORP, dashed beyond unless borrowing at rf
    const calY = (s) => RF + this._calSlope * s;
    const calFeasible = [{ x: 0, y: RF }, { x: m.orp.vol, y: calY(m.orp.vol) }];
    const calBeyond = [{ x: m.orp.vol, y: calY(m.orp.vol) }, { x: maxVol, y: calY(maxVol) }];

    // Indifference curve through the client: E = U + ½Aσ²
    const indiff = [];
    for (let i = 0; i <= 60; i++) {
      const s = (maxVol * i) / 60;
      indiff.push({ x: s, y: c.utility + 0.5 * c.A * s * s });
    }

    const datasets = [];
    if (showCompare) {
      datasets.push({ label: other.label, data: toPts(other.frontier), showLine: true, borderColor: alpha(INK.muted, 0.7), borderDash: [3, 4], borderWidth: 1.5, pointRadius: 0, pointHitRadius: 4, kind: 'frontier' });
    }
    datasets.push(
      { label: 'Efficient frontier', data: toPts(m.frontier), showLine: true, borderColor: FRONTIER_COLOR, pointRadius: 0, pointHitRadius: 6, kind: 'frontier' },
      { label: 'Inefficient branch', data: toPts(m.lower), showLine: true, borderColor: alpha(FRONTIER_COLOR, 0.45), borderDash: [5, 4], pointRadius: 0, pointHitRadius: 4, kind: 'frontier' },
      { label: 'CAL', data: calFeasible, showLine: true, borderColor: CAL_COLOR, pointRadius: 0, pointHitRadius: 0, kind: 'line' },
      { label: 'CAL beyond ORP (requires borrowing at rf)', data: calBeyond, showLine: true, borderColor: alpha(CAL_COLOR, 0.55), borderDash: [6, 5], pointRadius: 0, pointHitRadius: 0, kind: 'line' },
    );
    if (st.borrowing && c.tangentB) {
      const rB = RF + st.borrowSpread;
      const t = c.tangentB;
      const slope = (t.ret - rB) / t.vol;
      datasets.push({ label: 'Borrowing line from rB', data: [{ x: t.vol, y: t.ret }, { x: Math.min(maxVol, t.vol * st.maxLeverage), y: rB + slope * Math.min(maxVol, t.vol * st.maxLeverage) }], showLine: true, borderColor: CAL_COLOR, borderWidth: 2, pointRadius: 0, pointHitRadius: 0, kind: 'line' });
    }
    datasets.push(
      { label: 'Indifference curve', data: indiff, showLine: true, borderColor: alpha(INK.primary, 0.35), borderDash: [2, 4], borderWidth: 1.5, pointRadius: 0, pointHitRadius: 0, kind: 'line' },
      ...DATA.assets.map((a, i) => ({
        label: a.name, data: [{ x: a.vol, y: m.mu[i] }], backgroundColor: SERIES_COLORS[a.key], borderColor: INK.surface, borderWidth: 2,
        pointRadius: 6, pointHoverRadius: 8, labelText: a.short, labelOffset: a.key === 'IN_DEBT' ? [8, 14] : [8, -8], kind: 'asset',
      })),
      { label: 'Risk-free', data: [{ x: 0, y: RF }], backgroundColor: SERIES_COLORS.CASH, borderColor: INK.surface, borderWidth: 2, pointRadius: 6, labelText: 'rf', labelOffset: [8, 12], kind: 'asset' },
      { label: 'MVP', data: [{ x: m.mvp.vol, y: m.mvp.ret, w: m.mvp.w }], backgroundColor: INK.secondary, borderColor: INK.surface, borderWidth: 2, pointStyle: 'triangle', pointRadius: 8, labelText: 'MVP', labelOffset: [-10, -8], kind: 'port' },
      { label: 'ORP', data: [{ x: m.orp.vol, y: m.orp.ret, w: m.orp.w }], backgroundColor: CAL_COLOR, borderColor: INK.surface, borderWidth: 2, pointStyle: 'rectRot', pointRadius: 8, labelText: 'ORP', labelOffset: [-10, -10], kind: 'port' },
      { label: 'Client', data: [{ x: c.vol, y: c.ret, w: c.w, cash: c.cash }], backgroundColor: INK.primary, borderColor: INK.surface, borderWidth: 2, pointStyle: 'star', pointRadius: 11, pointHoverRadius: 13, labelText: 'Client', labelOffset: [10, 14], kind: 'port' },
    );

    const allY = [...m.frontier, ...m.lower].map((p) => p.ret).concat(m.mu, [RF, c.ret]);
    upsertChart('chart-frontier', {
      type: 'scatter',
      data: { datasets },
      options: {
        animation: false,
        interaction: { mode: 'nearest', intersect: false, axis: 'xy' },
        scales: {
          x: { type: 'linear', min: 0, max: maxVol, title: { display: true, text: 'Volatility σ (annual)' }, ticks: { callback: pctTick(0) }, grid: { color: INK.grid } },
          y: { min: Math.max(0, Math.min(...allY) - 0.02), max: Math.max(...allY) + 0.02, title: { display: true, text: 'Expected return (annual)' }, ticks: { callback: pctTick(0) }, grid: { color: INK.grid } },
        },
        plugins: {
          tooltip: {
            filter: (item) => item.dataset.kind !== 'line',
            callbacks: {
              title: (items) => items[0].dataset.label,
              label: (item) => {
                const p = item.raw;
                const lines = [`E[r] ${fmtPct(p.y, 2)} · σ ${fmtPct(p.x, 2)} · Sharpe ${fmtNum((p.y - RF) / Math.max(p.x, 1e-9), 2)}`];
                if (p.w) lines.push(...this.weightsTooltip(p.w));
                if (p.cash != null && Math.abs(p.cash) > 1e-6) lines.push(`  Risk-free: ${fmtPct(p.cash, 1)}`);
                return lines;
              },
            },
          },
        },
      },
      plugins: [pointLabelPlugin],
    });

    const key = (color, label, dashed) => `<span><span class="line-key${dashed ? ' dashed' : ''}" style="border-color:${color}"></span>${label}</span>`;
    const dot = (color, label, shape) => `<span><span class="swatch" style="background:${color};${shape === 'diamond' ? 'transform:rotate(45deg) scale(.8)' : shape === 'tri' ? 'clip-path:polygon(50% 0,100% 100%,0 100%)' : shape === 'star' ? 'clip-path:polygon(50% 0,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)' : 'border-radius:50%'}"></span>${label}</span>`;
    $('alloc-legend').innerHTML = [
      key(FRONTIER_COLOR, 'Efficient frontier'),
      key(alpha(FRONTIER_COLOR, 0.45), 'Inefficient branch', true),
      showCompare ? key(INK.muted, `${st.model === 'policy' ? 'Textbook' : 'Policy'} frontier`, true) : '',
      key(CAL_COLOR, 'Capital Allocation Line'),
      key(alpha(INK.primary, 0.5), 'Client indifference curve', true),
      dot(INK.secondary, 'MVP', 'tri'), dot(CAL_COLOR, 'ORP', 'diamond'), dot(INK.primary, 'Client', 'star'),
      ...DATA.assets.map((a) => dot(SERIES_COLORS[a.key], a.short)),
    ].join('');
  },

  renderWeights(m, c) {
    const bm = DATA.policy_benchmark;
    const rows = [...KEYS, 'CASH'].map((k, i) => {
      const nm = k === 'CASH' ? 'Risk-free' : ASSET[k].name;
      const g = (arr) => (k === 'CASH' ? 0 : arr[i]);
      return `<tr><td><span class="swatch" style="background:${SERIES_COLORS[k]}"></span>${esc(nm)}</td>
        <td>${fmtPct(g(m.mvp.w), 1)}</td><td>${fmtPct(g(m.orp.w), 1)}</td>
        <td style="color:var(--text-primary)">${fmtPct(k === 'CASH' ? c.cash : c.w[i], 1)}</td>
        <td>${fmtPct(bm[k] || 0, 1)}</td></tr>`;
    }).join('');
    const tot = (w, cash) => fmtPct(w.reduce((a, x) => a + x, 0) + cash, 1);
    $('alloc-weights').innerHTML = `<thead><tr><th>Sleeve</th><th>MVP</th><th>ORP</th><th>Client</th><th>Policy bmk</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr class="total"><td>Total</td><td>${tot(m.mvp.w, 0)}</td><td>${tot(m.orp.w, 0)}</td><td>${tot(c.w, c.cash)}</td><td>${fmtPct(Object.values(bm).reduce((a, x) => a + x, 0), 1)}</td></tr></tfoot>`;
  },

  renderTransitionMap(m, c) {
    const pts = m.frontier;
    const datasets = KEYS.map((k, i) => ({
      label: ASSET[k].short,
      data: pts.map((p) => ({ x: p.vol, y: p.w[i] })),
      backgroundColor: alpha(SERIES_COLORS[k], 0.85),
      borderColor: INK.surface,
      borderWidth: 1,
      fill: i === 0 ? 'origin' : '-1',
      pointRadius: 0,
      pointHitRadius: 6,
    }));
    const lines = [{ x: m.orp.vol, color: CAL_COLOR, label: 'ORP', dash: [4, 3] }];
    if (c.regime !== 'lend') lines.push({ x: c.risky.vol, color: INK.primary, label: 'Client', row: 1 });
    upsertChart('chart-tmap', {
      type: 'line',
      data: { datasets },
      options: {
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { type: 'linear', min: pts[0].vol, max: pts[pts.length - 1].vol, ticks: { callback: pctTick(0) }, title: { display: true, text: 'Frontier volatility σ' }, grid: { color: INK.grid } },
          y: { stacked: true, min: 0, max: 1, ticks: { callback: pctTick(0) }, grid: { color: INK.grid } },
        },
        plugins: {
          vLines: { lines },
          tooltip: {
            callbacks: {
              title: (items) => `σ ${fmtPct(items[0].parsed.x, 1)}`,
              label: (item) => `${item.dataset.label}: ${fmtPct(item.parsed.y, 1)}`,
            },
          },
        },
      },
      plugins: [vLinePlugin],
    });
    $('alloc-tmap-legend').innerHTML = KEYS.map((k) => `<span><span class="swatch" style="background:${SERIES_COLORS[k]}"></span>${esc(ASSET[k].short)}</span>`).join('');
  },

  renderInputs(m) {
    const pm = DATA.models.policy;
    $('alloc-inputs').innerHTML = `<thead><tr><th>Sleeve</th><th>Ticker</th><th>Sample μ</th><th>Bayes-Stein μ</th><th>σ (weekly ×√52)</th><th>CAGR</th><th>Max DD</th><th>Policy range</th></tr></thead>
      <tbody>${DATA.assets.map((a, i) => `<tr>
        <td><span class="swatch" style="background:${SERIES_COLORS[a.key]}"></span>${esc(a.name)}</td>
        <td style="color:var(--text-muted)">${esc(a.ticker === 'BASKET' ? '12-stock basket' : a.ticker)}${a.ccy === 'USD' ? ' ×USDINR' : ''}</td>
        <td>${fmtPct(a.mu_raw, 1)}</td><td>${fmtPct(a.mu_bs, 1)}</td><td>${fmtPct(a.vol, 1)}</td>
        <td>${fmtPct(a.cagr, 1)}</td><td class="neg">${fmtPct(a.max_drawdown, 1)}</td>
        <td>${fmtPct(pm.bounds[i][0], 0)}–${fmtPct(pm.bounds[i][1], 0)}</td></tr>`).join('')}</tbody>`;
    const bs = DATA.estimation.bayes_stein;
    const capped = KEYS.filter((k, i) => m.orp.w[i] >= m.bounds[i][1] - 1e-4).map((k) => ASSET[k].short);
    const floored = KEYS.filter((k, i) => m.bounds[i][0] > 0 && m.orp.w[i] <= m.bounds[i][0] + 1e-4).map((k) => ASSET[k].short);
    $('alloc-bs-note').innerHTML = `<strong>Shrinkage intensity φ = ${fmtNum(bs.phi, 3)}</strong> toward the minimum-variance mean of
      ${fmtPct(bs.mu0_annual, 1)} — with ${DATA.estimation.weeks} weekly observations the sample means are noisy, so roughly
      ${fmtPct(bs.phi, 0)} of each mean's deviation from the common anchor is discarded.
      ${capped.length ? `In the active model the ORP is <strong>pinned at its upper bound in ${esc(capped.join(', '))}</strong>` : 'No ORP weight is at its upper bound'}${floored.length ? ` and at its floor in ${esc(floored.join(', '))}` : ''} —
      a reminder that the optimizer leans hard on whichever sleeves had the best recent risk-adjusted history.`;
  },

  render() {
    const m = Portfolio.model();
    const c = Portfolio.client();
    this.renderControls(c);
    this.renderStats(m, c);
    this.renderFrontier(m, c);
    this.renderWeights(m, c);
    this.renderTransitionMap(m, c);
    this.renderInputs(m);
  },
};
