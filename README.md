# pi-ollama-cloud-usage-tracker

Pi extension that shows live Ollama Cloud usage in the footer status line.

```
5h 34% ⟳ 3h14m 7d 45% ⟳ 3d16h
```

- **5h** — session (5-hour window) percentage with reset countdown
- **7d** — weekly (7-day window) percentage with reset countdown
- Percent text color reflects **pace** (usage% vs elapsed%): green if under
  budget, cyan if on track, yellow/red if burning fast
- Sub-percent values are shown up to 2 decimals (e.g. `0.2%`, `1.25%`) to
  match the ollama.com dashboard
- Countdown shows time remaining until the window resets

## How it works

1. Extracts cookies from your local browser cookie database using
   [`@steipete/sweet-cookie`](https://github.com/steipete/sweet-cookie).
   Tries **Firefox first** (cookies.sqlite is unencrypted, no keyring needed)
   then falls back to **Chrome** and other Chromium-based browsers.
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
- **Firefox** or **Chrome** (or another Chromium-based browser like Helium,
  Brave, Arc) with an active Ollama Cloud login session. Firefox is preferred
  on macOS — its cookie database is unencrypted, so the extension works
  without any keychain access. On Linux, Firefox also works out of the box;
  Chromium-based browsers additionally need:
- **One of** (for Linux Chromium keyring access):
  - `libsecret-tools` (`secret-tool` CLI) — install with `sudo apt install libsecret-tools`
  - `python3-gi` + `gir1.2-secret-1` (PyGObject) — pre-installed on most GNOME desktops
  - `browser_cookie3` (Python, uses jeepney/dbus-python) — `pip install browser-cookie3`

  On macOS and Windows, sweet-cookie handles keyring access natively — no extra
  packages needed.

### Configuration

The Firefox profile is auto-discovered under
`~/Library/Application Support/Firefox/Profiles/` on macOS (or
`~/.mozilla/firefox/` on Linux). To pin a specific profile, set:

```bash
export OLLAMA_USAGE_FIREFOX_PROFILE="/path/to/Firefox/Profiles/xxxxx.profile-name"
```

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