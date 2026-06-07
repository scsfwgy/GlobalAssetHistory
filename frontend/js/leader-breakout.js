/** A-share leader breakout analysis — 龙头股回调冲击新高统计. */

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
    const progressWrap = document.getElementById("lbProgressWrap");
    const progressBar = document.getElementById("lbProgress");
    const progressText = document.getElementById("lbProgressText");
    const btnExport = document.getElementById("lbExportBtn");

    var _progressInterval = null;

    /* ── Run scan ── */
    function run() {
        setLoading(true);
        hideError();
        resultWrap.style.display = "none";
        startProgress();

        var body = {
            start_date: "2024-09-30",
            threshold: 9.5,
            min_consecutive_days: 6,
            workers: 10,
        };
        // Read optional inputs if present
        var startEl = document.getElementById("lbStartDate");
        var threshEl = document.getElementById("lbThreshold");
        var minDaysEl = document.getElementById("lbMinDays");
        if (startEl) body.start_date = startEl.value || "2024-09-30";
        if (threshEl) body.threshold = parseFloat(threshEl.value) || 9.5;
        if (minDaysEl) body.min_consecutive_days = parseInt(minDaysEl.value) || 6;

        fetch(LEADER_BREAKOUT_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (res) {
                stopProgress();
                setLoading(false);
                if (!res.ok || res.data.error) {
                    showError(res.data.error || "扫描失败");
                    return;
                }
                render(res.data);
            })
            .catch(function (e) {
                stopProgress();
                setLoading(false);
                showError(e.message || "网络错误（扫描可能超时，请重试）");
            });
    }

    /* ── Progress animation ── */
    function startProgress() {
        progressWrap.style.display = "block";
        progressBar.style.width = "0%";
        progressBar.style.transition = "none";
        progressText.textContent = "全市场扫描中，预计约2分钟...";

        var width = 0;
        _progressInterval = setInterval(function () {
            // Non-linear: fast start, slow towards end
            if (width < 30) width += 1.5;
            else if (width < 60) width += 0.8;
            else if (width < 85) width += 0.3;
            else width += 0.05;
            if (width > 92) width = 92;
            progressBar.style.width = width + "%";
            var elapsed = Math.round(width * 1.3); // ~120s total
            progressText.textContent = "扫描中... 已耗时约" + elapsed + "秒";
        }, 1000);
    }

    function stopProgress() {
        if (_progressInterval) clearInterval(_progressInterval);
        progressBar.style.transition = "width 0.5s ease";
        progressBar.style.width = "100%";
        progressText.textContent = "扫描完成！";
        setTimeout(function () {
            progressWrap.style.display = "none";
        }, 800);
    }

    /* ── Render ── */
    function render(data) {
        resultWrap.style.display = "block";
        if (btnExport) btnExport.style.display = "";
        var s = data.summary;
        var stocks = data.stocks || [];

        // Summary
        var recoveredPct = s.qualified > 0 ? Math.round(s.recovered / s.qualified * 100) : 0;
        summaryDiv.innerHTML = '<div class="crash-summary-grid">' +
            '<div class="crash-summary-item"><div class="crash-summary-label">扫描股票</div><div class="crash-summary-val">' + s.total_stocks_scanned + '</div></div>' +
            '<div class="crash-summary-item"><div class="crash-summary-label">符合条件</div><div class="crash-summary-val" style="color:var(--apple-blue);">' + s.qualified + '</div></div>' +
            '<div class="crash-summary-item"><div class="crash-summary-label">已突破前高</div><div class="crash-summary-val" style="color:var(--data-positive);">' + s.recovered + ' (' + recoveredPct + '%)</div></div>' +
            '<div class="crash-summary-item"><div class="crash-summary-label">未突破</div><div class="crash-summary-val" style="color:var(--data-negative);">' + s.not_recovered + '</div></div>' +
            '<div class="crash-summary-item"><div class="crash-summary-label">平均回调天数</div><div class="crash-summary-val">' + (s.avg_pullback_days != null ? s.avg_pullback_days : "—") + '</div></div>' +
            '<div class="crash-summary-item"><div class="crash-summary-label">平均突破天数</div><div class="crash-summary-val">' + (s.avg_breakthrough_days != null ? s.avg_breakthrough_days : "—") + '</div></div>' +
            '</div>';

        // Table header
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

        if (stocks.length === 0) {
            tableWrap.style.display = "none";
            emptyEl.style.display = "block";
            emptyEl.innerHTML = '<div style="font-size:24px;margin-bottom:8px;">&#128270;</div><div>未找到符合条件的龙头股（连续涨停' + (data.summary.qualified > 0 ? '' : ' ≥6天') + '）</div>';
        } else {
            tableWrap.style.display = "block";
            emptyEl.style.display = "none";

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
            tableBody.innerHTML = bodyHtml;
        }
    }

    /* ── Helpers ── */
    function escapeHtml(str) {
        var div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
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

    /* ── Export ── */
    function exportExcel() {
        if (!btnExport) return;
        btnExport.textContent = "⏳ 生成中...";
        btnExport.disabled = true;

        var body = {
            start_date: "2024-09-30",
            threshold: 9.5,
            min_consecutive_days: 6,
        };
        var startEl = document.getElementById("lbStartDate");
        var threshEl = document.getElementById("lbThreshold");
        var minDaysEl = document.getElementById("lbMinDays");
        if (startEl) body.start_date = startEl.value || "2024-09-30";
        if (threshEl) body.threshold = parseFloat(threshEl.value) || 9.5;
        if (minDaysEl) body.min_consecutive_days = parseInt(minDaysEl.value) || 6;

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
})();
