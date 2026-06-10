/**
 * VIX Fear Index tab — embedded in price-change.html.
 *
 * - SPY / QQQ on left Y-axis as % change
 * - VIX on right Y-axis as absolute index value
 * - Period switching: 1hour / daily / weekly / monthly (default daily)
 * - Manual bar count input (default 30)
 * - Legend click to toggle series visibility
 * - Hover crosshair with tooltip
 */

(function () {
    var VIX_COLORS = {
        spy: "#2997ff",
        qqq: "#e8a43e",
        vix: "#ff453a",
    };

    function isStepWise(period) {
        return period === "1hour" || period === "daily";
    }

    var _vixData = null;
    var _vixPeriod = "daily";
    var _vixHidden = {};
    var _vixLoading = false;

    function $(id) { return document.getElementById(id); }

    function getVixColors() {
        var s = getComputedStyle(document.documentElement);
        return {
            grid: s.getPropertyValue('--apple-chart-grid').trim() || 'rgba(255,255,255,0.08)',
            text: s.getPropertyValue('--apple-chart-text').trim() || 'rgba(255,255,255,0.6)',
            textDim: s.getPropertyValue('--apple-chart-text-dim').trim() || 'rgba(255,255,255,0.35)',
            crosshair: s.getPropertyValue('--apple-chart-crosshair').trim() || 'rgba(255,255,255,0.25)',
            tooltipBg: s.getPropertyValue('--apple-tooltip-bg').trim() || 'rgba(0,0,0,0.85)',
            tooltipText: s.getPropertyValue('--apple-tooltip-text').trim() || '#fff',
        };
    }

    function vixZone(vixVal) {
        if (vixVal == null || isNaN(vixVal)) return null;
        if (vixVal < 12)  return { label: "极度安逸", tip: "市场过度安逸，警惕黑天鹅风险，可适当配置对冲", cls: "zone-extreme-low" };
        if (vixVal < 15)  return { label: "低波动",   tip: "市场平静，波动率处于低位，正常定投即可",       cls: "zone-low" };
        if (vixVal < 20)  return { label: "正常区间", tip: "波动率正常，坚持长期投资策略",                 cls: "zone-normal" };
        if (vixVal < 25)  return { label: "恐惧上升", tip: "恐慌情绪升温，市场回调中，关注分批买入机会",   cls: "zone-elevated" };
        if (vixVal < 30)  return { label: "高度恐惧", tip: "市场恐慌加剧，长期投资者可考虑加大定投力度",   cls: "zone-high" };
        return              { label: "极度恐慌", tip: "危机模式！历史大底区域往往出现在此区间，激进者可重仓买入", cls: "zone-extreme" };
    }

    function readCount() {
        var input = $("vixCountInput");
        var n = input ? parseInt(input.value, 10) : 30;
        if (!Number.isFinite(n)) n = 30;
        n = Math.max(5, Math.min(n, _vixPeriod === "1hour" ? 240 : 2000));
        if (input) input.value = String(n);
        return n;
    }

    function fetchVixData(callback) {
        if (_vixLoading) return;
        _vixLoading = true;

        var loadingEl = $("vixLoading");
        var errorEl = $("vixError");
        if (loadingEl) loadingEl.style.display = "flex";
        if (errorEl) errorEl.style.display = "none";

        fetch(VIX_COMPARISON_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ period: _vixPeriod, count: readCount() }),
        })
            .then(function (r) {
                if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "HTTP " + r.status); });
                return r.json();
            })
            .then(function (data) {
                _vixData = data;
                if (loadingEl) loadingEl.style.display = "none";
                updateVixAdvice(data.latest_vix, data.stats || {});
                updateHeaderBadge(data.latest_vix);
                renderVixChart();
                if (callback) callback(null, data);
            })
            .catch(function (err) {
                _vixData = null;
                if (loadingEl) loadingEl.style.display = "none";
                if (errorEl) {
                    errorEl.textContent = "加载失败: " + err.message;
                    errorEl.style.display = "block";
                }
                if (callback) callback(err);
            })
            .finally(function () { _vixLoading = false; });
    }

    function updateVixAdvice(vixVal, stats) {
        var card = $("vixAdviceCard");
        var valEl = $("vixAdviceValue");
        var zoneEl = $("vixAdviceZone");
        var pctEl = $("vixPercentile");
        var corrEl = $("vixCorrelation");
        var tipEl = $("vixAdviceTip");
        if (!card) return;

        var zone = vixZone(vixVal);
        if (!zone) { card.style.display = "none"; return; }

        stats = stats || {};
        card.style.display = "";
        if (valEl) {
            valEl.textContent = vixVal.toFixed(2);
            valEl.style.color = vixVal >= 25 ? "var(--data-negative)" :
                                vixVal >= 20 ? "#ff9f0a" :
                                "var(--apple-text-primary)";
        }
        if (zoneEl) { zoneEl.textContent = zone.label; zoneEl.className = "vix-advice-zone " + zone.cls; }
        if (pctEl) {
            if (stats.vix_percentile_1y == null) {
                pctEl.textContent = "--";
                pctEl.style.color = "var(--apple-text-secondary)";
            } else {
                pctEl.textContent = stats.vix_percentile_1y.toFixed(1) + "%";
                pctEl.style.color = stats.vix_percentile_1y >= 80 ? "var(--data-negative)" :
                                    stats.vix_percentile_1y >= 60 ? "#ff9f0a" :
                                    "var(--apple-text-primary)";
            }
        }
        if (corrEl) {
            if (stats.spy_vix_corr_30 == null) {
                corrEl.textContent = "--";
                corrEl.style.color = "var(--apple-text-secondary)";
            } else {
                corrEl.textContent = stats.spy_vix_corr_30.toFixed(2);
                corrEl.style.color = stats.spy_vix_corr_30 > -0.2 ? "#ff9f0a" : "var(--apple-text-primary)";
            }
        }
        if (tipEl) {
            var extras = [];
            if (stats.vix_percentile_1y != null) extras.push("当前处于近1年约 " + stats.vix_percentile_1y.toFixed(1) + "% 分位");
            if (stats.spy_vix_corr_30 != null) {
                extras.push(stats.spy_vix_corr_30 > -0.2 ? "SPY/VIX负相关减弱，留意异常风险" : "SPY/VIX仍保持典型负相关");
            }
            tipEl.textContent = zone.tip + (extras.length ? "。" + extras.join("；") : "");
        }
    }

    function updateHeaderBadge(vixVal) {
        var line = $("vixHeaderLine");
        var badge = $("vixHeaderBadge");
        if (!badge || !line) return;
        if (vixVal == null || isNaN(vixVal)) { line.style.display = "none"; return; }

        var zone = vixZone(vixVal);
        if (!zone) { line.style.display = "none"; return; }

        line.style.display = "";
        badge.textContent = "VIX " + vixVal.toFixed(2) + " · " + zone.label + " · " +
            (vixVal >= 30 ? "⚠ 极度恐慌，历史大底" :
             vixVal >= 25 ? "📉 高度恐惧，关注买入" :
             vixVal >= 20 ? "👀 恐惧上升，耐心观望" :
             vixVal >= 15 ? "✅ 正常区间，坚持定投" :
             vixVal >= 12 ? "📊 低波动，正常定投" :
             "⚠ 极度安逸，警惕风险");
        badge.className = "vix-header-badge " + zone.cls;
    }

    function normalizePriceSeries(points, stepWise) {
        if (!points || points.length < 2) return [];
        var result = [];
        if (stepWise) {
            for (var i = 0; i < points.length; i++) {
                var pct = 0;
                if (i > 0) {
                    var prev = points[i - 1].close;
                    pct = prev ? ((points[i].close - prev) / prev) * 100 : 0;
                }
                result.push({ date: points[i].date, pct: pct, close: points[i].close });
            }
        } else {
            var base = points[0].close;
            if (!base) return [];
            for (var j = 0; j < points.length; j++) {
                result.push({ date: points[j].date, pct: ((points[j].close - base) / base) * 100, close: points[j].close });
            }
        }
        return result;
    }

    function vixValueSeries(points) {
        if (!points || points.length < 2) return [];
        return points.map(function (p) { return { date: p.date, value: p.close, close: p.close }; });
    }

    function formatDateLabel(dateStr, period) {
        if (period === "1hour") {
            var t = dateStr.indexOf("T");
            if (t > 0) return dateStr.substring(5, 10) + " " + dateStr.substring(t + 1, t + 6);
            return dateStr;
        }
        if (period === "monthly") return dateStr.substring(0, 7);
        return dateStr.substring(5);
    }

    function rangeWithPad(values, fallbackMin, fallbackMax, padRatio) {
        var valid = values.filter(function (v) { return Number.isFinite(v); });
        if (!valid.length) return { min: fallbackMin, max: fallbackMax, range: fallbackMax - fallbackMin };
        var min = Math.min.apply(null, valid);
        var max = Math.max.apply(null, valid);
        if (min === max) { min -= 1; max += 1; }
        var range = max - min;
        var pad = range * (padRatio || 0.12);
        min -= pad; max += pad;
        return { min: min, max: max, range: max - min };
    }

    function renderVixChart() {
        var container = $("vixChartContainer");
        if (!container || !_vixData) return;

        var stepWise = isStepWise(_vixPeriod);
        var spySeries = { key: "spy", name: "SPY", axis: "left", points: normalizePriceSeries(_vixData.spy || [], stepWise), color: VIX_COLORS.spy };
        var qqqSeries = { key: "qqq", name: "QQQ", axis: "left", points: normalizePriceSeries(_vixData.qqq || [], stepWise), color: VIX_COLORS.qqq };
        var vixSeries = { key: "vix", name: "VIX", axis: "right", points: vixValueSeries(_vixData.vix || []), color: VIX_COLORS.vix };
        var allSeries = [spySeries, qqqSeries, vixSeries];
        var validSeries = allSeries.filter(function (s) { return s.points.length >= 2; });

        if (validSeries.length === 0) {
            container.innerHTML = '<div style="text-align:center;padding:32px;color:var(--apple-text-secondary);">暂无数据</div>';
            return;
        }

        var CLR = getVixColors();
        var allDates = [];
        var dateSet = {};
        validSeries.forEach(function (s) {
            s.points.forEach(function (p) {
                if (!dateSet[p.date]) { dateSet[p.date] = true; allDates.push(p.date); }
            });
        });
        allDates.sort();
        if (allDates.length < 2) {
            container.innerHTML = '<div style="text-align:center;padding:32px;color:var(--apple-text-secondary);">数据点不足</div>';
            return;
        }

        var visibleLeft = validSeries.filter(function (s) { return s.axis === "left" && !_vixHidden[s.key]; });
        var visibleRight = validSeries.filter(function (s) { return s.axis === "right" && !_vixHidden[s.key]; });
        var leftVals = [];
        visibleLeft.forEach(function (s) { s.points.forEach(function (p) { leftVals.push(p.pct); }); });
        var rightVals = [];
        visibleRight.forEach(function (s) { s.points.forEach(function (p) { rightVals.push(p.value); }); });

        var leftRange = rangeWithPad(leftVals, -1, 1, 0.15);
        var rightRange = rangeWithPad(rightVals, 10, 40, 0.12);

        var W = 920, H = 350;
        var PAD = { top: 22, right: 62, bottom: 38, left: 62 };
        var plotW = W - PAD.left - PAD.right;
        var plotH = H - PAD.top - PAD.bottom;
        var xScale = function (i) { return PAD.left + (i / Math.max(allDates.length - 1, 1)) * plotW; };
        var leftY = function (v) { return PAD.top + plotH - ((v - leftRange.min) / leftRange.range) * plotH; };
        var rightY = function (v) { return PAD.top + plotH - ((v - rightRange.min) / rightRange.range) * plotH; };

        var dateX = {};
        allDates.forEach(function (d, i) { dateX[d] = xScale(i); });

        var svg = '<rect width="' + W + '" height="' + H + '" fill="transparent"/>';
        var gridLines = 5;
        for (var g = 0; g <= gridLines; g++) {
            var leftVal = leftRange.min + (leftRange.range / gridLines) * g;
            var y = leftY(leftVal);
            var rightVal = rightRange.min + (rightRange.range / gridLines) * g;
            svg += '<line x1="' + PAD.left + '" y1="' + y + '" x2="' + (W - PAD.right) + '" y2="' + y + '" stroke="' + CLR.grid + '" stroke-width="0.5"/>';
            svg += '<text x="' + (PAD.left - 6) + '" y="' + (y + 4) + '" fill="' + CLR.textDim + '" font-size="10" text-anchor="end">' + leftVal.toFixed(1) + '%</text>';
            if (visibleRight.length) {
                svg += '<text x="' + (W - PAD.right + 6) + '" y="' + (y + 4) + '" fill="' + VIX_COLORS.vix + '" font-size="10" text-anchor="start" opacity="0.75">' + rightVal.toFixed(1) + '</text>';
            }
        }

        var zeroY = leftY(0);
        if (zeroY > PAD.top && zeroY < H - PAD.bottom) {
            svg += '<line x1="' + PAD.left + '" y1="' + zeroY + '" x2="' + (W - PAD.right) + '" y2="' + zeroY + '" stroke="' + CLR.textDim + '" stroke-width="0.5" stroke-dasharray="4,3"/>';
        }

        validSeries.forEach(function (series) {
            if (_vixHidden[series.key]) return;
            var yFn = series.axis === "right" ? rightY : leftY;
            var valKey = series.axis === "right" ? "value" : "pct";
            var pathD = "";
            for (var i = 0; i < series.points.length; i++) {
                var x = dateX[series.points[i].date];
                var y = yFn(series.points[i][valKey]);
                if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                pathD += (pathD ? "L" : "M") + x.toFixed(1) + "," + y.toFixed(1) + " ";
            }
            svg += '<g id="vs-' + series.key + '">';
            if (pathD) {
                var width = series.axis === "right" ? "1.6" : "1.9";
                var dash = series.axis === "right" ? ' stroke-dasharray="4,3"' : "";
                svg += '<path d="' + pathD + '" fill="none" stroke="' + series.color + '" stroke-width="' + width + '" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"' + dash + '/>';
            }
            for (var j = 0; j < series.points.length; j++) {
                var dx = dateX[series.points[j].date];
                var dy = yFn(series.points[j][valKey]);
                if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
                svg += '<circle cx="' + dx.toFixed(1) + '" cy="' + dy.toFixed(1) + '" r="1.5" fill="' + series.color + '" stroke="var(--apple-bg)" stroke-width="0.5"/>';
            }
            svg += '</g>';
        });

        var leftLabel = stepWise ? "SPY/QQQ 逐期涨跌幅 %" : "SPY/QQQ 累计涨跌幅 %";
        svg += '<text x="8" y="14" fill="' + CLR.text + '" font-size="10">' + leftLabel + '</text>';
        if (visibleRight.length) {
            svg += '<text x="' + (W - PAD.right + 2) + '" y="14" fill="' + VIX_COLORS.vix + '" font-size="10">VIX</text>';
        }

        var labelEvery = Math.max(1, Math.floor(allDates.length / 8));
        for (var k = 0; k < allDates.length; k++) {
            if (k % labelEvery !== 0 && k !== allDates.length - 1) continue;
            var cx = dateX[allDates[k]];
            svg += '<text x="' + cx + '" y="' + (H - PAD.bottom + 16) + '" fill="' + CLR.textDim + '" font-size="9" text-anchor="middle">' + formatDateLabel(allDates[k], _vixPeriod) + '</text>';
        }

        var legendY = H + 6;
        validSeries.forEach(function (series, idx) {
            var hidden = !!_vixHidden[series.key];
            var lx = 10 + idx * 155;
            svg += '<g data-vix-legend="' + series.key + '" style="cursor:pointer;">';
            svg += '<rect x="' + (lx - 4) + '" y="' + (legendY - 12) + '" width="145" height="20" rx="4" fill="rgba(0,0,0,0.001)"/>';
            svg += '<rect x="' + lx + '" y="' + (legendY - 5) + '" width="10" height="3" rx="1.5" fill="' + series.color + '" opacity="' + (hidden ? 0.25 : 1) + '"/>';
            svg += '<text x="' + (lx + 14) + '" y="' + (legendY + 1) + '" fill="var(--apple-text-secondary)" font-size="11" opacity="' + (hidden ? 0.3 : 0.85) + '" text-decoration="' + (hidden ? "line-through" : "none") + '">' + series.name + (series.axis === "right" ? " (右轴)" : "") + '</text>';
            svg += '</g>';
        });

        var svgH = legendY + 22;
        svg += '<line id="vixCrosshair" x1="0" y1="' + PAD.top + '" x2="0" y2="' + (H - PAD.bottom) + '" stroke="' + CLR.crosshair + '" stroke-width="1" stroke-dasharray="4,2" style="display:none;pointer-events:none"/>';
        svg += '<rect id="vixTipRect" x="0" y="0" width="190" height="1" rx="6" fill="' + CLR.tooltipBg + '" style="display:none;pointer-events:none"/>';
        svg += '<text id="vixTipText" x="0" y="0" fill="' + CLR.tooltipText + '" font-size="11" style="display:none;pointer-events:none"></text>';

        var slotW = plotW / Math.max(allDates.length - 1, 1);
        for (var z = 0; z < allDates.length; z++) {
            var sx = dateX[allDates[z]] - slotW / 2;
            svg += '<rect x="' + sx.toFixed(1) + '" y="' + PAD.top + '" width="' + slotW.toFixed(1) + '" height="' + plotH + '" fill="transparent" data-vix-idx="' + z + '" class="vix-hover-zone"/>';
        }

        container.innerHTML = '<svg id="vixSvg" viewBox="0 0 ' + W + ' ' + svgH + '" style="width:100%;height:auto;display:block;font-family:-apple-system,SF Pro Text,Helvetica,Arial,sans-serif;">' + svg + '</svg>';
        attachVixInteractions(allDates, dateX, validSeries, W, H, PAD, slotW);
    }

    function attachVixInteractions(allDates, dateX, validSeries, W, H, PAD, slotW) {
        var svgEl = document.getElementById("vixSvg");
        if (!svgEl) return;

        validSeries.forEach(function (series) {
            var g = svgEl.querySelector('g[data-vix-legend="' + series.key + '"]');
            if (!g) return;
            g.addEventListener("click", function (e) {
                e.stopPropagation();
                _vixHidden[series.key] = !_vixHidden[series.key];
                renderVixChart();
            });
            g.addEventListener("mouseenter", function () {
                validSeries.forEach(function (s) {
                    if (s.key === series.key || _vixHidden[s.key]) return;
                    var el = svgEl.querySelector("#vs-" + s.key);
                    if (el) el.style.opacity = "0.12";
                });
            });
            g.addEventListener("mouseleave", function () {
                validSeries.forEach(function (s) {
                    if (_vixHidden[s.key]) return;
                    var el = svgEl.querySelector("#vs-" + s.key);
                    if (el) el.style.opacity = "1";
                });
            });
        });

        var crosshair = document.getElementById("vixCrosshair");
        var tipRect = document.getElementById("vixTipRect");
        var tipText = document.getElementById("vixTipText");

        svgEl.addEventListener("mousemove", function (e) {
            var rect = svgEl.getBoundingClientRect();
            var mx = (e.clientX - rect.left) / rect.width * W;
            var closestI = 0, closestDist = Infinity;
            for (var i = 0; i < allDates.length; i++) {
                var d = Math.abs(dateX[allDates[i]] - mx);
                if (d < closestDist) { closestDist = d; closestI = i; }
            }
            if (closestDist > slotW * 1.5) {
                crosshair.style.display = "none"; tipRect.style.display = "none"; tipText.style.display = "none";
                return;
            }

            var cx = dateX[allDates[closestI]];
            var dateStr = allDates[closestI];
            crosshair.setAttribute("x1", cx); crosshair.setAttribute("x2", cx);
            crosshair.style.display = "";

            var lines = ["日期：" + dateStr];
            validSeries.forEach(function (series) {
                if (_vixHidden[series.key]) return;
                var pt = null;
                for (var j = 0; j < series.points.length; j++) {
                    if (series.points[j].date === dateStr) { pt = series.points[j]; break; }
                }
                if (!pt) return;
                if (series.axis === "right") {
                    lines.push(series.name + "：" + pt.value.toFixed(2));
                } else {
                    lines.push(series.name + "：" + (pt.pct >= 0 ? "+" : "") + pt.pct.toFixed(2) + "% ($" + pt.close.toFixed(2) + ")");
                }
            });

            var tipW = 185, lineH = 14, tipH = lineH * lines.length + 14;
            var tipX = cx + 10, tipY = PAD.top + 4;
            if (tipX + tipW > W - PAD.right) tipX = cx - tipW - 10;
            tipRect.setAttribute("x", tipX); tipRect.setAttribute("y", tipY);
            tipRect.setAttribute("width", tipW); tipRect.setAttribute("height", tipH);
            tipRect.style.display = "";

            var tspans = "";
            lines.forEach(function (l, li) {
                tspans += '<tspan x="' + (tipX + 8) + '" y="' + (tipY + lineH + li * lineH + 2) + '">' + l + '</tspan>';
            });
            tipText.innerHTML = tspans;
            tipText.style.display = "";
        });

        svgEl.addEventListener("mouseleave", function () {
            if (crosshair) crosshair.style.display = "none";
            if (tipRect) tipRect.style.display = "none";
            if (tipText) tipText.style.display = "none";
        });
    }

    function initPeriodTabs() {
        var tabs = document.querySelectorAll("#vixPeriodTabs .transfer-tab");
        tabs.forEach(function (btn) {
            btn.addEventListener("click", function () {
                var period = btn.dataset.vixPeriod;
                if (period === _vixPeriod) return;
                _vixPeriod = period;
                tabs.forEach(function (b) { b.classList.remove("active"); });
                btn.classList.add("active");
                _vixHidden = {};
                fetchVixData();
            });
        });
    }

    function initReloadControls() {
        var btn = $("vixReloadBtn");
        var input = $("vixCountInput");
        if (btn) btn.addEventListener("click", function () { fetchVixData(); });
        if (input) {
            input.addEventListener("keydown", function (e) {
                if (e.key === "Enter") fetchVixData();
            });
        }
    }

    function onTabActivated() {
        if (!_vixData) { _vixHidden = {}; fetchVixData(); }
    }

    function fetchLatestVix() {
        fetch(VIX_COMPARISON_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ period: "daily", count: 5 }),
        })
            .then(function (r) { return r.json(); })
            .then(function (data) { if (data.latest_vix != null) updateHeaderBadge(data.latest_vix); })
            .catch(function () { /* silent — badge stays hidden */ });
    }

    function init() {
        fetchLatestVix();
        initPeriodTabs();
        initReloadControls();
        var vixTab = document.querySelector('.tab-btn[data-tab="vix"]');
        if (vixTab) vixTab.addEventListener("click", onTabActivated);
        if (document.getElementById("tab-vix") && document.getElementById("tab-vix").classList.contains("active")) onTabActivated();
        window._vixRefreshChart = function () { if (_vixData) renderVixChart(); };
        var origRefresh = window._refreshCharts;
        window._refreshCharts = function () {
            if (typeof origRefresh === "function") origRefresh();
            if (typeof window._vixRefreshChart === "function") window._vixRefreshChart();
        };
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
