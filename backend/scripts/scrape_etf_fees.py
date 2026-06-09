#!/usr/bin/env python3
"""Scrape ETF management fee & custody fee from East Money fund profile pages.

Usage:
    python3 backend/scripts/scrape_etf_fees.py

Output: backend/data/etf_fees.json

The JSON file is committed to the repo so the US-deployed server can read it
without needing to access Chinese financial sites at runtime.

Re-run this script periodically (cron or manual) to refresh the data.
Fee rates change very rarely (years), so monthly is more than enough.
"""

import json
import logging
import os
import re
import sys
import time
from pathlib import Path

import requests

# ── Config ──────────────────────────────────────────────────────────────────

# All ETF codes from frontend/js/etf-market.js ETF_GROUPS
ETF_CODES = [
    # NASDAQ 100
    "513300",  # 华夏
    "513110",  # 华泰柏瑞
    "159655",  # 华安
    "159660",  # 博时
    "159632",  # 易方达
    "159501",  # 招商
    "159513",  # 富国
    "159696",  # 摩根
    "159529",  # 汇添富
    "513100",  # 国泰
    "159941",  # 广发
    # S&P 500
    "513650",  # 华夏
    "159612",  # 国泰
    "513500",  # 博时
    "159652",  # 易方达
]

FUND_PROFILE_URL = "https://fundf10.eastmoney.com/jbgk_{code}.html"
REQUEST_TIMEOUT = 15
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "data"
OUTPUT_FILE = OUTPUT_DIR / "etf_fees.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("scrape_etf_fees")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


def scrape_fund_profile(code: str) -> dict | None:
    """Scrape management fee and custody fee for a single ETF.

    Returns:
        dict with keys 'mgmt_fee', 'custody_fee' on success, None on failure.
        Fund company name is NOT extracted here — the backend already does
        keyword-matching from the Tencent quote name at runtime.
    """
    url = FUND_PROFILE_URL.format(code=code)
    logger.info("Fetching %s ...", url)

    try:
        resp = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
    except requests.RequestException as e:
        logger.error("  ✗ HTTP error: %s", e)
        return None

    html = resp.text

    # Extract management fee: 管理费率</th><td>0.60%（每年）
    mgmt = None
    m = re.search(r"管理费率</th>\s*<td[^>]*>\s*([\d.]+%)", html)
    if m:
        mgmt = m.group(1)

    # Extract custody fee: 托管费率</th><td>0.20%（每年）
    custody = None
    m = re.search(r"托管费率</th>\s*<td[^>]*>\s*([\d.]+%)", html)
    if m:
        custody = m.group(1)

    if mgmt or custody:
        logger.info("  ✓ mgmt=%s custody=%s", mgmt, custody)
        return {"mgmt_fee": mgmt, "custody_fee": custody}
    else:
        logger.warning("  ✗ No fee data found in page")
        return None


def main():
    logger.info("Scraping ETF fees from East Money ...")
    logger.info("Output: %s", OUTPUT_FILE)

    results = {}
    ok = 0
    fail = 0

    for code in ETF_CODES:
        profile = scrape_fund_profile(code)
        if profile:
            results[code] = profile
            ok += 1
        else:
            results[code] = None
            fail += 1
        # Be polite — small delay between requests
        time.sleep(1.0)

    # Write JSON
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "_updated": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
        "_source": "fundf10.eastmoney.com",
        "funds": results,
    }

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    logger.info("Done. %d OK, %d failed → %s", ok, fail, OUTPUT_FILE)

    if fail:
        logger.warning("%d ETF(s) had no fee data — check manually", fail)
        sys.exit(1)


if __name__ == "__main__":
    main()
