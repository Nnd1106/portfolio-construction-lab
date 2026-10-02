/* ---------------------------------------------------------------------
 * main.js — app wiring: tabs, KPI strip, footer data notes, and the
 * render loop. Modules re-render on state change; hidden tabs are marked
 * dirty and rendered when next opened.
 * ------------------------------------------------------------------- */

(function () {
  'use strict';

  if (!window.PCL_DATA) {
    document.querySelector('main').innerHTML =
      '<p class="section-intro" style="padding:24px">Data file failed to load (docs/data/portfolio-data.js).</p>';
    return;
  }

  applyChartDefaults();
  Store.load();

  const MODULES = {
    profile: typeof Profile !== 'undefined' ? Profile : null,
    market: typeof Market !== 'undefined' ? Market : null,
    allocation: typeof Allocation !== 'undefined' ? Allocation : null,
    risk: typeof Risk !== 'undefined' ? Risk : null,
    performance: typeof Performance !== 'undefined' ? Performance : null,
    rebalance: typeof Rebalance !== 'undefined' ? Rebalance : null,
    goals: typeof Goals !== 'undefined' ? Goals : null,
  };

  let activeTab = 'profile';
  const dirty = new Set(Object.keys(MODULES));

  function renderModule(name) {
    const mod = MODULES[name];
    if (mod && mod.render) mod.render();
    dirty.delete(name);
  }

  /* ---------------- Tabs ---------------- */
  const tabButtons = document.querySelectorAll('.tab-btn');

  function activateTab(name, focus) {
    activeTab = name;
    tabButtons.forEach((btn) => {
      const on = btn.dataset.tab === name;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
      if (on && focus) btn.focus();
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      const on = p.id === 'panel-' + name;
      p.classList.toggle('active', on);
      p.hidden = !on;
    });
    if (dirty.has(name)) renderModule(name);
    try { history.replaceState(null, '', '#' + name); } catch (e) { /* file:// */ }
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const list = [...tabButtons];
      const i = list.indexOf(btn) + (e.key === 'ArrowRight' ? 1 : -1);
      activateTab(list[(i + list.length) % list.length].dataset.tab, true);
    });
  });

  /* ---------------- "Next step" buttons walk a client through the tabs in order ---------------- */
  const order = [...tabButtons];
  order.forEach((btn, i) => {
    const panel = $('panel-' + btn.dataset.tab);
    const next = order[i + 1];
    const prev = order[i - 1];
    if (!panel || (!next && !prev)) return;
    const nav = document.createElement('div');
    nav.className = 'step-nav';
    nav.innerHTML = (prev ? `<button type="button" class="btn" data-goto="${prev.dataset.tab}">← ${esc(prev.textContent)}</button>` : '<span></span>') +
      (next ? `<button type="button" class="btn primary" data-goto="${next.dataset.tab}">Next: ${esc(next.textContent)} →</button>` : '');
    panel.appendChild(nav);
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-goto]');
    if (!b) return;
    activateTab(b.dataset.goto);
    document.querySelector('.tab-nav').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  /* ---------------- Clock ---------------- */
  function tickClock() {
    $('clock').textContent = new Date().toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' }) + ' IST';
  }
  tickClock();
  setInterval(tickClock, 1000);

  /* ---------------- KPI strip ---------------- */
  function renderKpis() {
    const res = Profile.result();
    const c = Portfolio.client();
    const override = Store.state.aOverride != null;
    $('kpi-profile').textContent = override ? 'Manual A' : res.label;
    $('kpi-profile-sub').textContent = Profile.isSample() ? 'sample client' : 'questionnaire';
    $('kpi-A').textContent = c.A.toFixed(1);
    $('kpi-A-sub').textContent = override ? 'manual override' : 'from questionnaire';
    $('kpi-y').textContent = fmtPct(c.y, 0);
    $('kpi-y-sub').textContent = c.regime === 'lend' ? `${fmtPct(c.cash, 0)} risk-free`
      : c.regime === 'frontier' ? 'up the frontier' : `${fmtPct(-c.cash, 0)} borrowed`;
    $('kpi-ret').textContent = fmtPct(c.ret, 1);
    $('kpi-vol').textContent = fmtPct(c.vol, 1);
    $('kpi-sharpe').textContent = fmtNum(c.sharpe, 2);
    $('kpi-rf').textContent = 'rf ' + fmtPct(RF, 2);
    const daily = Portfolio.clientDaily();
    $('kpi-var').textContent = fmtPct(-quantile(daily, 0.05), 2);
  }

  /* ---------------- Footer data-quality line ---------------- */
  function renderFooter() {
    const dq = DATA.data_quality;
    const subs = Object.entries(dq.sleeves).filter(([, v]) => v.fallback_used).map(([k, v]) => `${k}→${v.ticker}`);
    const fixes = Object.entries(dq.sleeves).filter(([, v]) => v.dropped.length).map(([k, v]) => `${ASSET[k].short} (${v.dropped.length})`);
    if (dq.benchmark.dropped.length) fixes.push(`Nifty 50 (${dq.benchmark.dropped.length})`);
    $('as-of').textContent = fmtDate(DATA.meta.as_of);
    $('footer-dq').innerHTML = `<span class="dq">${esc(fmtDate(dq.window.start))} → ${esc(fmtDate(dq.window.end))} ·
      ${dq.window.sessions} NSE sessions (${dq.window.years} yrs) · ${DATA.estimation.weeks} weekly obs ·
      tickers: ${DATA.assets.map((a) => esc(a.ticker === 'BASKET' ? '12-stock basket' : a.ticker)).join(', ')},
      benchmark ${esc(DATA.benchmark.ticker)}, FX ${esc(dq.fx.ticker)}, rf ${esc(DATA.risk_free.ticker)} ·
      ${subs.length ? 'fallback tickers: ' + esc(subs.join(', ')) : 'no fallback tickers needed'} ·
      bad ticks removed: ${fixes.length ? esc(fixes.join(', ')) : 'none'} ·
      pipeline run ${esc(DATA.meta.generated_utc.replace('T', ' ').replace('Z', ' UTC'))}</span>`;
  }

  /* ---------------- Render loop ---------------- */
  Store.subscribe(() => {
    Object.keys(MODULES).forEach((k) => dirty.add(k));
    renderKpis();
    renderModule(activeTab);
  });

  Object.values(MODULES).forEach((m) => m && m.init && m.init());
  if (typeof Proposal !== 'undefined') Proposal.init();
  if (typeof Explain !== 'undefined') Explain.init();
  renderFooter();
  renderKpis();
  const fromHash = (location.hash || '').slice(1);
  activateTab(MODULES.hasOwnProperty(fromHash) ? fromHash : 'profile');

  // ?report=explain | proposal opens a report directly (shareable link, print automation)
  const report = new URLSearchParams(location.search).get('report');
  if (report === 'explain' && typeof Explain !== 'undefined') Explain.open();
  if (report === 'proposal' && typeof Proposal !== 'undefined') Proposal.open();
})();
