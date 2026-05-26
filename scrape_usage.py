"""Scrape Ollama Cloud usage from the settings dashboard.

Outputs JSON to stdout. Designed to be called from a pi extension via
child_process.execFile.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone

import browser_cookie3
import requests
from bs4 import BeautifulSoup


def main() -> None:
    try:
        cj = browser_cookie3.chrome(domain_name="ollama.com")
        cookies = {c.name: c.value for c in cj}
    except Exception as e:
        print(json.dumps({"error": f"Cookie extraction failed: {e}"}))
        sys.exit(1)

    if not cookies:
        print(json.dumps({"error": "No Ollama Cloud cookies found"}))
        sys.exit(1)

    try:
        resp = requests.get(
            "https://ollama.com/settings",
            cookies=cookies,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                ),
                "Accept": "text/html,application/xhtml+xml",
            },
            timeout=30,
            allow_redirects=False,
        )
        resp.raise_for_status()
    except Exception as e:
        print(json.dumps({"error": f"Settings fetch failed: {e}"}))
        sys.exit(1)

    soup = BeautifulSoup(resp.text, "html.parser")
    result: dict = {"fetched_at": datetime.now(timezone.utc).isoformat()}

    for track in soup.find_all("div", attrs={"aria-label": True}):
        aria = str(track["aria-label"])
        if not aria.startswith(("Session usage ", "Weekly usage ")):
            continue

        parts = aria.split()
        window = parts[0].lower()  # "session" or "weekly"
        pct = float(parts[2].rstrip("%"))

        result[f"{window}_pct"] = pct

        # Extract reset time from parent hierarchy
        meter_div = track.parent
        if meter_div:
            wrapper = meter_div.parent
            if wrapper:
                reset_div = wrapper.find("div", attrs={"data-time": True})
                if reset_div:
                    result[f"{window}_resets_at"] = reset_div["data-time"]

    if "session_pct" not in result:
        print(json.dumps({"error": "No usage data found on page"}))
        sys.exit(1)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
