/* ---------------------------------------------------------------------
 * utils.js — stats, formatting and chart helpers shared by every module.
 * Metric conventions mirror pipeline/analytics.py exactly (sample sd with
 * ddof=1, type-7 percentiles, 252-day annualization) so the browser's
 * numbers can be cross-checked against the pipeline's reference values.
 * ------------------------------------------------------------------- */

const TRADING_DAYS = 252;

/* ---------------- Palette (validated dark categorical slots 1–5) ---------------- */
// Checked with the dataviz validator against surface #0f131c: all checks pass
// (worst adjacent CVD ΔE 8.4, normal-vision ΔE 19.3, all ≥ 3:1 contrast).
const SERIES_COLORS = {
  IN_EQ: '#3987e5',
  IN_GOLD: '#d95926',
  IN_DEBT: '#199e70',
  GL_EQ: '#c98500',
  GL_BOND: '#d55181',
  CASH: '#6b7a8f',
};
const INK = { primary: '#e6edf7', secondary: '#9fb0c3', muted: '#6b7a8f', grid: 'rgba(255,255,255,0.06)', surface: '#0f131c' };
const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' };
const ROLE = { client: '#e6edf7', benchmark: '#9fb0c3', policy: '#6b7a8f' };

/* ---------------- PRNG ---------------- */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draw (Box-Muller) from a uniform RNG. */
function randNormal(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/* ---------------- Descriptive stats ---------------- */
const sum = (arr) => { let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i]; return s; };
const mean = (arr) => sum(arr) / arr.length;

function stdDev(arr) {
  const m = mean(arr);
  let v = 0;
  for (let i = 0; i < arr.length; i++) v += (arr[i] - m) * (arr[i] - m);
  return Math.sqrt(v / (arr.length - 1));
}

function covariance(a, b) {
  const ma = mean(a), mb = mean(b);
  let c = 0;
  for (let i = 0; i < a.length; i++) c += (a[i] - ma) * (b[i] - mb);
  return c / (a.length - 1);
}

/** Linear-interpolated percentile (numpy default / type 7). q in [0, 1]. */
function quantile(arr, q) {
  const s = Float64Array.from(arr).sort();
  const idx = q * (s.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/** Inverse standard-normal CDF (Acklam's rational approximation, |err| < 1.2e-9). */
function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
          ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

const normPdf = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

/* ---------------- Linear algebra on small arrays ---------------- */
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

function quadForm(w, M) {
  let s = 0;
  for (let i = 0; i < w.length; i++) for (let j = 0; j < w.length; j++) s += w[i] * M[i][j] * w[j];
  return s;
}

/* ---------------- Paths & drawdowns ---------------- */
function wealthPath(returns, start = 1) {
  const out = new Array(returns.length + 1);
  out[0] = start;
  for (let i = 0; i < returns.length; i++) out[i + 1] = out[i] * (1 + returns[i]);
  return out;
}

function drawdownSeries(wealth) {
  let peak = -Infinity;
  return wealth.map((v) => { peak = Math.max(peak, v); return v / peak - 1; });
}

function maxDrawdown(returns) {
  let w = 1, peak = 1, mdd = 0;
  for (const r of returns) {
    w *= 1 + r;
    if (w > peak) peak = w;
    mdd = Math.min(mdd, w / peak - 1);
  }
  return mdd;
}

function cagrFromReturns(returns, periodsPerYear = TRADING_DAYS) {
  let w = 1;
  for (const r of returns) w *= 1 + r;
  return Math.pow(w, periodsPerYear / returns.length) - 1;
}

/**
 * Full risk/performance metric set for a daily return series r, with daily
 * risk-free rf and benchmark b. Mirrors analytics.risk_metrics in Python.
 */
function riskMetrics(r, rf, b, conf = 0.95) {
  const n = r.length;
  const ex = new Array(n), bex = new Array(n), act = new Array(n);
  for (let i = 0; i < n; i++) { ex[i] = r[i] - rf[i]; bex[i] = b[i] - rf[i]; act[i] = r[i] - b[i]; }
  const q = quantile(r, 1 - conf);
  const tail = r.filter((x) => x <= q);
  const muD = mean(r), sdD = stdDev(r);
  const z = normInv(1 - conf);
  let dd = 0;
  for (const e of ex) dd += Math.min(e, 0) ** 2;
  dd = Math.sqrt(dd / n);
  const beta = covariance(ex, bex) / (stdDev(bex) ** 2);
  const te = stdDev(act) * Math.sqrt(TRADING_DAYS);
  const mEx = mean(ex);
  return {
    var_hist_1d: -q,
    cvar_hist_1d: -mean(tail),
    var_param_1d: -(muD + z * sdD),
    cvar_param_1d: -(muD - sdD * normPdf(z) / (1 - conf)),
    vol_ann: sdD * Math.sqrt(TRADING_DAYS),
    max_drawdown: maxDrawdown(r),
    sharpe: (mEx * TRADING_DAYS) / (sdD * Math.sqrt(TRADING_DAYS)),
    sortino: (mEx * TRADING_DAYS) / (dd * Math.sqrt(TRADING_DAYS)),
    beta,
    treynor: (mEx * TRADING_DAYS) / beta,
    jensen_alpha: (mEx - beta * mean(bex)) * TRADING_DAYS,
    tracking_error: te,
    information_ratio: (mean(act) * TRADING_DAYS) / te,
    cagr: cagrFromReturns(r),
  };
}

/** Compound daily returns into calendar-month returns. */
function monthlyReturns(dates, seriesMap) {
  const keys = Object.keys(seriesMap);
  const months = [];
  const out = Object.fromEntries(keys.map((k) => [k, []]));
  let cur = null;
  const acc = {};
  for (let i = 0; i < dates.length; i++) {
    const m = dates[i].slice(0, 7);
    if (m !== cur) {
      if (cur !== null) keys.forEach((k) => out[k].push(acc[k] - 1));
      cur = m; months.push(m);
      keys.forEach((k) => { acc[k] = 1; });
    }
    keys.forEach((k) => { acc[k] *= 1 + seriesMap[k][i]; });
  }
  if (cur !== null) keys.forEach((k) => out[k].push(acc[k] - 1));
  return { months, returns: out };
}

/* ---------------- Formatting ---------------- */
const fmtINR = (v, decimals = 0) =>
  (v < 0 ? '−₹' : '₹') + Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

const fmtPct = (v, decimals = 1) => (v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(decimals) + '%';
const fmtSignedPct = (v, decimals = 1) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(decimals) + '%';
const fmtNum = (v, decimals = 2) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(decimals);
const fmtBp = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 10000).toFixed(0) + ' bp';

/** Lakh / crore compact notation. */
function fmtCompactINR(v) {
  const abs = Math.abs(v), sign = v < 0 ? '−' : '';
  if (abs >= 1e7) return sign + '₹' + (abs / 1e7).toFixed(2) + ' Cr';
  if (abs >= 1e5) return sign + '₹' + (abs / 1e5).toFixed(2) + ' L';
  if (abs >= 1e3) return sign + '₹' + (abs / 1e3).toFixed(1) + 'K';
  return sign + '₹' + abs.toFixed(0);
}

const fmtDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** Escape text for safe insertion into innerHTML. */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const $ = (id) => document.getElementById(id);

/* ---------------- Chart.js helpers ---------------- */
function applyChartDefaults() {
  Chart.defaults.font.family = '-apple-system, "Segoe UI", system-ui, sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.color = INK.secondary;
  Chart.defaults.borderColor = INK.grid;
  Chart.defaults.plugins.legend.display = false;
  Chart.defaults.plugins.tooltip.backgroundColor = '#0b0e15';
  Chart.defaults.plugins.tooltip.borderColor = 'rgba(0, 240, 255, 0.25)';
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.titleColor = INK.primary;
  Chart.defaults.plugins.tooltip.bodyColor = INK.secondary;
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.boxPadding = 4;
  Chart.defaults.elements.line.borderWidth = 2;
  Chart.defaults.elements.point.radius = 0;
  Chart.defaults.elements.point.hoverRadius = 5;
  Chart.defaults.elements.bar.borderRadius = 4;
  Chart.defaults.animation.duration = 250;
  Chart.defaults.maintainAspectRatio = false;
}

const chartRegistry = {};

/** Create or replace a chart bound to a canvas id. */
function upsertChart(id, config) {
  if (chartRegistry[id]) chartRegistry[id].destroy();
  chartRegistry[id] = new Chart($(id), config);
  return chartRegistry[id];
}

/** Hex colour → rgba string with alpha. */
function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const pctTick = (decimals = 0) => (v) => (v * 100).toFixed(decimals) + '%';

/** Diverging blue↔gray↔red scale for correlations in [-1, 1] (dark-mode steps). */
function divergingColor(v) {
  const neutral = [56, 56, 53];          // #383835 dark-mode neutral midpoint
  const pos = [208, 59, 59];             // red pole (positive correlation)
  const neg = [42, 120, 214];            // blue pole (negative correlation)
  const t = Math.min(1, Math.abs(v));
  const pole = v >= 0 ? pos : neg;
  const c = neutral.map((n, i) => Math.round(n + (pole[i] - n) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}
