# pi-ollama-cloud-usage-tracker

Pi extension that shows live Ollama Cloud usage in the footer status line.

When the active provider is `ollama-cloud`, it displays:

```
🟢 12.7% ↻58m · 31%/wk
```

- **Session** (5h window): percentage used + countdown to reset
- **Weekly** (7d window): percentage used
- Color-coded: 🟢 under 50%, 🟡 50-80%, 🔴 over 80%

## How it works

- Scrapes `https://ollama.com/settings` using your Chrome cookies (`browser_cookie3`)
- Refreshes every 5 minutes and after each agent turn
- Only activates when `ollama-cloud` is the active provider

## Installation

```bash
pi install /home/boni/src/pi-ollama-cloud-usage-tracker
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["/home/boni/src/pi-ollama-cloud-usage-tracker"]
}
```

Reload with `/reload` in pi.

## Requirements

- Python 3.10+ with `browser-cookie3`, `requests`, `beautifulsoup4`
- Chrome with an active Ollama Cloud login session

## Files

```
├── package.json       # pi package manifest
├── index.ts           # Extension entry point
├── scrape_usage.py    # Python usage scraper
└── README.md
```
