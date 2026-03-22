LinkedIn Post Scraper

> A Chrome Extension that automates LinkedIn post extraction for media monitoring workflows. Search by keyword, filter by date range, and export clean structured data — instantly.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Platform](https://img.shields.io/badge/platform-Chrome-yellow)
![Manifest](https://img.shields.io/badge/manifest-v3-green)

---

## What It Does

Media monitoring on LinkedIn is a manual, time-consuming process. Analysts spend hours scrolling, copying post content, extracting timestamps with external tools, and compiling everything into spreadsheets.

**This extension automates the entire workflow in one click.**

You set a keyword on LinkedIn's search page, pick a date range, hit Start — and the extension scrolls, extracts, and exports a clean CSV with everything you need.

---

## Features

- **Keyword-based post extraction** — works directly on LinkedIn's Posts search results
- **Date range filtering** — scrape only posts within your specified window
- **Extracts 6 fields per post** — No., Date Posted, Profile Name, Followers, Post Content, Post URL
- **Handles LinkedIn's dual UI** — works on both the legacy DOM and LinkedIn's newer SDUI card format
- **Built-in timestamp parsing** — converts relative times (`2h`, `1d`, `1mo`) to exact calendar dates, no external tools needed
- **Repost content isolation** — strips repost bleed, company follower headers, author degree lines, and LinkedIn UI artifacts from post content
- **Live progress display** — real-time post count and progress bar while scraping
- **Runs in background** — close the popup anytime, scraping continues uninterrupted
- **One-click CSV export** — structured, UTF-8 encoded, ready for analyst workflows

---

## Output Format

Each exported CSV contains the following columns:

| Column | Description |
|---|---|
| No. | Row index |
| Date Posted | Exact date (YYYY-MM-DD) |
| Profile Name | Author name, company, or group page |
| Followers | Follower count (where available) |
| Post Content | Clean parent post text only (reposts stripped) |
| Post URL | Direct LinkedIn post link |

---

## Installation

> This extension is not on the Chrome Web Store. Install it manually as an unpacked extension.

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked**
5. Select the extension folder

The extension icon will appear in your Chrome toolbar.

---

## How to Use

1. Go to [LinkedIn](https://www.linkedin.com) and search for a keyword
2. Click the **Posts** tab in search results
3. Sort by **Latest** (important — ensures date filtering works correctly)
4. Click the extension icon in your toolbar
5. Set your **Start Date** and **End Date**
6. Click **Start** — the extension begins scrolling and collecting posts
7. You can close the popup — scraping runs in the background
8. Reopen the popup to check progress
9. When complete, click **Download CSV** to export your data

---

## Project Structure

```
hookedin/
├── manifest.json        # Extension config, permissions, version
├── background.js        # Core scraping logic, service worker
├── popup.html           # Extension popup UI
├── popup.js             # Popup controls and live progress
├── contentScript.js     # Injected into LinkedIn page
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Technical Overview

### Architecture

The extension is built on Chrome's **Manifest V3** architecture with three components working together:

- **popup.html / popup.js** — User interface for date input, start/stop/export controls, and live progress
- **background.js** — Service worker managing the scraping pipeline, state, and exports
- **contentScript.js** — Injected into the LinkedIn tab for DOM interaction

### Key Technical Details

**Dual UI Detection**
LinkedIn runs two UI systems simultaneously — a legacy DOM (`data-urn` attributes) and a newer SDUI card format (`componentkey` attributes). The extension detects and handles both.

**Keep-Alive Mechanism**
Chrome MV3 service workers go idle after inactivity. A keep-alive ping fires every 20 seconds to prevent the scraper from stopping mid-run.

**Custom Date Parser**
LinkedIn shows relative timestamps (`33m`, `2h`, `1d`, `3mo`). A custom parser converts these to exact calendar dates — no external tools required.

**Repost Content Isolation**
LinkedIn reposts embed the original post's content inside the resharer's card. The scraper isolates the parent post content by detecting:
- Timestamp boundaries (`2d •`, `1mo •`)
- Repost author lines (`Name • 3rd+`)
- Company follower headers (`Company 12,345 followers`)
- LinkedIn's `Show translation` UI artifact

**State Persistence**
Scraped data, progress, and date inputs are stored in `chrome.storage.local` — so if you close and reopen the popup mid-scrape, everything is preserved.

**Rate Handling**
Paced scrolling and stop signals reduce excessive activity, minimising the risk of temporary LinkedIn account restrictions.

---

## Roadmap

### Phase 1 — Core Automation ✅ Completed (v1.0.0)
- Chrome Extension with full scraping pipeline
- Dual UI compatibility (legacy + SDUI)
- Date range filtering with custom timestamp parser
- Repost content isolation
- CSV export

### Phase 2 — Enhanced Data Enrichment 🚧 Planned
- Region
- Follower count for every profile

### Phase 3 — Sentiment Intelligence 🚧 Planned
- Generative AI integration for automated post analysis
- Sentiment classification (positive / negative / neutral)
- Brand mention extraction, prominence scoring, topic classification

---

## Limitations

- **LinkedIn UI changes** — LinkedIn periodically updates their DOM structure. The extension may need updates when this happens. Watch for `nan` profile names or 0 posts scraped as indicators.
- **Follower count** — LinkedIn does not always expose follower counts for personal profiles. These will appear blank in the export.
- **Platform restrictions** — LinkedIn's terms of service restrict automated data collection. Use responsibly.

---

## Built With

- JavaScript (Chrome Extension APIs)
- Chrome Manifest V3
- `chrome.scripting`, `chrome.storage`, `chrome.downloads`

---

## Author

Developed by **Team Dorado**
Media Monitoring Analyst — CapeStart / Fullintel

---

## License

This project is intended for internal use within media monitoring workflows.

---

*Built for the CapeStart Ideathon 2026*
