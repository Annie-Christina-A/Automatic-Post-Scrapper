// popup.js

const btnStart   = document.getElementById('btnStart');
const btnStop    = document.getElementById('btnStop');
const btnExport  = document.getElementById('btnExport');
const statusBox  = document.getElementById('statusBox');
const progFill   = document.getElementById('progressFill');
const statusTxt  = document.getElementById('statusText');
const alertEl    = document.getElementById('alert');
const liveCount  = document.getElementById('liveCount');

function showAlert(msg, type = 'error') { alertEl.textContent = msg; alertEl.className = 'alert ' + type; }
function hideAlert() { alertEl.className = 'alert'; }
function setProgress(pct, msg) { progFill.style.width = pct + '%'; statusTxt.textContent = msg; }

function setScraping(on) {
  btnStart.disabled = on;
  btnStop.classList.toggle('show', on);
  statusBox.classList.toggle('show', on);
  if (!on) setProgress(0, '');
}

function resetFields() {
  document.getElementById('startDate').value = '';
  document.getElementById('endDate').value   = '';
  liveCount.style.display = 'none';
  liveCount.textContent   = '0';
  btnExport.classList.remove('show');
}

// ── On popup open: restore state from storage ─────────────────────────────
chrome.storage.local.get(['startDate','endDate','scrapedPosts','scraping','totalCount'], res => {
  if (res.startDate) document.getElementById('startDate').value = res.startDate;
  if (res.endDate)   document.getElementById('endDate').value   = res.endDate;

  const n = res.totalCount || res.scrapedPosts?.length || 0;

  if (res.scraping) {
    setScraping(true);
    setProgress(50, 'Scraping in progress… (popup was reopened)');
    if (n) { liveCount.textContent = n; liveCount.style.display = 'inline'; }
    showAlert('✅ Scraper is still running in the background. You can close this popup safely.', 'info');
  } else if (n > 0) {
    btnExport.classList.add('show');
    liveCount.textContent = n;
    liveCount.style.display = 'inline';
    showAlert(`${n} posts ready. Click Download Excel to export.`, 'info');
  }
});

// ── Live progress from background ─────────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type !== 'PROGRESS') return;
  setProgress(msg.pct || 0, msg.text || '');
  if (msg.count !== undefined) {
    liveCount.textContent = msg.count;
    liveCount.style.display = 'inline';
  }
  if (msg.done) {
    setScraping(false);
    resetFields();  // clear date fields — ready for next keyword
    showAlert(`✅ Done! ${msg.count} posts downloaded. Fields cleared for next search.`, 'success');
  }
  if (msg.error) {
    setScraping(false);
    showAlert('⚠️ ' + msg.error, 'error');
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  hideAlert();
  const startDate = document.getElementById('startDate').value;
  const endDate   = document.getElementById('endDate').value;

  if (!startDate) return showAlert('Please set a Start Date.');
  if (!endDate)   return showAlert('Please set an End Date.');
  if (startDate > endDate) return showAlert('Start date must be before End date.');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes('linkedin.com/search/results/content')) {
    return showAlert('⚠️ Go to LinkedIn → search a keyword → click the Posts tab → Sort by Latest, then open this extension.');
  }

  setScraping(true);
  btnExport.classList.remove('show');
  liveCount.style.display = 'none';
  setProgress(5, 'Starting…');

  chrome.runtime.sendMessage({ type: 'START_SCRAPE', tabId: tab.id, startDate, endDate });

  setTimeout(() => {
    showAlert('✅ Scraper is running. You can close this popup — scraping continues in the background. Reopen to check progress.', 'info');
  }, 1500);
});

// ── Stop ───────────────────────────────────────────────────────────────────
btnStop.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_SCRAPE' });
  setScraping(false);
  chrome.storage.local.get(['scrapedPosts'], res => {
    const n = res.scrapedPosts?.length || 0;
    if (n > 0) {
      btnExport.classList.add('show');
      showAlert(`Stopped. ${n} posts collected so far. Click Download Excel.`, 'info');
    } else {
      showAlert('Stopped.', 'info');
    }
  });
});

// ── Export ─────────────────────────────────────────────────────────────────
btnExport.addEventListener('click', () => {
  chrome.storage.local.get(['scrapedPosts','startDate','endDate'], res => {
    const posts = res.scrapedPosts || [];
    if (!posts.length) return showAlert('No posts to export yet.');
    downloadCSV(posts, res.startDate, res.endDate);
  });
});

function downloadCSV(posts, startDate, endDate) {
  const esc  = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = posts.map((p, i) => [i + 1, esc(p.date), esc(p.name), esc(p.followers), esc(p.content), esc(p.url)].join(','));
  const csv  = '\uFEFF' + ['No.,Date Posted,Profile Name,Followers,Post Content,Post URL', ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  chrome.downloads.download({
    url,
    filename: `LinkedIn_Posts_${startDate}_to_${endDate}.csv`,
    saveAs: false
  }, () => {
    URL.revokeObjectURL(url);
    showAlert('📥 File downloaded!', 'success');
  });
}