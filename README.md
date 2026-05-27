# pi-ollama-cloud-usage-tracker

Pi extension that shows live Ollama Cloud usage in the footer status line with
Claude-style quota bars.

```
5h ▕███░░░░░░░▏ 34% ⟳ 3h14m 7d ▕████░░░░░░▏ 45% ⟳ 3d16h
```

- **5h** — session (5-hour window) percentage bar with reset countdown
- **7d** — weekly (7-day window) percentage bar with reset countdown
- Bar color reflects **pace** (usage% vs elapsed%): green if under budget,
  cyan if on track, yellow/red if burning fast
- Countdown shows time remaining until the window resets

## How it works

1. Extracts Chrome cookies from the local cookie database using
   [`@steipete/sweet-cookie`](https://github.com/steipete/sweet-cookie)
2. If the Chrome cookie encryption key is locked in the system keyring,
   falls back to a tiny Python helper (`get-keyring-password.py`) that
   tries `gi` → `secret-tool` → `browser_cookie3` to unlock it
3. Fetches `https://ollama.com/settings` with those cookies
4. Parses usage percentages and reset timestamps from the dashboard HTML
5. Refreshes every 5 minutes and after each agent turn
6. Only activates when `ollama-cloud` is the active provider

## Installation

```bash
pi install npm:@entelligentsia/pi-ollama-cloud-usage-tracker
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@entelligentsia/pi-ollama-cloud-usage-tracker"]
}
```

Reload with `/reload` in pi.

## Requirements

- **Node.js** ≥ 22 (for `node:sqlite` used by sweet-cookie)
- **Chrome** with an active Ollama Cloud login session
- **One of** (for Linux keyring access):
  - `libsecret-tools` (`secret-tool` CLI) — install with `sudo apt install libsecret-tools`
  - `python3-gi` + `gir1.2-secret-1` (PyGObject) — pre-installed on most GNOME desktops
  - `browser_cookie3` (Python, uses jeepney/dbus-python) — `pip install browser-cookie3`

  On macOS and Windows, sweet-cookie handles keyring access natively — no extra
  packages needed.

## Files

```
src/
  index.ts                  # Pi extension entry — footer rendering + events
  scraper.ts                # Cookie extraction + HTML scraping (TypeScript)
  get-keyring-password.py  # Linux keyring fallback (Python shim)
package.json                # npm package manifest + pi extension config
tsconfig.json               # TypeScript configuration
```

## License

MIT