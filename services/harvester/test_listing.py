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
    "leagueCountry": "Europe",
    "leagueName": "Champions League",
}


def test_parse_row():
    row = listing._parse_row(SAMPLE_REC)
    assert row["home"] == "Arsenal"
    assert row["away"] == "Chelsea"
    assert row["odds"] == ["2.10", "3.40", "3.35"]
    assert row["league"] == "Europe Champions League"


def test_parse_row_rejects_non_1x2():
    two_prices = {**SAMPLE_REC, "parts": ["20:00", "Arsenal", "-", "Chelsea", "2.10", "3.40"]}
    assert listing._parse_row(two_prices) is None
    assert listing._parse_row({**SAMPLE_REC, "time": None}) is None


def test_league_label():
    # Header names win; the path is only a fallback.
    assert listing._league_label("/football/usa/mls/", "USA", "MLS") == "USA MLS"
    assert listing._league_label("/football/europe/champions-league/") == "Europe Champions League"
    assert listing._league_label("/football/") == ""


def test_match_url_promotes_the_event_id():
    assert (listing._match_url("/football/h2h/arsenal-chelsea/#WE22s2T6")
            == "https://www.oddsportal.com/football/h2h/arsenal-chelsea/WE22s2T6")


# The listing as OddsPortal renders it since September 2026: no data-testid
# hooks, utility classes only. A league group's first item carries the header
# (links to /football/<country>/<league>/) and the column heads; later items are
# bare rows. Rows are an <a> to the h2h page (clock + teams) plus a price list.
LISTING_HTML = """
<div class="tabs"><a href="/football/">Football</a><a href="/football/2026-09-27/">Tomorrow</a></div>
<div data-client-only-list><div>
  <div class="flex w-full flex-col">
    <div><a href="/football/">Football</a> / <a href="/football/usa/">USA</a> / <a href="/football/usa/mls/">MLS</a></div>
    <div>Tomorrow, 27 Sep <span>1</span><span>X</span><span>2</span></div>
    <div class="flex flex-col"><div class="flex w-full">
      <a href="/football/h2h/atlanta-united-EPngUvhk/new-york-city-vZraQYnO/#h8OvjEB6">
        <div>02:30</div><div><p>Atlanta Utd</p><p>-</p><p>New York City</p></div></a>
      <div></div><ul><li>2.28</li><li>3.54</li><li>2.93</li></ul>
    </div></div>
  </div>
  <div class="flex w-full">
    <a href="/football/h2h/cf-montreal-j9cigLCr/fc-cincinnati-8btog05R/#YFRRxgDM">
      <div>02:30</div><div><p>CF Montreal</p><p>-</p><p>FC Cincinnati</p></div></a>
    <div></div><ul><li>-</li><li>-</li><li>-</li></ul>
  </div>
  <div class="flex w-full flex-col">
    <div><a href="/football/">Football</a> / <a href="/football/europe/">Europe</a> / <a href="/football/europe/uefa-nations-league/">Nations League</a></div>
    <div>Tomorrow, 27 Sep</div>
    <div class="flex flex-col"><div class="flex w-full">
      <a href="/football/h2h/norway-8rP6JO0H/portugal-WvJrjFVN/#UycFdR8s">
        <div>21:45</div><div><p>Norway</p><p>-</p><p>Portugal</p></div></a>
      <div></div><ul><li>2.51</li><li>3.69</li><li>2.57</li></ul>
    </div></div>
  </div>
  <div class="flex w-full">
    <a href="/football/h2h/spain-bLyo6mco/france-QkGeVG1n/#Kd2Fp7Uy">
      <div>21:45</div><div><p>Spain</p><p>-</p><p>France</p></div></a>
    <div></div><ul><li>1.95</li><li>3.40</li><li>4.10</li></ul>
  </div>
</div></div>
"""


def test_row_records_reads_the_current_listing_markup():
    """Runs the real in-page extraction in Chromium; skipped where it isn't installed."""
    import pytest

    sync_api = pytest.importorskip("playwright.sync_api")
    try:
        pw = sync_api.sync_playwright().start()
        browser = pw.chromium.launch()
    except Exception as e:  # noqa: BLE001 — no browser binary on this machine
        pytest.skip(f"chromium unavailable: {e}")
    try:
        page = browser.new_page()
        page.set_content(LISTING_HTML)
        rows = [listing._parse_row(r) for r in listing._row_records(page, "football")]
        assert listing._match_count(page) == 4
    finally:
        browser.close()
        pw.stop()

    parsed = [r for r in rows if r]
    # The unpriced Montreal row is skipped, and each row takes its own group's league.
    assert [(r["home"], r["away"], r["time"], r["league"], r["odds"]) for r in parsed] == [
        ("Atlanta Utd", "New York City", "02:30", "USA MLS", ["2.28", "3.54", "2.93"]),
        ("Norway", "Portugal", "21:45", "Europe Nations League", ["2.51", "3.69", "2.57"]),
        ("Spain", "France", "21:45", "Europe Nations League", ["1.95", "3.40", "4.10"]),
    ]


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
