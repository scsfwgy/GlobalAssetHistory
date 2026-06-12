/** Backtest controls, chart, and result table. */

function getChartColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    invested: s.getPropertyValue('--apple-chart-invested').trim() || 'rgba(255,255,255,0.55)',
    guide: s.getPropertyValue('--apple-chart-guide').trim() || 'rgba(255,255,255,0.18)',
    tooltipBg: s.getPropertyValue('--apple-tooltip-bg').trim() || 'rgba(24,24,26,0.96)',
    tooltipBorder: s.getPropertyValue('--apple-tooltip-border').trim() || 'rgba(255,255,255,0.12)',
    tooltipText: s.getPropertyValue('--apple-tooltip-text').trim() || '#fff',
  };
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

  if (mode === "yearly") {
    // yearly: interval is useful (every-N-years), but day-of-month/weekday are not
    const intervalLabel = btInterval.previousElementSibling;
    if (intervalLabel) intervalLabel.style.display = "";
    btInterval.style.display = "";
    btDayOfMonth.style.display = "none";
    btDayOfMonthLabel.style.display = "none";
    btWeekday.style.display = "none";
    btWeekdayLabel.style.display = "none";
    btAmount.previousElementSibling && (btAmount.previousElementSibling.textContent = "每次投入");
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

function populateBacktestOptions() {
  // Default the date range from yearly data when available.
  // The backtest symbol is a free-text input — no dependency on presets.
  if (_lastYearlyData && _lastYearlyData.years) {
    const sortedYears = [..._lastYearlyData.years].map(Number).sort((a, b) => a - b);
    const firstYear = sortedYears[0];
    const lastYear = sortedYears[sortedYears.length - 1];
    if (firstYear && btStartDate && !btStartDate.value) btStartDate.value = `${firstYear}-01-01`;
    if (lastYear && btEndDate && !btEndDate.value) btEndDate.value = `${lastYear}-12-31`;
  }
}

async function runBacktest() {
  const symbol = (btSymbolInput?.value || "").trim().toUpperCase();
  const assetType = btTypeSelect?.value || "stock";
  if (!symbol) {
    showError("请输入定投标的代码");
    return;
  }

  const payload = {
    symbol,
    type: assetType,
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
  const c = getChartColors();
  const sampledCurve = sampleEvenly(equityCurve, getBacktestSampleSize());

  const W = 700, H = 220, PAD = { top: 32, right: 64, bottom: 30, left: 56 };
  const assetVals = sampledCurve.map((row) => row.value);
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
    investedLine += `<line x1="${x1}" y1="${investedY1}" x2="${x2}" y2="${investedY2}" stroke="${c.invested}" stroke-width="1.2" stroke-linecap="round" opacity="0.9"/>`;
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
    <rect x="${PAD.left + 60}" y="14" width="8" height="2.5" rx="1.25" fill="${c.invested}"/>
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
      <line id="btTooltipGuide" x1="0" y1="${PAD.top}" x2="0" y2="${PAD.top + ch}" stroke="${c.guide}" stroke-width="1" stroke-dasharray="4,3"/>
      <rect id="btTooltipBg" x="0" y="0" width="168" height="88" rx="8" fill="${c.tooltipBg}" stroke="${c.tooltipBorder}"/>
      <text id="btTooltipDate" x="10" y="16" fill="${c.tooltipText}" font-size="11"></text>
      <text id="btTooltipAsset" x="10" y="32" fill="#2997ff" font-size="11"></text>
      <text id="btTooltipInvested" x="10" y="48" fill="var(--apple-text-secondary)" font-size="11"></text>
      <text id="btTooltipProfit" x="10" y="64" fill="#30d158" font-size="11"></text>
      <text id="btTooltipReturn" x="10" y="80" fill="${c.tooltipText}" font-size="11"></text>
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
      <div class="pc-bt-summary-label has-tip" title="IRR年化是资金加权年化收益率：按每一笔投入的实际成交日期计算现金流，期末资产作为最终回收金额。它比一次性买入CAGR更适合定投回测。">IRR年化</div>
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

// ─── Advanced toggle ───
(function () {
  var advCheckbox = document.getElementById("pcBtAdvanced");
  if (!advCheckbox) return;
  advCheckbox.addEventListener("change", function () {
    var show = this.checked;
    document.querySelectorAll(".pc-bt-advanced").forEach(function (el) {
      if (show) {
        el.classList.add("show");
      } else {
        el.classList.remove("show");
      }
    });
  });
})();
