# Odds harvester for the Simulate game.
# Playwright base image ships Chromium + all the system libs it needs.
#
# The tag must equal the playwright version requirements.txt pins (1.62.0): the
# image ships browsers built for its own tag, so a mismatched tag leaves pip's
# driver looking for a Chromium revision that isn't there.
FROM mcr.microsoft.com/playwright/python:v1.62.0-noble

WORKDIR /app

COPY services/harvester/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY services/harvester/ ./

# One-shot by default; set HARVEST_INTERVAL_SEC>0 to loop, or override the CMD.
ENV HARVEST_SPORT=football \
    HARVEST_DAYS=7 \
    HARVEST_INTERVAL_SEC=0 \
    HARVEST_HEADLESS=true

CMD ["python", "-m", "harvester"]
