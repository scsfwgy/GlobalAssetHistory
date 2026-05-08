/** Month and day drilldown cards. */

// ─── Monthly drilldown card (line chart + monthly grid) ───

async function fetchMonthly(symbol, type, year) {
  try {
    const resp = await fetch(MONTHLY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, type, year }),
    });
    if (!resp.ok) return;
    const result = await resp.json();
    renderMonthlyCard(symbol, type, year, result.months);
  } catch {
    // silently fail
  }
}

async function fetchDaily(symbol, type, year, month, mountEl) {
  try {
    const resp = await fetch(DAILY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, type, year, month }),
    });
    if (!resp.ok) return;
    const result = await resp.json();
    renderDailyBlock(symbol, year, month, result.days, mountEl);
  } catch {
    // silently fail
  }
}

function renderMonthlyCard(symbol, type, year, months) {
  // Build title with display name if available
  const sym = symbols.find((s) => s.symbol === symbol);
  const label = sym && sym.name ? `${symbol}(${sym.name})` : symbol;

  const container = $("pcMonthlyContainer");

  // Create card
  const card = document.createElement("div");
  card.className = "pc-monthly";

  // Header
  const header = document.createElement("div");
  header.className = "pc-monthly-header";
  const title = document.createElement("span");
  title.className = "pc-monthly-title";
  title.textContent = `${label} — ${year} 年月度涨跌幅`;
  const closeBtn = document.createElement("button");
  closeBtn.className = "pc-btn";
  closeBtn.style.cssText = "padding:4px 10px;font-size:12px;";
  closeBtn.textContent = "关闭";
  closeBtn.addEventListener("click", () => card.remove());
  header.appendChild(title);
  header.appendChild(closeBtn);
  card.appendChild(header);

  // Monthly grid
  const grid = document.createElement("div");
  grid.className = "pc-monthly-grid";
  grid.innerHTML = months
    .map((m) => {
      const val = m.return;
      const formatted = val !== null ? formatPct(val) : "—";
      const colors = val !== null ? cellColor(val, -50, 50) : { bg: "var(--apple-surface-2)", text: "var(--apple-text-tertiary)" };
      const cls = val !== null ? "pc-month-block" : "pc-month-block is-empty";
      return `<div class="${cls}" data-month="${m.month}" style="background:${colors.bg};">
        <div class="pc-month-num">${m.month}月</div>
        <div class="pc-month-val" style="color:${colors.text};">${formatted}</div>
      </div>`;
    })
    .join("");
  card.appendChild(grid);

  const dailyMount = document.createElement("div");
  dailyMount.className = "pc-daily-wrap";
  dailyMount.style.display = "none";
  card.appendChild(dailyMount);

  grid.querySelectorAll(".pc-month-block").forEach((block) => {
    if (block.classList.contains("is-empty")) return;
    block.addEventListener("click", () => {
      const month = parseInt(block.dataset.month, 10);
      fetchDaily(symbol, type, year, month, dailyMount);
    });
  });

  container.appendChild(card);

  // Scroll to the new card
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderDailyBlock(symbol, year, month, days, mountEl) {
  if (!mountEl) return;
  if (!days || days.length === 0) {
    mountEl.innerHTML = `<div class="pc-empty" style="padding:20px 0;">${symbol} ${year}-${String(month).padStart(2, "0")} 暂无日线数据</div>`;
    mountEl.style.display = "";
    return;
  }

  mountEl.innerHTML = `
    <div class="pc-monthly-header" style="margin-bottom:12px;">
      <span class="pc-monthly-title">${symbol} - ${year}年${month}月日涨跌幅</span>
    </div>
    <div class="pc-daily-grid">
      ${days.map((d) => {
        const val = d.return;
        const formatted = val !== null ? formatPct(val) : "—";
        const colors = val !== null ? cellColor(val, -20, 20) : { bg: "var(--apple-surface-2)", text: "var(--apple-text-tertiary)" };
        return `<div class="pc-daily-block" style="background:${colors.bg};">
          <div class="pc-month-num">${d.day}日</div>
          <div class="pc-month-val" style="color:${colors.text};">${formatted}</div>
          <div style="font-size:10px;color:var(--apple-text-tertiary);margin-top:4px;">${d.close}</div>
        </div>`;
      }).join("")}
    </div>
  `;
  mountEl.style.display = "";
  mountEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Table cell click → monthly drilldown
tableBody.addEventListener("click", (e) => {
  const cell = e.target.closest(".pc-cell");
  if (!cell) return;
  const { symbol, year, type } = cell.dataset;
  if (!symbol || !year) return;
  fetchMonthly(symbol, type, parseInt(year, 10));
});
