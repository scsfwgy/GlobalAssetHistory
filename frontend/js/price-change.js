/**
 * Yearly price change tracker — heatmap table.
 *
 * Features:
 *   - Add/remove symbols (stock or crypto)
 *   - Preset symbol groups loaded from backend config
 *   - Configurable color range (min/max %)
 *   - Red/green background shading proportional to magnitude
 */

const API_BASE = "";
const ENDPOINT = `${API_BASE}/api/price-change/yearly`;
const CONFIG_ENDPOINT = `${API_BASE}/api/price-change/config`;
const MONTHLY_ENDPOINT = `${API_BASE}/api/price-change/monthly`;
const BATCH_MONTHLY_ENDPOINT = `${API_BASE}/api/price-change/monthly-batch`;
const DAILY_ENDPOINT = `${API_BASE}/api/price-change/daily`;
const BACKTEST_ENDPOINT = `${API_BASE}/api/price-change/backtest`;

// ─── State ───

let symbols = []; // [{symbol, type}, ...]
let PRESETS = []; // [{key, label, symbols}, ...] loaded from backend
let _currentSymKeys = []; // symbols currently shown in table columns
let _lastYearlyData = null; // {years, data} from last fetch, for line charts
let _mChartHidden = []; // hidden series indices for monthly chart

// ─── DOM refs ───

const $ = (id) => document.getElementById(id);
const symInput = $("pcSymbolInput");
const typeSelect = $("pcTypeSelect");
const addBtn = $("pcAddBtn");
const clearBtn = $("pcClearBtn");
const refreshBtn = $("pcRefreshBtn");
const minRange = $("pcMinRange");
const maxRange = $("pcMaxRange");
const tags = $("pcTags");
const table = $("pcTable");
const tableHead = $("pcTableHead");
const tableBody = $("pcTableBody");
const empty = $("pcEmpty");
const error = $("pcError");
const loading = $("pcLoading");
const metaInfo = $("pcMetaInfo");
const statusDot = $("statusDot");
const statusText = $("statusText");

const yearSelect = $("pcYearSelect");
const yearList = $("pcYearList");

// ─── Backtest DOM refs ───
const btWrap = $("pcBacktest");
const btAmount = $("pcBtAmount");
const btInitialAmount = $("pcBtInitialAmount");
const btStartDate = $("pcBtStartDate");
const btEndDate = $("pcBtEndDate");
const btFrequency = $("pcBtFrequency");
const btInterval = $("pcBtInterval");
const btDayOfMonth = $("pcBtDayOfMonth");
const btDayOfMonthLabel = $("pcBtDayOfMonthLabel");
const btWeekday = $("pcBtWeekday");
const btWeekdayLabel = $("pcBtWeekdayLabel");
const btSampleSize = $("pcBtSampleSize");
const btAnimSeconds = $("pcBtAnimSeconds");
const btAddSelect = $("btAddSelect");
const btRun = $("pcBtRun");
const btClose = $("pcBtClose");
const btResult = $("pcBtResult");
const btSummary = $("pcBtSummary");
const btHead = $("pcBtHead");
const btBody = $("pcBtBody");

const BACKTEST_MIN_SAMPLE = 20;
const BACKTEST_DEFAULT_SAMPLE = 120;

// ─── Status ───

function setConnected(ok) {
  statusDot.className = "status-dot" + (ok ? " connected" : "");
  statusText.textContent = ok ? "已连接" : "未连接";
}

// ─── Error / Loading ───

function showError(msg) {
  if (!msg) { error.style.display = "none"; return; }
  error.textContent = msg;
  error.style.display = "block";
}

function setLoading(on) {
  loading.style.display = on ? "flex" : "none";
}

// ─── Year mode helpers ───

function getSelectedYear() {
  const val = yearSelect?.value?.trim();
  if (!val || val === "历年汇总") return null;
  const num = parseInt(val, 10);
  return isNaN(num) ? null : num;
}

function populateYearOptions() {
  if (!yearList) return;
  const currentYear = new Date().getFullYear();
  const years = [];
  for (let y = currentYear; y >= 2015; y--) {
    years.push(`<option value="${y}">`);
  }
  yearList.innerHTML = years.join("");
}

function hideYearlySections() {
  $("pcChartWrap").style.display = "none";
  if (btWrap) btWrap.style.display = "none";
  if (btResult) btResult.style.display = "none";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderMetaInfo(meta) {
  if (!metaInfo) return;
  if (!meta || Object.keys(meta).length === 0) {
    metaInfo.style.display = "none";
    metaInfo.innerHTML = "";
    return;
  }

  const items = symbols
    .map((s) => meta[s.symbol])
    .filter(Boolean)
    .map((m) => {
      const source = m.source ? escapeHtml(m.source) : "未知源";
      const points = Number.isFinite(m.points) ? `${m.points} 条日线` : "";
      const suffix = m.error
        ? ` <span class="pc-meta-error">失败: ${escapeHtml(m.error)}</span>`
        : ` ${points}`;
      return `<span><strong>${escapeHtml(m.symbol)}</strong>: ${source}${suffix}</span>`;
    });

  metaInfo.innerHTML = items.join(" · ");
  metaInfo.style.display = items.length ? "block" : "none";
}

// ─── Display name helper ───

function displayName(s) {
  return s.name ? `${s.symbol}(${s.name})` : s.symbol;
}

// ─── Symbol tags ───

function renderTags() {
  if (symbols.length === 0) {
    tags.innerHTML = '<span style="color:var(--apple-text-tertiary);font-size:12px;">暂无代码，输入并添加</span>';
    return;
  }
  tags.innerHTML = symbols
    .map(
      (s, i) =>
        `<span class="pc-tag">
          ${displayName(s)}
          <span class="pc-tag-type">${s.type === "crypto" ? "币" : s.type === "cn_stock" ? "A" : "股"}</span>
          <span class="pc-tag-remove" data-index="${i}">✕</span>
        </span>`
    )
    .join("");

  tags.querySelectorAll(".pc-tag-remove").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.index, 10);
      symbols.splice(idx, 1);
      renderTags();
    });
  });
}

// ─── Add symbol ───

function addSymbol(symbol, type) {
  const sym = symbol.trim().toUpperCase();
  if (!sym) return false;
  if (symbols.some((s) => s.symbol === sym && s.type === type)) return false;
  symbols.push({ symbol: sym, type });
  renderTags();
  symInput.value = "";
  symInput.focus();
  return true;
}

// ─── Color helpers ───

function cellColor(val, min, max) {
  // Multi-stop HSL gradient for richer color depth.
  // Positive: light green → vibrant green → deep green
  // Negative: light red → vibrant red → deep red
  if (val > 0) {
    const intensity = Math.min(val / max, 1);
    // Green hue 142°: lightness 88%→35%, saturation 55%→85%, alpha grows
    const lightness = 88 - intensity * 53;
    const saturation = 55 + intensity * 30;
    const alpha = Math.min(0.18 + intensity * 0.72, 0.95);
    return {
      bg: `hsla(142, ${Math.round(saturation)}%, ${Math.round(lightness)}%, ${alpha.toFixed(3)})`,
      text: lightness < 50 ? "#fff" : "var(--data-positive)",
    };
  }
  if (val < 0) {
    const intensity = Math.min(Math.abs(val) / Math.abs(min), 1);
    // Red hue 4°: lightness 88%→35%, saturation 55%→85%, alpha grows
    const lightness = 88 - intensity * 53;
    const saturation = 55 + intensity * 30;
    const alpha = Math.min(0.18 + intensity * 0.72, 0.95);
    return {
      bg: `hsla(4, ${Math.round(saturation)}%, ${Math.round(lightness)}%, ${alpha.toFixed(3)})`,
      text: lightness < 50 ? "#fff" : "var(--data-negative)",
    };
  }
  // Zero or NaN: neutral
  return { bg: "transparent", text: "var(--apple-text-secondary)" };
}

function formatPct(val) {
  if (val == null || isNaN(val)) return "—";
  const sign = val > 0 ? "+" : "";
  return `${sign}${val.toFixed(2)}%`;
}

// ─── API call ───

async function fetchData() {
  if (symbols.length === 0) {
    showError("请至少添加一个代码");
    return;
  }

  // Check if monthly mode (specific year selected)
  const year = getSelectedYear();
  if (year !== null) {
    await fetchMonthlyBatch(year);
    return;
  }

  // Clear previous drilldown cards and chart on new query
  const mc = $("pcMonthlyContainer");
  if (mc) mc.innerHTML = "";
  renderMetaInfo(null);
  $("pcChartWrap").style.display = "none";
  if (btWrap) btWrap.style.display = "none";
  if (btResult) btResult.style.display = "none";
  _btSymbols = [];
  _chartData = null;
  _chartSymbols = null;
  _chartHidden = [];
  _lastYearlyData = null;

  showError(null);
  setLoading(true);
  table.style.display = "none";
  empty.style.display = "none";

  try {
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }

    const result = await resp.json();
    setConnected(true);
    _lastYearlyData = result;
    renderMetaInfo(result.meta);
    try {
      renderTable(result);
    } catch (renderErr) {
      console.error("renderTable error:", renderErr);
      showError(`渲染失败: ${renderErr.message}`);
    }
  } catch (e) {
    setConnected(false);
    showError(`请求失败: ${e.message}`);
    renderMetaInfo(null);
    empty.style.display = "block";
    table.style.display = "none";
  } finally {
    setLoading(false);
  }
}

// ─── Table render ───

function renderTable(result) {
  const { years, data } = result;

  if (!years || years.length === 0 || Object.keys(data).length === 0) {
    empty.innerHTML =
      "<div>查询完成，但未获取到有效数据</div>" +
      "<div class='pc-empty-hint'>请检查代码是否正确，或该代码暂无历史数据</div>";
    empty.style.display = "block";
    table.style.display = "none";
    return;
  }

  empty.style.display = "none";
  table.style.display = "";

  // Determine which symbols actually have data
  const activeSymbols = symbols.filter((s) => {
    const d = data[s.symbol];
    return d && Object.keys(d).length > 0;
  });
  const symKeys = activeSymbols.map((s) => s.symbol);

  if (symKeys.length === 0) {
    empty.innerHTML = "<div>查询完成，但所有代码均无有效数据</div>";
    empty.style.display = "block";
    table.style.display = "none";
    return;
  }

  // Read current range
  const minVal = parseFloat(minRange.value) || -50;
  const maxVal = parseFloat(maxRange.value) || 50;

  // Build a lookup for display names
  const nameLookup = {};
  const typeLookup = {};
  for (const s of symbols) {
    nameLookup[s.symbol] = s.name || null;
    typeLookup[s.symbol] = s.type || "stock";
  }
  _currentSymKeys = symKeys;

  // Render header — name on a separate line below the symbol
  tableHead.innerHTML =
    `<th>年份</th>` +
    symKeys.map((s) => {
      const name = nameLookup[s];
      return name ? `<th>${s}<span class="pc-th-name">${name}</span></th>` : `<th>${s}</th>`;
    }).join("");

  // Render body (years are already sorted descending from API)
  tableBody.innerHTML = years
    .map((year) => {
      let cells = `<td>${year}</td>`;
      for (const sym of symKeys) {
        const val = data[sym] && data[sym][year];
        const pct = val != null ? val : null;
        const formatted = pct !== null ? formatPct(pct) : "—";
        const colors = pct !== null ? cellColor(pct, minVal, maxVal) : { bg: "transparent", text: "var(--apple-text-tertiary)" };
        cells += `<td class="pc-cell" data-symbol="${sym}" data-year="${year}" data-type="${typeLookup[sym]}" style="background:${colors.bg};color:${colors.text};cursor:pointer;">${formatted}</td>`;
      }
      return `<tr>${cells}</tr>`;
    })
    .join("");

  // Multi-line chart
  _chartData = data;
  _chartSymbols = activeSymbols;
  _chartHidden = [];
  renderMultiLineChart(data, activeSymbols, []);

  // Populate backtest options and show the section
  try { populateBacktestOptions(); } catch (btErr) { console.error("bt opt fail:", btErr); }
  try { renderBtTags(); } catch (btErr) { console.error("bt tags fail:", btErr); }
  if (btWrap) btWrap.style.display = "";
}

// ─── Presets ───

async function loadConfigFromServer() {
  try {
    const resp = await fetch(CONFIG_ENDPOINT);
    if (!resp.ok) return { presets: [], colorRange: { min: -100, max: 100 } };
    const cfg = await resp.json();
    return {
      presets: cfg.presets || [],
      colorRange: cfg.color_range || { min: -100, max: 100 },
    };
  } catch {
    return { presets: [], colorRange: { min: -100, max: 100 } };
  }
}

function loadPreset(key) {
  const entry = PRESETS.find((p) => p.key === key);
  if (!entry || !entry.symbols) return;
  symbols = entry.symbols.map((s) => ({ ...s }));
  renderTags();
  fetchData();
}

function renderPresetChips() {
  const container = document.getElementById("pcPresets");
  if (!container) return;
  container.querySelectorAll(".pc-preset-chip").forEach((el) => el.remove());
  for (const p of PRESETS) {
    const chip = document.createElement("span");
    chip.className = "pc-preset-chip";
    chip.textContent = p.label || p.key;
    chip.dataset.preset = p.key;
    chip.addEventListener("click", () => loadPreset(p.key));
    container.appendChild(chip);
  }
}

// ─── Multi-line chart (all symbols overlaid) ───

const LINE_COLORS = [
  "#2997ff", "#e8a43e", "#30d158", "#ff453a", "#5ac8fa",
  "#ff9f0a", "#bf5af2", "#ff6482", "#64d2ff", "#ffd60a",
  "#ff375f", "#00c7be", "#ffb340", "#86868b", "#ff6482",
];

let _chartData = null;
let _chartSymbols = null;
let _chartHidden = []; // indices of hidden series

function renderMultiLineChart(data, symbolsList, hiddenIndices) {
  // Build series list
  const allSeries = [];
  let allYears = new Set();

  for (const s of symbolsList) {
    const yearly = data[s.symbol];
    if (!yearly) continue;
    const pts = Object.entries(yearly)
      .map(([y, v]) => ({ year: parseInt(y, 10), value: v }))
      .filter((p) => p.value != null)
      .sort((a, b) => a.year - b.year);
    if (pts.length < 2) continue;
    allSeries.push({ symbol: s.symbol, name: s.name || s.symbol, points: pts });
    pts.forEach((p) => allYears.add(p.year));
  }

  if (allSeries.length === 0) return;

  // Separate visible vs hidden
  const visibleSeries = allSeries.filter((_, i) => !hiddenIndices.includes(i));
  const hiddenSet = new Set(hiddenIndices);

  // Compute Y range from VISIBLE series only
  let allVals = [];
  visibleSeries.forEach((s) => s.points.forEach((p) => allVals.push(p.value)));
  if (allVals.length === 0) allVals = [0];
  const minVal = Math.min(...allVals, 0);
  const maxVal = Math.max(...allVals, 0);
  const range = maxVal - minVal || 1;
  const pad = range * 0.1;
  const yMin = minVal - pad;
  const yMax = maxVal + pad;
  const yRange = yMax - yMin;

  // Dynamic left padding based on max label width
  const maxAbsLabel = Math.max(Math.abs(yMin), Math.abs(yMax));
  const labelChars = maxAbsLabel.toFixed(1).length + 1; // "+XXX.X%"
  const PAD_LEFT = Math.max(48, labelChars * 7 + 8);
  const W = 700, H = 220, PAD = { top: 20, right: 16, bottom: 30, left: PAD_LEFT };
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;

  // Sorted years across all series (for x-axis)
  const years = Array.from(allYears).sort((a, b) => a - b);
  const xPos = (y) => PAD.left + ((y - years[0]) / (years[years.length - 1] - years[0] || 1)) * cw;
  const yPos = (v) => PAD.top + ch - ((v - yMin) / yRange) * ch;
  const zeroY = yPos(0);

  // Y-axis grid
  const yTicks = 5;
  let yGrid = "";
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + (yRange * i) / yTicks;
    const y = yPos(v);
    yGrid += `<line x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}" stroke="var(--apple-divider)" stroke-width="1"/>`;
    yGrid += `<text x="${PAD.left - 6}" y="${y + 4}" text-anchor="end" fill="var(--apple-text-tertiary)" font-size="11">${v.toFixed(1)}%</text>`;
  }

  // Zero line
  const zeroLine = (zeroY >= PAD.top && zeroY <= H - PAD.bottom)
    ? `<line x1="${PAD.left}" y1="${zeroY}" x2="${W - PAD.right}" y2="${zeroY}" stroke="var(--apple-text-tertiary)" stroke-width="1" stroke-dasharray="4,3" opacity="0.6"/>`
    : "";

  // X-axis labels
  let xLabels = "";
  if (years.length > 1) {
    const step = Math.max(1, Math.floor(years.length / 8));
    for (let i = 0; i < years.length; i++) {
      if (i % step === 0 || i === years.length - 1) {
        xLabels += `<text x="${xPos(years[i])}" y="${H - 8}" text-anchor="middle" fill="var(--apple-text-tertiary)" font-size="11">${years[i]}</text>`;
      }
    }
  }

  // Only render visible series
  let seriesGroups = "";
  visibleSeries.forEach((series, vi) => {
    const color = LINE_COLORS[vi % LINE_COLORS.length];
    const pts = series.points;
    let gLines = "";
    let gDots = "";
    for (let i = 0; i < pts.length - 1; i++) {
      const x1 = xPos(pts[i].year), y1 = yPos(pts[i].value);
      const x2 = xPos(pts[i + 1].year), y2 = yPos(pts[i + 1].value);
      gLines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1" stroke-linecap="round" opacity="0.75"/>`;
    }
    pts.forEach((p) => {
      gDots += `<circle cx="${xPos(p.year)}" cy="${yPos(p.value)}" r="1.8" fill="${color}" stroke="var(--apple-bg)" stroke-width="0.5"/>`;
    });
    // Use original series index for stable id but only show if visible
    const oi = allSeries.indexOf(series);
    seriesGroups += `<g id="cs-${oi}">${gLines}${gDots}</g>`;
  });

  // Legend (includes ALL series, hidden ones are greyed out)
  let legend = "";
  allSeries.forEach((series, idx) => {
    const isHidden = hiddenSet.has(idx);
    const color = LINE_COLORS[idx % LINE_COLORS.length];
    const label = series.name;
    const lx = 10 + (idx % 5) * 140;
    const ly = H + 14 + Math.floor(idx / 5) * 18;
    const barOpacity = isHidden ? 0.25 : 1;
    const txtOpacity = isHidden ? 0.3 : 0.85;
    const decoration = isHidden ? "line-through" : "none";
    legend += `<g data-legend="${idx}" style="cursor:pointer;">
      <rect x="${lx - 4}" y="${ly - 14}" width="130" height="22" rx="4" fill="rgba(0,0,0,0.001)"/>
      <rect class="cl-bar" x="${lx}" y="${ly - 7}" width="10" height="3" rx="1.5" fill="${color}" opacity="${barOpacity}"/>
      <text class="cl-label" x="${lx + 14}" y="${ly + 1}" fill="var(--apple-text-secondary)" font-size="11" opacity="${txtOpacity}" text-decoration="${decoration}">${label}</text>
    </g>`;
  });

  const svgH = legend ? H + 20 + Math.ceil(allSeries.length / 5) * 18 : H;

  $("pcChartSvg").innerHTML = `<svg viewBox="0 0 ${W} ${svgH}" style="width:100%;height:auto;display:block;">
    ${yGrid}
    ${zeroLine}
    ${seriesGroups}
    ${xLabels}
    ${legend}
  </svg>`;

  $("pcChartWrap").style.display = "";

  // Attach legend interactions (click on <g>, which covers bar + text + hit rect)
  allSeries.forEach((_, idx) => {
    const g = $("pcChartSvg").querySelector(`g[data-legend="${idx}"]`);
    if (!g) return;

    // Click → toggle hidden, re-render
    g.addEventListener("click", (e) => {
      e.stopPropagation();
      let newHidden;
      if (_chartHidden.includes(idx)) {
        newHidden = _chartHidden.filter((i) => i !== idx);
      } else {
        newHidden = [..._chartHidden, idx];
      }
      _chartHidden = newHidden;
      renderMultiLineChart(_chartData, _chartSymbols, _chartHidden);
    });

    // Hover → highlight only this series
    g.addEventListener("mouseenter", () => {
      const svgEl = $("pcChartSvg").querySelector("svg");
      allSeries.forEach((_, i) => {
        if (i === idx || _chartHidden.includes(i)) return;
        const g2 = svgEl.querySelector(`#cs-${i}`);
        if (g2) g2.style.opacity = "0.12";
      });
    });

    g.addEventListener("mouseleave", () => {
      const svgEl = $("pcChartSvg").querySelector("svg");
      allSeries.forEach((_, i) => {
        if (_chartHidden.includes(i)) return;
        const g2 = svgEl.querySelector(`#cs-${i}`);
        if (g2) g2.style.opacity = "1";
      });
    });
  });
}

// ─── Monthly batch view (symbols × months table for a specific year) ───

async function fetchMonthlyBatch(year) {
  showError(null);
  setLoading(true);
  table.style.display = "none";
  empty.style.display = "none";
  hideYearlySections();
  const mc = $("pcMonthlyContainer");
  if (mc) mc.innerHTML = "";
  renderMetaInfo(null);
  _lastYearlyData = null;

  try {
    const resp = await fetch(BATCH_MONTHLY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols, year }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }

    const result = await resp.json();
    setConnected(true);
    renderMonthlyTable(result);
  } catch (e) {
    setConnected(false);
    showError(`请求失败: ${e.message}`);
    empty.style.display = "block";
    table.style.display = "none";
  } finally {
    setLoading(false);
  }
}

function renderMonthlyTable(result) {
  const { year, data } = result;

  const symKeys = Object.keys(data).filter(k => data[k] && data[k].some(m => m.return !== null));
  if (symKeys.length === 0) {
    empty.innerHTML = "<div>查询完成，但未获取到有效数据</div>";
    empty.style.display = "block";
    table.style.display = "none";
    $("pcChartWrap").style.display = "none";
    return;
  }

  empty.style.display = "none";
  table.style.display = "";

  const minVal = parseFloat(minRange.value) || -50;
  const maxVal = parseFloat(maxRange.value) || 50;

  const nameLookup = {};
  for (const s of symbols) nameLookup[s.symbol] = s.name || null;

  // Transposed table: rows = months, columns = symbols
  // Header: 月份 | SYM1 | SYM2 | ...
  tableHead.innerHTML = `<th>${year}年</th>` +
    symKeys.map(sym => {
      const name = nameLookup[sym];
      return name ? `<th>${sym}<span class="pc-th-name">${name}</span></th>` : `<th>${sym}</th>`;
    }).join("");

  // Build monthMap[sym][month] = return
  const monthMap = {};
  for (const sym of symKeys) {
    monthMap[sym] = {};
    for (const m of data[sym]) {
      monthMap[sym][m.month] = m.return;
    }
  }

  // Annual return from monthly data (compounded)
  function annualReturn(months) {
    let product = 1, hasData = false;
    for (const m of months) {
      if (m.return !== null) { product *= (1 + m.return / 100); hasData = true; }
    }
    return hasData ? roundTo((product - 1) * 100, 2) : null;
  }

  const annualReturns = {};
  for (const sym of symKeys) {
    annualReturns[sym] = annualReturn(data[sym]);
  }

  // Body rows: 12 months then annual total
  const rows = [];
  for (let m = 1; m <= 12; m++) {
    let cells = `<td>${m}月</td>`;
    for (const sym of symKeys) {
      const val = monthMap[sym][m];
      const formatted = val !== null ? formatPct(val) : "—";
      const clr = val !== null ? cellColor(val, minVal, maxVal) : { bg: "transparent", text: "var(--apple-text-tertiary)" };
      cells += `<td style="background:${clr.bg};color:${clr.text};">${formatted}</td>`;
    }
    rows.push(`<tr>${cells}</tr>`);
  }

  // Annual total row (with top border to distinguish)
  let annualCells = `<td style="font-weight:600;">全年</td>`;
  for (const sym of symKeys) {
    const val = annualReturns[sym];
    const formatted = val !== null ? formatPct(val) : "—";
    const clr = val !== null ? cellColor(val, minVal, maxVal) : { bg: "transparent", text: "var(--apple-text-tertiary)" };
    annualCells += `<td style="background:${clr.bg};color:${clr.text};font-weight:600;">${formatted}</td>`;
  }
  rows.push(`<tr style="border-top:2px solid var(--apple-divider);">${annualCells}</tr>`);

  tableBody.innerHTML = rows.join("");

  // Annual note
  let note = $("pcMonthlyBatchNote");
  if (!note) {
    note = document.createElement("div");
    note.id = "pcMonthlyBatchNote";
    table.parentElement.appendChild(note);
  }
  note.style.cssText = "margin-top:8px;font-size:12px;color:var(--apple-text-tertiary);";
  note.textContent = "「全年」为各月涨跌幅复利累计值";

  // Render monthly trend chart (reset hidden state)
  _mChartHidden = [];
  renderMonthlyChart(year, symKeys, monthMap, annualReturns);
}

function renderMonthlyChart(year, symKeys, monthMap, annualReturns) {
  const nameLookup = {};
  for (const s of symbols) nameLookup[s.symbol] = s.name || s.symbol;

  const allSeries = [];
  for (const sym of symKeys) {
    const pts = [];
    for (let m = 1; m <= 12; m++) {
      const val = monthMap[sym][m];
      if (val !== null) pts.push({ month: m, value: val });
    }
    if (pts.length > 0) {
      allSeries.push({ symbol: sym, name: nameLookup[sym] || sym, points: pts });
    }
  }

  if (allSeries.length === 0) return;

  const hiddenSet = new Set(_mChartHidden);
  const visibleSeries = allSeries.filter((_, i) => !hiddenSet.has(i));

  const W = 700, H = 220, PAD = { top: 20, right: 16, bottom: 30, left: 48 };

  const allVals = [];
  visibleSeries.forEach(s => s.points.forEach(p => allVals.push(p.value)));
  if (allVals.length === 0) {
    // All hidden — show empty chart
  }
  const minVal = Math.min(...allVals, 0);
  const maxVal = Math.max(...allVals, 0);
  const range = maxVal - minVal || 1;
  const yMin = minVal - range * 0.1;
  const yMax = maxVal + range * 0.1;
  const yRange = yMax - yMin;
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;
  const xPos = (m) => PAD.left + ((m - 1) / 11) * cw;
  const yPos = (v) => PAD.top + ch - ((v - yMin) / yRange) * ch;

  // Y-axis grid
  const yTicks = 5;
  let yGrid = "";
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + (yRange * i) / yTicks;
    const y = yPos(v);
    yGrid += `<line x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}" stroke="var(--apple-divider)" stroke-width="1"/>`;
    yGrid += `<text x="${PAD.left - 6}" y="${y + 4}" text-anchor="end" fill="var(--apple-text-tertiary)" font-size="11">${v.toFixed(1)}%</text>`;
  }
  const zeroY = yPos(0);
  const zeroLine = (zeroY >= PAD.top && zeroY <= H - PAD.bottom)
    ? `<line x1="${PAD.left}" y1="${zeroY}" x2="${W - PAD.right}" y2="${zeroY}" stroke="var(--apple-text-tertiary)" stroke-width="1" stroke-dasharray="4,3" opacity="0.6"/>` : "";

  // X-axis: month labels
  let xLabels = "";
  for (let m = 1; m <= 12; m++) {
    xLabels += `<text x="${xPos(m)}" y="${H - 8}" text-anchor="middle" fill="var(--apple-text-tertiary)" font-size="11">${m}月</text>`;
  }

  // Legend — all series, hidden ones greyed out
  let legend = "";
  allSeries.forEach((series, idx) => {
    const isHidden = hiddenSet.has(idx);
    const color = LINE_COLORS[idx % LINE_COLORS.length];
    const lx = 10 + (idx % 5) * 140;
    const ly = H + 14 + Math.floor(idx / 5) * 18;
    const barOpacity = isHidden ? 0.25 : 1;
    const txtOpacity = isHidden ? 0.3 : 0.85;
    const decoration = isHidden ? "line-through" : "none";
    legend += `<g data-legend="${idx}" style="cursor:pointer;">
      <rect x="${lx - 4}" y="${ly - 14}" width="130" height="22" rx="4" fill="rgba(0,0,0,0.001)"/>
      <rect x="${lx}" y="${ly - 7}" width="10" height="3" rx="1.5" fill="${color}" opacity="${barOpacity}"/>
      <text x="${lx + 14}" y="${ly + 1}" fill="var(--apple-text-secondary)" font-size="11" opacity="${txtOpacity}" text-decoration="${decoration}">${series.name}</text>
    </g>`;
  });

  // Series groups (lines + dots), per-series for hover interaction
  let seriesGroups = "";
  visibleSeries.forEach((series, vi) => {
    const realIdx = allSeries.indexOf(series);
    const color = LINE_COLORS[vi % LINE_COLORS.length];
    let gLines = "", gDots = "";
    for (let i = 0; i < series.points.length - 1; i++) {
      const x1 = xPos(series.points[i].month), y1 = yPos(series.points[i].value);
      const x2 = xPos(series.points[i + 1].month), y2 = yPos(series.points[i + 1].value);
      gLines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5" stroke-linecap="round" opacity="0.85"/>`;
    }
    series.points.forEach(p => {
      gDots += `<circle cx="${xPos(p.month)}" cy="${yPos(p.value)}" r="2.5" fill="${color}" stroke="var(--apple-bg)" stroke-width="0.8"/>`;
    });
    seriesGroups += `<g id="ms-${realIdx}">${gLines}${gDots}</g>`;
  });

  const svgH = legend ? H + 20 + Math.ceil(allSeries.length / 5) * 18 : H;
  $("pcChartSvg").innerHTML = `<svg viewBox="0 0 ${W} ${svgH}" style="width:100%;height:auto;display:block;">
    ${yGrid} ${zeroLine} ${seriesGroups} ${xLabels} ${legend}
  </svg>`;

  // Update chart header & show
  const titleEl = document.querySelector("#pcChartWrap .pc-chart-title");
  if (titleEl) titleEl.textContent = `${year} 年月度涨跌幅走势`;
  $("pcChartWrap").style.display = "";

  // Attach legend interactions
  const svgEl = $("pcChartSvg").querySelector("svg");
  allSeries.forEach((_, idx) => {
    const g = svgEl?.querySelector(`g[data-legend="${idx}"]`);
    if (!g) return;

    g.addEventListener("click", (e) => {
      e.stopPropagation();
      _mChartHidden = _mChartHidden.includes(idx)
        ? _mChartHidden.filter(i => i !== idx)
        : [..._mChartHidden, idx];
      renderMonthlyChart(year, symKeys, monthMap, annualReturns);
    });

    g.addEventListener("mouseenter", () => {
      allSeries.forEach((_, i) => {
        if (i === idx || _mChartHidden.includes(i)) return;
        const g2 = svgEl?.querySelector(`#ms-${i}`);
        if (g2) g2.style.opacity = "0.12";
      });
    });

    g.addEventListener("mouseleave", () => {
      allSeries.forEach((_, i) => {
        if (_mChartHidden.includes(i)) return;
        const g2 = svgEl?.querySelector(`#ms-${i}`);
        if (g2) g2.style.opacity = "1";
      });
    });
  });
}

function roundTo(val, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

function getBacktestSampleSize() {
  const raw = parseInt(btSampleSize?.value, 10);
  return Number.isFinite(raw) ? Math.max(BACKTEST_MIN_SAMPLE, raw) : BACKTEST_DEFAULT_SAMPLE;
}

function getBacktestAnimMs() {
  const raw = parseFloat(btAnimSeconds?.value);
  if (!Number.isFinite(raw) || raw < 0) return 5000;
  return raw * 1000;
}

function sampleEvenly(items, maxPoints) {
  if (!Array.isArray(items) || items.length <= maxPoints) return items || [];
  const sampled = [];
  const lastIndex = items.length - 1;
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round((i * lastIndex) / Math.max(1, maxPoints - 1));
    sampled.push(items[idx]);
  }
  return sampled;
}

function updateBacktestFrequencyUI() {
  const mode = btFrequency?.value || "monthly";
  if (!btDayOfMonth || !btWeekday || !btDayOfMonthLabel || !btWeekdayLabel || !btInterval || !btAmount) return;

  if (mode === "once") {
    btInterval.style.display = "none";
    btDayOfMonth.style.display = "none";
    btDayOfMonthLabel.style.display = "none";
    btWeekday.style.display = "none";
    btWeekdayLabel.style.display = "none";
    const intervalLabel = btInterval.previousElementSibling;
    if (intervalLabel) intervalLabel.style.display = "none";
    btAmount.previousElementSibling && (btAmount.previousElementSibling.textContent = "一次性投入");
    return;
  }

  const intervalLabel = btInterval.previousElementSibling;
  if (intervalLabel) intervalLabel.style.display = "";
  btInterval.style.display = "";
  btAmount.previousElementSibling && (btAmount.previousElementSibling.textContent = "每次投入");

  if (mode === "daily") {
    btDayOfMonth.style.display = "none";
    btDayOfMonthLabel.style.display = "none";
    btWeekday.style.display = "none";
    btWeekdayLabel.style.display = "none";
    return;
  }

  if (mode === "weekly") {
    btDayOfMonth.style.display = "none";
    btDayOfMonthLabel.style.display = "none";
    btWeekday.style.display = "";
    btWeekdayLabel.style.display = "";
    btWeekdayLabel.textContent = "周几";
    return;
  }

  btDayOfMonth.style.display = "";
  btDayOfMonthLabel.style.display = "";
  btWeekday.style.display = "none";
  btWeekdayLabel.style.display = "none";
  btDayOfMonthLabel.textContent = "月内日期";
}

// ─── Monthly drilldown card (line chart + monthly grid) ───

async function fetchMonthly(symbol, type, year) {
  try {
    const resp = await fetch(MONTHLY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, type, year }),
    });
    if (!resp.ok) return;
    const result = await resp.json();
    renderMonthlyCard(symbol, type, year, result.months);
  } catch {
    // silently fail
  }
}

async function fetchDaily(symbol, type, year, month, mountEl) {
  try {
    const resp = await fetch(DAILY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, type, year, month }),
    });
    if (!resp.ok) return;
    const result = await resp.json();
    renderDailyBlock(symbol, year, month, result.days, mountEl);
  } catch {
    // silently fail
  }
}

function renderMonthlyCard(symbol, type, year, months) {
  // Build title with display name if available
  const sym = symbols.find((s) => s.symbol === symbol);
  const label = sym && sym.name ? `${symbol}(${sym.name})` : symbol;

  const container = $("pcMonthlyContainer");

  // Create card
  const card = document.createElement("div");
  card.className = "pc-monthly";

  // Header
  const header = document.createElement("div");
  header.className = "pc-monthly-header";
  const title = document.createElement("span");
  title.className = "pc-monthly-title";
  title.textContent = `${label} — ${year} 年月度涨跌幅`;
  const closeBtn = document.createElement("button");
  closeBtn.className = "pc-btn";
  closeBtn.style.cssText = "padding:4px 10px;font-size:12px;";
  closeBtn.textContent = "关闭";
  closeBtn.addEventListener("click", () => card.remove());
  header.appendChild(title);
  header.appendChild(closeBtn);
  card.appendChild(header);

  // Monthly grid
  const grid = document.createElement("div");
  grid.className = "pc-monthly-grid";
  grid.innerHTML = months
    .map((m) => {
      const val = m.return;
      const formatted = val !== null ? formatPct(val) : "—";
      const colors = val !== null ? cellColor(val, -50, 50) : { bg: "var(--apple-surface-2)", text: "var(--apple-text-tertiary)" };
      const cls = val !== null ? "pc-month-block" : "pc-month-block is-empty";
      return `<div class="${cls}" data-month="${m.month}" style="background:${colors.bg};">
        <div class="pc-month-num">${m.month}月</div>
        <div class="pc-month-val" style="color:${colors.text};">${formatted}</div>
      </div>`;
    })
    .join("");
  card.appendChild(grid);

  const dailyMount = document.createElement("div");
  dailyMount.className = "pc-daily-wrap";
  dailyMount.style.display = "none";
  card.appendChild(dailyMount);

  grid.querySelectorAll(".pc-month-block").forEach((block) => {
    if (block.classList.contains("is-empty")) return;
    block.addEventListener("click", () => {
      const month = parseInt(block.dataset.month, 10);
      fetchDaily(symbol, type, year, month, dailyMount);
    });
  });

  container.appendChild(card);

  // Scroll to the new card
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderDailyBlock(symbol, year, month, days, mountEl) {
  if (!mountEl) return;
  if (!days || days.length === 0) {
    mountEl.innerHTML = `<div class="pc-empty" style="padding:20px 0;">${symbol} ${year}-${String(month).padStart(2, "0")} 暂无日线数据</div>`;
    mountEl.style.display = "";
    return;
  }

  mountEl.innerHTML = `
    <div class="pc-monthly-header" style="margin-bottom:12px;">
      <span class="pc-monthly-title">${symbol} - ${year}年${month}月日涨跌幅</span>
    </div>
    <div class="pc-daily-grid">
      ${days.map((d) => {
        const val = d.return;
        const formatted = val !== null ? formatPct(val) : "—";
        const colors = val !== null ? cellColor(val, -20, 20) : { bg: "var(--apple-surface-2)", text: "var(--apple-text-tertiary)" };
        return `<div class="pc-daily-block" style="background:${colors.bg};">
          <div class="pc-month-num">${d.day}日</div>
          <div class="pc-month-val" style="color:${colors.text};">${formatted}</div>
          <div style="font-size:10px;color:var(--apple-text-tertiary);margin-top:4px;">${d.close}</div>
        </div>`;
      }).join("")}
    </div>
  `;
  mountEl.style.display = "";
  mountEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Table cell click → monthly drilldown
tableBody.addEventListener("click", (e) => {
  const cell = e.target.closest(".pc-cell");
  if (!cell) return;
  const { symbol, year, type } = cell.dataset;
  if (!symbol || !year) return;
  fetchMonthly(symbol, type, parseInt(year, 10));
});

function populateBacktestOptions() {
  if (!_lastYearlyData) return;
  const { years, data } = _lastYearlyData;
  if (!btAddSelect) return;

  const eligibleSymbols = symbols
    .filter((s) => data[s.symbol] && Object.keys(data[s.symbol]).length > 0)
    .map((s) => {
      const label = s.name ? `${s.symbol}(${s.name})` : s.symbol;
      return `<option value="${s.symbol}">${label}</option>`;
    })
    .join("");
  btAddSelect.innerHTML = eligibleSymbols || '<option value="">—</option>';

  const sortedYears = [...years].map(Number).sort((a, b) => a - b);
  const firstYear = sortedYears[0];
  const lastYear = sortedYears[sortedYears.length - 1];
  if (firstYear && btStartDate && !btStartDate.value) btStartDate.value = `${firstYear}-01-01`;
  if (lastYear && btEndDate && !btEndDate.value) btEndDate.value = `${lastYear}-12-31`;
}

async function runBacktest() {
  const symbol = btAddSelect?.value;
  const sym = symbols.find((s) => s.symbol === symbol);
  if (!symbol || !sym) return;

  const payload = {
    symbol,
    type: sym.type,
    initial_amount: parseFloat(btInitialAmount?.value) || 0,
    amount: parseFloat(btAmount?.value) || 0,
    start_date: btStartDate?.value,
    end_date: btEndDate?.value,
    frequency: btFrequency?.value || "monthly",
    interval: parseInt(btInterval?.value, 10) || 1,
    day_of_month: parseInt(btDayOfMonth?.value, 10) || 1,
    weekday: parseInt(btWeekday?.value, 10) || 0,
  };

  try {
    const resp = await fetch(BACKTEST_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await resp.json();
    if (!resp.ok) throw new Error(result.error || `HTTP ${resp.status}`);
    renderBacktestResult(symbol, result);
  } catch (e) {
    showError(`回测失败: ${e.message}`);
  }
}

function renderBtChart(equityCurve) {
  if (!equityCurve || equityCurve.length === 0) return;
  const sampledCurve = sampleEvenly(equityCurve, getBacktestSampleSize());

  const W = 700, H = 220, PAD = { top: 32, right: 64, bottom: 30, left: 56 };
  const assetVals = sampledCurve.map((row) => row.value);
  const investedVals = sampledCurve.map((row) => row.invested);
  const profitVals = sampledCurve.map((row) => row.value - row.invested);
  const minAssetVal = Math.min(...assetVals, 0);
  const maxAssetVal = Math.max(...assetVals, 0);
  const assetRange = maxAssetVal - minAssetVal || 1;
  const assetPad = assetRange * 0.1;
  const assetYMin = minAssetVal - assetPad;
  const assetYMax = maxAssetVal + assetPad;
  const assetYRange = assetYMax - assetYMin;
  const minProfitVal = Math.min(...profitVals, 0);
  const maxProfitVal = Math.max(...profitVals, 0);
  const profitRange = maxProfitVal - minProfitVal || 1;
  const profitPad = profitRange * 0.1;
  const profitYMin = minProfitVal - profitPad;
  const profitYMax = maxProfitVal + profitPad;
  const profitYRange = profitYMax - profitYMin;
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;
  const xPos = (idx) => PAD.left + (idx / Math.max(1, sampledCurve.length - 1)) * cw;
  const assetYPos = (v) => PAD.top + ch - ((v - assetYMin) / assetYRange) * ch;
  const profitYPos = (v) => PAD.top + ch - ((v - profitYMin) / profitYRange) * ch;

  // Left Y-axis: total assets
  const yTicks = 5;
  let yGrid = "";
  for (let i = 0; i <= yTicks; i++) {
    const v = assetYMin + (assetYRange * i) / yTicks;
    const y = assetYPos(v);
    yGrid += `<line x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}" stroke="var(--apple-divider)" stroke-width="1"/>`;
    const label = v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`;
    yGrid += `<text x="${PAD.left - 6}" y="${y + 4}" text-anchor="end" fill="var(--apple-text-tertiary)" font-size="11">${label}</text>`;
  }

  let rightAxis = "";
  for (let i = 0; i <= yTicks; i++) {
    const v = profitYMin + (profitYRange * i) / yTicks;
    const y = profitYPos(v);
    rightAxis += `<text x="${W - PAD.right + 8}" y="${y + 4}" text-anchor="start" fill="#30d158" font-size="11">${v >= 0 ? "+" : ""}$${v.toFixed(0)}</text>`;
  }

  const zeroY = assetYPos(0);
  const zeroLine = (zeroY >= PAD.top && zeroY <= H - PAD.bottom)
    ? `<line x1="${PAD.left}" y1="${zeroY}" x2="${W - PAD.right}" y2="${zeroY}" stroke="var(--apple-text-tertiary)" stroke-width="1" stroke-dasharray="4,3" opacity="0.6"/>`
    : "";

  // X-axis labels
  let xLabels = "";
  if (sampledCurve.length > 1) {
    const step = Math.max(1, Math.floor(sampledCurve.length / 8));
    for (let i = 0; i < sampledCurve.length; i++) {
      if (i % step === 0 || i === sampledCurve.length - 1)
        xLabels += `<text x="${xPos(i)}" y="${H - 8}" text-anchor="middle" fill="var(--apple-text-tertiary)" font-size="11">${sampledCurve[i].date.slice(2)}</text>`;
    }
  }

  let investedLine = "";
  let assetLines = "", assetDots = "", profitDots = "";
  const profitPolylinePoints = [];
  for (let i = 0; i < sampledCurve.length - 1; i++) {
    const x1 = xPos(i), x2 = xPos(i + 1);
    const assetY1 = assetYPos(sampledCurve[i].value), assetY2 = assetYPos(sampledCurve[i + 1].value);
    const profitY1 = profitYPos(sampledCurve[i].value - sampledCurve[i].invested), profitY2 = profitYPos(sampledCurve[i + 1].value - sampledCurve[i + 1].invested);
    const investedY1 = assetYPos(sampledCurve[i].invested), investedY2 = assetYPos(sampledCurve[i + 1].invested);
    assetLines += `<line x1="${x1}" y1="${assetY1}" x2="${x2}" y2="${assetY2}" stroke="#2997ff" stroke-width="1.5" stroke-linecap="round" opacity="0.9"/>`;
    investedLine += `<line x1="${x1}" y1="${investedY1}" x2="${x2}" y2="${investedY2}" stroke="rgba(255,255,255,0.55)" stroke-width="1.2" stroke-linecap="round" opacity="0.9"/>`;
  }
  sampledCurve.forEach((row, idx) => {
    profitPolylinePoints.push({ x: xPos(idx), y: profitYPos(row.value - row.invested), profit: row.value - row.invested });
    assetDots += `<circle cx="${xPos(idx)}" cy="${assetYPos(row.value)}" r="2.2" fill="#2997ff" stroke="var(--apple-bg)" stroke-width="0.8"/>`;
    profitDots += `<circle cx="${xPos(idx)}" cy="${profitYPos(row.value - row.invested)}" r="2.2" fill="#30d158" stroke="var(--apple-bg)" stroke-width="0.8"/>`;
  });

  function buildAreaSegments(points) {
    if (points.length < 2) return "";
    const zero = profitYPos(0);
    const positiveSegments = [];
    const negativeSegments = [];

    const addSegment = (target, p1, p2) => {
      target.push(`M ${p1.x} ${zero}`);
      target.push(`L ${p1.x} ${p1.y}`);
      target.push(`L ${p2.x} ${p2.y}`);
      target.push(`L ${p2.x} ${zero}`);
      target.push("Z");
    };

    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      if ((p1.profit >= 0 && p2.profit >= 0)) {
        addSegment(positiveSegments, p1, p2);
        continue;
      }
      if ((p1.profit <= 0 && p2.profit <= 0)) {
        addSegment(negativeSegments, p1, p2);
        continue;
      }
      const ratio = (0 - p1.profit) / (p2.profit - p1.profit);
      const crossX = p1.x + (p2.x - p1.x) * ratio;
      const crossPoint = { x: crossX, y: zero, profit: 0 };
      if (p1.profit > 0) {
        addSegment(positiveSegments, p1, crossPoint);
        addSegment(negativeSegments, crossPoint, p2);
      } else {
        addSegment(negativeSegments, p1, crossPoint);
        addSegment(positiveSegments, crossPoint, p2);
      }
    }

    const positive = positiveSegments.length
      ? `<path d="${positiveSegments.join(" ")}" fill="rgba(48,209,88,0.22)" stroke="none"/>`
      : "";
    const negative = negativeSegments.length
      ? `<path d="${negativeSegments.join(" ")}" fill="rgba(255,69,58,0.18)" stroke="none"/>`
      : "";
    const stroke = points.length
      ? `<polyline points="${points.map((p) => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="rgba(48,209,88,0.88)" stroke-width="1.2"/>`
      : "";
    return `${positive}${negative}${stroke}`;
  }

  const profitAreaPath = buildAreaSegments(profitPolylinePoints);

  const legend = `
    <rect x="${PAD.left}" y="14" width="8" height="2.5" rx="1.25" fill="#2997ff"/>
    <text x="${PAD.left + 12}" y="17" fill="var(--apple-text-secondary)" font-size="10">总资产</text>
    <rect x="${PAD.left + 60}" y="14" width="8" height="2.5" rx="1.25" fill="rgba(255,255,255,0.55)"/>
    <text x="${PAD.left + 72}" y="17" fill="var(--apple-text-secondary)" font-size="10">累计投入</text>
    <rect x="${PAD.left + 136}" y="11" width="8" height="8" rx="1.5" fill="rgba(48,209,88,0.22)" stroke="rgba(48,209,88,0.88)"/>
    <text x="${PAD.left + 148}" y="17" fill="var(--apple-text-secondary)" font-size="10">总收益</text>
  `;

  const hoverZones = sampledCurve.map((row, idx) => {
    const profit = row.value - row.invested;
    return `<rect
      class="bt-hover-zone"
      data-date="${row.date}"
      data-value="${row.value}"
      data-invested="${row.invested}"
      data-profit="${profit}"
      x="${Math.max(PAD.left, xPos(idx) - 8)}"
      y="${PAD.top}"
      width="16"
      height="${ch}"
      fill="transparent"
      style="cursor:crosshair;"
    />`;
  }).join("");

  const tooltip = `
    <g id="btTooltip" style="display:none;pointer-events:none;">
      <line id="btTooltipGuide" x1="0" y1="${PAD.top}" x2="0" y2="${PAD.top + ch}" stroke="rgba(255,255,255,0.18)" stroke-width="1" stroke-dasharray="4,3"/>
      <rect id="btTooltipBg" x="0" y="0" width="168" height="88" rx="8" fill="rgba(24,24,26,0.96)" stroke="rgba(255,255,255,0.12)"/>
      <text id="btTooltipDate" x="10" y="16" fill="#fff" font-size="11"></text>
      <text id="btTooltipAsset" x="10" y="32" fill="#2997ff" font-size="11"></text>
      <text id="btTooltipInvested" x="10" y="48" fill="var(--apple-text-secondary)" font-size="11"></text>
      <text id="btTooltipProfit" x="10" y="64" fill="#30d158" font-size="11"></text>
      <text id="btTooltipReturn" x="10" y="80" fill="#fff" font-size="11"></text>
    </g>
  `;

  const svgH = H;
  const animatedLayer = `
    <g id="btAnimatedLayer" clip-path="url(#btChartReveal)">
      ${profitAreaPath}
      ${investedLine}
      ${assetLines}
      ${assetDots}
      ${profitDots}
    </g>
  `;
  $("btChart").innerHTML = `<svg viewBox="0 0 ${W} ${svgH}" style="width:100%;height:auto;display:block;">
    <defs>
      <clipPath id="btChartReveal">
        <rect id="btChartRevealRect" x="0" y="0" width="0" height="${H}"></rect>
      </clipPath>
    </defs>
    ${yGrid} ${rightAxis} ${zeroLine} ${animatedLayer} ${xLabels} ${legend} ${hoverZones} ${tooltip}
  </svg>`;

  const svgEl = $("btChart").querySelector("svg");
  const revealRect = svgEl?.querySelector("#btChartRevealRect");
  const tooltipEl = svgEl?.querySelector("#btTooltip");
  const tooltipGuide = svgEl?.querySelector("#btTooltipGuide");
  const tooltipBg = svgEl?.querySelector("#btTooltipBg");
  const tooltipDate = svgEl?.querySelector("#btTooltipDate");
  const tooltipAsset = svgEl?.querySelector("#btTooltipAsset");
  const tooltipInvested = svgEl?.querySelector("#btTooltipInvested");
  const tooltipProfit = svgEl?.querySelector("#btTooltipProfit");
  const tooltipReturn = svgEl?.querySelector("#btTooltipReturn");

  svgEl?.querySelectorAll(".bt-hover-zone").forEach((zone) => {
    zone.addEventListener("mouseenter", () => {
      const x = parseFloat(zone.getAttribute("x") || "0");
      const value = parseFloat(zone.dataset.value || "0");
      const invested = parseFloat(zone.dataset.invested || "0");
      const profit = parseFloat(zone.dataset.profit || "0");
      const returnPct = invested === 0 ? 0 : (profit / invested) * 100;
      const tooltipX = Math.min(Math.max(x + 10, PAD.left), W - PAD.right - 160);
      const tooltipY = PAD.top + 8;
      if (tooltipEl) tooltipEl.setAttribute("transform", `translate(${tooltipX}, ${tooltipY})`);
      if (tooltipGuide) {
        const guideX = x + 8;
        tooltipGuide.setAttribute("x1", String(guideX));
        tooltipGuide.setAttribute("x2", String(guideX));
      }
      if (tooltipDate) tooltipDate.textContent = zone.dataset.date || "";
      if (tooltipAsset) tooltipAsset.textContent = `总资产: $${value.toFixed(2)}`;
      if (tooltipInvested) tooltipInvested.textContent = `累计投入: $${invested.toFixed(2)}`;
      if (tooltipProfit) {
        tooltipProfit.textContent = `总收益: ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)}`;
        tooltipProfit.setAttribute("fill", profit >= 0 ? "#30d158" : "#ff453a");
      }
      if (tooltipReturn) tooltipReturn.textContent = `回报率: ${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(2)}%`;
      if (tooltipBg) tooltipBg.setAttribute("height", "88");
      if (tooltipEl) tooltipEl.style.display = "";
    });
    zone.addEventListener("mouseleave", () => {
      if (tooltipEl) tooltipEl.style.display = "none";
    });
  });

  const durationMs = getBacktestAnimMs();
  if (revealRect) {
    if (durationMs <= 0) {
      revealRect.setAttribute("width", String(W));
    } else {
      revealRect.setAttribute("width", "0");
      const start = performance.now();
      const tick = (now) => {
        const progress = Math.min((now - start) / durationMs, 1);
        revealRect.setAttribute("width", String(W * progress));
        if (progress < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  }
}

function renderBacktestResult(symbol, result) {
  const summary = result.summary || {};
  renderBtChart(result.equity_curve || []);
  const maxPoints = getBacktestSampleSize();
  const sampledCashflows = sampleEvenly(result.cashflows || [], getBacktestSampleSize());
  const equityByDate = Object.fromEntries((result.equity_curve || []).map((row) => [row.date, row]));

  btSummary.innerHTML = `
    <div class="pc-bt-summary-item">
      <div class="pc-bt-summary-label">${symbol}</div>
      <div class="pc-bt-summary-val ${summary.profit >= 0 ? "bt-val-positive" : "bt-val-negative"}">$${(summary.final_value || 0).toFixed(2)}</div>
    </div>
    <div class="pc-bt-summary-item">
      <div class="pc-bt-summary-label">累计投入</div>
      <div class="pc-bt-summary-val">$${(summary.invested || 0).toFixed(2)}</div>
    </div>
    <div class="pc-bt-summary-item">
      <div class="pc-bt-summary-label">收益</div>
      <div class="pc-bt-summary-val ${summary.profit >= 0 ? "bt-val-positive" : "bt-val-negative"}">${summary.profit >= 0 ? "+" : ""}$${(summary.profit || 0).toFixed(2)} (${summary.return_pct >= 0 ? "+" : ""}${(summary.return_pct || 0).toFixed(2)}%)</div>
    </div>
    <div class="pc-bt-summary-item">
      <div class="pc-bt-summary-label">年化</div>
      <div class="pc-bt-summary-val">${summary.annualized_return_pct >= 0 ? "+" : ""}${(summary.annualized_return_pct || 0).toFixed(2)}%</div>
    </div>
    <div class="pc-bt-summary-item">
      <div class="pc-bt-summary-label">显示条数</div>
      <div class="pc-bt-summary-val">${Math.min((result.equity_curve || []).length, maxPoints)} / ${(result.equity_curve || []).length}</div>
    </div>
  `;

  btHead.innerHTML = "<th>日期</th><th>投入</th><th>成交价</th><th>买入份额</th><th>累计份额</th><th>当前总收益</th>";
  btBody.innerHTML = sampledCashflows.map((row) => `
    <tr>
      <td>${row.date}</td>
      <td>$${(row.amount || 0).toFixed(2)}</td>
      <td>${row.price}</td>
      <td>${row.units}</td>
      <td>${row.cum_units}</td>
      <td class="${((equityByDate[row.date]?.value || 0) - (equityByDate[row.date]?.invested || 0)) >= 0 ? "bt-val-positive" : "bt-val-negative"}">
        ${(() => {
          const point = equityByDate[row.date];
          if (!point) return "—";
          const profit = point.value - point.invested;
          return `${profit >= 0 ? "+" : ""}$${profit.toFixed(2)}`;
        })()}
      </td>
    </tr>
  `).join("");

  if (btResult) btResult.style.display = "";
  if (btWrap) btWrap.style.display = "";
}

// ─── Init ───

async function init() {
  // Load config (presets + color range)
  const cfg = await loadConfigFromServer();
  PRESETS = cfg.presets;
  minRange.value = cfg.colorRange.min;
  maxRange.value = cfg.colorRange.max;

  // Add button
  addBtn.addEventListener("click", () => {
    addSymbol(symInput.value, typeSelect.value);
  });

  symInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addSymbol(symInput.value, typeSelect.value);
  });

  clearBtn.addEventListener("click", () => {
    symbols = [];
    renderTags();
    const mc = $("pcMonthlyContainer");
    if (mc) mc.innerHTML = "";
    $("pcChartWrap").style.display = "none";
    _chartData = null;
    _chartSymbols = null;
    _chartHidden = [];
    _lastYearlyData = null;
    if (yearSelect) yearSelect.value = "";
    renderMetaInfo(null);
    table.style.display = "none";
    empty.style.display = "block";
  });

  refreshBtn.addEventListener("click", fetchData);

  // Chart close button
  $("pcChartClose").addEventListener("click", () => {
    $("pcChartWrap").style.display = "none";
  });

  // Backtest buttons
  if (btRun) btRun.addEventListener("click", runBacktest);
  if (btFrequency) btFrequency.addEventListener("change", updateBacktestFrequencyUI);
  if (btClose) btClose.addEventListener("click", () => {
    btWrap.style.display = "none";
    btResult.style.display = "none";
  });

  // Populate year options and set default
  populateYearOptions();

  // Year select: Enter triggers query, Escape reverts to "历年汇总"
  if (yearSelect) {
    yearSelect.addEventListener("keydown", (e) => {
      if (e.key === "Enter") fetchData();
      if (e.key === "Escape") { yearSelect.value = ""; fetchData(); }
    });
  }

  // Render preset chips after loading presets
  renderPresetChips();
  updateBacktestFrequencyUI();

  const today = new Date().toISOString().slice(0, 10);
  if (btEndDate && !btEndDate.value) btEndDate.value = today;

  // Enter key also triggers search in min/max fields
  minRange.addEventListener("keydown", (e) => { if (e.key === "Enter") fetchData(); });
  maxRange.addEventListener("keydown", (e) => { if (e.key === "Enter") fetchData(); });

  // Check backend health
  fetch(`${API_BASE}/api/health`)
    .then((r) => r.ok && setConnected(true))
    .catch(() => setConnected(false));
}

document.addEventListener("DOMContentLoaded", init);
