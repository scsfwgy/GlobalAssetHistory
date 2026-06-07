/** Crash statistics — detect big single-day drops, recovery metrics, and charts. */

(function () {
    /* ── DOM refs ── */
    const btnRun = document.getElementById("crashRunBtn");
    const symbolInput = document.getElementById("crashSymbol");
    const typeSelect = document.getElementById("crashType");
    const startInput = document.getElementById("crashStartDate");
    const endInput = document.getElementById("crashEndDate");
    const thresholdInput = document.getElementById("crashThreshold");
    const chartDaysInput = document.getElementById("crashChartDays");
    const resultWrap = document.getElementById("crashResult");
    const summaryDiv = document.getElementById("crashSummary");
    const tableBody = document.getElementById("crashTableBody");
    const tableHead = document.getElementById("crashTableHead");
    const tableWrap = document.getElementById("crashTableWrap");
    const loadingEl = document.getElementById("crashLoading");
    const errorEl = document.getElementById("crashError");
    const emptyEl = document.getElementById("crashEmpty");
    const closeBtn = document.getElementById("crashCloseBtn");

    /* ── State ── */
    var _lastCrashes = [];        // crash events from last query
    var _lastSymbol = "";
    var _lastAssetType = "";
    var _expandedRowIdx = -1;    // currently expanded crash index

    /* ── Init ── */
    function init() {
        var now = new Date();
        var fiveYearsAgo = new Date(now.getFullYear() - 5, now.getMonth(), now.getDate());
        if (endInput) endInput.value = now.toISOString().slice(0, 10);
        if (startInput) startInput.value = fiveYearsAgo.toISOString().slice(0, 10);
    }

    /* ── Run query ── */
    function run() {
        var symbol = (symbolInput.value || "").trim().toUpperCase();
        var startDate = (startInput.value || "").trim();
        var endDate = (endInput.value || "").trim();
        var threshold = parseFloat(thresholdInput.value || "4.77");

        if (!symbol) { showError("请输入股票代码"); return; }
        if (!startDate || !endDate) { showError("请选择起止日期"); return; }
        if (isNaN(threshold) || threshold <= 0) { showError("暴跌幅度必须是正数"); return; }

        setLoading(true);
        hideError();
        resultWrap.style.display = "none";
        _expandedRowIdx = -1;

        fetch(CRASH_STATS_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                symbol: symbol,
                type: typeSelect.value,
                start_date: startDate,
                end_date: endDate,
                threshold_pct: threshold,
            }),
        })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (res) {
                setLoading(false);
                if (!res.ok || res.data.error) { showError(res.data.error || "请求失败"); return; }
                render(res.data);
            })
            .catch(function (e) {
                setLoading(false);
                showError(e.message || "网络错误");
            });
    }

    /* ── Render table ── */
    function render(data) {
        resultWrap.style.display = "block";
        var s = data.summary;
        var crashes = data.crashes || [];
        _lastCrashes = crashes;
        _lastSymbol = data.symbol;
        _lastAssetType = data.type;

        // Summary grid
        var recoveredPct = s.total_crashes > 0 ? Math.round(s.recovered / s.total_crashes * 100) : 0;
        summaryDiv.innerHTML = '<div class="crash-summary-grid">' +
            '<div class="crash-summary-item"><div class="crash-summary-label">暴跌次数</div><div class="crash-summary-val" style="color:' + (s.total_crashes > 0 ? 'var(--data-negative)' : 'var(--data-positive)') + '">' + s.total_crashes + '</div></div>' +
            '<div class="crash-summary-item"><div class="crash-summary-label">已恢复</div><div class="crash-summary-val">' + s.recovered + ' / ' + s.total_crashes + ' (' + recoveredPct + '%)</div></div>' +
            '<div class="crash-summary-item"><div class="crash-summary-label">平均恢复天数</div><div class="crash-summary-val">' + (s.avg_recovery_days != null ? s.avg_recovery_days : "—") + '</div></div>' +
            '<div class="crash-summary-item"><div class="crash-summary-label">中位恢复天数</div><div class="crash-summary-val">' + (s.median_recovery_days != null ? s.median_recovery_days : "—") + '</div></div>' +
            '<div class="crash-summary-item"><div class="crash-summary-label">最大跌幅</div><div class="crash-summary-val" style="color:var(--data-negative)">' + (s.max_drop_pct != null ? s.max_drop_pct.toFixed(2) + "%" : "—") + '</div></div>' +
            '<div class="crash-summary-item"><div class="crash-summary-label">平均跌幅</div><div class="crash-summary-val" style="color:var(--data-negative)">' + (s.avg_drop_pct != null ? s.avg_drop_pct.toFixed(2) + "%" : "—") + '</div></div>' +
            '</div>';

        // Table header
        tableHead.innerHTML = '<th>暴跌日期</th><th>暴跌前收盘价</th><th>暴跌日收盘价</th><th>跌幅</th><th>触底日期</th><th>触底价格</th><th>触底跌幅</th><th>触底天数</th><th>恢复日期</th><th>恢复日收盘价</th><th>恢复天数</th><th>状态</th>';

        if (crashes.length === 0) {
            tableWrap.style.display = "none";
            emptyEl.style.display = "block";
            emptyEl.innerHTML = '<div style="font-size:24px;margin-bottom:8px;">&#9989;</div><div>在选定时间段内没有发现暴跌超过 ' + data.threshold_pct + '% 的交易日</div>';
        } else {
            tableWrap.style.display = "block";
            emptyEl.style.display = "none";

            var bodyHtml = "";
            crashes.forEach(function (c, idx) {
                var statusHtml = c.recovered
                    ? '<span class="crash-status recovered">已恢复</span>'
                    : '<span class="crash-status not-recovered">未恢复</span>';
                bodyHtml += '<tr class="crash-row" data-crash-idx="' + idx + '">' +
                    '<td>' + c.crash_date + '</td>' +
                    '<td>' + c.pre_crash_close.toFixed(2) + '</td>' +
                    '<td style="color:var(--data-negative);">' + c.crash_close.toFixed(2) + '</td>' +
                    '<td style="color:var(--data-negative);font-weight:600;">' + c.drop_pct.toFixed(2) + '%</td>' +
                    '<td>' + c.bottom_date + '</td>' +
                    '<td style="color:var(--data-negative);">' + c.bottom_close.toFixed(2) + '</td>' +
                    '<td style="color:var(--data-negative);font-weight:600;">' + c.bottom_pct.toFixed(2) + '%</td>' +
                    '<td>' + c.days_to_bottom + '</td>' +
                    '<td>' + (c.recovery_date || "—") + '</td>' +
                    '<td style="color:var(--data-positive);">' + (c.recovery_close != null ? c.recovery_close.toFixed(2) : "—") + '</td>' +
                    '<td>' + (c.recovery_days != null ? c.recovery_days : "—") + '</td>' +
                    '<td>' + statusHtml + '</td>' +
                    '</tr>';
            });
            tableBody.innerHTML = bodyHtml;

            // Bind click handlers
            var rows = tableBody.querySelectorAll("tr.crash-row");
            rows.forEach(function (row) {
                row.addEventListener("click", function () {
                    var idx = parseInt(row.getAttribute("data-crash-idx"), 10);
                    onRowClick(idx);
                });
            });
        }
    }

    /* ── Row click: toggle chart ── */
    function onRowClick(idx) {
        var crash = _lastCrashes[idx];
        if (!crash) return;

        // If clicking the already-expanded row, collapse it
        if (_expandedRowIdx === idx) {
            collapseChart();
            return;
        }

        // Remove previous expansion
        collapseChart();

        // Expand this row
        _expandedRowIdx = idx;
        var row = tableBody.querySelector('tr[data-crash-idx="' + idx + '"]');
        if (row) row.classList.add("expanded");

        // Insert chart row after the clicked row
        var chartRow = document.createElement("tr");
        chartRow.className = "crash-chart-row";
        chartRow.id = "crashChartRow";
        var chartTd = document.createElement("td");
        chartTd.colSpan = 12;
        chartTd.innerHTML = '<div class="crash-chart-container" id="crashChartContainer">' +
            '<div style="display:flex;align-items:center;justify-content:center;padding:40px;color:var(--apple-text-tertiary);">' +
                '<div class="spinner" style="margin-right:10px;"></div>加载走势图...' +
            '</div></div>';
        chartRow.appendChild(chartTd);
        row.parentNode.insertBefore(chartRow, row.nextSibling);

        // Fetch chart data
        var tradingDays = parseInt(chartDaysInput.value || "30", 10);
        fetch(CRASH_CHART_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                symbol: _lastSymbol,
                type: _lastAssetType,
                pre_crash_date: crash.pre_crash_date,
                trading_days: tradingDays,
            }),
        })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (res) {
                if (!res.ok || res.data.error) {
                    document.getElementById("crashChartContainer").innerHTML =
                        '<div style="padding:20px;color:var(--data-negative);">加载失败: ' + (res.data.error || "未知错误") + '</div>';
                    return;
                }
                renderCrashChart(res.data, crash);
            })
            .catch(function (e) {
                document.getElementById("crashChartContainer").innerHTML =
                    '<div style="padding:20px;color:var(--data-negative);">加载失败: ' + e.message + '</div>';
            });
    }

    function collapseChart() {
        var chartRow = document.getElementById("crashChartRow");
        if (chartRow) chartRow.parentNode.removeChild(chartRow);
        if (_expandedRowIdx >= 0) {
            var row = tableBody.querySelector('tr[data-crash-idx="' + _expandedRowIdx + '"]');
            if (row) row.classList.remove("expanded");
        }
        _expandedRowIdx = -1;
    }

    /* ── SVG Chart ── */
    var CHART_COLORS = {
        line: "#2997ff",
        preCrash: "var(--apple-text-tertiary)",
        bottom: "#ff453a",
        recovery: "#30d158",
        crashDot: "#ff9f0a",
        grid: "var(--apple-divider)",
        up: "#30d158",
        down: "#ff453a",
    };

    function renderCrashChart(chartData, crash) {
        var prices = chartData.prices || [];
        if (prices.length < 2) {
            document.getElementById("crashChartContainer").innerHTML =
                '<div style="padding:20px;color:var(--apple-text-tertiary);">数据不足，无法绘制图表</div>';
            return;
        }

        var preCrashClose = chartData.pre_crash_close;
        var W = 700, H = 300;
        var PAD = { top: 24, right: 60, bottom: 48, left: 64 };
        var cw = W - PAD.left - PAD.right;
        var ch = H - PAD.top - PAD.bottom;

        // Use candlesticks when the backend provided OHLC AND the window is
        // small enough for candles to stay readable; otherwise fall back to a
        // close-only line chart (e.g. A-share indices, or very wide windows).
        var useCandles = !!chartData.has_ohlc && prices.length <= 80;

        // Find value range. In candle mode include highs/lows so wicks fit.
        var allVals = [];
        prices.forEach(function (p) {
            if (useCandles) {
                allVals.push(p.high, p.low);
            } else {
                allVals.push(p.close);
            }
        });
        if (preCrashClose != null) allVals.push(preCrashClose);
        var minVal = Math.min.apply(null, allVals);
        var maxVal = Math.max.apply(null, allVals);
        var range = maxVal - minVal || 1;
        var yMin = minVal - range * 0.08;
        var yMax = maxVal + range * 0.08;
        var yRange = yMax - yMin;

        // Coordinate helpers — x maps to trading-day index
        var xPos = function (i) { return PAD.left + (i / (prices.length - 1)) * cw; };
        var yPos = function (v) { return PAD.top + ch - ((v - yMin) / yRange) * ch; };

        // Identify key indices in the price array
        var crashIdx = -1, bottomIdx = -1, recoveryIdx = -1;
        prices.forEach(function (p, i) {
            if (p.date === crash.crash_date) crashIdx = i;
            if (p.date === crash.bottom_date) bottomIdx = i;
            if (crash.recovery_date && p.date === crash.recovery_date) recoveryIdx = i;
        });

        // ── Y-axis grid ──
        var yTicks = 5;
        var yGrid = "";
        for (var i = 0; i <= yTicks; i++) {
            var v = yMin + (yRange * i) / yTicks;
            var y = yPos(v);
            yGrid += '<line x1="' + PAD.left + '" y1="' + y + '" x2="' + (W - PAD.right) + '" y2="' + y + '" stroke="var(--apple-divider)" stroke-width="1"/>';
            yGrid += '<text x="' + (PAD.left - 8) + '" y="' + (y + 4) + '" text-anchor="end" fill="var(--apple-text-tertiary)" font-size="11">' + v.toFixed(2) + '</text>';
        }

        // ── Pre-crash horizontal reference line ──
        var refLine = "";
        if (preCrashClose != null) {
            var refY = yPos(preCrashClose);
            refLine = '<line x1="' + PAD.left + '" y1="' + refY + '" x2="' + (W - PAD.right) + '" y2="' + refY + '" stroke="var(--apple-text-tertiary)" stroke-width="1" stroke-dasharray="6,4" opacity="0.5"/>';
            refLine += '<text x="' + (W - PAD.right + 6) + '" y="' + (refY + 4) + '" fill="var(--apple-text-tertiary)" font-size="10">暴跌前 ' + preCrashClose.toFixed(2) + '</text>';
        }

        // ── Price geometry: candlesticks (with OHLC) or a close line ──
        var seriesSvg = "";
        if (useCandles) {
            // Candle width derived from slot size; leave a gap between candles.
            var slot = cw / prices.length;
            var bodyW = Math.max(2, Math.min(14, slot * 0.62));
            prices.forEach(function (p, i) {
                var cx = xPos(i);
                var up = p.close >= p.open;
                var color = up ? CHART_COLORS.up : CHART_COLORS.down;
                var yHigh = yPos(p.high);
                var yLow = yPos(p.low);
                var yOpen = yPos(p.open);
                var yClose = yPos(p.close);
                var bodyTop = Math.min(yOpen, yClose);
                var bodyH = Math.max(1, Math.abs(yClose - yOpen));
                // Wick (high-low)
                seriesSvg += '<line x1="' + cx + '" y1="' + yHigh + '" x2="' + cx + '" y2="' + yLow + '" stroke="' + color + '" stroke-width="1"/>';
                // Body (open-close)
                seriesSvg += '<rect x="' + (cx - bodyW / 2) + '" y="' + bodyTop + '" width="' + bodyW + '" height="' + bodyH + '" fill="' + color + '" stroke="' + color + '" stroke-width="0.6"/>';
            });
        } else {
            var linePath = "";
            prices.forEach(function (p, i) {
                linePath += (i === 0 ? "M" : "L") + xPos(i) + "," + yPos(p.close);
            });
            seriesSvg = '<path d="' + linePath + '" fill="none" stroke="' + CHART_COLORS.line + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>';
            prices.forEach(function (p, i) {
                var dotColor = CHART_COLORS.line, dotR = 1.5;
                if (i === crashIdx) { dotColor = CHART_COLORS.crashDot; dotR = 4; }
                else if (i === bottomIdx) { dotColor = CHART_COLORS.bottom; dotR = 4; }
                else if (i === recoveryIdx) { dotColor = CHART_COLORS.recovery; dotR = 4; }
                seriesSvg += '<circle cx="' + xPos(i) + '" cy="' + yPos(p.close) + '" r="' + dotR + '" fill="' + dotColor + '" stroke="var(--apple-bg)" stroke-width="0.8"/>';
            });
        }

        // ── Key event markers (vertical) ──
        var markers = "";
        function addMarker(idx, color, label, price) {
            if (idx < 0) return;
            var cx = xPos(idx);
            markers += '<line x1="' + cx + '" y1="' + PAD.top + '" x2="' + cx + '" y2="' + (H - PAD.bottom) + '" stroke="' + color + '" stroke-width="1" stroke-dasharray="3,3" opacity="0.4"/>';
            var cy = yPos(price);
            // Label below axis
            var labelY = H - PAD.bottom + 16;
            markers += '<text x="' + cx + '" y="' + labelY + '" text-anchor="middle" fill="' + color + '" font-size="10">' + label + '</text>';
        }
        if (crashIdx >= 0) addMarker(crashIdx, CHART_COLORS.crashDot, "暴跌日 " + prices[crashIdx].date, prices[crashIdx].close);
        if (bottomIdx >= 0 && bottomIdx !== crashIdx) addMarker(bottomIdx, CHART_COLORS.bottom, "触底 " + prices[bottomIdx].date, prices[bottomIdx].close);
        if (recoveryIdx >= 0) addMarker(recoveryIdx, CHART_COLORS.recovery, "恢复 " + prices[recoveryIdx].date, prices[recoveryIdx].close);

        // ── X-axis labels ──
        var xLabels = "";
        var labelInterval = Math.max(1, Math.floor(prices.length / 10));
        prices.forEach(function (p, i) {
            if (i % labelInterval === 0 || i === prices.length - 1 || i === crashIdx || i === bottomIdx || i === recoveryIdx) {
                var label = "D" + (i - 1);  // Day 0 = crash day (index 1), Day -1 = pre-crash (index 0)
                if (i === 0) label = "暴跌前";
                var cx = xPos(i);
                xLabels += '<text x="' + cx + '" y="' + (H - PAD.bottom + 34) + '" text-anchor="middle" fill="var(--apple-text-tertiary)" font-size="10">' + label + '</text>';
            }
        });

        // ── Hover tooltip (invisible overlay) ──
        var tooltipRects = "";
        prices.forEach(function (p, i) {
            var cx = xPos(i);
            var attrs = ' data-idx="' + i + '" data-date="' + p.date + '" data-close="' + p.close.toFixed(2) + '"';
            if (p.open != null && p.high != null && p.low != null) {
                attrs += ' data-open="' + p.open.toFixed(2) + '" data-high="' + p.high.toFixed(2) + '" data-low="' + p.low.toFixed(2) + '"';
            }
            // Pct change vs previous trading day's close
            if (i > 0 && prices[i - 1].close) {
                var chg = (p.close / prices[i - 1].close - 1) * 100;
                attrs += ' data-chg="' + chg.toFixed(2) + '"';
            }
            tooltipRects += '<rect x="' + (cx - cw / prices.length / 2) + '" y="' + PAD.top + '" width="' + (cw / prices.length) + '" height="' + ch + '" fill="transparent"' + attrs + '/>';
        });

        // ── Assemble SVG ──
        var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block;font-family:-apple-system,SF Pro Text,Helvetica,Arial,sans-serif;">' +
            '<rect width="' + W + '" height="' + H + '" fill="transparent"/>' +
            yGrid +
            refLine +
            seriesSvg +
            markers +
            xLabels +
            '<g class="crash-chart-hover-zones">' + tooltipRects + '</g>' +
            '</svg>';

        var container = document.getElementById("crashChartContainer");
        container.innerHTML = svg;

        // ── Tooltip element ──
        var tooltipEl = document.createElement("div");
        tooltipEl.className = "crash-chart-tooltip";
        tooltipEl.id = "crashChartTooltip";
        container.appendChild(tooltipEl);

        // ── Hover interactions ──
        var hoverRects = container.querySelectorAll(".crash-chart-hover-zones rect");
        hoverRects.forEach(function (rect) {
            rect.addEventListener("mouseenter", function () {
                var d = rect.getAttribute("data-date");
                var c = rect.getAttribute("data-close");
                var o = rect.getAttribute("data-open");
                var h = rect.getAttribute("data-high");
                var l = rect.getAttribute("data-low");
                var chg = rect.getAttribute("data-chg");
                var html = '<div style="font-weight:600;">' + d + '</div>';
                if (o != null && h != null && l != null) {
                    html += '<div>开: <span style="color:var(--apple-text-secondary);">' + o + '</span>' +
                        '　高: <span style="color:var(--data-positive);">' + h + '</span></div>' +
                        '<div>低: <span style="color:var(--data-negative);">' + l + '</span>' +
                        '　收: <span style="color:var(--apple-blue);">' + c + '</span></div>';
                } else {
                    html += '<div>收盘价: <span style="color:var(--apple-blue);">' + c + '</span></div>';
                }
                if (chg != null) {
                    var chgNum = parseFloat(chg);
                    var chgColor = chgNum >= 0 ? "var(--data-positive)" : "var(--data-negative)";
                    html += '<div>涨跌: <span style="color:' + chgColor + ';">' + (chgNum >= 0 ? "+" : "") + chg + '%</span></div>';
                }
                tooltipEl.innerHTML = html;
                tooltipEl.style.display = "block";
            });
            rect.addEventListener("mousemove", function (e) {
                var box = container.getBoundingClientRect();
                var svgW = box.width;
                var scale = svgW / W;
                var relX = (e.clientX - box.left) / scale;
                tooltipEl.style.left = Math.min(relX + 12, cw - 140) + "px";
                tooltipEl.style.top = "8px";
            });
            rect.addEventListener("mouseleave", function () {
                tooltipEl.style.display = "none";
            });
        });
    }

    /* ── Helpers ── */
    function setLoading(show) {
        loadingEl.style.display = show ? "flex" : "none";
        if (show) resultWrap.style.display = "none";
    }

    function showError(msg) {
        errorEl.textContent = msg;
        errorEl.style.display = "block";
    }

    function hideError() {
        errorEl.style.display = "none";
    }

    function closeResult() {
        resultWrap.style.display = "none";
        hideError();
        _expandedRowIdx = -1;
    }

    /* ── Bind ── */
    if (btnRun) btnRun.addEventListener("click", run);
    if (closeBtn) closeBtn.addEventListener("click", closeResult);
    if (symbolInput) {
        symbolInput.addEventListener("keydown", function (e) {
            if (e.key === "Enter") run();
        });
    }

    init();
})();
