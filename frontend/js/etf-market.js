/**
 * A-Share ETF real-time market data tab — embedded in price-change.html.
 *
 * - Two sub-tabs: NASDAQ 100 / S&P 500
 * - Sortable table with real-time quotes from Tencent Finance
 * - Row click → expand detail panel with SVG candlestick chart + daily change% overlay
 */
(function () {
    var L = "<"; var C = L + "/";  // < and </ to avoid Node 24 parser issue

    /* ── ETF groups ── */
    var ETF_GROUPS = {
        nasdaq100: {
            label: "纳指100",
            symbols: [
                { code: "513300", name: "华夏" },
                { code: "513110", name: "华泰柏瑞" },
                { code: "159655", name: "华安" },
                { code: "159660", name: "博时" },
                { code: "159632", name: "易方达" },
                { code: "159501", name: "招商" },
                { code: "159513", name: "富国" },
                { code: "159696", name: "摩根" },
                { code: "159529", name: "汇添富" },
                { code: "513100", name: "国泰" },
                { code: "159941", name: "广发" },
            ],
        },
        sp500: {
            label: "标普500",
            symbols: [
                { code: "513650", name: "华夏" },
                { code: "159612", name: "国泰" },
                { code: "513500", name: "博时" },
                { code: "159652", name: "易方达" },
            ],
        },
    };

    /* ── State ── */
    var _quotes = {};
    var _activeTab = "nasdaq100";
    var _sortCol = "mc_total";
    var _sortDir = "desc";
    var _expandedCode = null;
    var _lastChartData = null;

    /* ── Chart type selection (single-select) ── */
    function activeChartType() {
        var active = document.querySelector('#etfChartToggles .transfer-tab.active');
        return active ? active.dataset.etfChart : "candle";
    }

    /* ── Chart constants ── */
    var CHART_COLORS = {
        candleUp: "#30d158",
        candleDown: "#ff453a",
        grid: "rgba(255,255,255,0.08)",
        text: "rgba(255,255,255,0.6)",
        textDim: "rgba(255,255,255,0.35)",
        dim: "rgba(255,255,255,0.35)",
        crosshair: "rgba(255,255,255,0.25)",
        tooltipBg: "rgba(0,0,0,0.85)",
    };

    /* ── Init ── */
    function init() {
        // Sub-tab clicks
        var subTabs = document.querySelectorAll("#etfTabBar .transfer-tab");
        subTabs.forEach(function (btn) {
            btn.addEventListener("click", function () {
                document.querySelectorAll("#etfTabBar .transfer-tab").forEach(function (b) { b.classList.remove("active"); });
                btn.classList.add("active");
                _activeTab = btn.dataset.etfTab;
                _expandedCode = null;
                hideDetail();
                renderTable();
            });
        });

        // Column sort clicks
        document.querySelectorAll(".etf-th-sort").forEach(function (th) {
            th.addEventListener("click", function () {
                var col = th.dataset.etfCol;
                if (_sortCol === col) {
                    _sortDir = _sortDir === "asc" ? "desc" : "asc";
                } else {
                    _sortCol = col;
                    _sortDir = "desc";
                }
                updateSortHeaders();
                renderTable();
            });
        });

        // Refresh button
        var refreshBtn = document.getElementById("etfRefreshBtn");
        if (refreshBtn) refreshBtn.addEventListener("click", fetchQuotes);

        // Detail close
        var closeBtn = document.getElementById("etfDetailClose");
        if (closeBtn) closeBtn.addEventListener("click", function () { hideDetail(); });

        // Chart type selector (single-select, radio style)
        document.querySelectorAll("#etfChartToggles .transfer-tab").forEach(function (btn) {
            btn.addEventListener("click", function (e) {
                e.stopPropagation();
                document.querySelectorAll("#etfChartToggles .transfer-tab").forEach(function (b) { b.classList.remove("active"); });
                btn.classList.add("active");
                if (_expandedCode) renderChart();
            });
        });

        fetchQuotes();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    /* ── Fetch real-time quotes ── */
    function fetchQuotes() {
        var symbols = [];
        for (var k in ETF_GROUPS) {
            ETF_GROUPS[k].symbols.forEach(function (s) { symbols.push(s.code); });
        }
        fetch("/api/etf-market/quote?symbols=" + symbols.join(","))
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var map = {};
                (data.quotes || []).forEach(function (q) { map[q.code] = q; });
                _quotes = map;
                var el = document.getElementById("etfRefreshInfo");
                if (el) el.textContent = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
                renderTable();
            })
            .catch(function () {
                document.getElementById("etfBody").innerHTML = '<tr><td colspan="13" style="text-align:center;padding:24px;color:var(--data-negative)">获取行情失败' + C + 'td>' + C + 'tr>';
            });
    }

    /* ── Render table ── */
    function renderTable() {
        var list = ETF_GROUPS[_activeTab].symbols;
        var rows = [];

        list.forEach(function (item) {
            var q = _quotes[item.code] || null;
            rows.push(buildRow(item, q));
        });

        rows.sort(function (a, b) {
            var va = a._sv, vb = b._sv;
            if (va == null && vb == null) return 0;
            if (va == null) return 1;
            if (vb == null) return -1;
            if (typeof va === "number" && typeof vb === "number") {
                return _sortDir === "asc" ? va - vb : vb - va;
            }
            return _sortDir === "asc"
                ? String(va).localeCompare(String(vb), "zh-CN")
                : String(vb).localeCompare(String(va), "zh-CN");
        });

        var html = "";
        rows.forEach(function (r) { html += r._html; });
        document.getElementById("etfBody").innerHTML = html;

        // Row click handlers
        document.querySelectorAll("#etfBody tr.etf-row").forEach(function (tr) {
            tr.addEventListener("click", function () {
                var code = tr.dataset.etfCode;
                toggleDetail(code);
            });
        });

        updateSortHeaders();
    }

    function buildRow(item, q) {
        var code = item.code;
        var has = q && q.price != null;

        var getSortVal = function () {
            if (_sortCol === "code") return code;
            if (_sortCol === "name") return (has && q.name) ? q.name : item.name;
            if (has) return q[_sortCol] != null ? q[_sortCol] : null;
            return null;
        };

        var num = function (val, dec, unit) {
            if (val == null) return '<span style="color:var(--apple-text-tertiary);text-align:right;display:block;">--' + C + 'span>';
            var d = val.toFixed(dec);
            if (unit === "vol") d = (val / 10000).toFixed(1) + "万";
            else if (unit === "amt") { d = val >= 1e8 ? (val / 1e8).toFixed(1) + "亿" : (val / 1e4).toFixed(0) + "万"; }
            else if (unit === "pct") d += "%";
            return '<span style="text-align:right;display:block;">' + d + C + 'span>';
        };

        var pctCls = "", pctDisp = "--";
        if (has && q.change_pct != null) {
            pctDisp = q.change_pct.toFixed(2) + "%";
            pctCls = q.change_pct > 0 ? "etf-pos" : q.change_pct < 0 ? "etf-neg" : "";
        }
        var premCls = "", premDisp = "--";
        if (has && q.premium != null) {
            premDisp = q.premium.toFixed(2) + "%";
            premCls = q.premium > 0 ? "etf-pos" : q.premium < 0 ? "etf-neg" : "";
        }
        var badge = has ? '<span class="etf-badge-' + q.market.toLowerCase() + '">' + q.market + C + 'span> ' : "";
        var name = (has && q.name) ? q.name : item.name;

        var expandedCls = (_expandedCode === code) ? " expanded" : "";

        var html =
            '<tr class="etf-row' + expandedCls + '" data-etf-code="' + code + '">' +
            "<td>" + badge + code + C + "td>" +
            "<td>" + name + C + "td>" +
            "<td style=\"font-weight:600;\">" + num(has ? q.price : null, 3) + C + "td>" +
            '<td><span class="' + pctCls + '" style="text-align:right;display:block;">' + pctDisp + C + "span>" + C + "td>" +
            "<td>" + num(has ? q.open : null, 3) + C + "td>" +
            "<td>" + num(has ? q.high : null, 3) + C + "td>" +
            "<td>" + num(has ? q.low : null, 3) + C + "td>" +
            "<td>" + num(has ? q.amplitude : null, 2, "pct") + C + "td>" +
            "<td>" + num(has ? q.volume : null, 0, "vol") + C + "td>" +
            "<td>" + num(has ? q.amount : null, 0, "amt") + C + "td>" +
            "<td>" + num(has ? q.turnover : null, 2, "pct") + C + "td>" +
            "<td>" + num(has ? q.mc_total : null, 2) + C + "td>" +
            '<td><span class="' + premCls + '" style="text-align:right;display:block;">' + premDisp + C + "span>" + C + "td>" +
            C + "tr>";

        return { _html: html, _sv: getSortVal() };
    }

    function updateSortHeaders() {
        document.querySelectorAll(".etf-th-sort").forEach(function (th) {
            th.classList.remove("active");
            var a = th.querySelector(".etf-sort-arrow");
            if (a) a.textContent = "⇅";
        });
        var active = document.querySelector('.etf-th-sort[data-etf-col="' + _sortCol + '"]');
        if (active) {
            active.classList.add("active");
            var arr = active.querySelector(".etf-sort-arrow");
            if (arr) arr.textContent = _sortDir === "asc" ? "▲" : "▼";
        }
    }

    /* ── Detail panel (chart) ── */
    function toggleDetail(code) {
        if (_expandedCode === code) { hideDetail(); return; }
        _expandedCode = code;
        renderTable();

        var item = findSymbol(code);
        var q = _quotes[code];
        var name = (q && q.name) || (item ? item.name : code);
        var title = code + " " + name;

        document.getElementById("etfDetailTitle").textContent = title;

        // Stats table — DOM API to avoid Node 24 </ parsing issue
        var tbody = document.querySelector("#etfDetailStats tbody");
        tbody.innerHTML = "";

        // Fund company from item name (ETF_GROUPS shorthand like "华夏", "华泰柏瑞")
        var companyName = (item && item.name) || ((q && q.name) ? q.name : "--");

        var tr = document.createElement("tr");
        function addLbl(v) { var t=document.createElement("td");t.textContent=v;t.className="etf-ds-label";tr.appendChild(t); }
        function addVal(v, cls) { var t=document.createElement("td");t.textContent=v;t.className="etf-ds-val" + (cls ? " "+cls : "");tr.appendChild(t); }

        addLbl("基金公司");
        addVal(companyName);
        addLbl("最新价");
        addVal(q && q.price != null ? q.price.toFixed(3) + " ¥" : "--", "etf-ds-price");

        addPctLabel = function(l, v) {
            addLbl(l);
            if (v==null) addVal("--");
            else { var t=document.createElement("td");t.textContent=(v>0?"+":"")+v.toFixed(2)+"%";t.className="etf-ds-val "+(v>0?"etf-pos":v<0?"etf-neg":"");tr.appendChild(t); }
        };
        addPctLabel("涨跌幅", q ? q.change_pct : null);
        addPctLabel("溢价率", q ? q.premium : null);
        addLbl("换手率");
        addVal(q && q.turnover != null ? q.turnover.toFixed(2)+"%" : "--");
        addLbl("振幅");
        addVal(q && q.amplitude != null ? q.amplitude.toFixed(2)+"%" : "--");
        addLbl("成交额");
        addVal(q && q.amount != null ? (q.amount>=1e8?(q.amount/1e8).toFixed(2)+"亿":(q.amount/1e4).toFixed(0)+"万") : "--");

        tbody.appendChild(tr);

        document.getElementById("etfDetail").style.display = "block";

        // Fetch history and render chart
        fetch("/api/etf-market/history?symbol=" + code + "&days=120")
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.bars && data.bars.length > 0) {
                    _lastChartData = data;
                    var noteEl = document.getElementById("etfPremiumNote");
                    if (noteEl) noteEl.style.display = data.premium_approx ? "" : "none";
                    appendHistoryStats(data.stats);
                    renderChart();
                } else {
                    document.getElementById("etfChartContainer").innerHTML =
                        '<div style="text-align:center;padding:24px;color:var(--apple-text-secondary);">暂无历史数据' + C + 'div>';
                }
            })
            .catch(function () {
                document.getElementById("etfChartContainer").innerHTML =
                    '<div style="text-align:center;padding:24px;color:var(--data-negative);">加载图表失败' + C + 'div>';
            });
    }

    function appendHistoryStats(st) {
        if (!st) return;
        var tbody = document.querySelector("#etfDetailStats tbody");
        if (!tbody) return;
        var tr = document.createElement("tr");
        function addLbl(v) { var t=document.createElement("td");t.textContent=v;t.className="etf-ds-label";tr.appendChild(t); }
        function addVal(v, cls) { var t=document.createElement("td");t.textContent=v;t.className="etf-ds-val"+(cls?" "+cls:"");tr.appendChild(t); }
        function addPctLbl(l, v) {
            addLbl(l);
            if (v==null) addVal("--");
            else { var t=document.createElement("td");t.textContent=(v>0?"+":"")+v.toFixed(2)+"%";t.className="etf-ds-val "+(v>0?"etf-pos":v<0?"etf-neg":"");tr.appendChild(t); }
        }
        function avgFmt(v) { return v==null?"--":v>=1e8?(v/1e8).toFixed(2)+"亿":(v/1e4).toFixed(0)+"万"; }

        addLbl("上市"); addVal((st.first_date||"").slice(0,7));
        addLbl("天数"); addVal((st.days_since_listed||"?")+"天");
        addPctLbl("近1月", st.ret_1m);
        addPctLbl("近3月", st.ret_3m);
        addLbl("日均成交"); addVal(avgFmt(st.avg_daily_amount));

        tbody.appendChild(tr);
    }

    function hideDetail() {
        _expandedCode = null;
        document.getElementById("etfDetail").style.display = "none";
        renderTable();
    }

    function findSymbol(code) {
        for (var k in ETF_GROUPS) {
            for (var i = 0; i < ETF_GROUPS[k].symbols.length; i++) {
                if (ETF_GROUPS[k].symbols[i].code === code) return ETF_GROUPS[k].symbols[i];
            }
        }
        return null;
    }

    /* ── SVG Chart — single selected type ── */
    function renderChart() {
        var bars = _lastChartData.bars;
        var hasPremium = _lastChartData.has_premium;
        if (!bars || !bars.length) return;

        var chartType = activeChartType();
        var W = 900, H = 340;
        var PAD = { top: 20, right: 20, bottom: 36, left: 56 };
        var plotW = W - PAD.left - PAD.right;
        var plotH = H - PAD.top - PAD.bottom;
        var n = bars.length;
        if (n < 1) return;

        var xScale = function (i) { return PAD.left + (i / Math.max(n - 1, 1)) * plotW; };

        var svg = buildChartBody(chartType, bars, hasPremium, W, H, PAD, plotW, plotH, n, xScale);
        if (!svg) return;

        // Crosshair + hover tooltip layer
        var hoverId = "etfHover_" + chartType;
        svg += '<line id="' + hoverId + '_line" x1="0" y1="0" x2="0" y2="' + H + '" stroke="' + CHART_COLORS.crosshair + '" stroke-width="1" stroke-dasharray="4,2" style="display:none;pointer-events:none"' + "/>";
        svg += '<rect id="' + hoverId + '_tip" x="0" y="0" width="160" height="1" rx="6" fill="' + CHART_COLORS.tooltipBg + '" style="display:none;pointer-events:none"' + "/>";
        svg += '<text id="' + hoverId + '_text" x="0" y="0" fill="#fff" font-size="11" style="display:none;pointer-events:none"' + ">" + C + "text>";

        // Invisible hover zones
        var slotW = plotW / Math.max(n - 1, 1);
        for (var i = 0; i < n; i++) {
            var sx = xScale(i) - slotW / 2;
            svg += '<rect x="' + sx + '" y="' + PAD.top + '" width="' + slotW + '" height="' + plotH + '" fill="transparent" data-idx="' + i + '" class="etf-hover-zone"' + "/>";
        }

        document.getElementById("etfChartContainer").innerHTML =
            '<svg id="etfSvg" viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block;font-family:-apple-system,SF Pro Text,Helvetica,Arial,sans-serif;">' +
            svg + C + "svg>";

        // Attach hover handlers
        var svgEl = document.getElementById("etfSvg");
        if (svgEl) {
            var tipLine = document.getElementById(hoverId + "_line");
            var tipRect = document.getElementById(hoverId + "_tip");
            var tipText = document.getElementById(hoverId + "_text");

            svgEl.addEventListener("mousemove", function (e) {
                var rect = svgEl.getBoundingClientRect();
                var mx = (e.clientX - rect.left) / rect.width * W;
                var closestI = 0, closestDist = Infinity;
                for (var i = 0; i < n; i++) {
                    var d = Math.abs(xScale(i) - mx);
                    if (d < closestDist) { closestDist = d; closestI = i; }
                }
                if (closestDist > slotW) { tipLine.style.display = "none"; tipRect.style.display = "none"; tipText.style.display = "none"; return; }

                var cx = xScale(closestI);
                var b = bars[closestI];

                tipLine.setAttribute("x1", cx); tipLine.setAttribute("x2", cx);
                tipLine.style.display = "";

                var fmt = function (label, val, unit) {
                    if (val == null || !isFinite(val)) return label + "：--";
                    var s = val.toFixed(val % 1 === 0 ? 0 : 3);
                    if (unit === "pct") s = (val > 0 ? "+" : "") + val.toFixed(2) + "%";
                    if (unit === "amt") s = (val / 1e8).toFixed(2) + "亿";
                    return label + "：" + s;
                };
                var lines = [
                    "日期：" + b.date,
                    fmt("最高价", b.high),
                    fmt("开盘价", b.open),
                    fmt("最低价", b.low),
                    fmt("收盘价", b.close),
                    fmt("涨跌幅", b.change_pct, "pct"),
                    fmt("溢价率", b.premium_pct, "pct"),
                    fmt("振幅", b.amplitude_pct, "pct"),
                    fmt("成交额", b.amount, "amt"),
                ];

                var tipW = 155, lineH = 13, tipH = lineH * lines.length + 14;
                var tipX = cx + 10, tipY = PAD.top + 4;
                if (tipX + tipW > W - PAD.right) tipX = cx - tipW - 10;

                tipRect.setAttribute("x", tipX); tipRect.setAttribute("y", tipY);
                tipRect.setAttribute("width", tipW); tipRect.setAttribute("height", tipH);
                tipRect.style.display = "";

                var tspans = "";
                lines.forEach(function (l, li) {
                    var ty = tipY + lineH + li * lineH + 2;
                    tspans += '<tspan x="' + (tipX + 8) + '" y="' + ty + '">' + l + C + "tspan>";
                });
                tipText.innerHTML = tspans;
                tipText.style.display = "";
            });

            svgEl.addEventListener("mouseleave", function () {
                tipLine.style.display = "none";
                tipRect.style.display = "none";
                tipText.style.display = "none";
            });
        }
    }


    /* ── buildChartBody — single-type chart rendering ── */
    function buildChartBody(chartType, bars, hasPremium, W, H, PAD, plotW, plotH, n, xScale) {
        var svg = '<rect width="' + W + '" height="' + H + '" fill="transparent"' + "/>";
        var gridLines = 5;

        // ── CANDLESTICK ──
        if (chartType === "candle") {
            var minV = Infinity, maxV = -Infinity;
            for (var i = 0; i < n; i++) {
                if (bars[i].low < minV) minV = bars[i].low;
                if (bars[i].high > maxV) maxV = bars[i].high;
            }
            var pad = (maxV - minV) * 0.06 || 0.1;
            minV -= pad; maxV += pad;
            var vRange = maxV - minV;
            var yScale = function (v) { return PAD.top + plotH - ((v - minV) / vRange) * plotH; };

            for (var g = 0; g <= gridLines; g++) {
                var val = minV + (vRange / gridLines) * g;
                var y = yScale(val);
                svg += '<line x1="' + PAD.left + '" y1="' + y + '" x2="' + (W - PAD.right) + '" y2="' + y + '" stroke="' + CHART_COLORS.grid + '" stroke-width="0.5"' + "/>";
                svg += '<text x="' + (PAD.left - 6) + '" y="' + (y + 4) + '" fill="' + CHART_COLORS.textDim + '" font-size="10" text-anchor="end">' + val.toFixed(2) + C + "text>";
            }

            var slotW = Math.min(plotW / n, 10);
            for (var i = 0; i < n; i++) {
                var b = bars[i], cx = xScale(i);
                var isUp = b.close >= b.open;
                var color = isUp ? CHART_COLORS.candleUp : CHART_COLORS.candleDown;
                var yHigh = yScale(b.high), yLow = yScale(b.low);
                var yOpen = yScale(b.open), yClose = yScale(b.close);

                svg += '<line x1="' + cx + '" y1="' + yHigh + '" x2="' + cx + '" y2="' + yLow + '" stroke="' + color + '" stroke-width="1"' + "/>";
                var bodyH = Math.abs(yClose - yOpen);
                var bodyW = Math.max(slotW * 0.65, 1.5);
                if (bodyH < 0.5) bodyH = 0.5;
                var bodyTop = isUp ? yClose : yOpen;
                svg += '<rect x="' + (cx - bodyW / 2) + '" y="' + bodyTop + '" width="' + bodyW + '" height="' + bodyH + '" fill="' + color + '" stroke="' + color + '" stroke-width="0.5"' + "/>";
            }
            svg += '<text x="' + (PAD.left + 4) + '" y="' + (PAD.top + 11) + '" fill="' + CHART_COLORS.text + '" font-size="10">蜡烛图 (OHLC)' + C + "text>";
            svg = addXAxis(svg, bars, n, xScale, H, PAD);
            return svg;
        }

        // ── LINE CHARTS (change%, premium, amplitude, amount) ──
        var values = [], label = "", unit = "", color = "rgba(255,255,255,0.7)", symmetric = false;

        if (chartType === "change") {
            for (var i = 0; i < n; i++) values.push(bars[i].change_pct);
            label = "涨跌幅"; unit = "%"; color = "#5ac8fa"; symmetric = true;
        } else if (chartType === "premium") {
            for (var i = 0; i < n; i++) values.push(bars[i].premium_pct);
            label = "溢价率"; unit = "%"; color = "#ff9f0a"; symmetric = false;
        } else if (chartType === "amplitude") {
            for (var i = 0; i < n; i++) values.push(bars[i].amplitude_pct);
            label = "振幅"; unit = "%"; color = "#bf5af2";
        } else if (chartType === "amount") {
            for (var i = 0; i < n; i++) values.push(bars[i].amount);
            label = "成交额"; unit = "亿"; color = "#30d158";
        } else {
            return null;
        }

        var validVals = values.filter(function (v) { return v != null && isFinite(v); });
        if (!validVals.length) return null;

        // Uniform 15% padding for all chart types
        var dataMin = Math.min.apply(null, validVals);
        var dataMax = Math.max.apply(null, validVals);
        if (dataMin === dataMax) { dataMin -= 1; dataMax += 1; }
        var dpad = (dataMax - dataMin) * 0.15 || 1;
        if (symmetric) {
            var absMax = Math.max(Math.abs(dataMin), Math.abs(dataMax)) + dpad;
            dataMax = absMax;
            dataMin = -absMax;
        } else {
            if (chartType === "amount") dataMin = 0;
            if (chartType === "amplitude") dataMin = Math.max(0, dataMin - dpad);
            else dataMin -= dpad;
            dataMax += dpad;
        }
        var dRange = dataMax - dataMin;
        var ly = function (v) { return PAD.top + plotH - ((v - dataMin) / dRange) * plotH; };

        // Grid + Y labels
        for (var g = 0; g <= gridLines; g++) {
            var val = dataMin + (dRange / gridLines) * g;
            var y = ly(val);
            svg += '<line x1="' + PAD.left + '" y1="' + y + '" x2="' + (W - PAD.right) + '" y2="' + y + '" stroke="' + CHART_COLORS.grid + '" stroke-width="0.5"' + "/>";
            var lbl;
            if (chartType === "amount") lbl = (val / 1e8).toFixed(1);
            else lbl = val.toFixed(1) + unit;
            svg += '<text x="' + (PAD.left - 6) + '" y="' + (y + 4) + '" fill="' + CHART_COLORS.textDim + '" font-size="10" text-anchor="end">' + lbl + C + "text>";
        }

        // Zero line for symmetric charts
        if (symmetric) {
            var zy = ly(0);
            svg += '<line x1="' + PAD.left + '" y1="' + zy + '" x2="' + (W - PAD.right) + '" y2="' + zy + '" stroke="' + CHART_COLORS.textDim + '" stroke-width="0.5" stroke-dasharray="3,3"' + "/>";
        }

        // Data line
        var path = "";
        for (var i = 0; i < n; i++) {
            if (values[i] == null || !isFinite(values[i])) continue;
            var py = ly(values[i]);
            path += (path ? "L" : "M") + xScale(i).toFixed(1) + "," + py.toFixed(1) + " ";
        }
        if (path) {
            svg += '<path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"' + "/>";
        }

        // Amount: fill area below line
        if (chartType === "amount" && path) {
            var areaPath = path + " L" + xScale(n - 1).toFixed(1) + "," + ly(0).toFixed(1) + " L" + xScale(0).toFixed(1) + "," + ly(0).toFixed(1) + " Z";
            svg += '<path d="' + areaPath + '" fill="rgba(48,209,88,0.08)"' + "/>";
        }

        svg += '<text x="' + (PAD.left + 4) + '" y="' + (PAD.top + 11) + '" fill="' + CHART_COLORS.text + '" font-size="10">' + label + " (" + unit + ")" + C + "text>";
        svg = addXAxis(svg, bars, n, xScale, H, PAD);
        return svg;
    }

    function addXAxis(svg, bars, n, xScale, H, PAD) {
        var labelEvery = Math.max(1, Math.floor(n / 6));
        for (var i = 0; i < n; i++) {
            if (i % labelEvery !== 0 && i !== n - 1) continue;
            var cx = xScale(i);
            var ds = bars[i].date.slice(5);
            svg += '<text x="' + cx + '" y="' + (H - PAD.bottom + 16) + '" fill="' + CHART_COLORS.textDim + '" font-size="9" text-anchor="middle">' + ds + C + "text>";
            svg += '<line x1="' + cx + '" y1="' + (H - PAD.bottom) + '" x2="' + cx + '" y2="' + (H - PAD.bottom + 5) + '" stroke="' + CHART_COLORS.textDim + '" stroke-width="0.5"' + "/>";
        }
        return svg;
    }
})();
