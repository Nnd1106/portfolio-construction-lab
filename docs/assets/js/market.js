/* ---------------------------------------------------------------------
 * market.js — Module 2: market data & transparency.
 * Shows every real instrument behind the platform: data freshness, the
 * asset-universe cards, relative performance, the 12-stock basket (table,
 * drill-down chart, correlation matrix, sectors), rolling cross-asset
 * correlations, macro & rates, and CSV downloads of the underlying data.
 * Everything here is read straight from the pipeline's snapshot.
 * ------------------------------------------------------------------- */

const PAIR_COLORS = ['#9085e9', '#e66767', '#008300', INK.secondary];   // categorical slots 7, 8, 6 + neutral
const POS_COLOR = '#3987e5', NEG_COLOR = '#e66767';                   // diverging poles for gains / losses
const UNIVERSE_ORDER = ['IN_EQ', 'IN_GOLD', 'IN_DEBT', 'GL_EQ', 'GL_BOND', 'BENCH', 'FX', 'RF'];
const ROLE_LABEL = { sleeve: 'Sleeve', benchmark: 'Benchmark', fx: 'Currency', rf: 'Risk-free', index: 'Index', stock: 'Stock' };
const RANGES = [['1M', 30], ['3M', 91], ['6M', 182], ['YTD', 'ytd'], ['1Y', 365], ['3Y', 1096], ['All', null]];

const Market = {
  range: '1Y',
  shown: new Set([...KEYS, 'BENCH']),
  sort: { key: 'weight', dir: -1 },
  drill: null,
  drillRange: '1Y',

  get M() { return DATA.market; },

  inst(key) { return this.M.instruments.find((i) => i.key === key); },

  stocks() { return this.M.instruments.filter((i) => i.role === 'stock'); },

  /** Price level series aligned to the market-close calendar. */
  level(key) {
    const c = this.M.closes;
    if (c.series[key]) return { dates: c.dates, values: c.series[key] };
    // the basket index (and any sleeve) can be rebuilt from the model's daily returns
    const r = DATA.series.returns[key];
    return { dates: [c.dates[0], ...DATA.series.dates], values: wealthPath(r, 1) };
  },

  /* ---------------- formatting helpers ---------------- */
  price(i, v = i.last) {
    if (v == null) return '—';
    if (i.key === 'IN_EQ') return v.toFixed(2);
    if (i.key === 'FX') return '₹' + v.toFixed(2);
    const sym = i.ccy === 'USD' ? '$' : '₹';
    return sym + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },
  pctCell(v, d = 1) {
    if (v == null || !Number.isFinite(v)) return '<td>—</td>';
    return `<td class="${v < 0 ? 'neg' : v > 0 ? 'pos' : ''}">${fmtSignedPct(v, d)}</td>`;
  },
  chg(v, label) {
    if (v == null) return '';
    const up = v >= 0;
    return `<span class="chg ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${fmtPct(Math.abs(v), 2)} <span>${label}</span></span>`;
  },
  mcap(v) {
    if (v == null) return '—';
    return v >= 1e12 ? `₹${(v / 1e12).toFixed(2)} L Cr` : `₹${Math.round(v / 1e7).toLocaleString('en-IN')} Cr`;
  },
  usdBig(v) {
    if (v == null) return '—';
    return v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${(v / 1e6).toFixed(0)}M`;
  },
  short(t) { return t.replace('.NS', ''); },

  /** Inline SVG sparkline of the last ~year of a level series. */
  sparkline(key, color) {
    const { values } = this.level(key);
    const v = values.slice(-252).filter((x) => x != null);
    if (v.length < 2) return '';
    const w = 260, h = 46, lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
    const pts = v.map((x, i) => `${(i / (v.length - 1) * w).toFixed(1)},${(h - 3 - (x - lo) / span * (h - 6)).toFixed(1)}`);
    const area = `0,${h} ${pts.join(' ')} ${w},${h}`;
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <polygon points="${area}" fill="${alpha(color, 0.12)}"/>
      <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
  },

  rangeBar(i) {
    const pos = Math.max(0, Math.min(1, (i.last - i.lo52) / Math.max(i.hi52 - i.lo52, 1e-12)));
    return `<div class="range52" title="52-week range">
      <span>${this.price(i, i.lo52)}</span>
      <div class="range52-track"><div class="range52-mark" style="left:${(pos * 100).toFixed(1)}%"></div></div>
      <span>${this.price(i, i.hi52)}</span></div>`;
  },

  /* ---------------- init ---------------- */
  init() {
    if (!this.M) return;
    $('mkt-range').innerHTML = RANGES.map(([k]) => `<button type="button" data-r="${k}">${k}</button>`).join('');
    $('mkt-range').addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (b) { this.range = b.dataset.r; this.renderRel(); }
    });
    const chipKeys = [...KEYS, 'BENCH', 'RF'];
    $('mkt-series').innerHTML = chipKeys.map((k) => {
      const nm = k === 'BENCH' ? 'Nifty 50' : k === 'RF' ? 'Risk-free' : ASSET[k].short;
      const col = k === 'BENCH' ? INK.secondary : SERIES_COLORS[k === 'RF' ? 'CASH' : k];
      return `<button type="button" class="chip" data-k="${k}" style="--c:${col}"><span class="dot"></span>${esc(nm)}</button>`;
    }).join('');
    $('mkt-series').addEventListener('click', (e) => {
      const b = e.target.closest('[data-k]');
      if (!b) return;
      const k = b.dataset.k;
      if (this.shown.has(k)) { if (this.shown.size > 1) this.shown.delete(k); } else this.shown.add(k);
      this.renderRel();
    });
    $('mkt-drill-range').innerHTML = ['3M', '1Y', '3Y', 'All'].map((k) => `<button type="button" data-r="${k}">${k}</button>`).join('');
    $('mkt-drill-range').addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (b) { this.drillRange = b.dataset.r; this.renderDrill(); }
    });
    $('mkt-basket-table').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (th) {
        const k = th.dataset.sort;
        this.sort = { key: k, dir: this.sort.key === k ? -this.sort.dir : (k === 'name' || k === 'sector' ? 1 : -1) };
        this.renderTable();
        return;
      }
      const tr = e.target.closest('tr[data-t]');
      if (tr) { this.selectStock(tr.dataset.t); $('mkt-drill-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    });
    $('mkt-basket-table').addEventListener('keydown', (e) => {
      const tr = e.target.closest('tr[data-t]');
      if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); tr.click(); }
    });
    $('mkt-downloads').addEventListener('click', (e) => {
      const b = e.target.closest('[data-dl]');
      if (b) this.download(b.dataset.dl);
    });
    // Stock selector (alphabetical) with previous / next stepping
    const byName = this.stocks().slice().sort((a, b) => a.name.localeCompare(b.name));
    this.stockOrder = byName.map((x) => x.key);
    $('mkt-stock-select').innerHTML = byName.map((x) =>
      `<option value="${esc(x.key)}">${esc(x.name)} — ${esc(this.short(x.ticker))} · ${esc(x.sector)}</option>`).join('');
    $('mkt-stock-select').addEventListener('change', (e) => this.selectStock(e.target.value));
    const step = (d) => {
      const i = this.stockOrder.indexOf(this.drill);
      this.selectStock(this.stockOrder[(i + d + this.stockOrder.length) % this.stockOrder.length]);
    };
    $('mkt-stock-prev').addEventListener('click', () => step(-1));
    $('mkt-stock-next').addEventListener('click', () => step(1));
    this.drill = this.stocks()[0].key;
  },

  /** One path for every way of choosing a stock: dropdown, arrows, table row. */
  selectStock(key) {
    if (!this.inst(key)) return;
    this.drill = key;
    $('mkt-stock-select').value = key;
    document.querySelectorAll('#mkt-basket-table tr[data-t]').forEach((tr) => tr.classList.toggle('selected', tr.dataset.t === key));
    this.renderDrill();
  },

  /** About one x-axis label per 90px of chart width (3 on a phone, 8 on desktop). */
  tickLimit(id) {
    const w = ($(id) && $(id).parentElement.clientWidth) || 800;
    return Math.max(3, Math.min(8, Math.floor(w / 90)));
  },

  /** Create a chart once, then update it in place (no destroy/re-create flash). */
  drawInPlace(id, type, data, options) {
    const ch = chartRegistry[id];
    if (ch && ch.config.type === type) {
      ch.data.labels = data.labels;
      ch.data.datasets = data.datasets;
      ch.options = options;
      ch.update('none');
      return ch;
    }
    return upsertChart(id, { type, data, options });
  },

  /* ---------------- sections ---------------- */
  renderSnapshot() {
    const gen = new Date(DATA.meta.generated_utc);
    const now = new Date();
    // next scheduled run: Saturday 02:30 UTC strictly after now
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 30));
    while (next.getUTCDay() !== 6 || next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const ageDays = (now - gen) / 864e5;
    const hrsToNext = (next - now) / 36e5;
    const untilNext = hrsToNext < 24 ? `in ${Math.max(1, Math.round(hrsToNext))} hour${Math.round(hrsToNext) === 1 ? '' : 's'}` : `in ${Math.ceil(hrsToNext / 24)} days`;
    const ist = (d) => d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) + ' IST';
    const nse = this.stocks().map((s) => s.last_date).sort().pop();
    const us = this.inst('GL_EQ').last_date;
    const dq = DATA.data_quality;
    const fallbacks = Object.values(dq.sleeves).filter((v) => v.fallback_used).length + (dq.benchmark.fallback_used ? 1 : 0);
    const ticks = Object.values(dq.sleeves).reduce((a, v) => a + v.dropped.length, 0) + dq.benchmark.dropped.length;
    const fresh = ageDays < 8;
    const tile = (label, value, sub) => `<div class="snap-tile"><div class="snap-label">${label}</div><div class="snap-value">${value}</div><div class="snap-sub">${sub}</div></div>`;
    $('mkt-snapshot').innerHTML = [
      tile('Last close · NSE', esc(fmtDate(nse)), 'Indian stocks &amp; ETFs'),
      tile('Last close · US', esc(fmtDate(us)), 'URTH, BNDX (USD)'),
      tile('Pipeline run', esc(ist(gen)), `<span class="status-chip ${fresh ? 'good' : 'warning'}">${fresh ? '✓ Fresh' : '! Stale'} · ${ageDays < 1 ? 'today' : Math.floor(ageDays) + 'd ago'}</span>`),
      tile('Next refresh', esc(ist(next)), `scheduled · ${untilNext} · GitHub often starts scheduled jobs a few hours late`),
      tile('Models computed through', esc(fmtDate(DATA.meta.as_of)), 'last date every series has a close'),
      tile('Coverage', `${this.M.instruments.length} instruments`, `${fallbacks ? fallbacks + ' fallback ticker(s)' : 'no fallbacks needed'} · ${ticks} bad ticks removed`),
      tile('Source', 'Yahoo Finance', 'via yfinance · keyless · server-side'),
    ].join('');
  },

  renderUniverse() {
    const fx = this.inst('FX');
    $('mkt-universe').innerHTML = UNIVERSE_ORDER.map((k) => {
      const i = this.inst(k);
      if (!i) return '';
      const color = k === 'BENCH' ? INK.secondary : k === 'FX' ? INK.primary : SERIES_COLORS[k === 'RF' ? 'CASH' : k];
      const info = i.info || {};
      const facts = [];
      if (info.expense_ratio != null) facts.push(`Expense ${fmtPct(info.expense_ratio, 2)}`);
      if (info.aum != null) facts.push(`AUM ${i.ccy === 'USD' ? this.usdBig(info.aum) : this.mcap(info.aum)}`);
      if (info.pe != null) facts.push(`P/E ${info.pe.toFixed(1)}`);
      if (info.div_yield) facts.push(`Yield ${fmtPct(info.div_yield, 2)}`);
      if (info.category) facts.push(esc(info.category));
      if (k === 'IN_EQ') facts.push('12 stocks · 9 sectors', 'Equal weight');
      const sub = k === 'IN_EQ' ? 'Basket index · 1.00 = Jan 2005'
        : k === 'RF' ? `NAV · trailing 1Y yield ${fmtPct(i.ret['1Y'], 2)}`
          : k === 'FX' ? 'Rupees per US dollar'
            : i.ccy === 'USD' ? `≈ ${fmtINR(i.last * fx.last, 0)} at ₹${fx.last.toFixed(2)}/$` : 'NSE-listed ETF';
      const r = i.ret;
      const stat = (label, v, isPct = true) => `<div><span>${label}</span><b class="${isPct && v != null ? (v < 0 ? 'neg' : 'pos') : ''}">${v == null ? '—' : isPct ? fmtSignedPct(v, 1) : v}</b></div>`;
      return `<article class="u-card" style="--c:${color}">
        <div class="u-head">
          <span class="u-swatch"></span>
          <div class="u-titles"><div class="u-name">${esc(i.name)}</div><div class="u-vehicle">${esc(i.vehicle || (info.long_name || ''))}</div></div>
          <span class="u-role">${ROLE_LABEL[i.role]}</span>
        </div>
        <div class="u-price"><span class="u-last">${this.price(i)}</span>${this.chg(r['1W'], '1W')}</div>
        <div class="u-meta">${i.key === 'IN_EQ' ? '' : `<span class="mono">${esc(i.ticker)}</span> · `}close ${esc(fmtDate(i.last_date))} · ${sub}</div>
        ${this.sparkline(k, color)}
        ${k === 'IN_EQ' ? '' : this.rangeBar(i)}
        <div class="u-stats">
          ${stat('1M', r['1M'])}${stat('YTD', r.YTD)}${stat('1Y', r['1Y'])}
          ${stat('3Y p.a.', r['3Y_ann'])}${stat('Vol 1Y', i.vol_1y == null ? null : fmtPct(i.vol_1y, 1), false)}${stat('From 52W high', i.from_hi52)}
        </div>
        ${facts.length ? `<div class="u-facts">${facts.map((f) => `<span>${f}</span>`).join('')}</div>` : ''}
        <p class="u-why">${esc(i.rationale || '')}</p>
      </article>`;
    }).join('');
  },

  rangeStart(dates, r) {
    const last = new Date(dates[dates.length - 1] + 'T00:00:00');
    if (r === 'All') return 0;
    let cut;
    if (r === 'YTD') cut = `${last.getFullYear() - 1}-12-31`;
    else {
      const days = RANGES.find(([k]) => k === r)[1];
      const d = new Date(last); d.setDate(d.getDate() - days);
      cut = d.toISOString().slice(0, 10);
    }
    // last observation on or before the cut becomes the base (=100)
    let idx = 0;
    for (let t = 0; t < dates.length; t++) { if (dates[t] <= cut) idx = t; else break; }
    return idx;
  },

  renderRel() {
    document.querySelectorAll('#mkt-range [data-r]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.r === this.range)));
    document.querySelectorAll('#mkt-series [data-k]').forEach((b) => b.setAttribute('aria-pressed', String(this.shown.has(b.dataset.k))));
    const dates = [this.M.closes.dates[0], ...DATA.series.dates];
    const s = this.rangeStart(dates, this.range);
    const R = DATA.series.returns;
    const keys = [...KEYS, 'BENCH', 'RF'].filter((k) => this.shown.has(k));
    const ends = [];
    const datasets = keys.map((k) => {
      const lv = wealthPath(R[k], 1).slice(s);
      const base = lv[0];
      const data = lv.map((v) => (v / base) * 100);
      ends.push({ k, v: data[data.length - 1] });
      const isB = k === 'BENCH', isR = k === 'RF';
      return {
        label: isB ? 'Nifty 50' : isR ? 'Risk-free (liquid fund)' : ASSET[k].name,
        data,
        borderColor: isB ? INK.secondary : SERIES_COLORS[isR ? 'CASH' : k],
        borderDash: isB ? [6, 4] : isR ? [2, 3] : [],
        borderWidth: isB || isR ? 1.5 : 2,
        pointRadius: 0,
      };
    });
    upsertChart('chart-mkt-rel', {
      type: 'line',
      data: { labels: dates.slice(s), datasets },
      options: {
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { maxTicksLimit: 8, callback(v) { const l = this.getLabelForValue(v); return s > dates.length - 140 ? fmtDate(l).replace(/ \d{4}$/, '') : l.slice(0, 7); } }, grid: { display: false } },
          y: { ticks: { callback: (v) => v.toFixed(0) }, grid: { color: (c) => (c.tick.value === 100 ? alpha(INK.secondary, 0.5) : INK.grid) } },
        },
        plugins: { tooltip: { itemSort: (a, b) => b.raw - a.raw, callbacks: { title: (it) => fmtDate(it[0].label), label: (it) => `${it.dataset.label}: ${it.raw.toFixed(1)} (${fmtSignedPct(it.raw / 100 - 1, 1)})` } } },
      },
    });
    ends.sort((a, b) => b.v - a.v);
    const nm = (k) => (k === 'BENCH' ? 'Nifty 50' : k === 'RF' ? 'Risk-free' : ASSET[k].name);
    $('mkt-rel-note').innerHTML = `${esc(this.range)} window from ${esc(fmtDate(dates[s]))}: best <strong style="color:var(--text-primary)">${esc(nm(ends[0].k))} ${fmtSignedPct(ends[0].v / 100 - 1, 1)}</strong>,
      worst <strong style="color:var(--text-primary)">${esc(nm(ends[ends.length - 1].k))} ${fmtSignedPct(ends[ends.length - 1].v / 100 - 1, 1)}</strong>. All series in INR (USD sleeves converted at USDINR), including dividends where the vehicle reinvests them. Click the chips to add or remove series.`;
  },

  renderBasketStats() {
    const st = this.stocks();
    const C = this.M.basket.corr_weekly;
    let s = 0, n = 0;
    for (let i = 0; i < C.length; i++) for (let j = i + 1; j < C.length; j++) { s += C[i][j]; n++; }
    const bk = this.inst('IN_EQ'), nf = this.inst('BENCH');
    const pes = st.map((x) => x.info && x.info.pe).filter((x) => x != null).sort((a, b) => a - b);
    const dys = st.map((x) => x.info && x.info.div_yield).filter((x) => x != null);
    const box = (label, value, sub) => `<div class="stat-box"><div class="stat-label">${label}</div><div class="stat-value" style="font-size:18px">${value}</div><div class="stat-sub">${sub}</div></div>`;
    $('mkt-basket-stats').innerHTML = [
      box('Basket 1Y return', fmtSignedPct(bk.ret['1Y'], 1), `Nifty 50 ${fmtSignedPct(nf.ret['1Y'], 1)} · gap ${fmtSignedPct(bk.ret['1Y'] - nf.ret['1Y'], 1)}`),
      box('Basket 3Y p.a.', fmtSignedPct(bk.ret['3Y_ann'], 1), `Nifty 50 ${fmtSignedPct(nf.ret['3Y_ann'], 1)} p.a.`),
      box('Avg. pairwise correlation', fmtNum(s / n, 2), 'weekly returns, full window'),
      box('Basket beta (1Y)', fmtNum(bk.beta_1y, 2), `vol ${fmtPct(bk.vol_1y, 1)} vs Nifty ${fmtPct(nf.vol_1y, 1)}`),
      box('Median P/E', pes.length ? fmtNum(pes[Math.floor(pes.length / 2)], 1) : '—', dys.length ? `avg dividend yield ${fmtPct(mean(dys), 2)}` : ''),
    ].join('');
  },

  renderTable() {
    const val = {
      name: (i) => i.name, sector: (i) => i.sector, last: (i) => i.last, w1: (i) => i.ret['1W'], m1: (i) => i.ret['1M'],
      ytd: (i) => i.ret.YTD, y1: (i) => i.ret['1Y'], hi: (i) => i.from_hi52, vol: (i) => i.vol_1y, beta: (i) => i.beta_1y,
      corr: (i) => i.corr_1y, mcap: (i) => (i.info || {}).market_cap, pe: (i) => (i.info || {}).pe, dy: (i) => (i.info || {}).div_yield, weight: (i) => i.weight,
    };
    const cols = [['name', 'Company'], ['sector', 'Sector'], ['last', 'Last close'], ['w1', '1W'], ['m1', '1M'], ['ytd', 'YTD'], ['y1', '1Y'],
      ['hi', '52W range'], ['vol', 'Vol 1Y'], ['beta', 'Beta'], ['corr', 'Corr Nifty'], ['mcap', 'Mkt cap'], ['pe', 'P/E'], ['dy', 'Div yld'], ['weight', 'Weight']];
    const { key, dir } = this.sort;
    const rows = this.stocks().slice().sort((a, b) => {
      const x = val[key](a), y = val[key](b);
      if (x == null) return 1; if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
    });
    const arrow = (k) => (k === key ? (dir > 0 ? ' ▲' : ' ▼') : '');
    $('mkt-basket-table').innerHTML = `<thead><tr>${cols.map(([k, l]) => `<th data-sort="${k}" aria-sort="${k === key ? (dir > 0 ? 'ascending' : 'descending') : 'none'}" tabindex="0">${l}${arrow(k)}</th>`).join('')}</tr></thead><tbody>` +
      rows.map((i) => {
        const info = i.info || {};
        return `<tr data-t="${esc(i.key)}" tabindex="0" class="${i.key === this.drill ? 'selected' : ''}">
          <td><span class="co">${esc(i.name)}</span><span class="tk">${esc(this.short(i.ticker))}</span></td>
          <td style="color:var(--text-muted)">${esc(i.sector)}</td>
          <td style="color:var(--text-primary)">${this.price(i)}<span class="tk">${esc(fmtDate(i.last_date).replace(/ \d{4}$/, ''))}</span></td>
          ${this.pctCell(i.ret['1W'])}${this.pctCell(i.ret['1M'])}${this.pctCell(i.ret.YTD)}${this.pctCell(i.ret['1Y'])}
          <td>${this.miniRange(i)}</td>
          <td>${fmtPct(i.vol_1y, 1)}</td><td>${fmtNum(i.beta_1y, 2)}</td><td>${fmtNum(i.corr_1y, 2)}</td>
          <td>${this.mcap(info.market_cap)}</td><td>${info.pe != null ? info.pe.toFixed(1) : '—'}</td>
          <td>${info.div_yield != null ? fmtPct(info.div_yield, 2) : '—'}</td><td>${fmtPct(i.weight, 2)}</td></tr>`;
      }).join('') + '</tbody>';
  },

  miniRange(i) {
    const pos = Math.max(0, Math.min(1, (i.last - i.lo52) / Math.max(i.hi52 - i.lo52, 1e-12)));
    return `<div class="mini-range" title="52W low ${this.price(i, i.lo52)} · high ${this.price(i, i.hi52)} · ${fmtSignedPct(i.from_hi52, 1)} from high">
      <div class="range52-track"><div class="range52-mark" style="left:${(pos * 100).toFixed(1)}%"></div></div><span>${fmtSignedPct(i.from_hi52, 0)}</span></div>`;
  },

  renderDrill() {
    const i = this.inst(this.drill);
    document.querySelectorAll('#mkt-drill-range [data-r]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.r === this.drillRange)));
    const { dates, values } = this.level(i.key);
    const bench = this.level('BENCH').values;
    let s = 0;
    if (this.drillRange !== 'All') {
      const days = { '3M': 91, '1Y': 365, '3Y': 1096 }[this.drillRange];
      const d = new Date(dates[dates.length - 1] + 'T00:00:00'); d.setDate(d.getDate() - days);
      const cut = d.toISOString().slice(0, 10);
      s = Math.max(0, dates.findIndex((x) => x > cut) - 1);
    }
    const px = values.slice(s), bx = bench.slice(s);
    const b0 = bx.find((x) => x != null), p0 = px.find((x) => x != null);
    const rebased = bx.map((x) => (x == null ? null : (x / b0) * p0));
    const datasets = [
      { label: i.name, data: px, borderColor: INK.primary, pointRadius: 0, borderWidth: 2 },
      { label: 'Nifty 50 (rebased to stock)', data: rebased, borderColor: INK.muted, borderDash: [6, 4], pointRadius: 0, borderWidth: 1.5 },
    ];
    if (this.drillRange !== '3Y' && this.drillRange !== 'All') {
      datasets.push({ label: '52W high', data: px.map(() => i.hi52), borderColor: alpha(POS_COLOR, 0.7), borderDash: [2, 3], pointRadius: 0, borderWidth: 1 });
      datasets.push({ label: '52W low', data: px.map(() => i.lo52), borderColor: alpha(NEG_COLOR, 0.7), borderDash: [2, 3], pointRadius: 0, borderWidth: 1 });
    }
    // month labels as "Feb '26" — same unambiguous style as the candlestick axis below
    const monthLabel = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { month: 'short' }) + " '" + iso.slice(2, 4);
    this.drawInPlace('chart-mkt-drill', 'line', { labels: dates.slice(s), datasets }, {
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { maxTicksLimit: this.tickLimit('chart-mkt-drill'), maxRotation: 0, autoSkipPadding: 14, callback(v) { return monthLabel(this.getLabelForValue(v)); } }, grid: { display: false } },
        y: { ticks: { callback: (v) => '₹' + Number(v).toLocaleString('en-IN') }, grid: { color: INK.grid } },
      },
      plugins: { tooltip: { callbacks: { title: (it) => fmtDate(it[0].label), label: (it) => (it.raw == null ? null : `${it.dataset.label}: ₹${it.raw.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`) } } },
    });
    this.renderCandles(i);
    const info = i.info || {};
    $('mkt-drill-title').textContent = `${i.name} — ${this.short(i.ticker)} · ${i.sector}`;
    $('mkt-drill-legend').innerHTML = `<span><span class="line-key" style="border-color:${INK.primary}"></span>${esc(i.name)} close</span>
      <span><span class="line-key dashed" style="border-color:${INK.muted}"></span>Nifty 50, rebased</span>
      ${this.drillRange === '3Y' || this.drillRange === 'All' ? '' : `<span><span class="line-key dashed" style="border-color:${POS_COLOR}"></span>52W high</span><span><span class="line-key dashed" style="border-color:${NEG_COLOR}"></span>52W low</span>`}`;
    const box = (l, v, sub = '') => `<div class="stat-box"><div class="stat-label">${l}</div><div class="stat-value" style="font-size:16px">${v}</div><div class="stat-sub">${sub}</div></div>`;
    $('mkt-drill-stats').innerHTML = [
      box('Last close', this.price(i), `${fmtDate(i.last_date)} · ${fmtSignedPct(i.chg_1d, 2)} on the day`),
      box('52-week range', `${this.price(i, i.lo52)} – ${this.price(i, i.hi52)}`, `${fmtSignedPct(i.from_hi52, 1)} from high`),
      box('1Y / 3Y p.a.', `${fmtSignedPct(i.ret['1Y'], 1)} / ${i.ret['3Y_ann'] == null ? '—' : fmtSignedPct(i.ret['3Y_ann'], 1)}`, `Nifty ${fmtSignedPct(this.inst('BENCH').ret['1Y'], 1)} / ${fmtSignedPct(this.inst('BENCH').ret['3Y_ann'], 1)}`),
      box('Risk (1Y)', `σ ${fmtPct(i.vol_1y, 1)} · β ${fmtNum(i.beta_1y, 2)}`, `max drawdown ${fmtPct(i.max_dd_1y, 1)}`),
      box('Valuation', info.pe != null ? `P/E ${info.pe.toFixed(1)}${info.pb != null ? ` · P/B ${info.pb.toFixed(1)}` : ''}` : '—', `${this.mcap(info.market_cap)}${info.industry ? ' · ' + esc(info.industry) : ''}`),
    ].join('');
  },

  /**
   * Candlestick (OHLC) chart for the selected stock on the shared period toggle.
   * 3M / 1Y use daily candles; 3Y / All use Friday-ending weekly candles (1,700
   * daily candles would be unreadable at that width). Up candles use the tab's
   * gain colour (blue) and down candles its loss colour (red) — the same CVD-safe
   * diverging pair as the 1-year return chart, rather than red/green.
   */
  renderCandles(i) {
    const O = this.M.ohlc;
    if (typeof Chart.registry.controllers.get('candlestick') === 'undefined' || !O) {
      $('mkt-candle-note').textContent = 'Candlestick data or the chart plugin is unavailable.';
      return;
    }
    const weekly = this.drillRange === '3Y' || this.drillRange === 'All';
    const blk = weekly ? O.weekly : O.daily;
    const ser = blk.series[i.key];
    let pts = [];
    if (ser) {
      const lastD = new Date(blk.dates[blk.dates.length - 1] + 'T00:00:00');
      const days = { '3M': 91, '1Y': 365, '3Y': 1096 }[this.drillRange];
      const cut = days ? new Date(lastD.getTime() - days * 864e5).toISOString().slice(0, 10) : '';
      for (let t = 0; t < blk.dates.length; t++) {
        if (blk.dates[t] < cut || ser.c[t] == null) continue;
        pts.push({ x: Date.parse(blk.dates[t] + 'T00:00:00'), o: ser.o[t], h: ser.h[t], l: ser.l[t], c: ser.c[t] });
      }
    }
    this.lastCandles = pts;
    const ups = pts.filter((p) => p.c > p.o).length, downs = pts.filter((p) => p.c < p.o).length;
    const unit = weekly ? (this.drillRange === 'All' ? 'year' : 'quarter') : (this.drillRange === '3M' ? 'week' : 'month');
    this.drawInPlace('chart-mkt-candle', 'candlestick', {
      datasets: [{
        label: i.name,
        data: pts,
        backgroundColors: { up: POS_COLOR, down: NEG_COLOR, unchanged: INK.secondary },
        borderColors: { up: POS_COLOR, down: NEG_COLOR, unchanged: INK.secondary },
        borderWidth: 1,
      }],
    }, {
      animation: false,
      parsing: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          type: 'timeseries',
          time: { unit, displayFormats: { week: "d MMM ''yy", month: "MMM ''yy", quarter: "MMM ''yy", year: 'yyyy' } },
          ticks: { maxTicksLimit: this.tickLimit('chart-mkt-candle'), source: 'auto', maxRotation: 0, autoSkipPadding: 14 },
          grid: { display: false },
        },
        y: { ticks: { callback: (v) => '₹' + Number(v).toLocaleString('en-IN') }, grid: { color: INK.grid } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (it) => {
              const d = new Date(it[0].raw.x);
              const iso = new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
              return weekly ? `Week ending ${fmtDate(iso)}` : fmtDate(iso);
            },
            label: (it) => {
              const p = it.raw;
              const f = (v) => '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              return [`Open ${f(p.o)}   High ${f(p.h)}`, `Low  ${f(p.l)}   Close ${f(p.c)}`, `${p.c >= p.o ? '▲' : '▼'} ${fmtSignedPct(p.c / p.o - 1, 2)} ${weekly ? 'over the week' : 'on the day'}`];
            },
          },
        },
      },
    });
    $('mkt-candle-res').textContent = weekly ? 'weekly candles' : 'daily candles';
    $('mkt-candle-legend').innerHTML = `<span><span class="swatch" style="background:${POS_COLOR}"></span>Up ${weekly ? 'week' : 'day'} (close above open) · ${ups}</span>
      <span><span class="swatch" style="background:${NEG_COLOR}"></span>Down ${weekly ? 'week' : 'day'} (close below open) · ${downs}</span>
      <span style="color:var(--text-muted)">Body = open→close · wick = high/low</span>`;
    $('mkt-candle-note').textContent = weekly
      ? `${pts.length} weekly candles (Friday-ending weeks) — daily candles are kept for the last ${O.daily_days} days and used for the 3M and 1Y views.`
      : `${pts.length} daily candles. Dividend- and split-adjusted prices, so the close matches the line chart above.`;
  },

  renderCorr() {
    const t = this.M.basket.tickers.map((x) => this.short(x));
    const C = this.M.basket.corr_weekly, cn = this.M.basket.corr_nifty;
    $('mkt-corr').innerHTML = `<thead><tr><th></th>${t.map((x) => `<th><span class="vert">${esc(x)}</span></th>`).join('')}<th><span class="vert">NIFTY</span></th></tr></thead><tbody>` +
      C.map((row, i) => `<tr><th class="row-h">${esc(t[i])}</th>${row.map((v, j) => (i === j ? '<td class="diag" style="background:#1f2430">—</td>'
        : `<td style="background:${divergingColor(v)}" title="${esc(t[i])} vs ${esc(t[j])}: ${v.toFixed(3)}">${v.toFixed(2)}</td>`)).join('')}
        <td class="nifty-col" style="background:${divergingColor(cn[i])}" title="${esc(t[i])} vs Nifty 50: ${cn[i].toFixed(3)}">${cn[i].toFixed(2)}</td></tr>`).join('') + '</tbody>';
    let hi = { v: -2 }, lo = { v: 2 };
    for (let i = 0; i < C.length; i++) for (let j = i + 1; j < C.length; j++) {
      if (C[i][j] > hi.v) hi = { v: C[i][j], a: t[i], b: t[j] };
      if (C[i][j] < lo.v) lo = { v: C[i][j], a: t[i], b: t[j] };
    }
    $('mkt-corr-note').innerHTML = `Most correlated: <strong style="color:var(--text-primary)">${esc(hi.a)} – ${esc(hi.b)} (${hi.v.toFixed(2)})</strong>;
      least: <strong style="color:var(--text-primary)">${esc(lo.a)} – ${esc(lo.b)} (${lo.v.toFixed(2)})</strong>. Last column: correlation with the Nifty 50.
      Low cross-sector correlations are why a 12-stock basket can carry roughly index-level volatility.`;
  },

  renderSectors() {
    const sec = Object.entries(this.M.basket.sectors).sort((a, b) => b[1] - a[1]);
    const members = (s) => this.stocks().filter((x) => x.sector === s).map((x) => this.short(x.ticker)).join(', ');
    upsertChart('chart-mkt-sectors', {
      type: 'bar',
      data: { labels: sec.map(([s]) => s), datasets: [{ label: 'Weight', data: sec.map(([, w]) => w), backgroundColor: INK.secondary, borderRadius: 4, barPercentage: 0.75 }] },
      options: {
        animation: false, indexAxis: 'y',
        scales: { x: { ticks: { callback: pctTick(0) }, grid: { color: INK.grid } }, y: { grid: { display: false } } },
        plugins: { tooltip: { callbacks: { label: (it) => `${fmtPct(it.raw, 1)} · ${members(it.label)}` } } },
      },
    });
    const st = this.stocks().slice().sort((a, b) => b.ret['1Y'] - a.ret['1Y']);
    upsertChart('chart-mkt-stock-ret', {
      type: 'bar',
      data: { labels: st.map((x) => this.short(x.ticker)), datasets: [{ label: '1Y return', data: st.map((x) => x.ret['1Y']), backgroundColor: st.map((x) => (x.ret['1Y'] >= 0 ? POS_COLOR : NEG_COLOR)), borderRadius: 3 }] },
      options: {
        animation: false,
        scales: { y: { ticks: { callback: pctTick(0) }, grid: { color: (c) => (c.tick.value === 0 ? alpha(INK.secondary, 0.5) : INK.grid) } }, x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 60, font: { size: 10 } } } },
        plugins: { tooltip: { callbacks: { label: (it) => `1Y: ${fmtSignedPct(it.raw, 1)}` } } },
      },
    });
  },

  renderRolling() {
    const rc = this.M.rolling_corr;
    const nm = (p) => p.split('|').map((k) => ASSET[k].short).join(' ↔ ');
    const pairs = Object.keys(rc.pairs);
    upsertChart('chart-mkt-roll', {
      type: 'line',
      data: {
        labels: rc.dates,
        datasets: pairs.map((p, i) => ({ label: nm(p), data: rc.pairs[p], borderColor: PAIR_COLORS[i], pointRadius: 0, borderWidth: 1.8 })),
      },
      options: {
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { maxTicksLimit: 7, callback(v) { return this.getLabelForValue(v).slice(0, 7); } }, grid: { display: false } },
          y: { min: -1, max: 1, ticks: { stepSize: 0.5 }, grid: { color: (c) => (c.tick.value === 0 ? alpha(INK.secondary, 0.5) : INK.grid) } },
        },
        plugins: { tooltip: { callbacks: { title: (it) => `52 weeks to ${fmtDate(it[0].label)}`, label: (it) => `${it.dataset.label}: ${it.raw.toFixed(2)}` } } },
      },
    });
    $('mkt-roll-legend').innerHTML = pairs.map((p, i) => {
      const v = rc.pairs[p];
      return `<span><span class="line-key" style="border-color:${PAIR_COLORS[i]}"></span>${esc(nm(p))} <span style="color:var(--text-muted)">now ${v[v.length - 1].toFixed(2)}</span></span>`;
    }).join('');
  },

  renderMacro() {
    const fx = this.inst('FX'), rf = this.inst('RF'), ns = this.inst('NSEI');
    const box = (l, v, sub) => `<div class="stat-box"><div class="stat-label">${l}</div><div class="stat-value" style="font-size:16px">${v}</div><div class="stat-sub">${sub}</div></div>`;
    $('mkt-macro-stats').innerHTML = [
      box('USD / INR', `₹${fx.last.toFixed(2)}`, `rupee ${fx.ret['1Y'] >= 0 ? 'weakened' : 'strengthened'} ${fmtPct(Math.abs(fx.ret['1Y']), 1)} in 1Y`),
      ns ? box('Nifty 50 index', ns.last.toLocaleString('en-IN', { maximumFractionDigits: 0 }), `${fmtSignedPct(ns.from_hi52, 1)} from 52W high`) : '',
      rf ? box('Risk-free (trailing 1Y)', fmtPct(rf.ret['1Y'], 2), 'liquid-fund NAV return') : '',
    ].join('');
    const lv = this.level('FX');
    const s = Math.max(0, lv.dates.length - 756);
    upsertChart('chart-mkt-fx', {
      type: 'line',
      data: { labels: lv.dates.slice(s), datasets: [{ label: 'USD/INR', data: lv.values.slice(s), borderColor: INK.primary, pointRadius: 0, borderWidth: 1.8 }] },
      options: {
        animation: false, interaction: { mode: 'index', intersect: false },
        scales: { x: { ticks: { maxTicksLimit: 6, callback(v) { return this.getLabelForValue(v).slice(0, 7); } }, grid: { display: false } }, y: { ticks: { callback: (v) => '₹' + v }, grid: { color: INK.grid } } },
        plugins: { tooltip: { callbacks: { title: (it) => fmtDate(it[0].label), label: (it) => `₹${it.raw.toFixed(2)} per $` } } },
      },
    });
    const yrs = Object.entries(DATA.risk_free.by_year);
    const lastYear = DATA.meta.as_of.slice(0, 4);
    upsertChart('chart-mkt-rf', {
      type: 'bar',
      data: { labels: yrs.map(([y]) => (y === lastYear ? `${y} YTD` : y)), datasets: [{ label: 'Return', data: yrs.map(([, v]) => v), backgroundColor: yrs.map(([y]) => (y === lastYear ? alpha(INK.secondary, 0.45) : INK.secondary)), borderRadius: 4 }] },
      options: {
        animation: false,
        scales: { y: { min: 0, ticks: { callback: pctTick(0) }, grid: { color: INK.grid } }, x: { grid: { display: false } } },
        plugins: { tooltip: { callbacks: { label: (it) => `${fmtPct(it.raw, 2)}${it.label.includes('YTD') ? ' (year to date)' : ''}` } } },
      },
    });
  },

  /* ---------------- downloads ---------------- */
  download(kind) {
    const csvCell = (v) => (v == null ? '' : typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    let rows, name;
    if (kind === 'snapshot') {
      const h = ['key', 'ticker', 'name', 'role', 'sector', 'currency', 'last_close', 'last_date', 'ret_1W', 'ret_1M', 'ret_3M', 'ret_6M', 'ret_YTD', 'ret_1Y', 'ret_3Y_ann', 'high_52w', 'low_52w', 'vol_1y', 'beta_1y', 'corr_nifty_1y', 'market_cap', 'pe', 'div_yield', 'expense_ratio'];
      rows = [h, ...this.M.instruments.map((i) => {
        const f = i.info || {};
        return [i.key, i.ticker, i.name, i.role, i.sector, i.ccy, i.last, i.last_date, i.ret['1W'], i.ret['1M'], i.ret['3M'], i.ret['6M'], i.ret.YTD, i.ret['1Y'], i.ret['3Y_ann'], i.hi52, i.lo52, i.vol_1y, i.beta_1y, i.corr_1y, f.market_cap, f.pe, f.div_yield, f.expense_ratio];
      })];
      name = 'pcl-snapshot';
    } else if (kind === 'closes') {
      const c = this.M.closes;
      const keys = Object.keys(c.series);
      rows = [['date', ...keys.map((k) => (this.inst(k) ? this.inst(k).ticker : k))], ...c.dates.map((d, t) => [d, ...keys.map((k) => c.series[k][t])])];
      name = 'pcl-daily-closes';
    } else {
      const R = DATA.series.returns;
      const keys = [...KEYS, 'BENCH', 'RF'];
      rows = [['date', ...keys], ...DATA.series.dates.map((d, t) => [d, ...keys.map((k) => R[k][t])])];
      name = 'pcl-daily-inr-returns';
    }
    const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${name}-${DATA.meta.as_of}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  render() {
    if (!this.M) {
      $('mkt-snapshot').innerHTML = '<p class="section-intro">The market snapshot was not produced in the latest pipeline run.</p>';
      return;
    }
    if (this._done) return;     // market data does not depend on client settings
    this.renderSnapshot();
    this.renderUniverse();
    this.renderRel();
    this.renderBasketStats();
    this.renderTable();
    this.selectStock(this.drill);
    this.renderCorr();
    this.renderSectors();
    this.renderRolling();
    this.renderMacro();
    this._done = true;
  },
};
