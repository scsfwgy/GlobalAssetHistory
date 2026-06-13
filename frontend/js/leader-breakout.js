/** A-share leader breakout analysis — 龙头股回调冲击新高统计.
 *
 *  Flow:
 *   1. POST triggers background scan → returns immediately
 *   2. If "scanning": poll GET every 5s until results arrive
 *   3. If results cached: render immediately
 *   4. On tab activation: auto-GET to check for cached results
 */

(function () {
    /* ── DOM refs ── */
    const btnRun = document.getElementById("lbRunBtn");
    const loadingEl = document.getElementById("lbLoading");
    const errorEl = document.getElementById("lbError");
    const resultWrap = document.getElementById("lbResult");
    const summaryDiv = document.getElementById("lbSummary");
    const tableBody = document.getElementById("lbTableBody");
    const tableHead = document.getElementById("lbTableHead");
    const tableWrap = document.getElementById("lbTableWrap");
    const emptyEl = document.getElementById("lbEmpty");
    const statusWrap = document.getElementById("lbStatusWrap");
    const statusText = document.getElementById("lbStatusText");
    const btnExport = document.getElementById("lbExportBtn");

    var _pollTimer = null;
    var _lastParams = null;

    /* ── Helpers ── */

    function getParams() {
        var startEl = document.getElementById("lbStartDate");
        var threshEl = document.getElementById("lbThreshold");
        var minDaysEl = document.getElementById("lbMinDays");
        return {
            start_date: startEl ? (startEl.value || "2024-09-30") : "2024-09-30",
            threshold: threshEl ? (parseFloat(threshEl.value) || 9.5) : 9.5,
            min_consecutive_days: minDaysEl ? (parseInt(minDaysEl.value, 10) || 6) : 6,
        };
    }

    function buildGetUrl(params) {
        return LEADER_BREAKOUT_ENDPOINT + "?start_date=" + encodeURIComponent(params.start_date) +
            "&threshold=" + params.threshold +
            "&min_days=" + params.min_consecutive_days;
    }

    function escapeHtml(str) {
        var div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    function setLoading(show) {
        if (loadingEl) loadingEl.style.display = show ? "flex" : "none";
        if (show && resultWrap) resultWrap.style.display = "none";
    }

    function showError(msg) {
        if (!errorEl) return;
        errorEl.textContent = msg;
        errorEl.style.display = "block";
    }

    function hideError() {
        if (errorEl) errorEl.style.display = "none";
    }

    function showStatus(msg, isScanning) {
        if (!statusWrap) return;
        statusWrap.style.display = "block";
        if (statusText) statusText.textContent = msg || "";
        statusWrap.className = "lb-status-wrap" + (isScanning ? " scanning" : "");
    }

    function hideStatus() {
        if (statusWrap) statusWrap.style.display = "none";
    }

    function stopPolling() {
        if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    }

    /* ── Poll for results ── */

    function startPolling(params) {
        stopPolling();
        showStatus("扫描进行中，约2分钟…完成后自动刷新结果", true);

        _pollTimer = setInterval(function () {
            fetch(buildGetUrl(params))
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    if (data.status === "scanning") {
                        showStatus("扫描进行中，约2分钟…完成后自动刷新结果", true);
                        return;
                    }
                    if (data.status === "idle" || data.status === "error") {
                        // Still waiting for results
                        return;
                    }
                    // Got results or error
                    stopPolling();
                    hideStatus();
                    if (data.error) {
                        showError(data.error);
                        return;
                    }
                    if (data.summary) {
                        render(data);
                    }
                })
                .catch(function () {
                    // Silently retry on network error
                });
        }, 5000);
    }

    /* ── Trigger scan ── */

    function run() {
        hideError();
        hideStatus();
        stopPolling();
        if (resultWrap) resultWrap.style.display = "none";
        setLoading(true);

        var params = getParams();
        _lastParams = params;

        fetch(LEADER_BREAKOUT_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                setLoading(false);
                if (data.error) {
                    showError(data.error);
                    return;
                }
                if (data.status === "scanning") {
                    // Scan started in background — poll for results
                    startPolling(params);
                    return;
                }
                // Got results immediately (cached)
                render(data);
            })
            .catch(function (e) {
                setLoading(false);
                showError(e.message || "网络错误（扫描可能超时，请刷新页面重试）");
            });
    }

    /* ── Auto-check on tab open ── */

    function autoCheck() {
        hideError();
        hideStatus();
        stopPolling();
        if (resultWrap) resultWrap.style.display = "none";

        var params = getParams();
        _lastParams = params;

        fetch(buildGetUrl(params))
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.summary) {
                    // Cached results available → render immediately
                    render(data);
                    return;
                }
                if (data.status === "scanning") {
                    // Scan in progress → start polling
                    startPolling(params);
                    return;
                }
                // idle or error — show nothing, user needs to click "开始扫描"
            })
            .catch(function () {
                // Silently ignore — user can manually trigger scan
            });
    }

    /* ── Render ── */

    function render(data) {
        if (!resultWrap) return;
        resultWrap.style.display = "block";
        if (btnExport) btnExport.style.display = "";
        var s = data.summary;
        var stocks = data.stocks || [];

        // Summary grid
        var recoveredPct = s.qualified > 0 ? Math.round(s.recovered / s.qualified * 100) : 0;
        if (summaryDiv) {
            summaryDiv.innerHTML = '<div class="crash-summary-grid">' +
                '<div class="crash-summary-item"><div class="crash-summary-label">扫描股票</div><div class="crash-summary-val">' + s.total_stocks_scanned + '</div></div>' +
                '<div class="crash-summary-item"><div class="crash-summary-label">符合条件</div><div class="crash-summary-val" style="color:var(--apple-blue);">' + s.qualified + '</div></div>' +
                '<div class="crash-summary-item"><div class="crash-summary-label">已突破前高</div><div class="crash-summary-val" style="color:var(--data-positive);">' + s.recovered + ' (' + recoveredPct + '%)</div></div>' +
                '<div class="crash-summary-item"><div class="crash-summary-label">未突破</div><div class="crash-summary-val" style="color:var(--data-negative);">' + s.not_recovered + '</div></div>' +
                '<div class="crash-summary-item"><div class="crash-summary-label">平均回调天数</div><div class="crash-summary-val">' + (s.avg_pullback_days != null ? s.avg_pullback_days : "—") + '</div></div>' +
                '<div class="crash-summary-item"><div class="crash-summary-label">平均突破天数</div><div class="crash-summary-val">' + (s.avg_breakthrough_days != null ? s.avg_breakthrough_days : "—") + '</div></div>' +
                '</div>';
        }

        // Table header
        if (tableHead) {
            tableHead.innerHTML =
                '<th>股票名称</th>' +
                '<th>首次涨停</th>' +
                '<th>涨停天数</th>' +
                '<th>高峰价格</th>' +
                '<th>次日跌停</th>' +
                '<th>回调天数</th>' +
                '<th>低点价格</th>' +
                '<th>突破天数</th>' +
                '<th>新高价格</th>';
        }

        if (stocks.length === 0) {
            if (tableWrap) tableWrap.style.display = "none";
            if (emptyEl) {
                emptyEl.style.display = "block";
                emptyEl.innerHTML = '<div style="font-size:24px;margin-bottom:8px;">&#128270;</div><div>未找到符合条件的龙头股（连续涨停 ≥6天）</div>';
            }
        } else {
            if (tableWrap) tableWrap.style.display = "block";
            if (emptyEl) emptyEl.style.display = "none";

            var bodyHtml = "";
            stocks.forEach(function (s) {
                var nameHtml = escapeHtml(s.name) + ' <span style="font-size:11px;color:var(--apple-text-tertiary);">' + s.code + '</span>';
                var ldHtml = s.next_day_limit_down
                    ? '<span style="color:var(--data-negative);font-weight:600;">是</span>'
                    : '<span style="color:var(--apple-text-secondary);">否</span>';
                var btHtml = s.breakthrough_days != null
                    ? '<span style="color:var(--data-positive);">' + s.breakthrough_days + '</span>'
                    : '<span style="color:var(--apple-text-tertiary);">—</span>';
                var nhHtml = s.new_high != null
                    ? '<span style="color:var(--data-positive);font-weight:600;">' + s.new_high.toFixed(2) + '</span>'
                    : '<span style="color:var(--apple-text-tertiary);">—</span>';

                bodyHtml += '<tr>' +
                    '<td style="text-align:left;">' + nameHtml + '</td>' +
                    '<td>' + s.first_streak_start + '</td>' +
                    '<td style="font-weight:600;">' + s.consecutive_limit_up_days + '</td>' +
                    '<td>' + s.peak_price.toFixed(2) + '</td>' +
                    '<td>' + ldHtml + '</td>' +
                    '<td>' + s.pullback_days + '</td>' +
                    '<td style="color:var(--data-negative);">' + s.bottom_price.toFixed(2) + '</td>' +
                    '<td>' + btHtml + '</td>' +
                    '<td>' + nhHtml + '</td>' +
                    '</tr>';
            });
            if (tableBody) tableBody.innerHTML = bodyHtml;
        }
    }

    /* ── Export Excel ── */

    function exportExcel() {
        if (!btnExport) return;
        btnExport.textContent = "⏳ 生成中...";
        btnExport.disabled = true;

        var body = getParams();

        fetch(LEADER_BREAKOUT_EXPORT_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        })
            .then(function (r) {
                if (!r.ok) throw new Error("导出失败");
                return r.blob();
            })
            .then(function (blob) {
                var url = window.URL.createObjectURL(blob);
                var a = document.createElement("a");
                a.href = url;
                a.download = "A股龙头股回调新高统计.xlsx";
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
                btnExport.textContent = "📥 导出Excel";
                btnExport.disabled = false;
            })
            .catch(function (e) {
                showError("导出失败: " + e.message);
                btnExport.textContent = "📥 导出Excel";
                btnExport.disabled = false;
            });
    }

    /* ── Bind ── */

    if (btnRun) btnRun.addEventListener("click", run);
    if (btnExport) btnExport.addEventListener("click", exportExcel);

    // Auto-check for cached results when the leader tab is first opened
    var _autoChecked = false;
    document.querySelectorAll('.tab-btn[data-tab="leader"]').forEach(function (btn) {
        btn.addEventListener("click", function () {
            if (!_autoChecked) {
                _autoChecked = true;
                autoCheck();
            }
        });
    });
})();
