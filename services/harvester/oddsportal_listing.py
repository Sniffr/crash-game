"""Scrape an OddsPortal date listing directly with Playwright.

Why this exists instead of the `oddsharvester` CLI
--------------------------------------------------
OddsPortal migrated its `/matches/<sport>/<date>/` listing to new markup and now
serves it at `/<sport>/<YYYY-MM-DD>/`. `oddsharvester` (0.10.0) still looks for
the old `div[class*="eventRow"]` and therefore returns zero rows for every date
— a silent empty scrape, not an error. Everything Simulate needs (kickoff,
teams, 1x2 prices) is present on the listing page itself, so we read it directly
and skip the per-match page visits the CLI performed.

Finding rows without markup hooks
---------------------------------
The page has twice changed its hooks under us: first the CLI's `eventRow`
classes, then (September 2026) every `data-testid` attribute disappeared, which
silently emptied the feed for weeks. Its classes are Tailwind utilities, no
steadier. So rows are located by what they *are* rather than what they're
tagged: each match links to its `/h2h/…/#<eventId>` page, and its row is the
smallest element around that link that also carries the three 1x2 prices. The
league is read from the nearest preceding header's `/<sport>/<country>/<league>/`
link.

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
# Every listed match links to its head-to-head page; the fragment is its id.
MATCH_LINK = 'a[href*="/h2h/"]'

# Detail pages to try when working out the display offset: we stop as soon as
# two agree, but some pages load without a usable kickoff (a slow load, a match
# already under way), so a few spares keep one bad page from aborting the run.
CALIBRATION_SAMPLES = 6

# Row text is "HH:MM | Home | - | Away | o1 | o2 | o3" once blank lines collapse.
_TIME_RE = re.compile(r"^\d{1,2}:\d{2}$")
_ODDS_RE = re.compile(r"^\d+\.\d+$")

# Shared by the row reader and the "prices have loaded" wait: the row of a match
# link is its closest ancestor holding three decimal prices, provided that
# ancestor doesn't also hold another match (then this match has no prices yet).
_ROW_OF_JS = """
const priceCount = (el) => ((el.innerText || '').match(/\\b\\d+\\.\\d+\\b/g) || []).length;
const matchIds = (el) => new Set([...el.querySelectorAll('a[href*="/h2h/"]')]
  .map((l) => l.getAttribute('href')));
const rowOf = (link) => {
  let row = link.parentElement;
  while (row && priceCount(row) < 3) {
    const up = row.parentElement;
    if (!up || matchIds(up).size > 1) return null;
    row = up;
  }
  return row && matchIds(row).size === 1 ? row : null;
};
"""


def _row_records(page: Page, sport: str) -> list[dict[str, Any]]:
    """Pull the raw (href, displayed time, teams, odds) tuples out of the DOM.

    A match can render its link more than once, so rows are de-duplicated on
    href. Links without an event-id fragment aren't listing rows.
    """
    return page.evaluate(
        "(sport) => {" + _ROW_OF_JS + """
          // League headers link /<sport>/<country>/<league>/; rows only link
          // /<sport>/h2h/… pages, so any other deep sport link marks a header.
          const leagueLinks = (el) => [...el.querySelectorAll('a[href]')]
            .map((l) => l.getAttribute('href') || '')
            .filter((h) => h.startsWith('/' + sport + '/') && !h.includes('/h2h/')
                           && h.split('/').filter(Boolean).length >= 3);
          // The header's link texts carry the display names ("USA", "MLS").
          const linkText = (el, href) => {
            const l = [...el.querySelectorAll('a[href]')].find((x) => x.getAttribute('href') === href);
            return l ? (l.innerText || '').trim() : '';
          };
          const leagueOf = (row) => {
            for (let n = row; n; n = n.parentElement) {
              for (let s = n.previousElementSibling; s; s = s.previousElementSibling) {
                const hrefs = leagueLinks(s);
                if (hrefs.length) {
                  // Deepest path = most specific (the league itself).
                  const href = hrefs.reduce((a, b) =>
                    b.split('/').filter(Boolean).length > a.split('/').filter(Boolean).length ? b : a);
                  const segs = href.split('/').filter(Boolean);
                  return {
                    href,
                    country: linkText(s, '/' + segs.slice(0, 2).join('/') + '/'),
                    name: linkText(s, href),
                  };
                }
              }
            }
            return { href: '', country: '', name: '' };
          };
          const out = [];
          const seen = new Set();
          for (const link of document.querySelectorAll('a[href*="/h2h/"]')) {
            const href = link.getAttribute('href');
            if (!href || !href.includes('#') || seen.has(href)) continue;
            const row = rowOf(link);
            if (!row) continue;
            seen.add(href);
            const league = leagueOf(row);
            out.push({
              href,
              // The link's own text opens with the kickoff clock ("02:30").
              time: ((link.innerText || '').match(/\\b\\d{1,2}:\\d{2}\\b/) || [null])[0],
              parts: row.innerText.split('\\n').map((s) => s.trim()).filter(Boolean),
              leagueHref: league.href,
              leagueCountry: league.country,
              leagueName: league.name,
            });
          }
          return out;
        }
        """,
        sport,
    )


def _match_count(page: Page) -> int:
    """Distinct match links currently in the DOM (the list grows as it scrolls)."""
    return page.evaluate(
        "(sel) => new Set([...document.querySelectorAll(sel)].map((l) => l.getAttribute('href'))).size",
        MATCH_LINK,
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
        "league": _league_label(
            rec.get("leagueHref") or "", rec.get("leagueCountry") or "", rec.get("leagueName") or ""
        ),
    }


def _league_label(href: str, country: str = "", name: str = "") -> str:
    """"Country League", e.g. "England Premier League", "USA MLS".

    Prefers the names the listing header displays; falls back to prettifying
    the path (`/football/europe/champions-league/` -> "Europe Champions League")
    when a header renders no link text.
    """
    if name:
        return f"{country} {name}".strip()
    segs = [s for s in href.split("/") if s]
    if len(segs) < 2:
        return ""
    def pretty(s: str) -> str:
        return " ".join(w.capitalize() for w in s.replace("-", " ").split())
    # segs[0] is the sport; the rest is country (+ league).
    return " ".join(pretty(s) for s in segs[1:3])


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
    tried = 0
    # Latest kickoffs first: by the afternoon the day's earliest matches are
    # over, and finished matches' pages rarely give a usable kickoff.
    candidates = sorted(rows, key=lambda r: r["time"].zfill(5), reverse=True)
    for row in candidates[:CALIBRATION_SAMPLES]:
        tried += 1
        minutes = _sample_offset(page, row, day, nav_timeout_ms)
        if minutes is not None:
            offsets[minutes] += 1
            if offsets[minutes] >= 2:
                break  # two independent pages agree — that's the answer

    if not offsets:
        return None
    best, count = offsets.most_common(1)[0]
    if count < 2:
        # A one-vote "plurality" is a coin toss between the real offset and a
        # postponed fixture whose JSON-LD still carries its original kickoff —
        # and the loser silently shifts every kickoff in the run.
        log.warning("%s: no two of %d samples agreed on the listing timezone (%s)",
                    day, tried, dict(offsets))
        return None
    log.info("timezone calibration: listing is UTC%+d min (%d/%d samples agreed)",
             best, count, tried)
    return timedelta(minutes=best)


def _wait_for_prices(page: Page, timeout_ms: int) -> None:
    """Block until the listing's price cells have actually filled in.

    Rows render before their odds: the cells sit at "-" for a second or two
    after the match links appear, and a row read at that moment carries no
    prices, so `_parse_row` discards it as "not a 1x2 row". Waiting on the links
    alone is what once made this scrape return zero fixtures for every date —
    the thing the blind 8s sleep it replaced had been quietly covering.
    """
    page.wait_for_function(
        "() => {" + _ROW_OF_JS + """
          return [...document.querySelectorAll('a[href*="/h2h/"]')].some((l) => rowOf(l) !== null);
        }""",
        timeout=timeout_ms,
    )


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
    day = datetime.strptime(date_yyyymmdd, "%Y%m%d").strftime("%Y-%m-%d")
    url = f"{BASE}/{sport}/{day}/"
    try:
        # The listing sometimes stalls on a load and never prices up, then loads
        # in seconds on the next visit — so reload once before calling a date empty.
        for attempt in (1, 2):
            page.goto(url, wait_until="domcontentloaded", timeout=nav_timeout_ms)
            try:
                page.wait_for_selector(MATCH_LINK, timeout=nav_timeout_ms)
                _wait_for_prices(page, nav_timeout_ms)
                break
            except PlaywrightTimeout:
                if attempt == 2:
                    # A date with no fixtures at all is a normal outcome, not a failure.
                    log.info("%s: no priced rows on the listing", date_yyyymmdd)
                    return [], offset
                log.info("%s: listing didn't price up — reloading once", date_yyyymmdd)

        # The listing lazy-renders AND virtualises: rows recycle as you scroll,
        # dropping their prices on the way out. Reading once at the end loses
        # every row that has already scrolled past, so harvest what is on
        # screen at each step and keep the first priced sighting of each match.
        seen: dict[str, dict[str, Any]] = {}
        previous = prev_seen = -1
        for _ in range(12):
            for rec in _row_records(page, sport):
                row = _parse_row(rec)
                if row:
                    seen.setdefault(row["href"], row)
            count = _match_count(page)
            # Stop once neither the list nor our haul is still growing.
            if count == previous and len(seen) == prev_seen:
                break
            previous, prev_seen = count, len(seen)
            page.mouse.wheel(0, 5_000)
            page.wait_for_timeout(800)

        parsed = list(seen.values())
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
