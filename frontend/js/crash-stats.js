/** Crash statistics — detect big single-day drops and recovery metrics. */

(function () {
    /* ── DOM refs ── */
    const btnRun = document.getElementById("crashRunBtn");
    const symbolInput = document.getElementById("crashSymbol");
    const typeSelect = document.getElementById("crashType");
    const startInput = document.getElementById("crashStartDate");
    const endInput = document.getElementById("crashEndDate");
    const thresholdInput = document.getElementById("crashThreshold");
    const resultWrap = document.getElementById("crashResult");
    const summaryDiv = document.getElementById("crashSummary");
    const tableBody = document.getElementById("crashTableBody");
    const tableHead = document.getElementById("crashTableHead");
    const tableWrap = document.getElementById("crashTableWrap");
    const loadingEl = document.getElementById("crashLoading");
    const errorEl = document.getElementById("crashError");
    const emptyEl = document.getElementById("crashEmpty");
    const closeBtn = document.getElementById("crashCloseBtn");

    /* ── Init ── */
    function init() {
        // Default to last 5 years
        const now = new Date();
        const fiveYearsAgo = new Date(now.getFullYear() - 5, now.getMonth(), now.getDate());
        if (endInput) endInput.value = now.toISOString().slice(0, 10);
        if (startInput) startInput.value = fiveYearsAgo.toISOString().slice(0, 10);
    }

    /* ── Run ── */
    function run() {
        const symbol = (symbolInput.value || "").trim().toUpperCase();
        const startDate = (startInput.value || "").trim();
        const endDate = (endInput.value || "").trim();
        const threshold = parseFloat(thresholdInput.value || "4.77");

        if (!symbol) {
            showError("请输入股票代码");
            return;
        }
        if (!startDate || !endDate) {
            showError("请选择起止日期");
            return;
        }
        if (isNaN(threshold) || threshold <= 0) {
            showError("暴跌幅度必须是正数");
            return;
        }

        setLoading(true);
        hideError();
        resultWrap.style.display = "none";

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
                if (!res.ok || res.data.error) {
                    showError(res.data.error || "请求失败");
                    return;
                }
                render(res.data);
            })
            .catch(function (e) {
                setLoading(false);
                showError(e.message || "网络错误");
            });
    }

    /* ── Render ── */
    function render(data) {
        resultWrap.style.display = "block";
        var s = data.summary;
        var crashes = data.crashes || [];

        // Summary
        var recoveredPct = s.total_crashes > 0 ? Math.round(s.recovered / s.total_crashes * 100) : 0;
        var html = '<div class="crash-summary-grid">' +
            '<div class="crash-summary-item">' +
                '<div class="crash-summary-label">暴跌次数</div>' +
                '<div class="crash-summary-val" style="color:' + (s.total_crashes > 0 ? 'var(--data-negative)' : 'var(--data-positive)') + '">' + s.total_crashes + '</div>' +
            '</div>' +
            '<div class="crash-summary-item">' +
                '<div class="crash-summary-label">已恢复</div>' +
                '<div class="crash-summary-val">' + s.recovered + ' / ' + s.total_crashes + ' (' + recoveredPct + '%)</div>' +
            '</div>' +
            '<div class="crash-summary-item">' +
                '<div class="crash-summary-label">平均恢复天数</div>' +
                '<div class="crash-summary-val">' + (s.avg_recovery_days != null ? s.avg_recovery_days : "—") + '</div>' +
            '</div>' +
            '<div class="crash-summary-item">' +
                '<div class="crash-summary-label">中位恢复天数</div>' +
                '<div class="crash-summary-val">' + (s.median_recovery_days != null ? s.median_recovery_days : "—") + '</div>' +
            '</div>' +
            '<div class="crash-summary-item">' +
                '<div class="crash-summary-label">最大跌幅</div>' +
                '<div class="crash-summary-val" style="color:var(--data-negative)">' + (s.max_drop_pct != null ? s.max_drop_pct.toFixed(2) + "%" : "—") + '</div>' +
            '</div>' +
            '<div class="crash-summary-item">' +
                '<div class="crash-summary-label">平均跌幅</div>' +
                '<div class="crash-summary-val" style="color:var(--data-negative)">' + (s.avg_drop_pct != null ? s.avg_drop_pct.toFixed(2) + "%" : "—") + '</div>' +
            '</div>' +
            '</div>';
        summaryDiv.innerHTML = html;

        // Table
        var headHtml = '<th>暴跌日期</th><th>暴跌前收盘价</th><th>暴跌日收盘价</th><th>跌幅</th><th>恢复日期</th><th>恢复天数</th><th>状态</th>';
        tableHead.innerHTML = headHtml;

        if (crashes.length === 0) {
            tableWrap.style.display = "none";
            emptyEl.style.display = "block";
            emptyEl.innerHTML = '<div style="font-size:24px;margin-bottom:8px;">&#9989;</div><div>在选定时间段内没有发现暴跌超过 ' + data.threshold_pct + '% 的交易日</div>';
        } else {
            tableWrap.style.display = "block";
            emptyEl.style.display = "none";

            var bodyHtml = "";
            crashes.forEach(function (c) {
                var statusHtml;
                if (c.recovered) {
                    statusHtml = '<span class="crash-status recovered">已恢复</span>';
                } else {
                    statusHtml = '<span class="crash-status not-recovered">未恢复</span>';
                }
                bodyHtml += '<tr>' +
                    '<td>' + c.crash_date + '</td>' +
                    '<td>' + c.pre_crash_close.toFixed(2) + '</td>' +
                    '<td style="color:var(--data-negative);">' + c.crash_close.toFixed(2) + '</td>' +
                    '<td style="color:var(--data-negative);font-weight:600;">' + c.drop_pct.toFixed(2) + '%</td>' +
                    '<td>' + (c.recovery_date || "—") + '</td>' +
                    '<td>' + (c.recovery_days != null ? c.recovery_days : "—") + '</td>' +
                    '<td>' + statusHtml + '</td>' +
                    '</tr>';
            });
            tableBody.innerHTML = bodyHtml;
        }
    }

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
    }

    /* ── Bind ── */
    if (btnRun) btnRun.addEventListener("click", run);
    if (closeBtn) closeBtn.addEventListener("click", closeResult);
    // Enter key on symbol input
    if (symbolInput) {
        symbolInput.addEventListener("keydown", function (e) {
            if (e.key === "Enter") run();
        });
    }

    init();
})();
