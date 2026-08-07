"""Unit tests for the harvester normalizer (no network / S3 / Playwright)."""

from normalize import (
    aggregate_1x2,
    build_feed,
    event_id_from_link,
    normalize_match,
    parse_kickoff,
)

SAMPLE_MATCH = {
    "scraped_date": "2026-02-02 09:30:03 UTC",
    "match_date": "2027-02-21 20:00:00 UTC",
    "match_link": "https://www.oddsportal.com/football/england/premier-league/leicester-brentford-xQ77QTN0",
    "home_team": "Leicester",
    "away_team": "Brentford",
    "league_name": "Premier League 2026/2027",
    "1x2_market": [
        {"1": "3.50", "X": "3.67", "2": "1.96", "bookmaker_name": "Betclic", "period": "FullTime"},
        {"1": "3.60", "X": "3.70", "2": "1.95", "bookmaker_name": "bwin", "period": "FullTime"},
        {"1": "3.65", "X": "3.80", "2": "1.96", "bookmaker_name": "Winamax", "period": "FullTime"},
    ],
}


def test_event_id_from_link():
    assert event_id_from_link(SAMPLE_MATCH["match_link"]) == "leicester-brentford-xQ77QTN0"
    assert event_id_from_link(None) is None
    assert event_id_from_link("") is None


def test_parse_kickoff():
    assert parse_kickoff("2027-02-21 20:00:00 UTC") == "2027-02-21T20:00:00Z"
    assert parse_kickoff("2027-02-21T20:00:00") == "2027-02-21T20:00:00Z"
    assert parse_kickoff("garbage") is None


def test_aggregate_1x2_median():
    agg = aggregate_1x2(SAMPLE_MATCH["1x2_market"])
    assert agg == {"home": 3.6, "draw": 3.7, "away": 1.96}


def test_aggregate_1x2_rejects_bad_prices():
    assert aggregate_1x2([{"1": "1.0", "X": "x", "2": None}]) is None
    assert aggregate_1x2([]) is None
    assert aggregate_1x2(None) is None


def test_normalize_match():
    fx = normalize_match(SAMPLE_MATCH)
    assert fx["eventId"] == "leicester-brentford-xQ77QTN0"
    assert fx["home"] == "Leicester"
    assert fx["away"] == "Brentford"
    assert fx["kickoff"] == "2027-02-21T20:00:00Z"
    assert fx["markets"]["1x2"]["away"] == 1.96


def test_normalize_match_missing_fields():
    assert normalize_match({"home_team": "A"}) is None
    assert normalize_match({}) is None
    assert normalize_match("not a dict") is None


def test_build_feed_filters_past_and_dedupes():
    past = {**SAMPLE_MATCH, "match_date": "2000-01-01 12:00:00 UTC", "match_link": ".../past-x1"}
    dup = {**SAMPLE_MATCH}
    feed = build_feed([SAMPLE_MATCH, dup, past], generated_at="2026-08-07T06:00:00Z")
    ids = [f["eventId"] for f in feed["fixtures"]]
    assert ids == ["leicester-brentford-xQ77QTN0"]  # dup removed, past dropped
    assert feed["feedVersion"] == 1
    assert feed["sport"] == "football"


def test_build_feed_sorts_by_kickoff():
    m1 = {**SAMPLE_MATCH, "match_date": "2027-05-01 12:00:00 UTC", "match_link": ".../late-x2"}
    m2 = {**SAMPLE_MATCH, "match_date": "2027-03-01 12:00:00 UTC", "match_link": ".../early-x3"}
    feed = build_feed([m1, m2], generated_at="2026-08-07T06:00:00Z")
    kickoffs = [f["kickoff"] for f in feed["fixtures"]]
    assert kickoffs == sorted(kickoffs)
