# Odds harvester for the Simulate game.
# Playwright base image ships Chromium + all system libs OddsHarvester needs.
FROM mcr.microsoft.com/playwright/python:v1.47.0-jammy

WORKDIR /app

COPY services/harvester/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY services/harvester/ ./

# One-shot by default; set HARVEST_INTERVAL_SEC>0 to loop, or override the CMD.
ENV HARVEST_SPORT=football \
    HARVEST_MARKETS=1x2 \
    HARVEST_DAYS=7 \
    HARVEST_INTERVAL_SEC=0 \
    HARVEST_HEADLESS=true

CMD ["python", "-m", "harvester"]
