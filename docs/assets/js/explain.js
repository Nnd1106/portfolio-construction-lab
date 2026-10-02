/* ---------------------------------------------------------------------
 * explain.js — "Explain My Portfolio": a plain-language report for a
 * client with no finance background.
 *
 * Same mechanism as the Client Proposal (full-page overlay + the
 * browser's Print / Save as PDF), same live client state. The two images
 * (allocation donut, goal fan chart) are rendered by Chart.js from the
 * live data onto off-screen canvases in a light print palette and
 * embedded as PNGs, so they print crisply on white paper instead of
 * relying on the dark-theme canvases printing well.
 * ------------------------------------------------------------------- */

// Validated light-mode categorical slots 1–5 (dataviz validator, white surface).
// Three sit below 3:1 contrast, so every colour is paired with a labelled table.
const LIGHT_SERIES = { IN_EQ: '#2a78d6', IN_GOLD: '#eb6834', IN_DEBT: '#1baf7a', GL_EQ: '#eda100', GL_BOND: '#e87ba4', CASH: '#8a8f98' };
const PAPER = { ink: '#111827', ink2: '#4b5563', ink3: '#6b7280', rule: '#e5e7eb', accent: '#2a78d6' };

const PLAIN = {
  IN_EQ: {
    name: 'Indian company shares',
    what: (stocks) => `Shares of 12 of India's largest, most established companies — ${stocks} — split equally and spread across nine different industries.`,
    why: 'This is the main engine for long-term growth. Owning a small piece of large Indian businesses lets your money grow as the economy does.',
  },
  IN_GOLD: {
    name: 'Gold',
    what: () => 'Nippon India ETF Gold BeES — a fund traded on the stock exchange that simply holds physical gold on your behalf (no lockers, no making charges).',
    why: 'The traditional Indian safety net. Gold has often held its value or risen when share markets fall, and when the rupee weakens.',
  },
  IN_DEBT: {
    name: 'Indian bonds',
    what: () => 'Bharat Bond ETF April 2030 — a fund that lends money to large government-owned companies with the highest (AAA) credit rating, and is repaid in April 2030.',
    why: 'Stability. Bonds are loans that pay steady interest, so this part moves far less than shares and cushions the bumpy parts.',
  },
  GL_EQ: {
    name: 'Shares of companies worldwide',
    what: () => 'iShares MSCI World ETF — one fund holding well over a thousand large companies across more than 20 developed countries.',
    why: 'Not keeping all your eggs in one country\'s basket. It also earns in US dollars, which helps when the rupee loses value.',
  },
  GL_BOND: {
    name: 'Bonds from around the world',
    what: () => 'Vanguard Total International Bond ETF — thousands of government and company loans from outside the US, with currency swings smoothed out against the dollar.',
    why: 'A calm, globally spread holding that tends to behave differently from Indian markets.',
  },
  CASH: {
    name: 'Safe cash fund',
    what: () => 'Nippon India Liquid Fund — a very low-risk fund that earns roughly what the government pays on short-term borrowing.',
    why: 'Money set aside that barely moves, so the overall ups and downs stay within what you said you can handle.',
  },
};

const Explain = {
  amountTouched: false,

  init() {
    $('open-explain').addEventListener('click', () => this.open());
    $('explain-close').addEventListener('click', () => this.close());
    $('explain-print').addEventListener('click', () => window.print());
    $('explain-amount').addEventListener('change', () => { this.amountTouched = true; this.build(); });
    $('explain-name').addEventListener('change', () => this.build());
    $('explain').addEventListener('click', (e) => { if (e.target.id === 'explain') this.close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('explain').hidden) this.close(); });
  },

  open() {
    this.lastFocus = document.activeElement;
    $('proposal').hidden = true;
    $('explain').hidden = false;
    document.body.classList.add('proposal-open');
    this.build();
    $('explain-close').focus();
  },

  close() {
    $('explain').hidden = true;
    document.body.classList.remove('proposal-open');
    if (this.lastFocus) this.lastFocus.focus();
  },

  /* ---------------- off-screen Chart.js → PNG ---------------- */
  renderPng(width, height, config) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    config.options = Object.assign({ responsive: false, animation: false, devicePixelRatio: 2 }, config.options);
    const chart = new Chart(canvas, config);
    const png = chart.toBase64Image('image/png', 1);
    chart.destroy();
    return png;
  },

  donutPng(wm, amt) {
    const keys = [...KEYS, 'CASH'].filter((k) => wm[k] > 0.0005);
    const centre = {
      id: 'centre',
      afterDraw(chart) {
        const { ctx, chartArea: a } = chart;
        const x = (a.left + a.right) / 2, y = (a.top + a.bottom) / 2;
        ctx.save();
        ctx.textAlign = 'center';
        ctx.fillStyle = PAPER.ink3;
        ctx.font = '600 15px -apple-system, "Segoe UI", system-ui, sans-serif';
        ctx.fillText('YOUR MONEY', x, y - 14);
        ctx.fillStyle = PAPER.ink;
        ctx.font = '700 30px -apple-system, "Segoe UI", system-ui, sans-serif';
        ctx.fillText(fmtCompactINR(amt), x, y + 22);
        ctx.restore();
      },
    };
    return this.renderPng(440, 440, {
      type: 'doughnut',
      data: {
        labels: keys.map((k) => PLAIN[k].name),
        datasets: [{ data: keys.map((k) => wm[k]), backgroundColor: keys.map((k) => LIGHT_SERIES[k]), borderColor: '#ffffff', borderWidth: 3 }],
      },
      options: { cutout: '62%', plugins: { legend: { display: false }, tooltip: { enabled: false } }, layout: { padding: 6 } },
      plugins: [centre],
    });
  },

  fanPng(sim, inp) {
    const stride = Math.max(1, Math.ceil(sim.steps / 96));
    const ts = [];
    for (let t = 0; t <= sim.steps; t += stride) ts.push(t);
    if (ts[ts.length - 1] !== sim.steps) ts.push(sim.steps);
    const real = (t) => Math.pow(1 + inp.infl, t / 12);
    const P = ts.map((t) => Goals.percentilesAt(sim, t));
    const pts = (k) => P.map((p, i) => ({ x: ts[i] / 12, y: p[k] / real(ts[i]) }));
    const tick = { color: PAPER.ink2, font: { size: 15 } };
    return this.renderPng(1100, 520, {
      type: 'line',
      data: {
        datasets: [
          { data: pts('p5'), borderColor: 'transparent', pointRadius: 0, fill: false },
          { data: pts('p95'), borderColor: 'transparent', backgroundColor: 'rgba(42,120,214,0.14)', pointRadius: 0, fill: '-1' },
          { data: pts('p25'), borderColor: 'transparent', pointRadius: 0, fill: false },
          { data: pts('p75'), borderColor: 'transparent', backgroundColor: 'rgba(42,120,214,0.30)', pointRadius: 0, fill: '-1' },
          { data: pts('p50'), borderColor: '#1c5cab', borderWidth: 3.5, pointRadius: 0 },
          { data: ts.map((t) => ({ x: t / 12, y: inp.goal })), borderColor: PAPER.ink, borderDash: [10, 7], borderWidth: 2.5, pointRadius: 0 },
        ],
      },
      options: {
        layout: { padding: { right: 14, top: 8 } },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { type: 'linear', min: 0, max: inp.years, ticks: { ...tick, stepSize: inp.years > 20 ? 5 : inp.years > 8 ? 2 : 1, callback: (v) => `Year ${v}` }, grid: { display: false }, border: { color: PAPER.rule } },
          y: { min: 0, ticks: { ...tick, callback: (v) => fmtCompactINR(v) }, grid: { color: PAPER.rule }, border: { display: false } },
        },
      },
    });
  },

  /* ---------------- analytics translated into plain numbers ---------------- */
  backtest(c) {
    const R = DATA.series.returns;
    const dates = DATA.series.dates;
    const spreadD = c.cash < 0 && c.regime === 'borrow' ? Store.state.borrowSpread / TRADING_DAYS : 0;
    const port = monthlyRebalancedReturns(dates, [...c.w, c.cash], (t) => [...KEYS.map((k) => R[k][t]), R.RF[t] + spreadD]);
    const pm = riskMetrics(port, R.RF, R.BENCH);
    const nm = riskMetrics(R.BENCH, R.RF, R.BENCH);
    const wP = wealthPath(port, 1), wN = wealthPath(R.BENCH, 1);
    // deepest fall with its dates
    let peak = 1, peakI = 0, worst = 0, wPeak = 0, wTrough = 0;
    wP.forEach((v, i) => {
      if (v > peak) { peak = v; peakI = i; }
      if (v / peak - 1 < worst) { worst = v / peak - 1; wPeak = peakI; wTrough = i; }
    });
    const d = (i) => (i === 0 ? dates[0] : dates[i - 1]);
    return { pm, nm, endP: wP[wP.length - 1], endN: wN[wN.length - 1], dd: { depth: worst, from: d(wPeak), to: d(wTrough) } };
  },

  monthlyRisk(daily) {
    const mo = monthlyReturns(DATA.series.dates, { r: daily });
    const r = mo.returns.r;
    let wi = 0;
    r.forEach((x, i) => { if (x < r[wi]) wi = i; });
    return { bad1in20: -quantile(r, 0.05), worst: r[wi], worstMonth: mo.months[wi], n: r.length };
  },

  rebalanceStory(c, amt) {
    const saved = Rebalance.bandType;
    Rebalance.bandType = 'abs';
    const p = { band: 0.05, check: 'daily', cal: 'quarterly', cost: 0.0015, value: amt };
    const target = [...c.w, c.cash];
    const bh = Rebalance.simulate('bh', target, p);
    const band = Rebalance.simulate('band', target, p);
    Rebalance.bandType = saved;
    const drift = KEYS.map((k, i) => ({ k, from: target[i], to: bh.endWeights[i] })).sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))[0];
    return { bh, band, drift, years: DATA.series.dates.length / TRADING_DAYS };
  },

  /* ---------------- the document ---------------- */
  build() {
    if (!this.amountTouched) $('explain-amount').value = Math.max(100000, +$('goal-initial').value || 1500000);
    const amt = Math.max(0, +$('explain-amount').value || 0);
    const name = ($('explain-name').value || '').trim() || 'Sample Client';
    const res = Profile.result();
    const c = Portfolio.client();
    const wm = Portfolio.weightMap(c);
    const daily = Portfolio.clientDaily();
    const mk = DATA.market;
    const stockNames = mk ? mk.instruments.filter((i) => i.role === 'stock').map((i) => i.name) : [];
    const stockList = stockNames.length ? `${stockNames.slice(0, -1).join(', ')} and ${stockNames[stockNames.length - 1]}` : 'twelve large Indian companies';
    const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    // lakh / crore in words; smaller amounts in full rupees (rounded to ₹100)
    const startLabel = fmtDate(DATA.series.dates[0]);
    const startMonth = new Date(DATA.series.dates[0] + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const endMonth = new Date(DATA.meta.as_of + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    let secNo = 0;
    const num = () => ++secNo;
    const L = (v) => (Math.abs(v) < 1e5 ? fmtINR(Math.round(v / 100) * 100) : fmtCompactINR(v).replace(' L', ' lakh').replace(' Cr', ' crore'));
    const pct = (v, d = 0) => fmtPct(Math.abs(v), d);

    // ---- Goal simulation (same engine and inputs as the Goals tab)
    let goal = null;
    try { Goals.render(); goal = { prob: Goals.prob, inp: Goals.inp, req: Goals.reqSip, sim: Goals.sim }; } catch (e) { goal = null; }

    const mr = this.monthlyRisk(daily);
    const bt = this.backtest(c);
    const rb = this.rebalanceStory(c, amt);
    const sel = { w: c.w, cash: c.cash, spread: c.regime === 'borrow' ? Store.state.borrowSpread : 0 };
    const stress = DATA.stress.map((s) => {
      const days = (new Date(s.end) - new Date(s.start)) / 864e5;
      const r = Risk.scenarioImpact(sel, Object.fromEntries(KEYS.map((k) => [k, s.returns[k].ret])), s.cash.ret, days);
      return { ...s, r, proxy: Object.values(s.returns).some((x) => x.source !== 'actual') };
    });

    // ---- 1. cover sentence
    const label = Store.state.aOverride != null ? 'Custom' : res.label;
    const aim = {
      Conservative: 'put protecting your money first, while still growing faster than a bank deposit',
      'Moderately Conservative': 'protect what you can\'t afford to lose, while still growing steadily',
      Balanced: 'balance growth with protecting what you can\'t afford to lose',
      Growth: 'aim for strong long-term growth, while still cushioning the bumps along the way',
      Aggressive: 'aim for the highest long-term growth you said you are comfortable with',
      Custom: 'match the level of risk you agreed with your adviser',
    }[label];
    const held = [...KEYS, 'CASH'].filter((k) => wm[k] > 0.0005);
    const summary = `Your ${L(amt)} has been split across ${held.length === 6 ? 'six' : held.length === 5 ? 'five' : held.length} types of investments — Indian company shares, gold, Indian bonds, and shares and bonds from around the world${wm.CASH > 0.0005 ? ', plus a safe cash fund' : ''} — chosen to ${aim}, based on your own answers about risk.`;

    // ---- 2. who this plan is for
    const governs = res.governs === 'capacity'
      ? `Your answers about your finances came out more careful than your answers about your feelings — so the plan follows your finances. In plain terms: you could probably stomach more ups and downs than your current situation can comfortably absorb.`
      : res.governs === 'willingness'
        ? `Your finances could handle a bit more risk than you said you'd be comfortable with — so the plan follows your comfort level. A plan you'd abandon in a bad year is worse than a slightly calmer plan you stick with.`
        : 'Both kinds of answers pointed the same way, so there was nothing to reconcile.';
    const position = c.regime === 'lend'
      ? `To keep the ups and downs within your comfort zone, ${pct(c.cash)} of your money (${L(c.cash * amt)}) sits in a <b>safe cash fund</b> (a fund that earns roughly what the government pays on short-term borrowing and barely moves). The rest is invested in the mix described next.`
      : c.regime === 'frontier'
        ? 'Your answers mean all of your money can be invested — none of it needs to sit in cash. We never borrow money to invest more on your behalf.'
        : `Based on your settings the plan uses some borrowed money (${pct(-c.cash)}) to invest more. This raises both potential gains and potential losses.`;

    // ---- 3. allocation rows
    const rows = held.map((k) => `
      <tr>
        <td class="ex-sw"><span style="background:${LIGHT_SERIES[k]}"></span></td>
        <td><b>${esc(PLAIN[k].name)}</b><div class="ex-what">${esc(PLAIN[k].what(stockList))}</div><div class="ex-why">Why: ${esc(PLAIN[k].why)}</div></td>
        <td class="ex-num"><b>${L(wm[k] * amt)}</b><div class="ex-what">${fmtPct(wm[k], 0)}</div></td>
      </tr>`).join('');
    const capped = KEYS.filter((k, i) => c.w[i] >= 0.495 * Math.max(c.y, 1e-9)).map((k) => PLAIN[k].name.toLowerCase());

    // ---- 4. what could go wrong
    const stressRows = stress.map((s, idx) => {
      const lossP = s.r * amt, lossN = s.benchmark.ret * amt;
      const maxAbs = Math.max(Math.abs(s.r), Math.abs(s.benchmark.ret), 0.01);
      const bar = (v, cls) => `<div class="ex-bar ${cls}"><span style="width:${(Math.abs(v) / maxAbs * 100).toFixed(1)}%"></span><em>${v < 0 ? '−' : '+'}${L(Math.abs(v) * amt)}</em></div>`;
      const when = `${new Date(s.start).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })} – ${new Date(s.end).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`;
      const story = s.id === 'covid2020' ? 'Markets fell sharply in five weeks as the pandemic began.'
        : s.id === 'gfc2008' ? 'The worst global crisis in decades, after a major US bank collapsed.'
          : 'Interest rates rose quickly worldwide; shares and bonds fell together.';
      // the lead-in sentence travels with the first crisis so it can never be orphaned at a page end
      const lead = idx === 0 ? '<p class="ex-lead">We also replayed three real market crashes on your exact mix, for your actual amount:</p>' : '';
      return `${lead ? '<div class="ex-keep">' + lead : ''}<div class="ex-crisis">
        <div class="ex-crisis-head"><b>${esc(s.name)}</b> <span>${esc(when)}</span></div>
        <p>${esc(story)} Your mix would have ${lossP < 0 ? 'lost' : 'gained'} about <b>${L(Math.abs(lossP))}</b> (${pct(s.r)}); putting the same money only in the Nifty 50 (India's 50 biggest companies) would have ${lossN < 0 ? 'lost' : 'gained'} about <b>${L(Math.abs(lossN))}</b>.${s.proxy ? ' <i>Some of today\'s funds didn\'t exist yet, so the closest equivalents were used.</i>' : ''}</p>
        <div class="ex-bars"><label>Your plan</label>${bar(s.r, 'you')}<label>Nifty 50 only</label>${bar(s.benchmark.ret, 'nifty')}</div>
      </div>${lead ? '</div>' : ''}`;
    }).join('');

    // ---- 5. history
    const pm = bt.pm, nm = bt.nm;
    const fasterGrowth = pm.cagr > nm.cagr;
    const smoother = pm.vol_ann < nm.vol_ann;
    const betterPerBump = pm.sharpe > nm.sharpe;
    const start10 = 1000000;
    const histLine = fasterGrowth && smoother
      ? `It grew faster than simply holding the Nifty 50 <b>and</b> it was a smoother ride — its ups and downs were about ${pct(1 - pm.vol_ann / nm.vol_ann)} smaller.`
      : fasterGrowth
        ? 'It grew faster than simply holding the Nifty 50, though with a similar or bumpier ride.'
        : smoother
          ? 'It grew a little more slowly than the Nifty 50, but with noticeably smaller ups and downs — which is exactly the trade-off a careful plan makes.'
          : 'Over this particular period it did not beat simply holding the Nifty 50.';
    const perBump = betterPerBump
      ? `For the amount of ups and downs it went through, it delivered more growth than the Nifty 50 did — which is the real test of a well-built mix.`
      : 'For the amount of ups and downs it went through, it delivered less growth than the Nifty 50 over this period.';

    // ---- 6. rebalancing
    const dr = rb.drift;
    const nReb = rb.band.events.length;
    const every = nReb ? Math.round((rb.years * 12) / nReb) : null;
    const rbDiff = rb.band.cagr - rb.bh.cagr;

    // ---- 7. goal
    // sections 1-5 are numbered inline; the goal (if present) is 6 and the closing notes follow
    const goalNo = 6;
    const lastNo = goal ? 7 : 6;
    let goalHtml = '';
    if (goal) {
      const g = goal.inp;
      const end = Goals.percentilesAt(goal.sim, goal.sim.steps);
      const defl = Math.pow(1 + g.infl, g.years);
      const n100 = Math.round(goal.prob * 100);
      const fan = this.fanPng(goal.sim, g);
      const futureGoal = g.goal * defl;
      const verdict = n100 >= 80 ? 'That is a comfortable margin.' : n100 >= 50 ? 'That is more likely than not, but with less margin than we would like.' : 'That means the plan, as it stands, will probably fall short.';
      const fix = n100 >= 80 ? ''
        : `<p>To reach the goal in about 80 of 100 futures, you could raise the monthly amount to about <b>${fmtINR(Math.ceil(Goals.reqSipFor(0.8) / 100) * 100)}</b> (still increasing ${fmtPct(g.step, 0)} a year), invest for longer, or start with a larger lump sum. Small changes early make a big difference later.</p>`;
      goalHtml = `
      <section class="ex-sec">
        <h3><span>${goalNo}</span>Will this reach your goal?</h3>
        <p>You told us you'd like to have <b>${L(g.goal)}</b> in today's money in <b>${g.years} years</b>. Prices rise over time (we assumed ${fmtPct(g.infl, 0)} a year), so that's about ${L(futureGoal)} in future rupees. You're starting with ${L(g.initial)} and adding ${fmtINR(g.sip)} a month, increasing it by ${fmtPct(g.step, 0)} each year.</p>
        <div class="ex-callout big"><b>Out of 100 possible futures</b> we simulated, based on how this mix of investments has historically behaved, the plan reached your goal in ${n100 < 1 ? '<b>none</b> of them' : n100 >= 100 ? '<b>virtually all</b> of them' : `about <b>${n100}</b> of them`}. ${verdict}</div>
        <figure class="ex-fig"><img src="${fan}" alt="Range of simulated outcomes for your plan over ${g.years} years compared with your goal" />
          <figcaption>The shaded band is the full range of realistic outcomes — from a rough patch (bottom edge) to a strong run (top edge); the darker middle is where half of all futures landed. The solid line is the typical outcome; the dashed line is your goal. All amounts are in today's money.</figcaption></figure>
        <p>In a typical future you would have about <b>${L(end.p50 / defl)}</b> in today's money. After a rough decade (1 future in 10) it would be closer to ${L(end.p10 / defl)}; after a strong run (1 in 10) around ${L(end.p90 / defl)}.</p>
        ${fix}
      </section>`;
    }

    const donut = this.donutPng(wm, amt);

    $('explain-body').innerHTML = `
      <section class="ex-cover">
        <div class="ex-kicker">Your portfolio, explained</div>
        <h2>What we did with your money — and why</h2>
        <div class="ex-for">Prepared for <b>${esc(name)}</b>${name === 'Sample Client' ? ' (sample)' : ''} · ${esc(today)}</div>
        <p class="ex-summary">${summary}</p>
        <div class="ex-glance">
          <div><span>Amount invested</span><b>${L(amt)}</b></div>
          <div><span>Typical yearly growth</span><b>about ${fmtPct(c.ret, 0)}</b><em>on average, not every year</em></div>
          <div><span>A bad month (1 in 20)</span><b>−${L(mr.bad1in20 * amt)}</b><em>or worse</em></div>
          ${goal ? `<div><span>Reaching your goal</span><b>${Math.round(goal.prob * 100) < 1 ? 'fewer than 1 in 100' : Math.round(goal.prob * 100) >= 100 ? 'virtually all 100' : `about ${Math.round(goal.prob * 100)} in 100`}</b><em>simulated futures</em></div>` : ''}
        </div>
        <p class="ex-howto">This report avoids jargon. Where a technical word can't be avoided, it is explained in brackets the first time it appears. Figures use real market prices up to ${esc(fmtDate(DATA.meta.as_of))}.</p>
      </section>

      <section class="ex-sec">
        <h3><span>${num()}</span>Who this plan is for</h3>
        <p>You are what we'd call a <b>${esc(label.toLowerCase())} investor</b>. We worked that out from two different kinds of questions:</p>
        <ul class="ex-list">
          <li><b>How much could you lose without panicking?</b> — questions about how you feel when investments fall. Your answers scored ${pct(res.willingness)} on our scale.</li>
          <li><b>How much could you lose without it hurting your life?</b> — questions about your income, your savings cushion and when you'll need the money. Your answers scored ${pct(res.capacity)}.</li>
        </ul>
        <p>These are different questions: someone can be calm about market swings but still need the money soon, or have plenty of savings but lose sleep over every dip. <b>When the two disagree, the more careful answer always wins</b> — because a plan you can't afford, or can't stick with in a bad year, isn't a good plan however good it looks on paper. ${governs}</p>
        <p>${position}</p>
        <p class="ex-small">For the technically curious: this corresponds to a risk-aversion score of ${c.A.toFixed(1)} on a scale of roughly 1.5 (adventurous) to 12 (very careful).</p>
      </section>

      <section class="ex-sec">
        <h3><span>${num()}</span>Where your money is going</h3>
        <div class="ex-alloc">
          <figure class="ex-donut"><img src="${donut}" alt="How your money is split between the investment types" /></figure>
          <table class="ex-table"><tbody>${rows}</tbody></table>
        </div>
        ${capped.length ? `<p class="ex-small">Why is ${esc(capped.join(' and '))} so large? Over the years we studied it was one of the best performers for the amount of ups and downs it had. We cap any single type at half of the invested money, so no one investment can take over the plan.</p>` : ''}
      </section>

      <section class="ex-sec">
        <h3><span>${num()}</span>What could go wrong — and what we've already planned for</h3>
        <p>All investments go up and down. Here is an honest picture of the bumps, so nothing comes as a surprise.</p>
        <div class="ex-callout"><b>In about 1 month out of every 20</b>, a portfolio like yours has fallen by ${pct(mr.bad1in20, 1)} or more — on your ${L(amt)}, that's roughly <b>${L(mr.bad1in20 * amt)}</b>. The single worst month in our records (${esc(new Date(mr.worstMonth + '-01').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }))}) was a fall of ${pct(mr.worst, 1)}, about ${L(Math.abs(mr.worst) * amt)}.</div>
        ${stressRows}
        <p>Markets have historically recovered from each of these crashes, although recoveries took months to years. The point of your mix is that the falls are smaller than in an all-shares portfolio — which makes it much easier not to sell at the worst possible moment, the most common way investors lose money.</p>
      </section>

      <section class="ex-sec">
        <h3><span>${num()}</span>How this approach has done in the past</h3>
        <p>If ${L(start10)} had been invested in this mix on ${esc(startLabel)}, it would have grown to about <b>${L(start10 * bt.endP)}</b> by ${esc(fmtDate(DATA.meta.as_of))}. The same ${L(start10)} in the Nifty 50 alone would have become about <b>${L(start10 * bt.endN)}</b>.</p>
        <p>${histLine} ${perBump} Its deepest fall along the way was ${pct(bt.dd.depth)} (between ${esc(fmtDate(bt.dd.from))} and ${esc(fmtDate(bt.dd.to))}), compared with ${pct(nm.max_drawdown)} for the Nifty 50.</p>
        <p class="ex-note"><b>Please read this with care:</b> the mix was designed using this same period's data, so it naturally looks good in hindsight. Treat this as evidence the approach is sensible, not as a forecast — future results will almost certainly be less impressive than this.</p>
      </section>

      <section class="ex-sec ex-whole">
        <h3><span>${num()}</span>Keeping it on track</h3>
        <p>Think of your portfolio like a recipe. Over time some ingredients "grow" faster than others, and the dish slowly turns into something you didn't order. If we had set up your mix in ${esc(startMonth)} and never touched it, <b>${esc(PLAIN[dr.k].name.toLowerCase())}</b> would have drifted from ${fmtPct(dr.from, 0)} to ${fmtPct(dr.to, 0)} of your money — quietly changing how risky the plan is.</p>
        <p>So we periodically re-measure the ingredients — rebalancing (selling a little of whatever has grown too large and topping up what has fallen behind). Our rule: whenever any part drifts more than 5 percentage points from its target, we bring everything back in line. Over the period we studied that would have happened ${nReb} time${nReb === 1 ? '' : 's'}${every ? `, roughly once every ${every} months` : ''}, and it ${rbDiff >= 0 ? `added about ${fmtPct(rbDiff, 1)} a year compared with doing nothing` : `cost about ${fmtPct(-rbDiff, 1)} a year compared with doing nothing`}, while keeping the ride closer to what you signed up for. It also builds in a healthy habit: it trims what has become expensive and adds to what has become cheap.</p>
      </section>

      ${goalHtml}

      <section class="ex-sec ex-final">
        <h3><span>${lastNo}</span>Important things to know</h3>
        <ul class="ex-list">
          <li><b>The past is a guide, not a promise.</b> Everything here is based on how markets behaved from ${esc(startMonth)} to ${esc(endMonth)}. The future will be different, and returns are never guaranteed.</li>
          <li><b>This is not official investment advice.</b> It comes from an independent educational project and is meant to explain an approach — talk to a registered adviser before acting on it.</li>
          <li><b>Taxes and some fees aren't included.</b> Capital-gains tax and advisory fees would reduce the numbers shown; the funds' own running costs are already reflected in their prices.</li>
          <li><b>Some money is in other currencies.</b> The worldwide investments are held in US dollars, so changes in the rupee's value move their worth up or down.</li>
          <li><b>The Indian bond fund ends in April 2030.</b> Before then the money will need to move into a similar fund.</li>
          <li><b>Prices are updated weekly.</b> This report uses closing prices up to ${esc(fmtDate(DATA.meta.as_of))}.</li>
        </ul>
      </section>`;
  },
};
