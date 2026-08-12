"""Odds harvester for the Simulate game.

Scrapes OddsPortal's date listings with Playwright (see oddsportal_listing.py)
over a rolling window of upcoming dates, normalizes the scraped odds into the
Simulate "fixtures feed", and uploads it to S3 (Contabo) where the crash-game
server reads it.

Entry points:
    python -m harvester            # one shot (or loop if HARVEST_INTERVAL_SEC>0)
    python -m harvester --once     # force a single run
    python -m harvester --dry-run  # scrape + normalize, print feed, no S3

Everything is env-configured (see .env.example). Nothing here is hard-coded to
a tenant. If Chromium or the network is unavailable, the run logs the
failure and exits non-zero WITHOUT touching S3 — the server keeps serving the
last-good `latest.json` (or its bundled sample), so Simulate never goes dark.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone

from playwright.sync_api import sync_playwright

from normalize import build_feed
from oddsportal_listing import scrape_date
from s3_store import LATEST_KEY, upload_feed

log = logging.getLogger("harvester")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def harvest_once(*, upload: bool = True) -> dict:
    """Scrape the rolling window, normalize, and (optionally) upload the feed."""
    sport = os.environ.get("HARVEST_SPORT", "football")
    days = _env_int("HARVEST_DAYS", 7)
    headless = os.environ.get("HARVEST_HEADLESS", "true").lower() != "false"
    nav_timeout_ms = _env_int("HARVEST_NAV_TIMEOUT_SEC", 60) * 1000
    # Wall-clock budget for the whole run, not per page load: one wedged date
    # must not be able to stretch the run to days * nav timeout.
    budget_sec = _env_int("HARVEST_TIMEOUT_SEC", 900)

    today = datetime.now(timezone.utc).date()
    all_matches: list[dict] = []
    deadline = time.monotonic() + budget_sec
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        page = browser.new_context(locale="en-GB").new_page()
        # The listing timezone follows this browser's IP, so the first date with
        # rows calibrates it and the rest confirm that answer with one sample.
        offset = None
        try:
            for i in range(days):
                if time.monotonic() >= deadline:
                    log.warning(
                        "HARVEST_TIMEOUT_SEC=%d exhausted after %d/%d days — "
                        "publishing what was harvested",
                        budget_sec, i, days,
                    )
                    break
                d = today + timedelta(days=i)
                matches, offset = scrape_date(
                    page,
                    sport,
                    d.strftime("%Y%m%d"),
                    offset=offset,
                    nav_timeout_ms=nav_timeout_ms,
                )
                all_matches.extend(matches)
        finally:
            browser.close()

    feed = build_feed(all_matches, sport=sport)
    log.info("normalized %d fixtures from %d scraped matches", len(feed["fixtures"]), len(all_matches))

    if not feed["fixtures"]:
        raise RuntimeError("no fixtures scraped — leaving existing S3 feed untouched")

    if upload:
        keys = upload_feed(feed)
        log.info("uploaded feed to: %s", ", ".join(keys))
    return feed


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    parser = argparse.ArgumentParser(description="Simulate odds harvester")
    parser.add_argument("--once", action="store_true", help="run a single harvest then exit")
    parser.add_argument("--dry-run", action="store_true", help="scrape + normalize, print feed, no S3")
    args = parser.parse_args(argv)

    interval = _env_int("HARVEST_INTERVAL_SEC", 0)

    def run() -> int:
        try:
            feed = harvest_once(upload=not args.dry_run)
            if args.dry_run:
                print(json.dumps(feed, indent=2, ensure_ascii=False))
            return 0
        except Exception as e:  # noqa: BLE001 — top-level guard, log and report
            log.error("harvest failed: %s", e)
            return 1

    if args.once or args.dry_run or interval <= 0:
        return run()

    log.info("harvester loop every %ds → s3://%s", interval, LATEST_KEY)
    while True:
        run()
        time.sleep(interval)


if __name__ == "__main__":
    sys.exit(main())
