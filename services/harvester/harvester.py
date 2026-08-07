"""Odds harvester for the Simulate game.

Runs OddsHarvester (https://github.com/jordantete/OddsHarvester) over a rolling
window of upcoming dates, normalizes the scraped odds into the Simulate
"fixtures feed", and uploads it to S3 (Contabo) where the crash-game server
reads it.

Entry points:
    python -m harvester            # one shot (or loop if HARVEST_INTERVAL_SEC>0)
    python -m harvester --once     # force a single run
    python -m harvester --dry-run  # scrape + normalize, print feed, no S3

Everything is env-configured (see .env.example). Nothing here is hard-coded to
a tenant. If OddsHarvester or the network is unavailable, the run logs the
failure and exits non-zero WITHOUT touching S3 — the server keeps serving the
last-good `latest.json` (or its bundled sample), so Simulate never goes dark.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

from normalize import build_feed
from s3_store import LATEST_KEY, upload_feed

log = logging.getLogger("harvester")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def scrape_date(sport: str, markets: str, date_yyyymmdd: str, *, headless: bool = True) -> list[dict]:
    """Run `oddsharvester upcoming` for one date; return the parsed matches.

    Uses the CLI (the pip package `oddsharvester`) writing JSON to a temp file,
    then reads it back. Returns [] on any failure for this date.
    """
    with tempfile.NamedTemporaryFile("r", suffix=".json", delete=False) as tf:
        out_path = tf.name
    cmd = [
        "oddsharvester", "upcoming",
        "-s", sport,
        "-d", date_yyyymmdd,
        "-m", markets,
        "--storage", "local",
        "--format", "json",
        "--output", out_path,
    ]
    if headless:
        cmd.append("--headless")
    log.info("scrape %s: %s", date_yyyymmdd, " ".join(cmd))
    try:
        subprocess.run(cmd, check=True, timeout=_env_int("HARVEST_TIMEOUT_SEC", 900))
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        log.warning("scrape failed for %s: %s", date_yyyymmdd, e)
        return []
    try:
        with open(out_path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        log.warning("could not read scraped output for %s: %s", date_yyyymmdd, e)
        return []
    finally:
        try:
            os.unlink(out_path)
        except OSError:
            pass
    return data if isinstance(data, list) else []


def harvest_once(*, upload: bool = True) -> dict:
    """Scrape the rolling window, normalize, and (optionally) upload the feed."""
    sport = os.environ.get("HARVEST_SPORT", "football")
    markets = os.environ.get("HARVEST_MARKETS", "1x2")
    days = _env_int("HARVEST_DAYS", 7)
    headless = os.environ.get("HARVEST_HEADLESS", "true").lower() != "false"

    today = datetime.now(timezone.utc).date()
    all_matches: list[dict] = []
    for i in range(days):
        d = today + timedelta(days=i)
        all_matches.extend(scrape_date(sport, markets, d.strftime("%Y%m%d"), headless=headless))

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
