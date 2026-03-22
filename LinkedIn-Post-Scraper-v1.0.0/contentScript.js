// content.js
// Lightweight listener so the page can receive STOP_SCRAPE from the background worker.
// The main scraping logic is injected directly via scripting.executeScript in background.js.

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STOP_SCRAPE') {
    window.__linkedinScraperStop = true;
  }
});