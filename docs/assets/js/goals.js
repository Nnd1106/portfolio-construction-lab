/* ---------------------------------------------------------------------
 * goals.js — Module 7: goals-based planning (client-side Monte Carlo).
 * Lognormal monthly returns moment-matched to the client portfolio's
 * ex-ante μ and σ; SIP with annual step-up; probability of success,
 * fan chart, and the exact required SIP for a target confidence.
 * ------------------------------------------------------------------- */

const GOAL_PRESETS = {
  retire: { amount: 50000000, years: 25, initial: 2500000, sip: 75000, step: 0.07 },
  edu: { amount: 5000000, years: 15, initial: 500000, sip: 15000, step: 0.05 },
  home: { amount: 4000000, years: 5, initial: 1000000, sip: 40000, step: 0.05 },
};
const N_PATHS = 5000;
const FAN_COLOR = INK.primary;
const GOAL_COLOR = '#9085e9';

const Goals = {
  seed: 20260930,
  retOverride: false,
  yearsTouched: false,

  init() {
    // Slider drags fire many events; coalesce them so a re-simulation never queues up.
    const schedule = () => {
      if (this.pending) return;
      this.pending = true;
      requestAnimationFrame(() => { this.pending = false; this.render(); });
    };
    ['goal-amount', 'goal-initial', 'goal-sip'].forEach((id) => $(id).addEventListener('change', schedule));
    ['goal-infl', 'goal-step', 'goal-conf'].forEach((id) => $(id).addEventListener('input', schedule));
    $('goal-years').addEventListener('input', () => { this.yearsTouched = true; schedule(); });
    ['goal-mu', 'goal-sigma'].forEach((id) => $(id).addEventListener('input', () => { this.retOverride = true; schedule(); }));
    $('goal-real').addEventListener('change', () => this.renderFan());
    $('goal-reset-ret').addEventListener('click', () => { this.retOverride = false; this.render(); });
    $('goal-reseed').addEventListener('click', () => { this.seed = (this.seed * 1103515245 + 12345) >>> 0; this.render(); });
    $('goal-presets').addEventListener('click', (e) => {
      const b = e.target.closest('[data-preset]');
      if (!b) return;
      const p = GOAL_PRESETS[b.dataset.preset];
      $('goal-amount').value = p.amount; $('goal-years').value = p.years; $('goal-initial').value = p.initial;
      $('goal-sip').value = p.sip; $('goal-step').value = p.step;
      this.yearsTouched = true;
      document.querySelectorAll('#goal-presets .preset-btn').forEach((x) => x.classList.toggle('active', x === b));
      this.render();
    });
  },

  inputs() {
    const c = Portfolio.client();
    if (!this.retOverride) {
      $('goal-mu').value = Math.min(0.2, Math.max(0.02, c.ret));
      $('goal-sigma').value = Math.min(0.3, Math.max(0.01, c.vol));
    }
    if (!this.yearsTouched) $('goal-years').value = Profile.result().horizonYears;
    return {
      goal: Math.max(0, +$('goal-amount').value || 0),
      years: +$('goal-years').value,
      infl: +$('goal-infl').value,
      initial: Math.max(0, +$('goal-initial').value || 0),
      sip: Math.max(0, +$('goal-sip').value || 0),
      step: +$('goal-step').value,
      mu: this.retOverride ? +$('goal-mu').value : c.ret,
      sigma: this.retOverride ? +$('goal-sigma').value : c.vol,
      conf: +$('goal-conf').value,
    };
  },

  /**
   * Runs the simulation. Stores wealth at every month (Float32, paths × steps)
   * plus the linear decomposition W_T = a + SIP·b for exact SIP solving.
   */
  simulate(inp) {
    const steps = inp.years * 12;
    const s2 = Math.log(1 + (inp.sigma * inp.sigma) / ((1 + inp.mu) ** 2));
    const mLn = Math.log(1 + inp.mu) - s2 / 2;
    const mM = mLn / 12, sM = Math.sqrt(s2 / 12);
    const rng = makeRng(this.seed);
    const W = new Float32Array(N_PATHS * (steps + 1));
    const a = new Float64Array(N_PATHS), b = new Float64Array(N_PATHS);
    const kM = new Float64Array(steps);                              // step-up multiplier per month
    for (let t = 0; t < steps; t++) kM[t] = Math.pow(1 + inp.step, Math.floor(t / 12));
    let spare = null;                                                // Box-Muller yields normals in pairs
    const normal = () => {
      if (spare !== null) { const z = spare; spare = null; return z; }
      let u = 0, v = 0;
      while (u === 0) u = rng();
      v = rng();
      const r = Math.sqrt(-2 * Math.log(u)), th = 2 * Math.PI * v;
      spare = r * Math.sin(th);
      return r * Math.cos(th);
    };
    for (let i = 0; i < N_PATHS; i++) {
      let w = inp.initial, A = inp.initial, B = 0;
      W[i * (steps + 1)] = w;
      for (let t = 0; t < steps; t++) {
        const k = kM[t];
        const g = Math.exp(mM + sM * normal());
        w = (w + inp.sip * k) * g;
        A *= g;
        B = (B + k) * g;
        W[i * (steps + 1) + t + 1] = w;
      }
      a[i] = A; b[i] = B;
    }
    // cumulative contributions path
    const contrib = [inp.initial];
    for (let t = 0; t < steps; t++) contrib.push(contrib[t] + inp.sip * Math.pow(1 + inp.step, Math.floor(t / 12)));
    return { W, a, b, steps, contrib, mLn, sLn: Math.sqrt(s2) };
  },

  percentilesAt(sim, t) {
    if (this.pctCache && this.pctCache[t]) return this.pctCache[t];
    const col = new Float64Array(N_PATHS);
    for (let i = 0; i < N_PATHS; i++) col[i] = sim.W[i * (sim.steps + 1) + t];
    col.sort();
    const q = (p) => { const idx = p * (N_PATHS - 1); const lo = Math.floor(idx); return col[lo] + (col[Math.min(lo + 1, N_PATHS - 1)] - col[lo]) * (idx - lo); };
    const out = { p5: q(0.05), p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), p95: q(0.95), col };
    if (this.pctCache) this.pctCache[t] = out;
    return out;
  },

  render() {
    const inp = this.inputs();
    this.inp = inp;
    $('goal-years-val').textContent = `${inp.years} yrs`;
    $('goal-years-note').textContent = this.yearsTouched ? '' : `Defaulted from the questionnaire's horizon answer (${Profile.result().horizonYears} yrs).`;
    $('goal-infl-val').textContent = fmtPct(inp.infl, 2);
    $('goal-step-val').textContent = fmtPct(inp.step, 0);
    $('goal-mu-val').textContent = fmtPct(inp.mu, 2);
    $('goal-sigma-val').textContent = fmtPct(inp.sigma, 2);
    $('goal-conf-val').textContent = fmtPct(inp.conf, 0);
    $('goal-ret-src').textContent = this.retOverride
      ? 'Manual assumptions (overriding the client portfolio).'
      : `From the client portfolio (${DATA.models[Store.state.model].label.split(' (')[0]} model, A = ${Portfolio.client().A.toFixed(1)}).`;

    // Paths depend only on these inputs; confidence and inflation just move the goal line.
    const key = [inp.years, inp.mu, inp.sigma, inp.initial, inp.sip, inp.step, this.seed].join('|');
    if (key !== this.simKey) { this.sim = this.simulate(inp); this.simKey = key; this.pctCache = {}; }
    const sim = this.sim;
    const goalNom = inp.goal * Math.pow(1 + inp.infl, inp.years);
    const end = this.percentilesAt(sim, sim.steps);
    let hit = 0, shortSum = 0, shortN = 0;
    for (const v of end.col) {
      if (v >= goalNom) hit += 1; else { shortSum += goalNom - v; shortN += 1; }
    }
    const prob = hit / N_PATHS;
    this.prob = prob;
    const deflate = Math.pow(1 + inp.infl, inp.years);
    const totalContrib = sim.contrib[sim.steps];

    // exact required SIP at the chosen confidence
    const needed = Array.from(sim.a, (ai, i) => Math.max(0, (goalNom - ai) / sim.b[i]));
    const reqSip = quantile(needed, inp.conf);
    this.reqSip = reqSip;
    // required lump sum (no SIP change): W_T = initial·(a/initial) + SIP·b → per-path initial needed
    const growth = Array.from(sim.a, (ai) => (inp.initial > 0 ? ai / inp.initial : null));
    const reqInitial = inp.initial > 0
      ? quantile(Array.from(sim.b, (bi, i) => Math.max(0, (goalNom - inp.sip * bi) / growth[i])), inp.conf)
      : null;

    const zone = prob >= 0.8 ? ['good', '✓', 'On track'] : prob >= 0.5 ? ['warning', '!', 'At risk'] : ['critical', '✕', 'Off track'];
    $('goal-stats').innerHTML = `
      <div class="stat-box" style="border-left:3px solid ${STATUS[zone[0]]}">
        <div class="stat-label">Probability of reaching goal</div>
        <div class="stat-value" style="font-size:28px">${fmtPct(prob, 1)}</div>
        <div style="margin-top:6px"><span class="status-chip ${zone[0]}">${zone[1]} ${zone[2]}</span></div></div>
      <div class="stat-box"><div class="stat-label">Target at horizon (nominal)</div><div class="stat-value">${fmtCompactINR(goalNom)}</div>
        <div class="stat-sub">${fmtCompactINR(inp.goal)} today at ${fmtPct(inp.infl, 1)} inflation</div></div>
      <div class="stat-box"><div class="stat-label">Median outcome</div><div class="stat-value">${fmtCompactINR(end.p50)}</div>
        <div class="stat-sub">${fmtCompactINR(end.p50 / deflate)} in today's ₹</div></div>
      <div class="stat-box"><div class="stat-label">10th – 90th percentile</div><div class="stat-value" style="font-size:16px">${fmtCompactINR(end.p10)} – ${fmtCompactINR(end.p90)}</div>
        <div class="stat-sub">nominal, at year ${inp.years}</div></div>
      <div class="stat-box"><div class="stat-label">Total contributed</div><div class="stat-value">${fmtCompactINR(totalContrib)}</div>
        <div class="stat-sub">median growth ×${fmtNum(end.p50 / Math.max(totalContrib, 1), 2)} on capital</div></div>
      <div class="stat-box"><div class="stat-label">Avg. shortfall if missed</div><div class="stat-value">${shortN ? fmtCompactINR(shortSum / shortN) : '—'}</div>
        <div class="stat-sub">${shortN ? fmtPct(shortSum / shortN / goalNom, 0) + ' of target, across failing paths' : 'no failing paths'}</div></div>`;

    const conf = fmtPct(inp.conf, 0);
    $('goal-what').innerHTML = [
      `<strong>SIP for ${conf} confidence: ${fmtINR(Math.ceil(reqSip / 100) * 100)} / month</strong>
        (stepping up ${fmtPct(inp.step, 0)} a year) — ${reqSip <= inp.sip ? `your current ${fmtINR(inp.sip)} is enough` : `${fmtINR(Math.ceil((reqSip - inp.sip) / 100) * 100)} more than today's plan`}.`,
      reqInitial != null ? `Or, keeping the SIP unchanged, an initial lump sum of <strong>${fmtCompactINR(reqInitial)}</strong> reaches ${conf} confidence.` : 'Add an initial investment to see the equivalent lump-sum requirement.',
      `Only the <strong>bottom ${fmtPct(1 - inp.conf, 0)}</strong> of paths fall short at the required SIP — the plan is sized to a bad-but-plausible market, not the median one.`,
      `Simulated paths assume E[r] = ${fmtPct(inp.mu, 2)}, σ = ${fmtPct(inp.sigma, 2)} (lognormal drift ${fmtPct(sim.mLn, 2)}, σ<sub>ln</sub> ${fmtPct(sim.sLn, 2)}). A 1 pp lower return materially changes the answer — stress it with the sliders.`,
    ].map((s) => `<li>${s}</li>`).join('');

    this.renderFan();
    this.renderProb();
  },

  renderFan() {
    const sim = this.sim, inp = this.inp;
    const real = $('goal-real').checked;
    const stride = Math.max(1, Math.ceil(sim.steps / 120));
    const ts = [];
    for (let t = 0; t <= sim.steps; t += stride) ts.push(t);
    if (ts[ts.length - 1] !== sim.steps) ts.push(sim.steps);
    const def = (t) => (real ? Math.pow(1 + inp.infl, t / 12) : 1);
    const P = ts.map((t) => this.percentilesAt(sim, t));
    const lab = ts.map((t) => t / 12);
    const series = (k) => P.map((p, i) => p[k] / def(ts[i]));
    const goalPath = ts.map((t) => (real ? inp.goal : inp.goal * Math.pow(1 + inp.infl, t / 12)));
    const contrib = ts.map((t) => sim.contrib[t] / def(t));
    const pts = (arr) => arr.map((y, i) => ({ x: lab[i], y }));
    upsertChart('chart-goal-fan', {
      type: 'line',
      data: {
        datasets: [
          { label: '5th pct', data: pts(series('p5')), borderColor: 'transparent', pointRadius: 0, fill: false },
          { label: '95th pct', data: pts(series('p95')), borderColor: 'transparent', backgroundColor: alpha(FAN_COLOR, 0.09), pointRadius: 0, fill: '-1' },
          { label: '25th pct', data: pts(series('p25')), borderColor: 'transparent', pointRadius: 0, fill: false },
          { label: '75th pct', data: pts(series('p75')), borderColor: 'transparent', backgroundColor: alpha(FAN_COLOR, 0.2), pointRadius: 0, fill: '-1' },
          { label: 'Median', data: pts(series('p50')), borderColor: FAN_COLOR, pointRadius: 0 },
          { label: real ? 'Goal (today\'s ₹)' : 'Goal (inflating)', data: pts(goalPath), borderColor: GOAL_COLOR, borderDash: [6, 4], pointRadius: 0 },
          { label: 'Contributions', data: pts(contrib), borderColor: INK.muted, borderDash: [2, 3], borderWidth: 1.5, pointRadius: 0 },
        ],
      },
      options: {
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { type: 'linear', min: 0, max: inp.years, title: { display: true, text: 'Years from today' }, ticks: { stepSize: inp.years > 20 ? 5 : inp.years > 8 ? 2 : 1 }, grid: { display: false } },
          y: { min: 0, ticks: { callback: (v) => fmtCompactINR(v) }, grid: { color: INK.grid } },
        },
        plugins: { tooltip: { callbacks: {
          title: (it) => `Year ${fmtNum(it[0].parsed.x, 1)}`,
          label: (it) => `${it.dataset.label}: ${fmtCompactINR(it.parsed.y)}`,
        } } },
      },
    });
    $('goal-fan-legend').innerHTML = `<span><span class="swatch" style="background:${alpha(FAN_COLOR, 0.09)};border:1px solid ${alpha(FAN_COLOR, 0.3)}"></span>5th–95th pct</span>
      <span><span class="swatch" style="background:${alpha(FAN_COLOR, 0.25)}"></span>25th–75th pct</span>
      <span><span class="line-key" style="border-color:${FAN_COLOR}"></span>Median</span>
      <span><span class="line-key dashed" style="border-color:${GOAL_COLOR}"></span>Goal</span>
      <span><span class="line-key dashed" style="border-color:${INK.muted}"></span>Contributions</span>`;
  },

  renderProb() {
    const sim = this.sim, inp = this.inp;
    const years = [], probs = [];
    for (let y = 1; y <= inp.years; y++) {
      const t = y * 12;
      const g = inp.goal * Math.pow(1 + inp.infl, y);
      let hit = 0;
      for (let i = 0; i < N_PATHS; i++) if (sim.W[i * (sim.steps + 1) + t] >= g) hit += 1;
      years.push(y); probs.push(hit / N_PATHS);
    }
    upsertChart('chart-goal-prob', {
      type: 'bar',
      data: { labels: years.map((y) => `Y${y}`), datasets: [{ label: 'P(success)', data: probs, backgroundColor: probs.map((p, i) => (i === probs.length - 1 ? INK.primary : alpha(INK.secondary, 0.55))), borderRadius: 3 }] },
      options: {
        animation: false,
        scales: { y: { min: 0, max: 1, ticks: { callback: pctTick(0) }, grid: { color: INK.grid } }, x: { grid: { display: false }, ticks: { maxTicksLimit: 12 } } },
        plugins: { tooltip: { callbacks: { label: (it) => `P(success): ${fmtPct(it.raw, 1)}` } } },
      },
    });
  },
};
