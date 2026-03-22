// background.js — GLOBAL
// Based on the original working code with 4 minimal additions:
//
// 1. Keep-alive: prevents service worker going idle on fresh installs
//    (fixes "scroll only, no posts" on friend's machine)
//
// 2. sdui card detection: adds div[componentkey] "Feed post" cards
//    (fixes LinkedIn's new UI that doesn't use data-urn)
//
// 3. extractURL improvements: feed/update first, group posts, profile fallback
//    (fixes wrong/missing URLs on new LinkedIn UI)
//
// 4. dateFromRelativeTime: handles sdui "33m", "2h", "1d" format
//    (fixes date filtering on new LinkedIn UI)
//
// Everything else is identical to the original working code.

let isScraping        = false;
let scrapeTabId       = null;
let keepAliveInterval = null;

function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(function() {
    chrome.storage.local.get(['totalCount'], function() {});
  }, 20000);
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

chrome.runtime.onMessage.addListener((msg) => {

  if (msg.type === 'START_SCRAPE') {
    if (isScraping) {
      notify({ type: 'PROGRESS', error: 'Already scraping. Stop first or refresh the tab.' });
      return;
    }
    isScraping  = true;
    scrapeTabId = msg.tabId;
    chrome.storage.local.set({ scrapedPosts: [], scraping: true, totalCount: 0 });
    startKeepAlive();
    runScrape(msg);
  }

  if (msg.type === 'STOP_SCRAPE') {
    isScraping = false;
    stopKeepAlive();
    chrome.storage.local.set({ scraping: false });
    if (scrapeTabId) chrome.tabs.sendMessage(scrapeTabId, { type: 'STOP_SCRAPE' }).catch(() => {});
  }

  if (msg.type === 'BATCH') {
    chrome.storage.local.get(['scrapedPosts'], res => {
      const all = [...(res.scrapedPosts || []), ...msg.posts];
      chrome.storage.local.set({ scrapedPosts: all, totalCount: all.length });
      notify({ type: 'PROGRESS', pct: Math.min(88, msg.pct || 20), text: msg.text, count: all.length });
    });
  }

  if (msg.type === 'DONE') {
    isScraping = false;
    stopKeepAlive();
    chrome.storage.local.set({ scraping: false });
    chrome.storage.local.get(['scrapedPosts'], res => {
      const n = (res.scrapedPosts || []).length;
      notify({ type: 'PROGRESS', pct: 100, text: 'Done! ' + n + ' posts. Downloading...', done: true, count: n });
    });
  }

  if (msg.type === 'ERROR') {
    isScraping = false;
    stopKeepAlive();
    chrome.storage.local.set({ scraping: false });
    notify({ type: 'PROGRESS', pct: 0, error: msg.error });
  }

  if (msg.type === 'GET_POST_URL' && scrapeTabId) {
    var markAttr = msg.markAttr;
    var resultAttr = msg.resultAttr;
    chrome.scripting.executeScript({
      target: { tabId: scrapeTabId },
      world: 'MAIN',
      func: function(mAttr, rAttr) {
        var card = document.querySelector('[' + mAttr + ']');
        if (!card) return;
        var orig = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = function(text) {
          navigator.clipboard.writeText = orig;
          card.setAttribute(rAttr, text);
          return orig(text);
        };
      },
      args: [markAttr, resultAttr]
    }).catch(function() {});
    return true;
  }

  if (msg.type === 'RUN_MAIN_MENU' && scrapeTabId) {
    var markAttr = msg.markAttr;
    var resultAttr = msg.resultAttr;
    // Inject mainWorldMenuClick into MAIN world — handles portal polling + clipboard intercept
    chrome.scripting.executeScript({
      target: { tabId: scrapeTabId },
      world: 'MAIN',
      func: function(mAttr, rAttr) {
        var card = document.querySelector('[' + mAttr + ']');
        if (!card) return;

        var menuBtn = card.querySelector('button[aria-label*="control menu"]');
        if (!menuBtn) { card.setAttribute(rAttr, ''); return; }

        // Intercept clipboard BEFORE clicking (works in MAIN world)
        var captured = '';
        var orig = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = function(text) {
          captured = text;
          navigator.clipboard.writeText = orig;
          return orig(text);
        };

        menuBtn.click();

        // Poll for portal + spinner gone
        var elapsed = 0;
        var waitForMenu = setInterval(function() {
          elapsed += 200;
          var portal = document.querySelector('[data-floating-ui-portal]');
          if (!portal || portal.querySelector('[role="progressbar"]')) {
            if (elapsed >= 8000) {
              clearInterval(waitForMenu);
              try { navigator.clipboard.writeText = orig; } catch(e) {}
              document.body.click();
              card.setAttribute(rAttr, '');
            }
            return;
          }
          clearInterval(waitForMenu);

          // Find "Copy link to post" leaf text -> walk up to role=menuitem
          var copyBtn = null;
          var allEls = portal.querySelectorAll('*');
          for (var i = 0; i < allEls.length; i++) {
            var txt = (allEls[i].innerText || '').trim().toLowerCase();
            if (txt === 'copy link to post' && allEls[i].children.length === 0) {
              var anc = allEls[i].parentElement;
              while (anc && anc !== portal) {
                if (anc.getAttribute('role') === 'menuitem') { copyBtn = anc; break; }
                anc = anc.parentElement;
              }
              if (!copyBtn) copyBtn = allEls[i];
              break;
            }
          }

          if (!copyBtn) {
            try { navigator.clipboard.writeText = orig; } catch(e) {}
            document.body.click();
            card.setAttribute(rAttr, ''); return;
          }

          copyBtn.click();

          // Poll for clipboard result
          var clipWaited = 0;
          var waitForClip = setInterval(function() {
            clipWaited += 50;
            if (captured || clipWaited >= 2000) {
              clearInterval(waitForClip);
              try { navigator.clipboard.writeText = orig; } catch(e) {}
              document.body.click();
              card.setAttribute(rAttr, captured || '');
            }
          }, 50);
        }, 200);
      },
      args: [markAttr, resultAttr]
    }).catch(function() {
      // If injection fails, mark as empty so the poll doesn't wait forever
      chrome.scripting.executeScript({
        target: { tabId: scrapeTabId },
        world: 'MAIN',
        func: function(mAttr, rAttr) {
          var card = document.querySelector('[' + mAttr + ']');
          if (card) card.setAttribute(rAttr, '');
        },
        args: [markAttr, resultAttr]
      }).catch(function() {});
    });
    return true;
  }

  return true;
});

async function runScrape({ tabId, startDate, endDate }) {
  notify({ type: 'PROGRESS', pct: 5, text: 'Starting...' });
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: scraperMain, args: [startDate, endDate] });
  } catch (e) {
    isScraping = false;
    stopKeepAlive();
    chrome.storage.local.set({ scraping: false });
    notify({ type: 'PROGRESS', pct: 0, error: 'Injection failed: ' + e.message });
  }
}

function notify(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }

// Runs in MAIN world via executeScript — intercepts clipboard and clicks "Copy link to post"
// Uses floating-ui portal detection + spinner polling (confirmed via console debugging)
function mainWorldMenuClick(markAttr) {
  return new Promise(function(resolve) {
    var card = document.querySelector('[' + markAttr + ']');
    if (!card) { resolve(''); return; }

    var menuBtn = card.querySelector('button[aria-label*="control menu"]');
    if (!menuBtn) { resolve(''); return; }

    // Intercept clipboard BEFORE clicking (MAIN world — this works)
    var captured = '';
    var orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = function(text) {
      captured = text;
      navigator.clipboard.writeText = orig;
      return orig(text);
    };

    menuBtn.click();

    // Poll for portal to appear and spinner to disappear (menu takes ~400-3400ms)
    var elapsed = 0;
    var waitForMenu = setInterval(function() {
      elapsed += 200;
      var portal = document.querySelector('[data-floating-ui-portal]');
      if (!portal || portal.querySelector('[role="progressbar"]')) {
        if (elapsed >= 8000) {
          clearInterval(waitForMenu);
          try { navigator.clipboard.writeText = orig; } catch(e) {}
          document.body.click();
          resolve('');
        }
        return;
      }
      clearInterval(waitForMenu);

      // Find "Copy link to post" — it is a leaf <P> inside DIV[role="menuitem"]
      var copyBtn = null;
      var allEls = portal.querySelectorAll('*');
      for (var i = 0; i < allEls.length; i++) {
        var txt = (allEls[i].innerText || '').trim().toLowerCase();
        if (txt === 'copy link to post' && allEls[i].children.length === 0) {
          var anc = allEls[i].parentElement;
          while (anc && anc !== portal) {
            if (anc.getAttribute('role') === 'menuitem') { copyBtn = anc; break; }
            anc = anc.parentElement;
          }
          if (!copyBtn) copyBtn = allEls[i];
          break;
        }
      }

      if (!copyBtn) {
        try { navigator.clipboard.writeText = orig; } catch(e) {}
        document.body.click();
        resolve(''); return;
      }

      copyBtn.click();

      // Poll for clipboard capture
      var clipWaited = 0;
      var waitForClip = setInterval(function() {
        clipWaited += 50;
        if (captured || clipWaited >= 2000) {
          clearInterval(waitForClip);
          try { navigator.clipboard.writeText = orig; } catch(e) {}
          document.body.click();
          resolve(captured || '');
        }
      }, 50);
    }, 200);
  });
}

function scraperMain(startDate, endDate) {

  if (!startDate || !endDate || startDate === 'undefined' || endDate === 'undefined') {
    chrome.runtime.sendMessage({ type: 'ERROR', error: 'Date range missing. Please set start and end dates and try again.' });
    return;
  }

  if (window.__lsRunning) {
    chrome.runtime.sendMessage({ type: 'ERROR', error: 'Scraper already running. Refresh the tab and try again.' });
    return;
  }
  window.__lsRunning = true;

  // All dates are pure UTC — identical on every device, every region, every timezone.
  // This matches https://ollie-boyd.github.io/Linkedin-post-timestamp-extractor/
  // which decodes the same UTC timestamp from the post ID.
  // Users set their date range in UTC: if the tool shows "2026-03-20" for a post, 
  // setting start=2026-03-20 will include it regardless of machine timezone.
  const START_STR = startDate;
  const END_STR   = endDate;

  const seenKeys = new Set();
  let   stopped  = false;
  let   allPosts = [];

  chrome.runtime.onMessage.addListener(function(m) {
    if (m.type === 'STOP_SCRAPE') stopped = true;
  });

  function makeOverlay() {
    const d = document.createElement('div');
    d.id = '__ls_overlay';
    d.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:999999;' +
      'background:#0077b5;color:#fff;padding:12px 18px;border-radius:12px;' +
      'font:600 13px/1.6 sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.3);' +
      'max-width:300px;pointer-events:none;';
    d.innerHTML = '<div>LinkedIn Scraper</div>' +
      '<div id="__ls_txt" style="font-weight:400;font-size:12px;opacity:.9">Starting...</div>';
    document.body.appendChild(d);
  }
  function setOverlay(txt) { var e = document.getElementById('__ls_txt'); if (e) e.textContent = txt; }
  function removeOverlay() { var e = document.getElementById('__ls_overlay'); if (e) e.remove(); }
  makeOverlay();

  // ── DATE FROM ACTIVITY ID (id >> 22) ──────────────────────────────────
  // IMPORTANT: Only decode 'activity:' IDs — they use LinkedIn's snowflake epoch (post-2013).
  // 'ugcPost:' IDs use a DIFFERENT internal ID scheme; decoding them with >> 22 yields
  // wrong ancient dates (e.g. 1975), which incorrectly triggers hitOldPost and stops the scrape early.
  function dateFromActivityID(url) {
    if (!url) return null;
    // Only match activity: or fwd: prefixes — NOT ugcPost:
    var match = url.match(/(?:activity[:\-]|fwd[:\-])(\d{15,21})/i)
             || url.match(/activity-(\d{15,21})/i);
    // Also extract from /posts/ slug (format: profileslug_keyword-NNNNN-xxxx)
    if (!match) {
      var postsMatch = url.match(/\/posts\/[^/?#]+-(\d{15,21})-[^/?#]+/i);
      if (postsMatch) match = postsMatch;
    }
    if (!match) return null;
    try {
      var ms   = Number(BigInt(match[1]) >> 22n);
      var date = new Date(ms);
      if (date.getFullYear() >= 2013 && date.getFullYear() <= new Date().getFullYear() + 1) {
        return date;
      }
    } catch(e) {}
    return null;
  }

  // ── DATE FROM RELATIVE TIME (sdui UI: "33m", "2h", "1d") ─────────────
  function dateFromRelativeTime(str) {
    if (!str) return null;
    var t = str.toLowerCase().trim();
    if (/just now|moments? ago/.test(t)) return new Date();
    var map = [
      [/^(\d+)\s*s/,       1000],
      [/^(\d+)\s*m(?!o)/,  60000],
      [/^(\d+)\s*h/,       3600000],
      [/^(\d+)\s*d/,       86400000],
      [/^(\d+)\s*w/,       604800000],
      [/^(\d+)\s*mo/,      2592000000],
      [/^(\d+)\s*(yr|y)/,  31536000000]
    ];
    for (var i = 0; i < map.length; i++) {
      var m = t.match(map[i][0]);
      if (m) return new Date(Date.now() - parseInt(m[1]) * map[i][1]);
    }
    return null;
  }

  // ── DATE FROM DOM (old UI fallback) ───────────────────────────────────
  function dateFromDOM(card) {
    var els, i, d, lbl, t;
    els = card.querySelectorAll('time[datetime]');
    for (i = 0; i < els.length; i++) {
      d = new Date(els[i].getAttribute('datetime'));
      if (!isNaN(d)) return d;
    }
    els = card.querySelectorAll('[aria-label]');
    for (i = 0; i < els.length; i++) {
      lbl = els[i].getAttribute('aria-label') || '';
      if (/ago|day|week|month|hour|minute|year|posted/i.test(lbl)) {
        d = relToDate(lbl);
        if (d) return d;
      }
    }
    var sels = [
      'span[class*="time-ago"]', 'span[class*="timestamp"]',
      'a[class*="timestamp"]',   '[class*="update-timestamp"]',
      '.visually-hidden',        '[class*="actor-meta"] span'
    ];
    for (var s = 0; s < sels.length; s++) {
      els = card.querySelectorAll(sels[s]);
      for (i = 0; i < els.length; i++) {
        t = els[i].innerText.trim();
        if (t && /\d/.test(t) && /ago|day|week|month|hour|min|yr/i.test(t)) {
          d = relToDate(t);
          if (d) return d;
        }
      }
    }
    return null;
  }

  function relToDate(raw) {
    if (!raw) return null;
    var t = raw.toLowerCase().replace(/\s+/g, ' ').trim();
    if (/just now|moments? ago/.test(t)) return new Date();
    var map = [
      [/(\d+)\s*s(ec)?/,      1000],
      [/(\d+)\s*m(?!o)(in)?/, 60000],
      [/(\d+)\s*h(ou?r)?/,    3600000],
      [/(\d+)\s*d(ay)?/,      86400000],
      [/(\d+)\s*w(ee?k)?/,    604800000],
      [/(\d+)\s*mo(nth)?/,    2592000000],
      [/(\d+)\s*y(ea?r)?/,    31536000000]
    ];
    for (var i = 0; i < map.length; i++) {
      var m = t.match(map[i][0]);
      if (m) return new Date(Date.now() - parseInt(m[1]) * map[i][1]);
    }
    var n = new Date(raw);
    return isNaN(n) ? null : n;
  }

  // Use browser local time — matches the "Uploaded on" field shown by
  // https://ollie-boyd.github.io/Linkedin-post-timestamp-extractor/
  // JS Date.getFullYear/Month/Date automatically uses the device's timezone,
  // so this gives the correct local date on every device in every region.
  function toLocalDateStr(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  // ── URL EXTRACTION ─────────────────────────────────────────────────────
  function urnToURL(urn) {
    if (!urn) return '';
    var m = urn.match(/urn:li:(activity|ugcPost|share):\d+/i);
    return m ? 'https://www.linkedin.com/feed/update/' + m[0] : '';
  }

  function extractURL(card) {
    // For reposts, the card contains TWO post URLs:
    //   - The resharer's URL (outer) — this is what we want
    //   - The original post's URL (inner, nested) — must be skipped
    // Strategy: find the resharer's actor link first, derive post URL from their profile,
    // then fall back to the first feed/update or /posts/ anchor that belongs to the outer card.

    // Helper: is this element inside a nested/reposted content block?
    function isNested(el) {
      var p = el.parentElement;
      while (p && p !== card) {
        // LinkedIn wraps inner reposted content in a container with these markers
        var ck = p.getAttribute('componentkey') || '';
        if (/repost|reshare|embed|quoted|inner|original/i.test(ck)) return true;
        // Nested cards also tend to be inside a second Feed post componentkey div
        if (p !== card && /^Feed post/i.test((p.innerText || '').trim()) && p.getAttribute('componentkey')) return true;
        p = p.parentElement;
      }
      return false;
    }

    // 1. data-urn on card root (old UI)
    var u = urnToURL(card.getAttribute('data-urn') || card.getAttribute('data-entity-urn') || '');
    if (u) return u;

    // 2. data-urn on non-nested descendants (old UI)
    var urned = card.querySelectorAll('[data-urn],[data-entity-urn]');
    for (var i = 0; i < urned.length; i++) {
      if (isNested(urned[i])) continue;
      u = urnToURL(urned[i].getAttribute('data-urn') || urned[i].getAttribute('data-entity-urn') || '');
      if (u) return u;
    }

    // 3. feed/update anchors — pick the FIRST one NOT inside a nested block
    var feedEls = card.querySelectorAll('a[href*="/feed/update/"]');
    for (var fi = 0; fi < feedEls.length; fi++) {
      if (isNested(feedEls[fi])) continue;
      try {
        var fp = new URL(feedEls[fi].href).pathname;
        if (!/^\/(in|company)\//.test(fp)) return 'https://www.linkedin.com' + fp;
      } catch(e) {}
    }

    // 4. Group posts: activity ID in highlightedUpdateUrn query param
    var groupEl = card.querySelector('a[href*="highlightedUpdateUrn"]');
    if (groupEl && groupEl.href) {
      var gm = groupEl.href.match(/highlightedUpdateUrn=([^&]+)/);
      if (gm) {
        var decoded = decodeURIComponent(gm[1]);
        var am = decoded.match(/urn:li:(activity|ugcPost|share):\d+/i);
        if (am) return 'https://www.linkedin.com/feed/update/' + am[0];
      }
    }

    // 5. /posts/ anchors — collect ALL non-nested candidates, take the LAST one.
    // LinkedIn sometimes renders a link to the previous card's post inside the
    // current card (as a reshare reference), so the first match can be wrong.
    // The card's own post link appears last in DOM order.
    var anchorSels = [
      'a[href*="/posts/"]',
      'a[href*="activity-"]',
      'a[href*="ugcPost"]',
      'a[data-tracking*="view"]'
    ];
    var postURLCandidates = [];
    for (var s = 0; s < anchorSels.length; s++) {
      var els = card.querySelectorAll(anchorSels[s]);
      for (var ei = 0; ei < els.length; ei++) {
        if (isNested(els[ei])) continue;
        try {
          var p = new URL(els[ei].href).pathname;
          if (!/^\/(in|company)\//.test(p)) {
            postURLCandidates.push('https://www.linkedin.com' + p);
          }
        } catch(e) {}
      }
    }
    // Take the LAST candidate — the card's own link appears after any referenced links
    if (postURLCandidates.length > 0) return postURLCandidates[postURLCandidates.length - 1];

    // 6. Walk up ancestors (old UI)
    var anc = card.parentElement;
    for (var j = 0; j < 5 && anc; j++, anc = anc.parentElement) {
      u = urnToURL(anc.getAttribute('data-urn') || anc.getAttribute('data-entity-urn') || '');
      if (u) return u;
    }

    // 7. Search card HTML for feed/update URL — take the LAST match
    // (outer resharer's URL tends to appear after the inner post's URL in HTML)
    var html = card.outerHTML || '';
    var feedMatches = html.match(/https:\/\/www\.linkedin\.com\/feed\/update\/urn[^"'?\s]+/g) || [];
    if (feedMatches.length > 0) return feedMatches[feedMatches.length - 1].split('?')[0];

    // 8. Search HTML for /posts/ URL with long numeric ID
    var postsMatches = html.match(/https:\/\/www\.linkedin\.com\/posts\/[^"'?\s]+/g) || [];
    for (var pi = 0; pi < postsMatches.length; pi++) {
      var pm = postsMatches[pi].split('?')[0];
      if (/\d{15,}/.test(pm)) return pm;
    }

    // 9. Fallback: profile activity page
    var profileEl = card.querySelector('a[href*="/in/"], a[href*="/company/"], a[href*="/groups/"]');
    if (profileEl) {
      var ph = profileEl.getAttribute('href') || '';
      var im = ph.match(/\/in\/([^/?#]+)/);
      var cm = ph.match(/\/company\/([^/?#]+)/);
      if (im) return 'https://www.linkedin.com/in/' + im[1] + '/recent-activity/all/';
      if (cm) return 'https://www.linkedin.com/company/' + cm[1] + '/posts/';
    }

    return '';
  }

  // ── CONTENT EXTRACTION ────────────────────────────────────────────────
  // Returns a Promise so we can await DOM re-render after clicking "…more"
  async function extractContent(card) {
    // For sdui cards (start with "Feed post"), use line-by-line parsing
    // CSS selectors pick up wrong elements (video text, name) on sdui cards
    var cardTxt = (card.innerText || '').trim();
    if (/^Feed post/i.test(cardTxt)) {
      // Expand ALL "…more" buttons in the card (outer post + nested reposts)
      // LinkedIn renders: SPAN("more") inside SPAN > SPAN > BUTTON(hashed classes)
      async function clickAllMoreBtns(container) {
        var anyClicked = false;
        // Pass 1: find buttons whose full innerText is "more" / "…more"
        var btns = container.querySelectorAll('button');
        for (var bi = 0; bi < btns.length; bi++) {
          var bt = (btns[bi].innerText || '').trim();
          if (bt === 'more' || bt === '…more' || bt === '… more') {
            try { btns[bi].click(); anyClicked = true; } catch(e) {}
          }
        }
        // Pass 2: leaf spans with "more"/"see more" — walk up to BUTTON ancestor
        if (!anyClicked) {
          var spans = container.querySelectorAll('span');
          for (var si = 0; si < spans.length; si++) {
            if (spans[si].children.length === 0) {
              var st = (spans[si].innerText || '').trim();
              if (st === 'more' || st === '…more' || st === '… more' || st === 'see more' || st === 'See more') {
                var anc = spans[si].parentElement;
                while (anc && anc !== container) {
                  if (anc.tagName === 'BUTTON') {
                    try { anc.click(); anyClicked = true; } catch(e) {} break;
                  }
                  anc = anc.parentElement;
                }
                if (!anyClicked) { try { spans[si].click(); anyClicked = true; } catch(e) {} }
              }
            }
          }
        }
        return anyClicked;
      }

      var clicked = await clickAllMoreBtns(card);
      if (clicked) {
        await sleep(400);
        // After expanding, check for nested "…more" (reposts have a second layer)
        var clickedAgain = await clickAllMoreBtns(card);
        if (clickedAgain) await sleep(400);
      }
      cardTxt = (card.innerText || '').trim();
      return extractSduiContent(cardTxt);
    }

    // Old UI: CSS selectors
    var btns = card.querySelectorAll(
      'button[aria-label*="see more"], button[class*="see-more"], ' +
      '.feed-shared-text-view__see-more, [class*="inline-show-more"] button'
    );
    for (var b = 0; b < btns.length; b++) { try { btns[b].click(); } catch(e) {} }
    var sels = [
      '.break-words', '.feed-shared-update-v2__description',
      '[dir="ltr"]', 'div[dir="ltr"]', '.update-components-text',
      '[class*="commentary"]', '[class*="feed-shared-text"]'
    ];
    for (var s = 0; s < sels.length; s++) {
      var el = card.querySelector(sels[s]);
      if (el) {
        var t = el.innerText && el.innerText.trim().replace(/\s+/g, ' ');
        if (t && t.length > 20) return t;
      }
    }
    return '';
  }

  // Parse sdui card text to extract just the post content
  // Card structure: "Feed post\nName\n[Role]\n[Followers]\nTime •\n[Follow]\nContent...\nLike Comment Repost Send"
  function extractSduiContent(cardTxt) {
    var lines = cardTxt.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
    var contentLines = [];
    var timeFound = false;
    var headerDone = false;

    for (var i = 1; i < lines.length; i++) {  // skip "Feed post"
      var line = lines[i];

      // Stop at action bar
      if (/^(like|comment|repost|send|share)$/i.test(line)) break;
      if (/^\d+\s*(reaction|comment|repost|like)/i.test(line)) break;

      // Stop at LinkedIn translation UI artifact — everything after is repost content
      if (/^Show translation$/i.test(line)) {
        break;
      }

      if (headerDone) {
        // Repost boundary 1: new relative timestamp with bullet e.g. "2d •", "3mo •"
        if (/^\d+\s*[smhdw](\s*•|$)|^\d+\s*mo(\s*•|$)/i.test(line)) {

          break;
        }
        // Repost boundary 2: repost author line e.g. "Bill Stott • 3rd+" or "Jane Doe • 2nd"
        if (/^.{2,60}\s*•\s*(1st|2nd|3rd\+?)\b/i.test(line)) {

          break;
        }
        contentLines.push(line);
        continue;
      }

      // Detect relative time line — marks end of header
      if (!timeFound && /^\d+\s*[smhdw]|^\d+\s*mo/i.test(line)) {
        timeFound = true;
        continue;
      }

      // Skip header lines before time
      if (!timeFound) continue;

      // Skip "Follow", "Following", "Connect", "More"
      if (/^(follow|following|connect|message|more)$/i.test(line)) continue;

      // Content starts here
      headerDone = true;
      contentLines.push(line);
    }

    var result = contentLines.join(' ').replace(/\s+/g, ' ').trim();

    // Fix 1: strip leading UI button words (Join / Follow / Connect / Message)
    result = result.replace(/^(Join|Follow|Connect|Message)\s+/i, '');

    // Fix 2: strip trailing @mention names that appear after the last hashtag
    var lastHashEnd = -1;
    var hashRe = /#\w+/g, hm;
    while ((hm = hashRe.exec(result)) !== null) lastHashEnd = hm.index + hm[0].length;
    if (lastHashEnd !== -1) {
      var afterHash = result.slice(lastHashEnd);
      if (afterHash.length > 0 && !/[.!?,;:\d]|https?:\/\//.test(afterHash)) {
        result = result.slice(0, lastHashEnd);
      }
    }

    // Post-process: trim inline repost bleed not caught by line-level checks
    // Helper: given a terminal position, walk back to the last sentence/emoji/hashtag boundary
    function trimAtBoundary(str, terminalPos) {
      var pre = str.slice(0, terminalPos);
      // Mark URL spans so we can exclude their dots from sentence boundaries
      var urlSpans = [];
      var urlRe = /https?:\/\/\S+/g;
      var um;
      while ((um = urlRe.exec(pre)) !== null) urlSpans.push([um.index, um.index + um[0].length]);
      function inUrl(pos) {
        for (var u = 0; u < urlSpans.length; u++) {
          if (pos >= urlSpans[u][0] && pos < urlSpans[u][1]) return true;
        }
        return false;
      }
      var lastBoundary = -1;
      var re = /[.!?]|[\u{1F300}-\u{1FFFF}]|#\w+/gu;
      var m;
      while ((m = re.exec(pre)) !== null) {
        if (!inUrl(m.index)) lastBoundary = m.index + m[0].length;
      }
      if (lastBoundary === -1) return null;  // no boundary found — skip trim
      var bleed = str.slice(lastBoundary);
      // If bleed starts with a URL, that URL is parent content — include it
      var urlPrefix = /^\s*(https?:\/\/\S+)\s+/.exec(bleed);
      if (urlPrefix) {
        lastBoundary += urlPrefix[0].length;
        bleed = str.slice(lastBoundary);
      }
      if (bleed.length > 250) return null;   // too long — likely not a repost trailer
      return { cut: lastBoundary, bleed: bleed };
    }

    // Bleed 1: degree marker "• 3rd+" — walk backward token-by-token to find name start
    var degreeMatch = /\u2022\s*(1st|2nd|3rd\+?)\b.*$/i.exec(result);
    if (degreeMatch) {
      var bulletPos = degreeMatch.index;
      var seg = result.slice(Math.max(0, bulletPos - 120), bulletPos);
      var segOffset = Math.max(0, bulletPos - 120);
      var tokens = [], tokRe = /\S+/g, tokM;
      while ((tokM = tokRe.exec(seg)) !== null) tokens.push(tokM);
      var nameStartIdx = null;
      for (var ti = tokens.length - 1; ti >= 0; ti--) {
        var tok = tokens[ti][0];
        if (tok === tok.toUpperCase() && tok.length > 3) { nameStartIdx = ti + 1; break; }
        if (/^\d/.test(tok)) { nameStartIdx = ti + 1; break; }
        var lowers = ['de','van','von','der','la','le'];
        if (tok[0] === tok[0].toLowerCase() && lowers.indexOf(tok) === -1) { nameStartIdx = ti + 1; break; }
      }
      if (nameStartIdx === null) nameStartIdx = 0;
      if (nameStartIdx < tokens.length) {
        var degreeCut = segOffset + tokens[nameStartIdx].index;

        result = result.slice(0, degreeCut).trim();
      }
    }

    // Bleed 2: "Company N followers" — only look in last 120 chars
    var tail = result.length > 120 ? result.slice(-120) : result;
    var offset = Math.max(0, result.length - 120);
    var followersMatch = /[A-Z][^.\n!?]{2,60}\s+[\d,]+\s+followers\s*$/i.exec(tail);
    if (followersMatch) {
      var termPos = offset + followersMatch.index;
      var t2 = trimAtBoundary(result, termPos);
      if (t2) {

        result = result.slice(0, t2.cut).trim();
      } else {
        // No sentence boundary before — hard cut at the terminal position

        result = result.slice(0, termPos).trim();
      }
    }

    return result;
  }

  // ── NAME EXTRACTION ───────────────────────────────────────────────────
  function extractName(card) {
    var cardTxt = (card.innerText || '').trim();

    // New sdui UI: name is always line 1 after "Feed post"
    if (/^Feed post/i.test(cardTxt)) {
      var lines = cardTxt.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
      // lines[0] = "Feed post", lines[1] = name
      if (lines.length > 1 && lines[1].length > 1 && lines[1].length < 120 &&
          !/^\d/.test(lines[1]) &&
          !/^(video player|loading|like|comment|repost|send)/i.test(lines[1])) {
        return lines[1];
      }
    }

    // Old UI: class-based selectors
    var sels = [
      '[class*="actor-name"]',
      '[class*="feed-shared-actor__name"]',
      '[class*="update-components-actor__name"]',
      'a[href*="/in/"] span[aria-hidden="true"]',
      'a[href*="/company/"] span[aria-hidden="true"]',
      'a[href*="/groups/"] span[aria-hidden="true"]'
    ];
    for (var s = 0; s < sels.length; s++) {
      var el = card.querySelector(sels[s]);
      if (el) {
        var t = el.innerText && el.innerText.trim().replace(/\s+/g, ' ');
        if (t && t.length > 1 && t.length < 80) return t;
      }
    }
    // Restricted fallback: only look for profile links inside the actor header,
    // NOT the post body (avoids picking up @mentioned names in content)
    var actorContainers = card.querySelectorAll(
      '[class*="actor"], [class*="update-components-actor"], [class*="feed-shared-actor"]'
    );
    for (var a = 0; a < actorContainers.length; a++) {
      var link = actorContainers[a].querySelector('a[href*="/in/"], a[href*="/company/"], a[href*="/groups/"]');
      if (link) {
        var t = link.innerText && link.innerText.trim().replace(/\s+/g, ' ');
        if (t && t.length > 1 && t.length < 80) return t;
      }
    }
    return '';
  }

  // ── URL FROM ... MENU ────────────────────────────────────────────────
  // The clipboard intercept ONLY works in MAIN world (confirmed via console).
  // Content script isolated world intercept never fires for LinkedIn's writeText.
  // Solution: inject via chrome.scripting.executeScript with world: 'MAIN',
  // mark the card with a unique attribute, then poll for the result stored on it.
  // Mutex ensures only one menu click runs at a time.
  var __menuMutex = Promise.resolve();

  function getURLFromMenu(card) {
    if (card._menuDone) { return Promise.resolve(''); }
    card._menuDone = true;

    var menuBtn = card.querySelector('button[aria-label*="control menu"]');
    if (!menuBtn) { return Promise.resolve(''); }

    __menuMutex = __menuMutex.then(function() {
      return new Promise(function(resolve) {
        // Mark this card with a unique attribute so MAIN world can find it
        var markAttr = '__ls_m' + Date.now();
        var resultAttr = '__ls_r' + Date.now();
        card.setAttribute(markAttr, '1');

        // Inject MAIN world function that handles the whole flow
        chrome.runtime.sendMessage({
          type: 'RUN_MAIN_MENU',
          markAttr: markAttr,
          resultAttr: resultAttr
        });

        // Poll for result attribute (set by MAIN world after clipboard fires)
        var waited = 0;
        var poll = setInterval(function() {
          waited += 100;
          var result = card.getAttribute(resultAttr);
          if (result !== null || waited >= 8000) {
            clearInterval(poll);
            card.removeAttribute(markAttr);
            card.removeAttribute(resultAttr);
            var url = result || '';
            if (url) {
              try { url = 'https://www.linkedin.com' + new URL(url).pathname; }
              catch(e) { url = url.split('?')[0]; }
            }
            resolve(url);
          }
        }, 100);
      });
    });

    return __menuMutex;
  }

  // ── FOLLOWERS EXTRACTION ──────────────────────────────────────────────
  function extractFollowers(card) {
    var sels = [
      '[class*="actor-description"]',
      '[class*="feed-shared-actor__description"]',
      '[class*="update-components-actor__description"]',
      '[class*="actor-meta"]',
      '[class*="subline"]'
    ];
    for (var s = 0; s < sels.length; s++) {
      var els = card.querySelectorAll(sels[s]);
      for (var i = 0; i < els.length; i++) {
        var t = els[i].innerText && els[i].innerText.trim();
        if (t && /follower/i.test(t)) {
          var m = t.match(/([\d,\.]+[KkMm]?\s*followers?)/i);
          if (m) return m[1].trim();
        }
      }
    }
    // New sdui UI: scan all elements for follower text
    var allEls = card.querySelectorAll('span, div, p');
    for (var i = 0; i < allEls.length; i++) {
      if (allEls[i].children.length > 0) continue;
      var t = allEls[i].innerText && allEls[i].innerText.trim();
      if (t && /follower/i.test(t) && t.length < 30) {
        var m = t.match(/([\d,\.]+[KkMm]?\+?\s*followers?)/i);
        if (m) return m[1].trim();
      }
    }
    return '';
  }

  // ── CARD DETECTION: old UI + new sdui UI ──────────────────────────────
  var CARD_SELECTORS = [
    'div[data-urn*="activity"]', 'div[role="article"]',
    '.occludable-update', '.feed-shared-update-v2',
    '[data-urn*="urn:li:activity"]',
    'li[class*="search-results__list-item"]',
    '[data-urn*="ugcPost"]'
  ];

  async function readAllCards() {
    var seen  = new Set();
    var cards = [];

    // Old UI card selectors
    for (var s = 0; s < CARD_SELECTORS.length; s++) {
      var els = document.querySelectorAll(CARD_SELECTORS[s]);
      for (var i = 0; i < els.length; i++) {
        if (!seen.has(els[i])) { seen.add(els[i]); cards.push(els[i]); }
      }
    }

    // New sdui UI: componentkey divs starting with "Feed post"
    // Pick the innermost card (not a parent wrapper)
    var ckEls = document.querySelectorAll('div[componentkey]');
    var sduiCards = [];
    for (var i = 0; i < ckEls.length; i++) {
      var el = ckEls[i];
      if (seen.has(el)) continue;
      if (/^Feed post/i.test((el.innerText || '').trim()) && el.children.length >= 2) {
        sduiCards.push(el);
      }
    }
    // Keep only non-parent sdui cards to avoid duplicates
    for (var i = 0; i < sduiCards.length; i++) {
      var el = sduiCards[i];
      if (seen.has(el)) continue;
      var isParent = false;
      for (var j = 0; j < sduiCards.length; j++) {
        if (i !== j && el.contains(sduiCards[j])) { isParent = true; break; }
      }
      if (!isParent) { seen.add(el); cards.push(el); }
    }

    var newPosts   = [];
    var hitOldPost = false;

    // Track profile slugs seen so far to detect leaked /posts/ URLs
    var seenProfileSlugs = new Set();

    for (var c = 0; c < cards.length; c++) {
      var card    = cards[c];
      var url     = extractURL(card);
      var content = await extractContent(card);

      if (!content || content.length < 20) continue;

      // ── DEDUPLICATION ───────────────────────────────────────────────────
      // Primary key: URL (most reliable — every real post has a unique URL)
      // Fallback key: content fingerprint (first 160 chars) — only used when URL is
      // a non-unique fallback (profile/company page) shared by many posts.
      // This avoids false-positive dedup of different posts by the same person
      // whose content happens to share the same opening words.

      // ── URL OWNERSHIP VALIDATION ──────────────────────────────────────
      // If extractURL returned a /posts/ URL whose profile slug belongs to a
      // DIFFERENT card we already processed, it's a leaked DOM anchor.
      // Force menu-click for this card to get the correct URL.
      if (url && url.includes('/posts/')) {
        var slugMatch = url.match(/\/posts\/([^/?#_]+)/);
        if (slugMatch) {
          var urlSlug = slugMatch[1].toLowerCase().replace(/-/g, '');
          var cardName = extractName(card);
          var cardNameSlug = cardName.toLowerCase().replace(/[^a-z0-9]/g, '');
          // Check: does this slug belong to another profile we've seen?
          // It's a leak if: slug is in seenProfileSlugs AND doesn't match this card's name
          var nameMatchesSlug = cardNameSlug.length > 3 && urlSlug.includes(cardNameSlug.slice(0, 6));
          if (seenProfileSlugs.has(urlSlug) && !nameMatchesSlug) {
            // Leaked anchor — clear URL so menu-click runs below
            url = '';
          } else if (cardNameSlug.length > 3) {
            seenProfileSlugs.add(urlSlug);
          }
        }
      }

      var isReliableURL = url &&
        !url.includes('/recent-activity/all/') &&
        !(url.includes('/company/') && url.endsWith('/posts/')) &&
        !url.includes('/preload/');

      var urlKey     = isReliableURL ? ('url:' + url) : null;
      // name is available here — use it to strengthen the content fingerprint
      // name + content[:160] prevents false dedup between different people
      // posting similar content, while still catching same card re-rendered on scroll
      var postName   = extractName(card);
      var contentKey = 'txt:' + postName.slice(0, 40) + '|' + content.slice(0, 160);

      // Skip if we've seen this exact URL before
      if (urlKey && seenKeys.has(urlKey)) continue;

      // Skip if no reliable URL AND fingerprint matches (same card re-rendered on scroll)
      if (!urlKey && seenKeys.has(contentKey)) continue;

      if (urlKey) seenKeys.add(urlKey);
      else seenKeys.add(contentKey);

      // ── DATE RESOLUTION (priority order) ────────────────────────────────
      // Goal: exact post ID timestamp matching https://ollie-boyd.github.io/Linkedin-post-timestamp-extractor/
      // Relative time ("1d", "2h") is approximate and scrape-time-dependent — avoid it.

      // 1. Try activity: ID from current URL (most reliable)
      var date = dateFromActivityID(url);
      var dateIsExact = (date !== null);  // true = came from post ID (exact timestamp)

      // 2. Scan card HTML for any activity: ID if URL had none
      //    Covers cases where extractURL returned a fallback URL with no ID
      if (!date) {
        var htmlScan = card.outerHTML || '';
        var idMatches = htmlScan.match(/activity[:\-](\d{15,21})/gi) || [];
        for (var im = 0; im < idMatches.length; im++) {
          var idNum = idMatches[im].replace(/activity[:\-]/i, '');
          try {
            var idMs = Number(BigInt(idNum) >> 22n);
            var idDt = new Date(idMs);
            if (idDt.getFullYear() >= 2013 && idDt.getFullYear() <= new Date().getFullYear() + 1) {
              date = idDt; dateIsExact = true; break;
            }
          } catch(e) {}
        }
      }

      // 3. Last resort only: relative time or DOM (used when no ID exists anywhere)
      if (!date) {
        var cardTxt = (card.innerText || '').trim();
        if (/^Feed post/i.test(cardTxt)) {
          var tlines = cardTxt.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
          for (var ti = 0; ti < tlines.length; ti++) {
            if (/^\d+\s*[smhdw]|^\d+\s*mo/i.test(tlines[ti])) {
              date = dateFromRelativeTime(tlines[ti].replace(/\s*[•·].*/, '').trim());
              break;
            }
          }
        }
        if (!date) date = dateFromDOM(card);
      }
      if (!date) continue;

      var dateStr = toLocalDateStr(date);

      if (dateStr > END_STR) continue;
      if (dateStr < START_STR) {
        // Only signal stop when the date is exact (from post ID).
        // Relative time ("1d") is approximate — a "1d" post could still be within
        // the start date depending on exact publish time, so we skip it but keep scrolling.
        if (dateIsExact) hitOldPost = true;
        continue;
      }

      // Only click menu for posts that passed date filter — saves time
      // Also include feed/update URLs with share: or ugcPost: URNs — these belong to the
      // ORIGINAL post, not the resharer. Menu click gets the resharer's correct activity URL.
      var isFallback = !url ||
        url.includes('/recent-activity/all/') ||
        (url.includes('/company/') && url.endsWith('/posts/')) ||
        /feed\/update\/urn:li:(share|ugcPost):/i.test(url);
      if (isFallback) {
        try {
          var menuURL = await getURLFromMenu(card);
          if (menuURL && menuURL.length > 10) {
            url = menuURL;
            // Re-derive date from the resolved URL's activity: ID — exact timestamp,
            // overrides any relative-time approximation used earlier.
            var resolvedDate = dateFromActivityID(url);
            if (resolvedDate) {
              dateStr = toLocalDateStr(resolvedDate);
              // Re-check range with exact date
              if (dateStr > END_STR) continue;
              if (dateStr < START_STR) { hitOldPost = true; continue; }
            }
          }
        } catch(menuErr) { /* ignore */ }
      }

      newPosts.push({
        date:      dateStr,
        name:      postName,
        followers: extractFollowers(card),
        content:   content,
        url:       url || '(URL not found)'
      });
    }

    return { newPosts: newPosts, hitOldPost: hitOldPost };
  }

  function clickShowMore() {
    var sels = [
      'button.scaffold-finite-scroll__load-button',
      'button[class*="see-more-jobs"]',
      'button[class*="load-more"]',
      'button[class*="show-more"]'
    ];
    for (var s = 0; s < sels.length; s++) {
      var btn = document.querySelector(sels[s]);
      if (btn && btn.offsetParent !== null) { btn.click(); return true; }
    }
    var phrases = ['show more result', 'see more result', 'load more', 'see more post', 'show more'];
    var tags = ['button', 'a', 'span[role="button"]', 'div[role="button"]'];
    for (var t = 0; t < tags.length; t++) {
      var els = document.querySelectorAll(tags[t]);
      for (var i = 0; i < els.length; i++) {
        var txt = (els[i].innerText || '').toLowerCase().trim();
        if (phrases.some(function(p) { return txt.includes(p); }) && els[i].offsetParent !== null) {
          els[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
          els[i].click();
          return true;
        }
      }
    }
    return false;
  }

  function triggerDownload() {
    if (allPosts.length === 0) return;
    function esc(v) { return '"' + String(v != null ? v : '').replace(/"/g, '""') + '"'; }
    var rows = allPosts.map(function(p, i) {
      return [i + 1, esc(p.date), esc(p.name), esc(p.followers), esc(p.content), esc(p.url)].join(',');
    });
    var csv  = '\uFEFF' + ['No.,Date Posted,Profile Name,Followers,Post Content,Post URL'].concat(rows).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = 'LinkedIn_Posts_' + startDate + '_to_' + endDate + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  async function scrollLoop() {
    var STEP          = 600;
    var WAIT          = 2500;
    var WAIT_BTN      = 3500;
    var MAX_SCROLLS   = 1200;
    var MAX_NO_GROWTH = 15;
    // How many consecutive scrolls seeing only out-of-range posts before stopping.
    // Posts are sequential (newest first). Once we see exact-ID posts before start date,
    // we keep scrolling briefly to catch any remaining "1d" boundary posts that
    // may still be within range. 3 scrolls is enough since posts are ordered.
    var MAX_PAST_SCROLLS = 3;

    var scrollsDone    = 0;
    var noGrowth       = 0;
    var lastHeight     = 0;
    var totalCollected = 0;
    var scrollsPastStart = 0;  // consecutive scrolls past start date with no in-range finds

    setOverlay('Reading visible posts...');
    await sleep(800);
    var initial = await readAllCards();
    if (initial.newPosts.length > 0) {
      allPosts = allPosts.concat(initial.newPosts);
      totalCollected += initial.newPosts.length;
      sendBatch(initial.newPosts, 0, totalCollected);
    }
    if (initial.hitOldPost && initial.newPosts.length === 0) scrollsPastStart++;

    while (!stopped && scrollsDone < MAX_SCROLLS) {
      window.scrollBy(0, STEP);
      await sleep(WAIT);

      var result = await readAllCards();
      if (result.newPosts.length > 0) {
        allPosts = allPosts.concat(result.newPosts);
        totalCollected += result.newPosts.length;
        sendBatch(result.newPosts, scrollsDone, totalCollected);
        // Found in-range posts — reset the past-start counter
        scrollsPastStart = 0;
      }

      if (result.hitOldPost) {
        if (result.newPosts.length === 0) {
          // Saw only out-of-range posts this scroll — increment counter
          scrollsPastStart++;
        }
        if (scrollsPastStart >= MAX_PAST_SCROLLS) {
          setOverlay('Passed start date — stopping scroll.');
          break;
        }
        // Otherwise keep scrolling — there may still be in-range posts ahead
        setOverlay('Scanning past start date... (' + scrollsPastStart + '/' + MAX_PAST_SCROLLS + ')');
      } else {
        // No old posts seen this scroll — reset counter
        scrollsPastStart = 0;
      }

      var h = document.documentElement.scrollHeight;
      if (h <= lastHeight) {
        var clicked = clickShowMore();
        if (clicked) {
          setOverlay('Clicked "Show more results"... loading next batch');
          await sleep(WAIT_BTN);
          noGrowth = 0;
        } else {
          noGrowth++;
          if (noGrowth >= MAX_NO_GROWTH) break;
          await sleep(3000);
        }
      } else {
        noGrowth = 0;
      }

      lastHeight = document.documentElement.scrollHeight;
      scrollsDone++;
    }

    setOverlay('Done! ' + totalCollected + ' posts — downloading CSV...');
    triggerDownload();
    await sleep(2000);
    removeOverlay();
    chrome.runtime.sendMessage({ type: 'DONE', count: totalCollected });
    window.__lsRunning = false;
  }

  function sendBatch(posts, scroll, total) {
    var txt = 'Collected ' + total + ' posts... (scroll ' + scroll + ')';
    setOverlay(txt);
    chrome.runtime.sendMessage({
      type:  'BATCH',
      posts: posts,
      pct:   Math.min(88, 10 + Math.round(scroll / 1200 * 78)),
      text:  txt
    });
  }

  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  scrollLoop().catch(function(e) {
    removeOverlay();
    chrome.runtime.sendMessage({ type: 'ERROR', error: e.message });
    window.__lsRunning = false;
  });
}
