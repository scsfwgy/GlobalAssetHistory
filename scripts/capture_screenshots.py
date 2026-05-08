from pathlib import Path
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "doc" / "screenshot"
URL = "http://127.0.0.1:8730"


def wait_for_idle(page):
    page.wait_for_timeout(2000)


def capture_yearly(page):
    page.goto(URL, wait_until="networkidle")
    page.get_by_text("持有").click()
    page.wait_for_selector("#pcTable")
    wait_for_idle(page)
    page.locator("#pcTableWrap").screenshot(path=str(OUT / "yearly-heatmap.png"))
    page.locator("#pcChartWrap").screenshot(path=str(OUT / "yearly-chart.png"))


def capture_monthly(page):
    page.goto(URL, wait_until="networkidle")
    year = page.locator("#pcYearSelect")
    year.fill("2024")
    page.get_by_text("持有").click()
    page.wait_for_selector("#pcTable")
    wait_for_idle(page)
    page.locator("#pcTableWrap").screenshot(path=str(OUT / "monthly-breakdown.png"))
    page.locator("#pcChartWrap").screenshot(path=str(OUT / "monthly-trend.png"))


def capture_backtest(page):
    page.goto(URL, wait_until="networkidle")
    page.get_by_text("持有").click()
    page.wait_for_selector("#pcTable")
    wait_for_idle(page)
    page.locator("#pcBacktest").scroll_into_view_if_needed()
    page.locator("#pcBtFrequency").select_option("monthly")
    page.locator("#pcBtAmount").fill("1000")
    page.locator("#pcBtInitialAmount").fill("0")
    page.locator("#pcBtStartDate").fill("2020-01-01")
    page.locator("#pcBtEndDate").fill("2025-12-31")
    page.locator("#pcBtSampleSize").fill("80")
    page.locator("#pcBtAnimSeconds").fill("0")
    page.locator("#btAddSelect").select_option("NVDA")
    page.get_by_text("开始回测").click()
    page.wait_for_selector("#pcBtResult", state="visible")
    wait_for_idle(page)
    page.locator("#pcBacktest").screenshot(path=str(OUT / "backtest.png"))
    page.locator("#pcBtResult").screenshot(path=str(OUT / "backtest-detail.png"))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 1400}, device_scale_factor=2)
        capture_yearly(page)
        capture_monthly(page)
        capture_backtest(page)
        browser.close()


if __name__ == "__main__":
    main()
