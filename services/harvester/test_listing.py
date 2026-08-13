"""Unit tests for the OddsPortal listing scraper (no network / browser).

Imported as a module rather than by name: the calibration tests swap out
`_jsonld_start`, which is the only call in this file's paths that would
otherwise need a browser and a live page.
"""

from datetime import datetime, timedelta, timezone

import oddsportal_listing as listing

UTC = timezone.utc

# One de-duplicated DOM record, as `_row_records` hands them to `_parse_row`.
# The trailing "12" is the bookmaker count the row also renders.
SAMPLE_REC = {
    "href": "/football/europe/champions-league/arsenal-chelsea-xQ77QTN0/#WE22s2T6",
    "time": "20:00",
    "parts": ["20:00", "Arsenal", "-", "Chelsea", "2.10", "3.40", "3.35", "12"],
    "leagueHref": "/football/europe/champions-league/",
}


def test_parse_row():
    row = listing._parse_row(SAMPLE_REC)
    assert row["home"] == "Arsenal"
    assert row["away"] == "Chelsea"
    assert row["odds"] == ["2.10", "3.40", "3.35"]
    assert row["league"] == "Europe: Champions League"


def test_parse_row_rejects_non_1x2():
    two_prices = {**SAMPLE_REC, "parts": ["20:00", "Arsenal", "-", "Chelsea", "2.10", "3.40"]}
    assert listing._parse_row(two_prices) is None
    assert listing._parse_row({**SAMPLE_REC, "time": None}) is None


def test_league_label():
    assert listing._league_label("/football/europe/champions-league/") == "Europe: Champions League"
    assert listing._league_label("/football/") == ""


def test_match_url_promotes_the_event_id():
    assert (listing._match_url("/football/h2h/arsenal-chelsea/#WE22s2T6")
            == "https://www.oddsportal.com/football/h2h/arsenal-chelsea/WE22s2T6")


def _stub_kickoffs(*starts):
    """Feed canned JSON-LD kickoffs to the calibration path, one per sample."""
    it = iter(starts)
    listing._jsonld_start = lambda *a: next(it)


def test_sample_offset_normalises_day_rollover():
    # The 20261021 listing shows a 00:30 kickoff that is really 00:30 on the
    # 22nd local (UTC+120), i.e. 22:30Z on the 21st: a raw delta of -1320 min.
    _stub_kickoffs(datetime(2026, 10, 21, 22, 30, tzinfo=UTC))
    row = {"href": "/football/h2h/a-b/#x", "time": "00:30"}
    assert listing._sample_offset(None, row, "20261021", 0) == 120


def test_calibration_rejects_a_plurality_of_one():
    rows = [{"href": "/football/h2h/a-b/#x", "time": "20:00"}] * 3
    # One vote each for +120 and +60 (a postponed fixture whose JSON-LD still
    # carries its original kickoff) plus a timed-out detail page: a tie broken
    # by insertion order would shift every kickoff in the run by an hour.
    _stub_kickoffs(
        datetime(2026, 10, 21, 18, 0, tzinfo=UTC),
        datetime(2026, 10, 21, 19, 0, tzinfo=UTC),
        None,
    )
    assert listing._calibrate_offset(None, rows, "20261021", 0) is None

    _stub_kickoffs(
        datetime(2026, 10, 21, 18, 0, tzinfo=UTC),
        datetime(2026, 10, 21, 18, 0, tzinfo=UTC),
        None,
    )
    assert listing._calibrate_offset(None, rows, "20261021", 0) == timedelta(minutes=120)
