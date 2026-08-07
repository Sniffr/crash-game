"""Pure transforms: OddsHarvester JSON  ->  Simulate fixtures feed.

This module has NO network / S3 / Playwright dependency so it is fully unit
testable. `harvester.py` calls it after scraping; `test_normalize.py` calls it
against captured sample data.

The output "fixtures feed" is the contract the crash-game server reads
(see packages/server/src/simulate/fixtures.ts). Keep the two in sync.

Feed shape::

    {
      "generatedAt": "2026-08-07T08:00:00Z",
      "source": "oddsportal",
      "sport": "football",
      "fixtures": [
        {
          "eventId": "leicester-brentford-xQ77QTN0",
          "sport": "football",
          "league": "Premier League 2024/2025",
          "home": "Leicester",
          "away": "Brentford",
          "kickoff": "2025-02-21T20:00:00Z",
          "markets": { "1x2": { "home": 3.6, "draw": 3.75, "away": 1.96 } }
        }
      ]
    }
"""

from __future__ import annotations

import re
import statistics
from datetime import datetime, timezone
from typing import Any, Iterable

FEED_VERSION = 1


def _to_float(v: Any) -> float | None:
    """Parse an odds cell ("3.50" / 3.5) into a float > 1, else None."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f <= 1.0 or f != f:  # reject <=1 and NaN
        return None
    return round(f, 3)


def event_id_from_link(match_link: str | None) -> str | None:
    """OddsPortal match URLs end with a stable slug+id, e.g.

        https://www.oddsportal.com/football/england/premier-league/leicester-brentford-xQ77QTN0

    We use that final path segment as the fixture's stable id.
    """
    if not match_link or not isinstance(match_link, str):
        return None
    seg = match_link.rstrip("/").rsplit("/", 1)[-1]
    seg = seg.strip()
    return seg or None


def parse_kickoff(match_date: str | None) -> str | None:
    """"2025-02-21 20:00:00 UTC" (or ISO) -> "2025-02-21T20:00:00Z"."""
    if not match_date or not isinstance(match_date, str):
        return None
    s = match_date.strip()
    # Strip a trailing " UTC" / timezone word and normalise separators.
    s = re.sub(r"\s+UTC$", "", s)
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            dt = datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
            return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            continue
    # Last resort: fromisoformat handles offset forms.
    try:
        dt = datetime.fromisoformat(match_date.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None


def aggregate_1x2(market_rows: Iterable[dict[str, Any]] | None) -> dict[str, float] | None:
    """Median of home/draw/away decimal odds across bookmakers.

    Only FullTime rows are used when a period is present (falls back to all
    rows if none are marked). Returns None if any of the three outcomes has no
    usable price.
    """
    if not market_rows:
        return None
    rows = list(market_rows)
    ft = [r for r in rows if str(r.get("period", "")).lower() in ("", "fulltime", "full time")]
    use = ft or rows

    homes, draws, aways = [], [], []
    for r in use:
        h, d, a = _to_float(r.get("1")), _to_float(r.get("X")), _to_float(r.get("2"))
        if h is not None:
            homes.append(h)
        if d is not None:
            draws.append(d)
        if a is not None:
            aways.append(a)
    if not homes or not draws or not aways:
        return None
    return {
        "home": round(statistics.median(homes), 3),
        "draw": round(statistics.median(draws), 3),
        "away": round(statistics.median(aways), 3),
    }


def normalize_match(match: dict[str, Any], sport: str = "football") -> dict[str, Any] | None:
    """One OddsHarvester match dict -> one fixture, or None if unusable."""
    if not isinstance(match, dict):
        return None
    event_id = event_id_from_link(match.get("match_link"))
    home = match.get("home_team")
    away = match.get("away_team")
    kickoff = parse_kickoff(match.get("match_date"))
    if not event_id or not home or not away or not kickoff:
        return None

    markets: dict[str, Any] = {}
    one_x_two = aggregate_1x2(match.get("1x2_market"))
    if one_x_two:
        markets["1x2"] = one_x_two

    if not markets:
        return None  # nothing to bet on

    return {
        "eventId": event_id,
        "sport": sport,
        "league": match.get("league_name") or "",
        "home": home,
        "away": away,
        "kickoff": kickoff,
        "markets": markets,
    }


def build_feed(
    matches: Iterable[dict[str, Any]],
    *,
    sport: str = "football",
    generated_at: str | None = None,
    source: str = "oddsportal",
) -> dict[str, Any]:
    """Normalize a list of OddsHarvester matches into the fixtures feed.

    De-dupes by eventId (keeps the first), drops fixtures whose kickoff is in
    the past relative to `generated_at`, and sorts by kickoff ascending.
    """
    gen = generated_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    now_dt = datetime.strptime(gen, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)

    seen: set[str] = set()
    fixtures: list[dict[str, Any]] = []
    for m in matches:
        fx = normalize_match(m, sport=sport)
        if not fx or fx["eventId"] in seen:
            continue
        ko = datetime.strptime(fx["kickoff"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        if ko < now_dt:
            continue  # only upcoming fixtures are simulatable
        seen.add(fx["eventId"])
        fixtures.append(fx)

    fixtures.sort(key=lambda f: f["kickoff"])
    return {
        "feedVersion": FEED_VERSION,
        "generatedAt": gen,
        "source": source,
        "sport": sport,
        "fixtures": fixtures,
    }
