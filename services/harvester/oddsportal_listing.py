"""Scrape an OddsPortal date listing directly with Playwright.

Why this exists instead of the `oddsharvester` CLI
--------------------------------------------------
OddsPortal migrated its `/matches/<sport>/<date>/` listing to the same
`data-testid="game-row"` markup its live listing already used, and now redirects
that URL to `/<sport>/<YYYY-MM-DD>/`. `oddsharvester` (0.10.0) still looks for
the old `div[class*="eventRow"]` and therefore returns zero rows for every date
— a silent empty scrape, not an error. Everything Simulate needs (kickoff,
teams, 1x2 prices) is present on the listing page itself, so we read it directly
and skip the per-match page visits the CLI performed.

Timezone — the subtle part
--------------------------
The times rendered in the listing are in the *viewer's* timezone, which
OddsPortal geolocates from the request IP. The same page shows 19:00 from
Nairobi and 18:00 from Prague for one fixture. Parsing the displayed clock face
would therefore bake the scraper's hosting location into the feed, and a
dev-machine feed would disagree with a production one.

Each match's detail page carries a JSON-LD `startDate` with an explicit UTC
offset, which is unambiguous. Rather than fetch a detail page per fixture, we
fetch a few and derive the offset between "what the listing displayed" and "the
true instant", then apply that single offset to every row. The offset follows
the scraper's IP *timezone*, not the date — but a timezone is not a fixed
offset: a DST boundary inside the scraped window moves it by an hour. So the
first date with rows pays for a full calibration and every later date spends
one sample to confirm it, re-calibrating only when that sample disagrees. If
calibration fails (or its samples don't agree) we refuse to emit fixtures
rather than publish times that may be hours wrong.

The output dicts match what `normalize.normalize_match` expects, so the rest of
the pipeline (normalize -> build_feed -> S3) is unchanged.
"""

from __future__ import annotations

import json
import logging
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

from playwright.sync_api import Page, TimeoutError as PlaywrightTimeout

log = logging.getLogger("harvester.listing")

BASE = "https://www.oddsportal.com"
GAME_ROW = '[data-testid="game-row"]'
TIME_ITEM = '[data-testid="time-item"]'

# How many detail pages to sample when working out the display offset.
CALIBRATION_SAMPLES = 3

# Row text is "HH:MM | Home | - | Away | o1 | o2 | o3" once blank lines collapse.
_TIME_RE = re.compile(r"^\d{1,2}:\d{2}$")
_ODDS_RE = re.compile(r"^\d+\.\d+$")


def _row_records(page: Page) -> list[dict[str, Any]]:
    """Pull the raw (href, displayed time, teams, odds) tuples out of the DOM.

    The `game-row` testid appears twice per fixture (outer div and a nested one
    inside the anchor), so rows are de-duplicated on href.
    """
    return page.evaluate(
        """
        (sel) => {
          const [rowSel, timeSel] = sel;
          const out = [];
          const seen = new Set();
          for (const row of document.querySelectorAll(rowSel)) {
            const a = row.querySelector('a[href]');
            if (!a) continue;
            const href = a.getAttribute('href');
            if (!href || seen.has(href)) continue;
            seen.add(href);
            const timeEl = row.querySelector(timeSel);
            const parts = row.innerText.split('\\n')
                             .map(s => s.trim()).filter(Boolean);
            out.push({
              href,
              time: timeEl ? timeEl.innerText.trim() : null,
              parts,
              // Rows sit under a `sport-country-league-item` header. Its visible
              // text is fragmented across nodes, but its anchors carry the
              // path (/football/europe/champions-league/), which is a cleaner
              // source for the label than the text.
              leagueHref: (() => {
                let n = row;
                while (n) {
                  let s = n.previousElementSibling;
                  while (s) {
                    const hdr = s.matches?.('[data-testid="sport-country-league-item"]')
                      ? s : s.querySelector?.('[data-testid="sport-country-league-item"]');
                    if (hdr) {
                      const hrefs = [...hdr.querySelectorAll('a[href]')]
                        .map(l => l.getAttribute('href') || '')
                        .filter(h => h.startsWith('/'));
                      if (hrefs.length) {
                        // Deepest path = most specific (the league itself).
                        return hrefs.reduce((a, b) =>
                          b.split('/').filter(Boolean).length >
                          a.split('/').filter(Boolean).length ? b : a);
                      }
                    }
                    s = s.previousElementSibling;
                  }
                  n = n.parentElement;
                }
                return '';
              })(),
            });
          }
          return out;
        }
        """,
        [GAME_ROW, TIME_ITEM],
    )


def _parse_row(rec: dict[str, Any]) -> dict[str, Any] | None:
    """One DOM record -> {href, time, home, away, odds[3], league} or None."""
    parts = [p for p in rec.get("parts") or [] if p]
    time_txt = rec.get("time")
    if not time_txt or not _TIME_RE.match(time_txt):
        return None

    odds = [p for p in parts if _ODDS_RE.match(p)]
    # A 1x2 row carries exactly three prices; anything else isn't a 1x2 market.
    if len(odds) < 3:
        return None
    odds = odds[:3]

    # Teams sit between the clock face and the first price, minus the "-" score.
    try:
        start = parts.index(time_txt) + 1
    except ValueError:
        start = 1
    end = parts.index(odds[0])
    teams = [p for p in parts[start:end] if p not in ("-", "–", ":")]
    if len(teams) < 2:
        return None

    return {
        "href": rec["href"],
        "time": time_txt,
        "home": teams[0],
        "away": teams[1],
        "odds": odds,
        "league": _league_label(rec.get("leagueHref") or ""),
    }


def _league_label(href: str) -> str:
    """`/football/europe/champions-league/` -> "Europe: Champions League"."""
    segs = [s for s in href.split("/") if s]
    if len(segs) < 2:
        return ""
    def pretty(s: str) -> str:
        return " ".join(w.capitalize() for w in s.replace("-", " ").split())
    # segs[0] is the sport; the rest is country (+ league).
    parts = [pretty(s) for s in segs[1:3]]
    return ": ".join(p for p in parts if p)


def _match_url(href: str) -> str:
    """Absolute match URL whose last segment is the stable OddsPortal event id.

    Listing hrefs look like `/football/h2h/<a>/<b>/#WE22s2T6`; the fragment is
    the event id, so we promote it to a path segment for `event_id_from_link`.
    """
    path, _, frag = href.partition("#")
    path = path.rstrip("/")
    return f"{BASE}{path}/{frag}" if frag else f"{BASE}{path}"


def _jsonld_start(page: Page, url: str, nav_timeout_ms: int) -> datetime | None:
    """True kickoff instant from a match page's JSON-LD `startDate`."""
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=nav_timeout_ms)
        page.wait_for_timeout(4_000)
        html = page.content()
    except Exception as e:  # noqa: BLE001 — calibration is best-effort per sample
        log.debug("calibration fetch failed for %s: %s", url, e)
        return None

    for blob in re.findall(
        r'<script[^>]*application/ld\+json[^>]*>(.*?)</script>', html, re.S
    ):
        try:
            data = json.loads(blob)
        except json.JSONDecodeError:
            continue
        for obj in data if isinstance(data, list) else [data]:
            if not isinstance(obj, dict):
                continue
            start = obj.get("startDate")
            if not start:
                continue
            try:
                dt = datetime.fromisoformat(str(start).replace("Z", "+00:00"))
            except ValueError:
                continue
            if dt.tzinfo is None:
                continue  # no offset -> still ambiguous, skip
            return dt.astimezone(timezone.utc)
    return None


def _sample_offset(
    page: Page, row: dict[str, Any], day: str, nav_timeout_ms: int
) -> int | None:
    """One row's displayed clock minus its true kickoff, in minutes (or None)."""
    # The detail page lives at the href's path; the "#fragment" event id is
    # only needed for `_match_url`'s stable id.
    detail = BASE + row["href"].partition("#")[0].rstrip("/")
    true_utc = _jsonld_start(page, detail, nav_timeout_ms)
    if true_utc is None:
        return None
    hh, mm = (int(x) for x in row["time"].split(":"))
    # Interpret the displayed clock on the listing's date, then see how far
    # it sits from the real instant. Round to 15min to absorb odd offsets.
    shown = datetime.strptime(day, "%Y%m%d").replace(
        hour=hh, minute=mm, tzinfo=timezone.utc
    )
    delta_min = round((shown - true_utc).total_seconds() / 60)
    # Displayed date can roll over for late kickoffs; normalise to +/-12h.
    # ponytail: that also folds a genuine UTC+13/+14 host onto the wrong side;
    # if the scraper ever runs from one, key the fold off the row's own date.
    while delta_min > 720:
        delta_min -= 1440
    while delta_min < -720:
        delta_min += 1440
    return int(round(delta_min / 15) * 15)


def _calibrate_offset(
    page: Page, rows: list[dict[str, Any]], day: str, nav_timeout_ms: int
) -> timedelta | None:
    """Minutes between the listing's displayed clock and true UTC.

    Returns None unless two samples agree — callers must then abort rather than
    emit fixtures with guessed times.
    """
    offsets: Counter[int] = Counter()
    for row in rows[:CALIBRATION_SAMPLES]:
        minutes = _sample_offset(page, row, day, nav_timeout_ms)
        if minutes is not None:
            offsets[minutes] += 1

    if not offsets:
        return None
    best, count = offsets.most_common(1)[0]
    if count < 2:
        # A one-vote "plurality" is a coin toss between the real offset and a
        # postponed fixture whose JSON-LD still carries its original kickoff —
        # and the loser silently shifts every kickoff in the run.
        log.warning("%s: no two samples agreed on the listing timezone (%s)",
                    day, dict(offsets))
        return None
    log.info("timezone calibration: listing is UTC%+d min (%d/%d samples agreed)",
             best, count, min(len(rows), CALIBRATION_SAMPLES))
    return timedelta(minutes=best)


def scrape_date(
    page: Page,
    sport: str,
    date_yyyymmdd: str,
    *,
    offset: timedelta | None = None,
    nav_timeout_ms: int = 60_000,
) -> tuple[list[dict[str, Any]], timedelta | None]:
    """Scrape one date's listing on an already-open page.

    Returns (match dicts for `normalize`, the run's listing offset). Pass the
    returned offset back in for the next date: only the first date with rows
    pays for a full calibration, later dates just spend one sample confirming
    the carried offset still holds (a DST boundary inside the window moves it).

    Returns ([], offset) on any failure — the caller decides what an empty day
    means — but *raises* if calibration itself fails, aborting the run rather
    than publishing kickoffs that may be hours wrong.
    """
    url = f"{BASE}/matches/{sport}/{date_yyyymmdd}/"
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=nav_timeout_ms)
        try:
            page.wait_for_selector(GAME_ROW, timeout=nav_timeout_ms)
        except PlaywrightTimeout:
            # A date with no fixtures at all is a normal outcome, not a failure.
            log.info("%s: no rows on the listing", date_yyyymmdd)
            return [], offset
        # The listing lazy-renders; scroll until the row count settles.
        previous = -1
        for _ in range(12):
            count = len(page.query_selector_all(GAME_ROW))
            if count == previous:
                break
            previous = count
            page.mouse.wheel(0, 5_000)
            page.wait_for_timeout(800)

        parsed = [r for r in (_parse_row(rec) for rec in _row_records(page)) if r]
    except Exception as e:  # noqa: BLE001 — one bad date must not kill the run
        log.warning("scrape failed for %s: %s: %s", date_yyyymmdd, type(e).__name__, e)
        return [], offset

    log.info("%s: %d rows with a 1x2 market", date_yyyymmdd, len(parsed))
    if not parsed:
        return [], offset

    if offset is not None:
        # One sample is enough to notice a DST shift; a fetch that fails keeps
        # the carried offset rather than burning three more page loads.
        minutes = _sample_offset(page, parsed[0], date_yyyymmdd, nav_timeout_ms)
        if minutes is not None and timedelta(minutes=minutes) != offset:
            log.info("%s: listing now UTC%+d min (DST boundary?) — re-calibrating",
                     date_yyyymmdd, minutes)
            offset = None

    if offset is None:
        # Calibration navigates `page` off the listing, which is fine — `parsed`
        # already holds everything this date needs from the DOM.
        offset = _calibrate_offset(page, parsed, date_yyyymmdd, nav_timeout_ms)
        if offset is None:
            raise RuntimeError(
                f"{date_yyyymmdd}: could not establish the listing timezone — "
                "aborting rather than publishing possibly-wrong kickoffs"
            )

    base_day = datetime.strptime(date_yyyymmdd, "%Y%m%d")
    out: list[dict[str, Any]] = []
    for row in parsed:
        hh, mm = (int(x) for x in row["time"].split(":"))
        shown = base_day.replace(hour=hh, minute=mm, tzinfo=timezone.utc)
        kickoff = shown - offset
        out.append(
            {
                "match_link": _match_url(row["href"]),
                "home_team": row["home"],
                "away_team": row["away"],
                "match_date": kickoff.strftime("%Y-%m-%d %H:%M:%S UTC"),
                "league_name": row["league"],
                "1x2_market": [
                    {
                        "1": row["odds"][0],
                        "X": row["odds"][1],
                        "2": row["odds"][2],
                        "period": "FullTime",
                    }
                ],
            }
        )
    return out, offset
