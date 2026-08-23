'use strict';

/*
 * Visual and console smoke test. Boots the real app, waits for the chrome UI to
 * settle, records every renderer console message and captures screenshots.
 *
 *   npx electron tools/smoke.js
 *
 * Screenshots land in tools/shots/. Any console error fails the run.
 */

const path = require('node:path');
const fs = require('node:fs');

process.env.NULA_SMOKE = '1';

const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const { app, BrowserWindow, ipcMain } = require('electron');

const problems = [];

// Stub the IPC surface so the renderer boots exactly as it would in the app.
const STUBS = {
  'nula:bootstrap': { ok: true, data: { serverUrl: null, deviceName: 'SMOKE', locked: true, platform: 'win32', version: '2.2.0' } },
  'nula:activity': { ok: true, data: null },
};

app.whenReady().then(async () => {
  for (const [channel, value] of Object.entries(STUBS)) {
    ipcMain.handle(channel, () => value);
  }

  // Reuse the real renderer, not a stand-in.
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    backgroundColor: '#0a0b0d',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'chrome.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    const label = ['debug', 'info', 'warning', 'error'][level] || level;
    console.log(`  [${label}] ${message} (${path.basename(source || '')}:${line})`);
    if (level === 3) problems.push(message);
  });

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    problems.push(`Laden fehlgeschlagen: ${desc} (${code})`);
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1400));

  // 1: lock screen, dark
  await shoot(win, 'lock-dark');

  // 2: lock screen with the URL filled in and remembering switched off
  await win.webContents.executeJavaScript(`
    document.querySelector('#lock-server').value = 'https://sync.example.com';
    document.querySelector('#lock-remember').checked = false;
    updateRememberHint();
    true;
  `);
  await pause(260);
  await shoot(win, 'lock-remember-off');

  await win.webContents.executeJavaScript(`
    document.querySelector('#lock-remember').checked = true;
    updateRememberHint();
    true;
  `);

  // 3: lock screen, light
  await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = 'light'`);
  await pause(320);
  await shoot(win, 'lock-light');

  // 3: browser chrome with tabs and a panel, dark
  await win.webContents.executeJavaScript(`
    document.documentElement.dataset.theme = 'dark';
    document.body.dataset.platform = 'win32';
    document.querySelector('#lock').classList.add('is-hidden');
    ui.tabs = [
      { id: '1', url: 'https://arstechnica.com/security/', title: 'Sicherheitsnachrichten und Analysen', loading: false, canGoBack: true, canGoForward: false, favicon: null },
      { id: '2', url: 'https://developer.mozilla.org/de/docs/Web/API', title: 'Web-APIs bei MDN', loading: false, canGoBack: false, canGoForward: false, favicon: null },
      { id: '3', url: 'https://news.ycombinator.com/', title: 'Hacker News', loading: true, canGoBack: false, canGoForward: false, favicon: null }
    ];
    ui.activeId = '1';
    ui.bookmarks = [
      { id: 'b1', url: 'https://developer.mozilla.org/de/docs/Web/API', title: 'Web-APIs bei MDN', folder: null, updatedAt: new Date().toISOString() },
      { id: 'b2', url: 'https://www.privacyguides.org/de/', title: 'Privacy Guides', folder: null, updatedAt: new Date(Date.now() - 3600000).toISOString() },
      { id: 'b3', url: 'https://codeberg.org/explore/repos', title: 'Codeberg Explore', folder: 'via Handy-Shortcut', updatedAt: new Date(Date.now() - 86400000).toISOString() }
    ];
    ui.settings = { searchEngine: 'duckduckgo', autoLockMinutes: 15, blockTrackers: true, theme: 'dark' };
    ui.status = { locked: false, sync: { state: 'synced' }, blocked: 1247, device: 'SMOKE-PC', serverUrl: 'https://sync.example.com' };
    document.querySelector('#sync-dot').dataset.state = 'synced';
    document.querySelector('#sync-label').textContent = 'Synchron';
    renderTabs(); renderToolbar(); renderBookmarks();
    openPanel('bookmarks');
    true;
  `);
  await pause(520);
  await shoot(win, 'chrome-bookmarks-dark');

  // 4: settings panel, dark
  await win.webContents.executeJavaScript(`openPanel('settings'); true;`);
  await pause(320);
  await shoot(win, 'chrome-settings-dark');

  // 5: light theme, devices panel with an empty state
  await win.webContents.executeJavaScript(`
    document.documentElement.dataset.theme = 'light';
    ui.settings.theme = 'light';
    openPanel('devices');
    true;
  `);
  await pause(320);
  await shoot(win, 'chrome-devices-light');

  console.log(`\n${problems.length ? 'FEHLER' : 'Sauber'}: ${problems.length} Konsolenfehler`);
  problems.forEach((p) => console.log(`  - ${p}`));
  console.log(`Screenshots: ${SHOTS}\n`);

  app.exit(problems.length ? 1 : 0);
});

function pause(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function shoot(win, name) {
  // capturePage can hand back the previous frame, so wait for two real paints first.
  await win.webContents.executeJavaScript(
    `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`
  );
  await pause(120);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), image.toPNG());
  console.log(`  gespeichert ${name}.png`);
}
