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

- Extracts Chrome cookies via [`@steipete/sweet-cookie`](https://github.com/steipete/sweet-cookie) (no native addons, no Python)
- Scrapes `https://ollama.com/settings` with those cookies
- Parses usage percentages and reset timestamps from the dashboard HTML
- Refreshes every 5 minutes and after each agent turn
- Only activates when `ollama-cloud` is the active provider

## Installation

```bash
pi install @entelligentsia/pi-ollama-cloud-usage-tracker
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["@entelligentsia/pi-ollama-cloud-usage-tracker"]
}
```

Reload with `/reload` in pi.

## Requirements

- Node.js ≥ 22 (for `node:sqlite` used by `@steipete/sweet-cookie`)
- Chrome with an active Ollama Cloud login session

## Files

```
src/
  index.ts       # Pi extension entry point – footer rendering + events
  scraper.ts     # Pure TS usage scraper (cookies → fetch → parse)
package.json     # npm package manifest + pi extension config
tsconfig.json    # TypeScript configuration
```

## License

MIT