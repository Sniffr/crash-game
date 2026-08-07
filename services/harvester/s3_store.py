"""S3 (Contabo) upload for the fixtures feed.

Credentials come entirely from env (see .env.example):

    S3_ENDPOINT     e.g. https://eu2.contabostorage.com
    S3_REGION       e.g. eu2
    S3_BUCKET       e.g. crash
    S3_ACCESS_KEY
    S3_SECRET_KEY

The feed is written to two keys so the server can read a stable "latest" while
we keep a dated audit trail:

    simulate/fixtures/latest.json
    simulate/fixtures/<sport>/<YYYY-MM-DD>.json
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

LATEST_KEY = "simulate/fixtures/latest.json"


def _require(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(f"{name} is not set")
    return v


def make_client():
    """Build an S3 client for a path-style (Contabo) endpoint."""
    import boto3  # lazy: only needed when actually uploading (keeps --dry-run dep-free)
    from botocore.client import Config

    return boto3.client(
        "s3",
        endpoint_url=_require("S3_ENDPOINT"),
        region_name=os.environ.get("S3_REGION", "eu2"),
        aws_access_key_id=_require("S3_ACCESS_KEY"),
        aws_secret_access_key=_require("S3_SECRET_KEY"),
        config=Config(s3={"addressing_style": "path"}),
    )


def dated_key(sport: str, generated_at: str) -> str:
    day = generated_at[:10]  # YYYY-MM-DD
    return f"simulate/fixtures/{sport}/{day}.json"


def upload_feed(feed: dict[str, Any], *, client=None) -> list[str]:
    """Upload the feed to the latest + dated keys. Returns the keys written."""
    client = client or make_client()
    bucket = _require("S3_BUCKET")
    body = json.dumps(feed, ensure_ascii=False).encode("utf-8")
    sport = feed.get("sport", "football")
    generated_at = feed.get("generatedAt") or datetime.now(timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )

    keys = [LATEST_KEY, dated_key(sport, generated_at)]
    for key in keys:
        client.put_object(
            Bucket=bucket,
            Key=key,
            Body=body,
            ContentType="application/json",
            CacheControl="public, max-age=60",
        )
    return keys
