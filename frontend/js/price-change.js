/**
 * Yearly price change tracker — heatmap table.
 *
 * Features:
 *   - Add/remove symbols (stock or crypto)
 *   - Preset symbol groups loaded from backend config
 *   - Configurable color range (min/max %)
 *   - Red/green background shading proportional to magnitude
 */

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

function roundTo(val, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
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

  // Repopulate the backtest symbol dropdown each time the 回测 tab opens, since
  // symbols may have been added/removed in the 历年涨跌幅 tab and the backtest
  // no longer depends on a prior yearly query.
  document.querySelectorAll('.tab-btn[data-tab="backtest"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      try { populateBacktestOptions(); } catch (e) { console.error("bt opt fail:", e); }
    });
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
