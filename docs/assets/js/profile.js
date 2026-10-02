/* ---------------------------------------------------------------------
 * profile.js — Module 1: client risk profiling.
 *
 * Eight onboarding questions split across the two dimensions an IPS
 * separates: WILLINGNESS (attitude) and CAPACITY (financial ability) to
 * bear risk. As in CFA-style IPS practice, when the two disagree the lower
 * one governs. The combined score s ∈ [0, 1] maps to the coefficient of
 * risk aversion A used in U = E[r] − ½·A·σ²:
 *
 *     A(s) = A_MAX · (A_MIN / A_MAX)^s     (log-linear, A_MAX = 12, A_MIN = 1.5)
 *
 * Log-linear because y* ∝ 1/A: equal steps in score then give roughly
 * proportional steps in risky exposure rather than bunching at one end.
 * ------------------------------------------------------------------- */

const QUESTIONS = [
  {
    id: 'drawdown', dim: 'W',
    text: 'Your portfolio falls 20% in a single month during a market sell-off. What do you do?',
    options: ['Sell everything to stop further losses', 'Sell part of it and move to safer assets', 'Hold and wait for recovery', 'Invest more while prices are low'],
  },
  {
    id: 'objective', dim: 'W',
    text: 'Which best describes your primary investment objective?',
    options: ['Preserve capital — avoid losses', 'Regular income with modest growth', 'Balanced long-term growth', 'Maximum long-term growth'],
  },
  {
    id: 'tradeoff', dim: 'W',
    text: 'Which hypothetical portfolio would you choose (best year / worst year)?',
    options: ['+6% / +2%', '+12% / −5%', '+20% / −15%', '+32% / −28%'],
  },
  {
    id: 'experience', dim: 'W',
    text: 'What is your experience with market-linked investments?',
    options: ['None — FDs and savings only', 'Mutual funds / SIPs', 'Direct equities', 'Equities plus derivatives or active trading'],
  },
  {
    id: 'horizon', dim: 'C',
    text: 'When will you need to withdraw most of this money?',
    options: ['Within 3 years', '3–5 years', '5–10 years', 'More than 10 years'],
    horizonYears: [2, 4, 8, 15],
  },
  {
    id: 'income', dim: 'C',
    text: 'How stable is your income?',
    options: ['Irregular, or no earned income', 'Somewhat variable (business / commission)', 'Stable salaried income', 'Very stable, with multiple income sources'],
  },
  {
    id: 'emergency', dim: 'C',
    text: 'How many months of expenses do you hold in an emergency fund outside this portfolio?',
    options: ['None', 'Less than 3 months', '3–6 months', 'More than 6 months'],
  },
  {
    id: 'concentration', dim: 'C',
    text: 'What share of your total net worth does this portfolio represent?',
    options: ['More than 75%', '50–75%', '25–50%', 'Less than 25%'],
  },
];

// A typical mid-career salaried investor, used until the visitor answers.
const SAMPLE_ANSWERS = [2, 2, 1, 1, 2, 2, 2, 1];

const A_MAX = 12;
const A_MIN = 1.5;

const PROFILE_BANDS = [
  { max: 0.2, label: 'Conservative' },
  { max: 0.4, label: 'Moderately Conservative' },
  { max: 0.6, label: 'Balanced' },
  { max: 0.8, label: 'Growth' },
  { max: 1.01, label: 'Aggressive' },
];

const Profile = {
  answers() {
    const a = Store.state.answers;
    return Array.isArray(a) && a.length === QUESTIONS.length ? a : SAMPLE_ANSWERS;
  },

  isSample() {
    const a = Store.state.answers;
    return !(Array.isArray(a) && a.length === QUESTIONS.length);
  },

  result() {
    const ans = this.answers();
    let w = 0, wn = 0, c = 0, cn = 0;
    QUESTIONS.forEach((q, i) => {
      if (q.dim === 'W') { w += ans[i]; wn += 3; } else { c += ans[i]; cn += 3; }
    });
    const willingness = w / wn;
    const capacity = c / cn;
    const score = Math.min(willingness, capacity);
    const A = Math.round(A_MAX * Math.pow(A_MIN / A_MAX, score) * 10) / 10;
    const band = PROFILE_BANDS.find((b) => score < b.max);
    const horizonQ = QUESTIONS.findIndex((q) => q.id === 'horizon');
    return {
      willingness, capacity, score, A, label: band.label,
      governs: capacity < willingness ? 'capacity' : willingness < capacity ? 'willingness' : 'both',
      horizonYears: QUESTIONS[horizonQ].horizonYears[ans[horizonQ]],
      answers: ans,
    };
  },

  /** Rule-based suitability notes — every statement derives from the answers or the computed portfolio. */
  notes(res, client) {
    const n = [];
    const a = res.answers;
    const idx = (id) => QUESTIONS.findIndex((q) => q.id === id);
    const gap = Math.abs(res.willingness - res.capacity);
    if (res.governs === 'capacity') {
      n.push(`<strong>Capacity governs.</strong> Attitude scores ${fmtPct(res.willingness, 0)} but financial capacity only ${fmtPct(res.capacity, 0)} — the recommendation is sized to what the client can afford to lose, not what they are comfortable with.`);
    } else if (res.governs === 'willingness') {
      n.push(`<strong>Willingness governs.</strong> The client could afford more risk (capacity ${fmtPct(res.capacity, 0)}) than they are comfortable with (${fmtPct(res.willingness, 0)}). An adviser may educate, but should not push the client beyond their stated tolerance.`);
    } else {
      n.push('<strong>Willingness and capacity agree</strong> — no conflict to resolve.');
    }
    if (gap >= 0.34) n.push(`<strong>Large gap (${fmtPct(gap, 0)}) between the two dimensions</strong> — worth a follow-up conversation before implementing.`);
    if (a[idx('horizon')] === 0) n.push('<strong>Short horizon (&lt; 3 years).</strong> Liquidity needs dominate; a volatile allocation risks forced selling in a drawdown.');
    if (a[idx('emergency')] === 0) n.push('<strong>No emergency fund.</strong> Standard practice is to build 6 months of expenses in liquid instruments before investing for growth.');
    if (a[idx('concentration')] === 0) n.push('<strong>Portfolio is most of net worth.</strong> Losses here are hard to absorb elsewhere, which lowers capacity.');
    if (client.regime === 'lend') {
      n.push(`Optimal complete portfolio holds <strong>${fmtPct(client.y, 0)} in the risky portfolio</strong> and ${fmtPct(client.cash, 0)} in the risk-free asset (liquid fund).`);
    } else if (client.regime === 'frontier') {
      n.push(`Unconstrained y* = ${fmtNum(client.yStar, 2)} would require borrowing. With no leverage the client stays <strong>fully invested and moves up the efficient frontier</strong> past the ORP to a higher-return mix.`);
    } else {
      n.push(`Client borrows at rf + spread: <strong>${fmtPct(client.y, 0)} risky exposure</strong>, financed by ${fmtPct(-client.cash, 0)} borrowing.`);
    }
    return n;
  },

  renderQuestions() {
    const ans = this.answers();
    $('q-list').innerHTML = QUESTIONS.map((q, i) => `
      <div class="q-block" role="radiogroup" aria-labelledby="q-${q.id}">
        <div class="q-head" id="q-${q.id}">
          <span class="q-num">${String(i + 1).padStart(2, '0')}</span>
          <span>${esc(q.text)}</span>
          <span class="q-dim" title="${q.dim === 'W' ? 'Willingness (attitude to risk)' : 'Capacity (financial ability to bear risk)'}">${q.dim === 'W' ? 'Willingness' : 'Capacity'}</span>
        </div>
        <div class="q-options">
          ${q.options.map((o, j) => `<button type="button" class="q-opt" role="radio" aria-checked="${ans[i] === j}" data-q="${i}" data-o="${j}">${esc(o)}</button>`).join('')}
        </div>
      </div>`).join('');
  },

  render() {
    const res = this.result();
    const client = Portfolio.client();
    const usingOverride = Store.state.aOverride != null;

    $('profile-sample-note').hidden = !this.isSample();
    $('profile-label').textContent = res.label;
    $('profile-A').textContent = res.A.toFixed(1);
    $('profile-score').textContent = fmtPct(res.score, 0);
    $('profile-A-use').innerHTML = usingOverride
      ? `Manual override active on the Allocation tab: <strong>A = ${Store.state.aOverride.toFixed(1)}</strong>. <button type="button" class="btn" id="profile-clear-override">Use questionnaire A</button>`
      : 'This A feeds the Allocation engine and every downstream module.';
    const clr = $('profile-clear-override');
    if (clr) clr.addEventListener('click', () => Store.set({ aOverride: null }));

    const setBar = (id, v, gov) => {
      $(id + '-val').textContent = fmtPct(v, 0);
      const f = $(id + '-fill');
      f.style.width = (v * 100).toFixed(1) + '%';
      f.classList.toggle('governing', gov);
    };
    setBar('bar-will', res.willingness, res.governs !== 'capacity');
    setBar('bar-cap', res.capacity, res.governs !== 'willingness');

    $('profile-notes').innerHTML = this.notes(res, client).map((s) => `<li>${s}</li>`).join('');

    // Allocation bar (100% horizontal) + table
    const wm = Portfolio.weightMap(client);
    const items = [...KEYS, 'CASH'].map((k) => ({ k, name: k === 'CASH' ? 'Risk-free (liquid fund)' : ASSET[k].name, w: wm[k] }));
    const positive = items.filter((it) => it.w > 0.0005);
    const tot = positive.reduce((s, it) => s + it.w, 0);
    $('profile-alloc-bar').innerHTML = positive.map((it) =>
      `<div title="${esc(it.name)}: ${fmtPct(it.w, 1)}" style="width:${(it.w / tot * 100).toFixed(2)}%;background:${SERIES_COLORS[it.k]}"></div>`).join('');
    $('profile-alloc-table').innerHTML = `
      <thead><tr><th>Sleeve</th><th>Weight</th><th>Vehicle</th></tr></thead>
      <tbody>${items.map((it) => `<tr>
        <td><span class="swatch" style="background:${SERIES_COLORS[it.k]}"></span>${esc(it.name)}</td>
        <td>${fmtPct(it.w, 1)}</td>
        <td style="color:var(--text-muted)">${it.k === 'CASH' ? esc(DATA.risk_free.source) : esc(ASSET[it.k].vehicle)}</td></tr>`).join('')}
      </tbody>
      <tfoot><tr class="total"><td>Expected return / volatility</td><td>${fmtPct(client.ret, 1)}</td><td>σ ${fmtPct(client.vol, 1)} · ex-ante Sharpe ${fmtNum(client.sharpe, 2)}</td></tr></tfoot>`;
  },

  init() {
    this.renderQuestions();
    $('q-list').addEventListener('click', (e) => {
      const btn = e.target.closest('.q-opt');
      if (!btn) return;
      const ans = this.answers().slice();
      ans[+btn.dataset.q] = +btn.dataset.o;
      Store.set({ answers: ans });
      this.renderQuestions();
    });
    $('profile-reset').addEventListener('click', () => {
      Store.set({ answers: null, aOverride: null });
      this.renderQuestions();
    });
  },
};
