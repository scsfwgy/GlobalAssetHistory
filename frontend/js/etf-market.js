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
        nasdaq100: { label: "纳指100", preset: "cn_etf_nasdaq100", symbols: [] },
        sp500: { label: "标普500", preset: "cn_etf_sp500", symbols: [] },
        global_others: { label: "其它", preset: "cn_etf_others", symbols: [] },
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
        var active = document.querySelector('#etfChartToggles .etf-chart-tab.active');
        return active ? active.dataset.etfChart : "candle";
    }

    /* ── Chart colors — use CSS variable references so SVG auto-adapts to theme changes ── */
    function getEtfChartColors() {
        return {
            candleUp: "#30d158",
            candleDown: "#ff453a",
            grid: 'var(--apple-chart-grid)',
            text: 'var(--apple-chart-text)',
            textDim: 'var(--apple-chart-text-dim)',
            dim: 'var(--apple-chart-text-dim)',
            crosshair: 'var(--apple-chart-crosshair)',
            tooltipBg: 'var(--apple-tooltip-bg)',
            tooltipText: 'var(--apple-tooltip-text)',
            chartColor: 'var(--apple-chart-color)',
        };
    }

    function loadEtfGroupsFromConfig() {
        return fetch(CONFIG_ENDPOINT)
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (cfg) {
                var presets = cfg && cfg.presets ? cfg.presets : [];
                for (var key in ETF_GROUPS) {
                    var presetKey = ETF_GROUPS[key].preset;
                    var preset = presets.find(function (p) { return p.key === presetKey; });
                    ETF_GROUPS[key].symbols = (preset && preset.symbols ? preset.symbols : []).map(function (s) {
                        return { code: s.symbol, name: s.name || s.symbol };
                    });
                }
            })
            .catch(function () {
                for (var key in ETF_GROUPS) ETF_GROUPS[key].symbols = [];
            });
    }

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
        document.querySelectorAll("#etfChartToggles .etf-chart-tab").forEach(function (btn) {
            btn.addEventListener("click", function (e) {
                e.stopPropagation();
                document.querySelectorAll("#etfChartToggles .etf-chart-tab").forEach(function (b) { b.classList.remove("active"); });
                btn.classList.add("active");
                if (_expandedCode) renderChart();
            });
        });

        loadEtfGroupsFromConfig().then(fetchQuotes);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    // Hook into theme-switch refresh chain (follows same pattern as vix-chart.js)
    var _origEtfRefresh = window._refreshCharts;
    window._refreshCharts = function () {
        if (typeof _origEtfRefresh === "function") _origEtfRefresh();
        if (typeof window._refreshEtfChart === "function") window._refreshEtfChart();
    };

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
                document.getElementById("etfBody").innerHTML = '<tr><td colspan="12" style="text-align:center;padding:24px;color:var(--data-negative)">获取行情失败' + C + 'td>' + C + 'tr>';
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
            if (_sortCol === "mgmt_fee" || _sortCol === "custody_fee") {
                if (!has || !q[_sortCol]) return null;
                var p = parseFloat(q[_sortCol]);
                return isNaN(p) ? null : p;
            }
            if (has) return q[_sortCol] != null ? q[_sortCol] : null;
            return null;
        };

        // --- Cell helpers ---
        var R = ' style="text-align:right;"';  // right-align attr for numeric <td>

        var num = function (val, dec, unit) {
            if (val == null) return '<td' + R + '><span style="color:var(--apple-text-tertiary);">--' + C + 'span>' + C + 'td>';
            var d = val.toFixed(dec);
            if (unit === "%") d += "%";
            else if (unit) d += unit;
            return '<td' + R + '>' + d + C + 'td>';
        };

        // Standard: green-up / red-down (涨跌幅, 溢价万元盈亏)
        var pctCell = function (val, dec, unit) {
            if (val == null) return '<td' + R + '><span style="color:var(--apple-text-tertiary);">--' + C + 'span>' + C + 'td>';
            var cls = val > 0 ? "etf-pos" : val < 0 ? "etf-neg" : "";
            var d = (val > 0 ? "+" : "") + val.toFixed(dec);
            if (unit === "%") d += "%";
            else if (unit) d += unit;
            return '<td' + R + ' class="' + cls + '">' + d + C + 'td>';
        };

        // Cost columns: positive = loss (RED), negative = gain (GREEN)  — inverted
        var costPctCell = function (val, dec) {
            if (val == null) return '<td' + R + '><span style="color:var(--apple-text-tertiary);">--' + C + 'span>' + C + 'td>';
            var cls = val > 0 ? "etf-neg" : val < 0 ? "etf-pos" : "";
            var d = (val > 0 ? "+" : "") + val.toFixed(dec) + "%";
            return '<td' + R + ' class="' + cls + '">' + d + C + 'td>';
        };

        var costNumCell = function (val, dec, unit) {
            if (val == null) return '<td' + R + '><span style="color:var(--apple-text-tertiary);">--' + C + 'span>' + C + 'td>';
            var cls = val > 0 ? "etf-neg" : val < 0 ? "etf-pos" : "";
            var d = (val > 0 ? "+" : "") + val.toFixed(dec) + (unit || "");
            return '<td' + R + ' class="' + cls + '">' + d + C + 'td>';
        };

        var badge = has ? '<span class="etf-badge-' + q.market.toLowerCase() + '">' + q.market + C + 'span> ' : "";
        var name = (has && q.name) ? q.name : item.name;
        var expandedCls = (_expandedCode === code) ? " expanded" : "";

        // Fee display (strings like "0.60%")
        var feeStrCell = function (val) {
            if (!val) return '<td' + R + '><span style="color:var(--apple-text-tertiary);">--' + C + 'span>' + C + 'td>';
            return '<td' + R + '>' + val + C + 'td>';
        };

        // Columns: 代码 | 名称 | 最新价 | 涨跌幅 | 总市值(亿) | 管理费 | 托管费 | 费率合计 | 万元年费 | 溢价率 | 溢价万元盈亏
        var html =
            '<tr class="etf-row' + expandedCls + '" data-etf-code="' + code + '">' +
            "<td>" + badge + code + C + "td>" +
            "<td>" + name + C + "td>" +
            "<td style=\"font-weight:600;text-align:right;\">" + (has && q.price != null ? q.price.toFixed(3) : '<span style="color:var(--apple-text-tertiary);">--' + C + 'span>') + C + "td>" +
            pctCell(has ? q.change_pct : null, 2, "%") +
            num(has ? q.mc_total : null, 2) +
            feeStrCell(has ? q.mgmt_fee : null) +
            feeStrCell(has ? q.custody_fee : null) +
            num(has ? q.total_fee : null, 2, "%") +
            num(has ? q.fee_per_10k : null, 0, "元") +
            costPctCell(has ? q.premium : null, 2) +
            pctCell(has ? q.premium_cost_per_10k : null, 0, "元") +
            pctCell(has ? q.tracking_error_30d_pct : null, 2, "%") +
            pctCell(has ? q.profit_diff_30d_per_10k : null, 0, "元") +
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

        // Row 1 — matches table: 代码 | 名称 | 最新价 | 涨跌幅 | 总市值 | 管理费 | 托管费 | 费率合计 | 万元年费 | 溢价率 | 溢价万元盈亏 | 追踪误差
        var tr1 = document.createElement("tr");
        function addLbl(v) { var t=document.createElement("td");t.textContent=v;t.className="etf-ds-label";tr1.appendChild(t); }
        function addTipLbl(v, tip) { var t=document.createElement("td");t.textContent=v;t.className="etf-ds-label has-tip";t.title=tip;tr1.appendChild(t); }
        function addVal(v, cls) { var t=document.createElement("td");t.textContent=v;t.className="etf-ds-val" + (cls ? " "+cls : "");tr1.appendChild(t); }
        // Standard: green-up / red-down
        function addStdPct(l, v) {
            addLbl(l);
            if (v==null) addVal("--");
            else addVal((v>0?"+":"")+v.toFixed(2)+"%", v>0?"etf-pos":v<0?"etf-neg":"");
        }
        // Cost columns: positive = loss (RED), negative = gain (GREEN)
        function addCostPct(l, v) {
            addLbl(l);
            if (v==null) addVal("--");
            else addVal((v>0?"+":"")+v.toFixed(2)+"%", v>0?"etf-neg":v<0?"etf-pos":"");
        }

        addLbl("代码"); addVal(code);
        addLbl("名称"); addVal(name);
        addLbl("最新价"); addVal(q && q.price != null ? q.price.toFixed(3) + " ¥" : "--", "etf-ds-price");
        addStdPct("涨跌幅", q ? q.change_pct : null);
        addLbl("总市值(亿)"); addVal(q && q.mc_total != null ? q.mc_total.toFixed(2) : "--");
        addLbl("管理费"); addVal(q && q.mgmt_fee ? q.mgmt_fee : "--");
        addLbl("托管费"); addVal(q && q.custody_fee ? q.custody_fee : "--");
        addLbl("费率合计"); addVal(q && q.total_fee != null ? q.total_fee.toFixed(2)+"%" : "--");
        addLbl("万元年费"); addVal(q && q.fee_per_10k != null ? q.fee_per_10k.toFixed(0)+"元" : "--");
        addCostPct("溢价率", q ? q.premium : null);
        // Premium cost: negative = loss (RED), positive = gain/savings (GREEN)
        addLbl("溢价万元盈亏");
        if (q && q.premium_cost_per_10k != null) {
            var pc = q.premium_cost_per_10k;
            var sign = pc > 0 ? "+" : "";
            addVal(sign + pc.toFixed(0) + "元", pc < 0 ? "etf-neg" : pc > 0 ? "etf-pos" : "");
        } else {
            addVal("--");
        }
        var tracking30Tip = "30日真实误差：最近30个共同交易日，A股ETF价格涨跌幅与美股基准ETF(QQQ/SPY)涨跌幅的累计差值。正数=A股ETF跑赢，负数=跑输。⚠️ 含溢价波动，非纯跟踪能力。";
        var diff30Tip = "30日万元收益差：最近30个共同交易日，分别投入1万元到当前A股ETF和对应美股ETF后的收益差额。正数=多赚，负数=少赚。";
        addTipLbl("30日真实误差", tracking30Tip);
        if (q && q.tracking_error_30d_pct != null) addVal((q.tracking_error_30d_pct>0?"+":"") + q.tracking_error_30d_pct.toFixed(2)+"%", q.tracking_error_30d_pct>0?"etf-pos":q.tracking_error_30d_pct<0?"etf-neg":"");
        else addVal("--");
        addTipLbl("30日万元收益差", diff30Tip);
        if (q && q.profit_diff_30d_per_10k != null) addVal((q.profit_diff_30d_per_10k>0?"+":"") + q.profit_diff_30d_per_10k.toFixed(0)+"元", q.profit_diff_30d_per_10k>0?"etf-pos":q.profit_diff_30d_per_10k<0?"etf-neg":"");
        else addVal("--");

        tbody.appendChild(tr1);

        document.getElementById("etfDetail").classList.add("open");

        // Fetch history and render chart
        fetch("/api/etf-market/history?symbol=" + code + "&days=120")
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.bars && data.bars.length > 0) {
                    _lastChartData = data;
                    var noteEl = document.getElementById("etfPremiumNote");
                    if (noteEl) noteEl.style.display = data.premium_approx ? "" : "none";
                    appendHistoryStats(data.stats, q);
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

    function appendHistoryStats(st, q) {
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
        function amtFmt(v) { return v==null?"--":v>=1e8?(v/1e8).toFixed(2)+"亿":(v/1e4).toFixed(0)+"万"; }
        function volFmt(v) { return v==null?"--":(v/10000).toFixed(1)+"万手"; }

        // Row 2 — supplementary: 基金公司 | 上市 | 天数 | 近1月 | 近3月 | 开盘 | 最高 | 最低 | 振幅 | 成交量 | 成交额 | 换手率
        addLbl("基金公司"); addVal(st.company || "--");
        addLbl("上市"); addVal((st.first_date||"").slice(0,7));
        addLbl("天数"); addVal((st.days_since_listed||"?")+"天");
        addPctLbl("近1月", st.ret_1m);
        addPctLbl("近3月", st.ret_3m);
        addLbl("开盘"); addVal(q && q.open != null ? q.open.toFixed(3) : "--");
        addLbl("最高"); addVal(q && q.high != null ? q.high.toFixed(3) : "--");
        addLbl("最低"); addVal(q && q.low != null ? q.low.toFixed(3) : "--");
        addLbl("振幅"); addVal(q && q.amplitude != null ? q.amplitude.toFixed(2)+"%" : "--");
        addLbl("成交量"); addVal(volFmt(q ? q.volume : null));
        addLbl("成交额"); addVal(amtFmt(q ? q.amount : null));
        addLbl("换手率"); addVal(q && q.turnover != null ? q.turnover.toFixed(2)+"%" : "--");

        tbody.appendChild(tr);

        // Row 3 — 30日 tracking metrics from history data (more accurate than real-time)
        var tr3 = document.createElement("tr");
        function l3(v, tip) { var t=document.createElement("td");t.textContent=v;t.className="etf-ds-label";if(tip){t.className+=" has-tip";t.title=tip;}tr3.appendChild(t); }
        function v3(v, cls) { var t=document.createElement("td");t.textContent=v;t.className="etf-ds-val"+(cls?" "+cls:"");tr3.appendChild(t); }
        function e3() { v3(""); }

        var bm = st.nav_tracking_benchmark || st.tracking_error_benchmark || "QQQ/SPY";

        // 30日真实误差 (price-level cumulative, from history)
        l3("30日真实误差", "基于历史数据的30日真实误差：A股ETF价格涨跌幅 vs " + bm + "涨跌幅的累计差值。反映实际持有体验，含溢价波动影响。");
        if (st.tracking_error_30d_pct != null) v3((st.tracking_error_30d_pct>0?"+":"") + st.tracking_error_30d_pct.toFixed(2) + "%", st.tracking_error_30d_pct>0?"etf-pos":"etf-neg");
        else v3("--");

        // 30日追踪误差 (NAV-level MAE, NEW)
        l3("30日追踪误差", "基于净值的30日追踪紧度：基金净值日收益率 vs " + bm + "指数日收益率偏差的绝对值均值。纯净值层面衡量基金跟踪能力，不含溢价噪声。越低越好：<0.05%极紧，<0.15%正常，>0.30%偏松。");
        if (st.nav_tracking_mae_30d != null) {
            var mae = st.nav_tracking_mae_30d;
            v3(mae.toFixed(3) + "%", mae <= 0.10 ? "etf-pos" : mae <= 0.25 ? "" : "etf-neg");
        } else v3("--");

        // 30日万元收益差 (compound profit diff)
        l3("30日万元收益差", "最近30日，分别投入1万元到此A股ETF vs " + bm + "的累计收益差额。正数=多赚，负数=少赚。");
        if (st.profit_diff_30d_per_10k != null) v3((st.profit_diff_30d_per_10k>0?"+":"") + st.profit_diff_30d_per_10k.toFixed(0) + "元", st.profit_diff_30d_per_10k>0?"etf-pos":"etf-neg");
        else v3("--");

        // Fill remaining cells to match table width
        for (var fi = 0; fi < 7; fi++) e3();

        tbody.appendChild(tr3);
    }

    function hideDetail() {
        _expandedCode = null;
        document.getElementById("etfDetail").classList.remove("open");
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

    // Expose for theme-toggle re-render
    window._refreshEtfChart = function () {
        if (_expandedCode && _lastChartData && _lastChartData.bars) renderChart();
    };

    /* ── SVG Chart — single selected type ── */
    function renderChart() {
        var bars = _lastChartData.bars;
        var hasPremium = _lastChartData.has_premium;
        if (!bars || !bars.length) return;

        var CLR = getEtfChartColors();
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
        svg += '<line id="' + hoverId + '_line" x1="0" y1="0" x2="0" y2="' + H + '" stroke="' + CLR.crosshair + '" stroke-width="1" stroke-dasharray="4,2" style="display:none;pointer-events:none"' + "/>";
        svg += '<rect id="' + hoverId + '_tip" x="0" y="0" width="160" height="1" rx="6" fill="' + CLR.tooltipBg + '" style="display:none;pointer-events:none"' + "/>";
        svg += '<text id="' + hoverId + '_text" x="0" y="0" fill="' + CLR.tooltipText + '" font-size="11" style="display:none;pointer-events:none"' + ">" + C + "text>";

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
                    if (unit === "yuan") s = (val > 0 ? "+" : "") + val.toFixed(0) + "元";
                    return label + "：" + s;
                };
                var lines;
                if (chartType === "compare") {
                    lines = [
                        "日期：" + b.date,
                        fmt("ETF收益", b.etf_profit_per_10k, "yuan"),
                        fmt("基准收益", b.benchmark_profit_per_10k, "yuan"),
                        fmt("收益差", b.profit_diff_per_10k, "yuan"),
                    ];
                } else if (chartType === "tracking3") {
                    lines = [
                        "日期：" + b.date,
                        fmt("收盘价", b.close),
                        fmt("涨跌幅", b.change_pct, "pct"),
                        fmt("溢价率", b.premium_pct, "pct"),
                        fmt("真实误差(价格级)", b.price_tracking_deviation_pct, "pct"),
                        fmt("追踪误差(净值级)", b.nav_tracking_deviation_pct, "pct"),
                    ];
                } else {
                    lines = [
                        "日期：" + b.date,
                        fmt("最高价", b.high),
                        fmt("开盘价", b.open),
                        fmt("最低价", b.low),
                        fmt("收盘价", b.close),
                        fmt("涨跌幅", b.change_pct, "pct"),
                        fmt("溢价率", b.premium_pct, "pct"),
                        fmt("净值偏离", b.nav_tracking_deviation_pct, "pct"),
                        fmt("真实误差", b.tracking_error_pct, "pct"),
                        fmt("振幅", b.amplitude_pct, "pct"),
                        fmt("成交额", b.amount, "amt"),
                    ];
                }

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
        var CLR = getEtfChartColors();
        var svg = '<rect width="' + W + '" height="' + H + '" fill="transparent"' + "/>";
        var gridLines = 5;

        // ── COMPARE: ETF cumulative return vs benchmark cumulative return ──
        if (chartType === "compare") {
            var etfVals = [], benchmarkVals = [], allVals = [];
            for (var i = 0; i < n; i++) {
                etfVals.push(bars[i].etf_profit_per_10k);
                benchmarkVals.push(bars[i].benchmark_profit_per_10k);
                if (bars[i].etf_profit_per_10k != null && isFinite(bars[i].etf_profit_per_10k)) allVals.push(bars[i].etf_profit_per_10k);
                if (bars[i].benchmark_profit_per_10k != null && isFinite(bars[i].benchmark_profit_per_10k)) allVals.push(bars[i].benchmark_profit_per_10k);
            }
            if (!allVals.length) return null;
            var minR = Math.min.apply(null, allVals), maxR = Math.max.apply(null, allVals);
            if (minR === maxR) { minR -= 1; maxR += 1; }
            var padR = (maxR - minR) * 0.15 || 1;
            minR -= padR; maxR += padR;
            var rRange = maxR - minR;
            var ry = function (v) { return PAD.top + plotH - ((v - minR) / rRange) * plotH; };

            for (var g = 0; g <= gridLines; g++) {
                var val = minR + (rRange / gridLines) * g;
                var y = ry(val);
                svg += '<line x1="' + PAD.left + '" y1="' + y + '" x2="' + (W - PAD.right) + '" y2="' + y + '" stroke="' + CLR.grid + '" stroke-width="0.5"' + "/>";
                svg += '<text x="' + (PAD.left - 6) + '" y="' + (y + 4) + '" fill="' + CLR.textDim + '" font-size="10" text-anchor="end">' + val.toFixed(0) + '元' + C + "text>";
            }
            var zeroY = ry(0);
            if (zeroY >= PAD.top && zeroY <= PAD.top + plotH) {
                svg += '<line x1="' + PAD.left + '" y1="' + zeroY + '" x2="' + (W - PAD.right) + '" y2="' + zeroY + '" stroke="' + CLR.textDim + '" stroke-width="0.5" stroke-dasharray="3,3"' + "/>";
            }
            function linePath(vals) {
                var p = "";
                for (var j = 0; j < n; j++) {
                    if (vals[j] == null || !isFinite(vals[j])) continue;
                    p += (p ? "L" : "M") + xScale(j).toFixed(1) + "," + ry(vals[j]).toFixed(1) + " ";
                }
                return p;
            }
            var etfPath = linePath(etfVals);
            var benchmarkPath = linePath(benchmarkVals);
            if (etfPath) svg += '<path d="' + etfPath + '" fill="none" stroke="#2997ff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"' + "/>";
            if (benchmarkPath) svg += '<path d="' + benchmarkPath + '" fill="none" stroke="#ff9f0a" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"' + "/>";
            var benchmarkName = _lastChartData && _lastChartData.stats && _lastChartData.stats.tracking_error_benchmark ? _lastChartData.stats.tracking_error_benchmark : "基准";
            // Legend: larger indicators + readable spacing
            svg += '<rect x="' + (PAD.left + 4) + '" y="7" width="10" height="10" rx="3" fill="#2997ff"' + "/>";
            svg += '<text x="' + (PAD.left + 20) + '" y="16" fill="' + CLR.text + '" font-size="11">A股ETF万元收益' + C + "text>";
            svg += '<rect x="' + (PAD.left + 140) + '" y="7" width="10" height="10" rx="3" fill="#ff9f0a"' + "/>";
            svg += '<text x="' + (PAD.left + 156) + '" y="16" fill="' + CLR.text + '" font-size="11">' + benchmarkName + '万元收益' + C + "text>";
            svg = addXAxis(svg, bars, n, xScale, H, PAD, CLR);
            return svg;
        }

        // ── TRACKING3: 溢价率 + 真实误差(价格级) + 追踪误差(净值级) 三线 ──
        if (chartType === "tracking3") {
            var series = [
                { key: "premium_pct", label: "溢价率", color: "#ff9f0a", unit: "%" },
                { key: "price_tracking_deviation_pct", label: "真实误差", color: "#5ac8fa", unit: "%" },
                { key: "nav_tracking_deviation_pct", label: "追踪误差", color: "#30d158", unit: "%" },
            ];
            var allVals = [], seriesData = [];
            for (var s = 0; s < series.length; s++) {
                var vals = [];
                for (var i = 0; i < n; i++) {
                    var v = bars[i][series[s].key];
                    vals.push(v != null && isFinite(v) ? v : null);
                    if (v != null && isFinite(v)) allVals.push(v);
                }
                seriesData.push(vals);
            }
            if (!allVals.length) return null;

            // Shared Y range: symmetric around 0, covering all series
            var absMax = Math.max(Math.abs(Math.min.apply(null, allVals)), Math.abs(Math.max.apply(null, allVals)));
            absMax = Math.max(absMax, 1); // minimum range
            absMax *= 1.15; // 15% padding
            var dMin = -absMax, dMax = absMax, dRange = dMax - dMin;
            var ly = function (v) { return PAD.top + plotH - ((v - dMin) / dRange) * plotH; };

            // Grid + Y labels
            for (var g = 0; g <= gridLines; g++) {
                var val = dMin + (dRange / gridLines) * g;
                var y = ly(val);
                svg += '<line x1="' + PAD.left + '" y1="' + y + '" x2="' + (W - PAD.right) + '" y2="' + y + '" stroke="' + CLR.grid + '" stroke-width="0.5"' + "/>";
                svg += '<text x="' + (PAD.left - 6) + '" y="' + (y + 4) + '" fill="' + CLR.textDim + '" font-size="10" text-anchor="end">' + val.toFixed(1) + "%" + C + "text>";
            }
            // Zero line
            var zy = ly(0);
            svg += '<line x1="' + PAD.left + '" y1="' + zy + '" x2="' + (W - PAD.right) + '" y2="' + zy + '" stroke="' + CLR.textDim + '" stroke-width="0.5" stroke-dasharray="3,3"' + "/>";

            // Draw three lines
            for (var s = 0; s < series.length; s++) {
                var path = "";
                for (var i = 0; i < n; i++) {
                    if (seriesData[s][i] == null) continue;
                    var py = ly(seriesData[s][i]);
                    path += (path ? "L" : "M") + xScale(i).toFixed(1) + "," + py.toFixed(1) + " ";
                }
                if (path) {
                    svg += '<path d="' + path + '" fill="none" stroke="' + series[s].color + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"' + "/>";
                }
            }

            // Legend
            var lx = PAD.left + 4, lyOff = PAD.top + 12;
            for (var s = 0; s < series.length; s++) {
                svg += '<rect x="' + lx + '" y="' + (lyOff - 9) + '" width="28" height="3" fill="' + series[s].color + '" rx="1"' + "/>";
                lx += 32;
                svg += '<text x="' + lx + '" y="' + lyOff + '" fill="' + CLR.text + '" font-size="10">' + series[s].label + C + "text>";
                lx += series[s].label.length * 10 + 14;
            }

            // Hover markers — small circles at each data point for the hovered index
            var hoverId3 = "etfHover_tracking3";
            for (var s = 0; s < series.length; s++) {
                svg += '<circle id="' + hoverId3 + '_dot' + s + '" cx="0" cy="0" r="3" fill="' + series[s].color + '" style="display:none;pointer-events:none"' + "/>";
            }
            // Store series info for tooltip
            svg += '<!-- tracking3_series:' + JSON.stringify(series.map(function(s){return s.key;})) + '-->';

            svg = addXAxis(svg, bars, n, xScale, H, PAD, CLR);
            return svg;
        }

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
                svg += '<line x1="' + PAD.left + '" y1="' + y + '" x2="' + (W - PAD.right) + '" y2="' + y + '" stroke="' + CLR.grid + '" stroke-width="0.5"' + "/>";
                svg += '<text x="' + (PAD.left - 6) + '" y="' + (y + 4) + '" fill="' + CLR.textDim + '" font-size="10" text-anchor="end">' + val.toFixed(2) + C + "text>";
            }

            var slotW = Math.min(plotW / n, 10);
            for (var i = 0; i < n; i++) {
                var b = bars[i], cx = xScale(i);
                var isUp = b.close >= b.open;
                var color = isUp ? CLR.candleUp : CLR.candleDown;
                var yHigh = yScale(b.high), yLow = yScale(b.low);
                var yOpen = yScale(b.open), yClose = yScale(b.close);

                svg += '<line x1="' + cx + '" y1="' + yHigh + '" x2="' + cx + '" y2="' + yLow + '" stroke="' + color + '" stroke-width="1"' + "/>";
                var bodyH = Math.abs(yClose - yOpen);
                var bodyW = Math.max(slotW * 0.65, 1.5);
                if (bodyH < 0.5) bodyH = 0.5;
                var bodyTop = isUp ? yClose : yOpen;
                svg += '<rect x="' + (cx - bodyW / 2) + '" y="' + bodyTop + '" width="' + bodyW + '" height="' + bodyH + '" fill="' + color + '" stroke="' + color + '" stroke-width="0.5"' + "/>";
            }
            svg += '<text x="' + (PAD.left + 4) + '" y="' + (PAD.top + 12) + '" fill="' + CLR.text + '" font-size="11">蜡烛图 (OHLC)' + C + "text>";
            svg = addXAxis(svg, bars, n, xScale, H, PAD, CLR);
            return svg;
        }

        // ── LINE CHARTS (change%, premium, tracking error, amplitude, amount) ──
        var values = [], label = "", unit = "", color = CLR.chartColor, symmetric = false;

        if (chartType === "change") {
            for (var i = 0; i < n; i++) values.push(bars[i].change_pct);
            label = "涨跌幅"; unit = "%"; color = "#5ac8fa"; symmetric = true;
        } else if (chartType === "premium") {
            for (var i = 0; i < n; i++) values.push(bars[i].premium_pct);
            label = "溢价率"; unit = "%"; color = "#ff9f0a"; symmetric = false;
        } else if (chartType === "tracking") {
            for (var i = 0; i < n; i++) values.push(bars[i].tracking_error_pct);
            label = "追踪误差"; unit = "%"; color = "#64d2ff";
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
            svg += '<line x1="' + PAD.left + '" y1="' + y + '" x2="' + (W - PAD.right) + '" y2="' + y + '" stroke="' + CLR.grid + '" stroke-width="0.5"' + "/>";
            var lbl;
            if (chartType === "amount") lbl = (val / 1e8).toFixed(1);
            else lbl = val.toFixed(1) + unit;
            svg += '<text x="' + (PAD.left - 6) + '" y="' + (y + 4) + '" fill="' + CLR.textDim + '" font-size="10" text-anchor="end">' + lbl + C + "text>";
        }

        // Zero line for symmetric charts
        if (symmetric) {
            var zy = ly(0);
            svg += '<line x1="' + PAD.left + '" y1="' + zy + '" x2="' + (W - PAD.right) + '" y2="' + zy + '" stroke="' + CLR.textDim + '" stroke-width="0.5" stroke-dasharray="3,3"' + "/>";
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

        svg += '<text x="' + (PAD.left + 4) + '" y="' + (PAD.top + 12) + '" fill="' + CLR.text + '" font-size="11">' + label + " (" + unit + ")" + C + "text>";
        svg = addXAxis(svg, bars, n, xScale, H, PAD, CLR);
        return svg;
    }

    function addXAxis(svg, bars, n, xScale, H, PAD, CLR) {
        var labelEvery = Math.max(1, Math.floor(n / 6));
        for (var i = 0; i < n; i++) {
            if (i % labelEvery !== 0 && i !== n - 1) continue;
            var cx = xScale(i);
            var ds = bars[i].date.slice(5);
            svg += '<text x="' + cx + '" y="' + (H - PAD.bottom + 16) + '" fill="' + CLR.textDim + '" font-size="9" text-anchor="middle">' + ds + C + "text>";
            svg += '<line x1="' + cx + '" y1="' + (H - PAD.bottom) + '" x2="' + cx + '" y2="' + (H - PAD.bottom + 5) + '" stroke="' + CLR.textDim + '" stroke-width="0.5"' + "/>";
        }
        return svg;
    }
})();
