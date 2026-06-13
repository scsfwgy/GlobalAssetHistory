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
let _sortBy = null; // symbol key currently sorted (null = default year desc)
let _sortDir = "desc"; // "asc" or "desc"
let _lastFetchTime = null; // Date.now() of last successful data fetch
let _lastFetchFn = null; // retry callback for the most recent fetch
const STORAGE_KEY = "gah_state";

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
const statusText = $("settingsConnLabel");

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
const btSymbolInput = $("btSymbolInput");
const btTypeSelect = $("btTypeSelect");
const btRun = $("pcBtRun");
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
  statusText.style.cursor = ok ? "pointer" : "default";
  statusText.style.color = ok ? "var(--apple-blue)" : "";
  statusText.title = ok ? "查看系统健康度" : "";
  statusText.onclick = ok ? function () { location.href = "/health.html"; } : null;
}

// ─── Error / Loading ───

function showError(msg, retryFn) {
  error.style.display = msg ? "block" : "none";
  if (!msg) return;
  var html = escapeHtml(msg);
  if (retryFn) {
    html += ' <button class="pc-error-retry" id="pcErrorRetry">重试</button>';
  }
  error.innerHTML = html;
  if (retryFn) {
    var btn = error.querySelector("#pcErrorRetry");
    if (btn) btn.addEventListener("click", retryFn);
  }
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
      saveState();
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
  _lastFetchFn = fetchData; // store for retry

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
    _lastFetchTime = Date.now();
    saveState();
    updateFreshness();
    renderMetaInfo(result.meta);
    try {
      renderTable(result);
    } catch (renderErr) {
      console.error("renderTable error:", renderErr);
      showError(`渲染失败: ${renderErr.message}`, fetchData);
    }
  } catch (e) {
    setConnected(false);
    showError(`请求失败: ${e.message}`, fetchData);
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

  // Sort indicator arrow
  function sortArrow(sym) {
    if (_sortBy !== sym) return '<span class="pc-sort-arrow" style="color:var(--apple-text-tertiary);">▼</span>';
    return _sortDir === "desc"
      ? '<span class="pc-sort-arrow active">▼</span>'
      : '<span class="pc-sort-arrow active">▲</span>';
  }

  // Render header — clickable symbol columns for sorting
  tableHead.innerHTML =
    `<th>年份</th>` +
    symKeys.map((s) => {
      const name = nameLookup[s];
      const arrow = sortArrow(s);
      return name
        ? `<th class="pc-sortable-th" data-sort-sym="${s}" style="cursor:pointer;">${s}${arrow}<span class="pc-th-name">${name}</span></th>`
        : `<th class="pc-sortable-th" data-sort-sym="${s}" style="cursor:pointer;">${s}${arrow}</th>`;
    }).join("");

  // Sort years if a column is selected, otherwise keep API order (descending)
  let sortedYears = [...years];
  if (_sortBy && symKeys.includes(_sortBy)) {
    sortedYears.sort((a, b) => {
      const va = data[_sortBy]?.[a];
      const vb = data[_sortBy]?.[b];
      // nulls always sort to the end regardless of direction
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return _sortDir === "desc" ? vb - va : va - vb;
    });
  }

  // Render body
  tableBody.innerHTML = sortedYears
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

  // Bind sort click handlers
  tableHead.querySelectorAll(".pc-sortable-th").forEach((th) => {
    th.addEventListener("click", () => {
      const sym = th.dataset.sortSym;
      if (_sortBy === sym) {
        _sortDir = _sortDir === "desc" ? "asc" : "desc";
      } else {
        _sortBy = sym;
        _sortDir = "desc";
      }
      renderTable({ years, data }); // re-render with sort
    });
  });

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
  _sortBy = null; _sortDir = "desc";
  renderTags();
  saveState();
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
  _lastFetchFn = function () { fetchMonthlyBatch(year); };

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
    _lastFetchTime = Date.now();
    saveState();
    updateFreshness();
    renderMonthlyTable(result);
  } catch (e) {
    setConnected(false);
    showError(`请求失败: ${e.message}`, function () { fetchMonthlyBatch(year); });
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

// ─── State persistence (localStorage) ───

function saveState() {
  try {
    var state = {
      symbols: symbols.map(function (s) { return { symbol: s.symbol, type: s.type, name: s.name || null }; }),
      minRange: minRange.value,
      maxRange: maxRange.value,
      selectedYear: yearSelect ? yearSelect.value : "",
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (_) { /* quota exceeded or private browsing — silently ignore */ }
}

function restoreState() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    var state = JSON.parse(raw);
    if (state.symbols && Array.isArray(state.symbols)) {
      symbols = state.symbols;
    }
    if (state.minRange != null) minRange.value = state.minRange;
    if (state.maxRange != null) maxRange.value = state.maxRange;
    if (state.selectedYear && yearSelect) yearSelect.value = state.selectedYear;
    return symbols.length > 0;
  } catch (_) {
    return false;
  }
}

// ─── Data freshness indicator ───

function updateFreshness() {
  var el = document.getElementById("pcFreshness");
  if (!el) return;
  if (!_lastFetchTime) { el.style.display = "none"; return; }
  var diffMs = Date.now() - _lastFetchTime;
  var diffMin = Math.floor(diffMs / 60000);
  var text;
  if (diffMin < 1) text = "刚刚更新";
  else if (diffMin < 60) text = diffMin + " 分钟前更新";
  else { var hrs = Math.floor(diffMin / 60); text = hrs + " 小时前更新"; }
  el.textContent = "· " + text;
  el.className = "pc-freshness" + (diffMin > 30 ? " stale" : "");
  el.style.display = "";
}

// ─── CSV export ───

function exportCSV() {
  if (!_lastYearlyData || !_lastYearlyData.years || !_lastYearlyData.data) return;
  var data = _lastYearlyData.data;
  var years = _lastYearlyData.years;

  // Determine active symbols
  var activeSymbols = symbols.filter(function (s) {
    var d = data[s.symbol];
    return d && Object.keys(d).length > 0;
  });
  if (activeSymbols.length === 0) return;

  var symKeys = activeSymbols.map(function (s) { return s.symbol; });

  // Build CSV: BOM for Excel Chinese compatibility
  var rows = [];
  rows.push("年份," + symKeys.join(","));

  years.forEach(function (year) {
    var cells = [String(year)];
    symKeys.forEach(function (sym) {
      var val = data[sym] && data[sym][year];
      cells.push(val != null ? val.toFixed(2) : "");
    });
    rows.push(cells.join(","));
  });

  var csv = "﻿" + rows.join("\n");
  var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = "涨跌幅数据.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Init ───

async function init() {
  // Load config (presets + color range)
  const cfg = await loadConfigFromServer();
  PRESETS = cfg.presets;

  // Restore previous state from localStorage (before applying config defaults)
  var hadState = restoreState();
  // Only apply config defaults for fields NOT restored
  if (!hadState) {
    minRange.value = cfg.colorRange.min;
    maxRange.value = cfg.colorRange.max;
  }

  // CSV export button
  var csvBtn = $("pcExportCsv");
  if (csvBtn) csvBtn.addEventListener("click", exportCSV);

  // Auto-refresh if state was restored
  if (hadState) {
    renderTags();
    fetchData();
  }

  // Add button
  addBtn.addEventListener("click", () => {
    addSymbol(symInput.value, typeSelect.value);
    saveState();
  });

  symInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { addSymbol(symInput.value, typeSelect.value); saveState(); }
  });

  clearBtn.addEventListener("click", () => {
    symbols = [];
    renderTags();
    _sortBy = null; _sortDir = "desc";
    _lastFetchTime = null;
    saveState();
    updateFreshness();
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

  // Repopulate the backtest symbol dropdown each time the 回测 tab opens, since
  // symbols may have been added/removed in the 历年涨跌幅 tab and the backtest
  // no longer depends on a prior yearly query.
  document.querySelectorAll('.tab-btn[data-tab="backtest"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      // Ensure backtest container is visible (yearly fetchData may have hidden it)
      if (btWrap) btWrap.style.display = "";
      if (btResult) btResult.style.display = "";
      try { populateBacktestOptions(); } catch (e) { console.error("bt opt fail:", e); }
    });
  });

  // Populate year options and set default
  populateYearOptions();

  // Year select: Enter triggers query, Escape reverts to "历年汇总"
  if (yearSelect) {
    yearSelect.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { saveState(); fetchData(); }
      if (e.key === "Escape") { yearSelect.value = ""; saveState(); fetchData(); }
    });
    yearSelect.addEventListener("change", () => { saveState(); });
  }

  // Render preset chips after loading presets
  renderPresetChips();
  updateBacktestFrequencyUI();

  const today = new Date().toISOString().slice(0, 10);
  if (btEndDate && !btEndDate.value) btEndDate.value = today;

  // Enter key also triggers search in min/max fields; save on blur
  minRange.addEventListener("keydown", (e) => { if (e.key === "Enter") fetchData(); });
  maxRange.addEventListener("keydown", (e) => { if (e.key === "Enter") fetchData(); });
  minRange.addEventListener("change", saveState);
  maxRange.addEventListener("change", saveState);

  // Check backend health
  fetch(`${API_BASE}/api/health`)
    .then((r) => r.ok && setConnected(true))
    .catch(() => setConnected(false));

  // ── Symbol quick buttons (preset shortcuts) ──
  var QUICK_PRESET_KEYS = {
    stock: ['core_us_etf', 'aggressive_us_etf', 'hot_us_stocks'],
    cn_stock: ['cn_index', 'cn_etf_nasdaq100', 'cn_etf_sp500', 'cn_etf_others'],
    crypto: ['hot_crypto']
  };

  function renderSymbolQuick(containerId, type, targetInputId) {
    var container = document.getElementById(containerId);
    if (!container) return;
    var presetKeys = QUICK_PRESET_KEYS[type] || [];
    var html = '';
    presetKeys.forEach(function (key) {
      var preset = PRESETS.find(function (p) { return p.key === key; });
      if (!preset) return;
      html += '<button class="pc-symbol-quick-chip" data-preset-key="' + key + '">' + preset.label + '</button>';
    });
    container.innerHTML = html;

    // Click handler
    container.querySelectorAll('.pc-symbol-quick-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var pKey = this.dataset.presetKey;
        var preset = PRESETS.find(function (p) { return p.key === pKey; });
        if (!preset || !preset.symbols) return;
        if (targetInputId === 'pcSymbolInput') {
          // Main page: add all symbols from the preset
          preset.symbols.forEach(function (s) {
            addSymbol(s.symbol, s.type);
          });
        } else {
          // Backtest / crash: fill the input with the first symbol
          var input = document.getElementById(targetInputId);
          if (input && preset.symbols.length > 0) {
            input.value = preset.symbols[0].symbol;
            input.focus();
          }
        }
      });
    });
  }

  // Init quick buttons
  if (document.getElementById('pcSymbolQuick')) {
    renderSymbolQuick('pcSymbolQuick', 'stock', 'pcSymbolInput');
    var pcTypeSel = document.getElementById('pcTypeSelect');
    if (pcTypeSel) {
      pcTypeSel.addEventListener('change', function () {
        renderSymbolQuick('pcSymbolQuick', pcTypeSel.value, 'pcSymbolInput');
      });
    }
  }

  // ── Autocomplete: build search index from all presets ──
  var _acIndex = [];
  var _acSeen = {};
  (PRESETS || []).forEach(function (p) {
    (p.symbols || []).forEach(function (s) {
      var key = s.symbol + '|' + s.type;
      if (_acSeen[key]) return;
      _acSeen[key] = true;
      _acIndex.push({ code: s.symbol, name: s.name || '', type: s.type });
    });
  });

  function _acFilter(query) {
    var q = query.trim().toLowerCase();
    if (!q) return [];
    return _acIndex.filter(function (s) {
      return s.code.toLowerCase().indexOf(q) !== -1 ||
             (s.name && s.name.toLowerCase().indexOf(q) !== -1);
    }).slice(0, 10);
  }

  function _acRenderDrop(items) {
    if (!items.length) return '';
    return items.map(function (it, i) {
      var label = it.name ? '<span class="ac-name">' + it.name + '</span>' : '';
      return '<div class="pc-ac-item" data-idx="' + i + '">' +
             '<span class="ac-code">' + it.code + '</span>' + label +
             '</div>';
    }).join('');
  }

  function attachAutocomplete(inputEl, typeEl) {
    if (!inputEl) return;
    var wrap = document.createElement('span');
    wrap.style.position = 'relative';
    inputEl.parentNode.insertBefore(wrap, inputEl);
    wrap.appendChild(inputEl);

    var drop = document.createElement('div');
    drop.className = 'pc-ac-dropdown';
    wrap.appendChild(drop);

    var items = [], activeIdx = -1;

    function showDropdown() {
      var q = inputEl.value || '';
      items = _acFilter(q);
      drop.innerHTML = _acRenderDrop(items);
      activeIdx = -1;
      drop.style.display = items.length ? 'block' : 'none';
    }

    function selectItem(it) {
      inputEl.value = it.code;
      if (typeEl) typeEl.value = it.type;
      drop.style.display = 'none';
      if (inputEl.id === 'pcSymbolInput' && typeof addSymbol === 'function') {
        addSymbol(it.code, it.type);
      }
    }

    inputEl.addEventListener('input', showDropdown);
    inputEl.addEventListener('focus', showDropdown);

    inputEl.addEventListener('keydown', function (e) {
      if (!items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); _acHighlight(drop, activeIdx); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); _acHighlight(drop, activeIdx); }
      else if (e.key === 'Enter' && activeIdx >= 0) { e.preventDefault(); selectItem(items[activeIdx]); }
      else if (e.key === 'Escape') { drop.style.display = 'none'; }
    });

    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) drop.style.display = 'none';
    });

    drop.addEventListener('click', function (e) {
      var el = e.target.closest('.pc-ac-item');
      if (el) { selectItem(items[parseInt(el.dataset.idx, 10)]); }
    });
  }

  function _acHighlight(drop, idx) {
    drop.querySelectorAll('.pc-ac-item').forEach(function (el, i) {
      el.classList.toggle('active', i === idx);
    });
  }

  // Bind autocomplete
  attachAutocomplete(document.getElementById('pcSymbolInput'), document.getElementById('pcTypeSelect'));
  attachAutocomplete(document.getElementById('btSymbolInput'), document.getElementById('btTypeSelect'));
  attachAutocomplete(document.getElementById('crashSymbol'), document.getElementById('crashType'));
}

document.addEventListener("DOMContentLoaded", init);
