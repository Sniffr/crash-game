# Odds harvester (Simulate feed)

Scrapes upcoming sports odds off OddsPortal's date listings with Playwright
(`oddsportal_listing.py`), normalizes them into the **Simulate fixtures feed**,
and uploads that feed to S3
(Contabo). The crash-game server reads the feed and serves it to the Simulate
game, where players build a bet slip and *simulate* the outcome (provably-fair
RNG at a configured RTP) instead of placing a real wager.

```
oddsportal_listing.py ──scrape──▶ normalize.py ──▶ fixtures feed ──▶ S3 (simulate/fixtures/latest.json)
                                                                     │
                                              crash-game server ◀────┘  (GET /api/simulate/fixtures)
```

## Feed shape

```json
{
  "feedVersion": 1,
  "generatedAt": "2026-08-07T08:00:00Z",
  "source": "oddsportal",
  "sport": "football",
  "fixtures": [
    {
      "eventId": "arsenal-chelsea-xQ77QTN0",
      "sport": "football",
      "league": "England Premier League",
      "home": "Arsenal",
      "away": "Chelsea",
      "kickoff": "2026-08-07T17:30:00Z",
      "markets": { "1x2": { "home": 2.1, "draw": 3.4, "away": 3.35 } }
    }
  ]
}
```

`eventId` is the stable OddsPortal match slug; `1x2` odds are the **median**
across the prices the listing returned (FullTime period).

## Run it

```bash
pip install -r requirements.txt
playwright install chromium          # first run only (outside the Docker image)

# scrape + normalize + print, no S3 write:
python -m harvester --dry-run

# scrape the next 7 days and upload to S3:
python -m harvester --once

# unit tests (no network):
pytest
```

## Configuration (all via env)

| Var | Default | Meaning |
| --- | --- | --- |
| `HARVEST_SPORT` | `football` | OddsPortal sport path segment |
| `HARVEST_DAYS` | `7` | rolling window: today … today+N-1 |
| `HARVEST_INTERVAL_SEC` | `0` | `0` = one-shot; `>0` = loop every N seconds |
| `HARVEST_HEADLESS` | `true` | run Chromium headless |
| `HARVEST_TIMEOUT_SEC` | `900` | wall-clock budget for a whole run (checked between dates) |
| `HARVEST_NAV_TIMEOUT_SEC` | `60` | per-page-load timeout |
| `S3_ENDPOINT` | — | e.g. `https://eu2.contabostorage.com` |
| `S3_REGION` | `eu2` | S3 region |
| `S3_BUCKET` | — | e.g. `crash` |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | — | credentials |

If a scrape yields no fixtures (network down, Chromium missing), the run
exits non-zero and **does not touch S3** — the server keeps serving the
last-good `latest.json` (or its bundled sample), so Simulate never goes dark.
