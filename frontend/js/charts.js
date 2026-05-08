/** SVG chart renderers for yearly and monthly trend views. */

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
