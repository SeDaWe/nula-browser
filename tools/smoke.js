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

const os = require('node:os');
const crypto = require('node:crypto');

const { app, BrowserWindow, ipcMain } = require('electron');

/*
 * Software-Rendering. capturePage() haengt am Viz-Compositor, und ein
 * angeschlagener GPU-Prozess laesst den ganzen Lauf stumm stehenbleiben
 * (UnknownVizError, oder gar keine Antwort). Fuer Screenshots einer statischen
 * Oberflaeche bringt die GPU nichts, also wird sie hier gar nicht erst
 * gebraucht - das macht den Test auf jedem Rechner und in CI reproduzierbar.
 */
app.disableHardwareAcceleration();

/*
 * Eigenes Wegwerf-Profil, aus zwei Gruenden. Erstens schrieb der Smoke-Test
 * sonst in das gemeinsame Electron-Profil des Rechners, was in genau diesem
 * Projekt ein schlechter Witz waere. Zweitens teilt er sich damit keinen Lock
 * mehr mit anderen Electron-Laeufen: ein haengengebliebener Prozess liess den
 * naechsten Start sonst stumm blockieren.
 */
const RUN_PROFILE = path.join(os.tmpdir(), `nula-smoke-${crypto.randomBytes(5).toString('hex')}`);
fs.mkdirSync(RUN_PROFILE, { recursive: true });
app.setPath('userData', RUN_PROFILE);
app.setPath('sessionData', RUN_PROFILE);

// Ein Fehler im Testcode selbst soll sichtbar abbrechen, statt mit offenem
// Fenster stehenzubleiben.
process.on('unhandledRejection', (err) => {
  console.log(`FEHLER Der Smoke-Test selbst ist abgebrochen -> ${err && err.message ? err.message : err}`);
  app.exit(1);
});

const problems = [];

// Stub the IPC surface so the renderer boots exactly as it would in the app.
const STUBS = {
  'nula:bootstrap': { ok: true, data: { serverUrl: null, deviceName: 'SMOKE', locked: true, platform: 'win32', version: '2.5.0', autoUpdate: true, update: { state: 'current', version: null, detail: null, percent: 0 } } },
  'nula:activity': { ok: true, data: null },
  'nula:popup:allow': { ok: true, data: { opened: true, host: 'shop.example.org' } },
};

// Was die Oberflaeche tatsaechlich zur Navigation schickt.
const navigated = [];

app.whenReady().then(async () => {
  ipcMain.handle('nula:tab:navigate', (_e, payload) => {
    navigated.push(payload);
    return { ok: true, data: null };
  });
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
    ui.settings = { searchEngine: 'duckduckgo', autoLockMinutes: 15, blockTrackers: true, blockPopups: true, theme: 'dark' };
    ui.status = { locked: false, sync: { state: 'synced' }, blocked: 1247, popupsBlocked: 34, device: 'SMOKE-PC', serverUrl: 'https://sync.example.com' };
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

  // 5: the complete export card at the bottom of settings
  await win.webContents.executeJavaScript(`
    const body = document.querySelector('.panel-view[data-view="settings"] .panel-body');
    body.scrollTop = body.scrollHeight;
    true;
  `);
  await pause(320);
  await shoot(win, 'chrome-backup-dark');

  // 6: light theme, devices panel with an empty state
  await win.webContents.executeJavaScript(`
    document.documentElement.dataset.theme = 'light';
    ui.settings.theme = 'light';
    openPanel('devices');
    true;
  `);
  await pause(320);
  await shoot(win, 'chrome-devices-light');

  // 7: volle Tab-Leiste. Der Punkt, an dem Tabs frueher zu Streifen wurden.
  await win.webContents.executeJavaScript(`
    document.documentElement.dataset.theme = 'dark';
    ui.settings.theme = 'dark';
    closePanel();
    ui.tabs = Array.from({ length: 24 }, (_, i) => ({
      id: 'v' + i,
      url: 'https://beispiel' + i + '.example/artikel',
      title: ['Sicherheitsnachrichten', 'Web-APIs bei MDN', 'Hacker News', 'Privacy Guides',
              'Codeberg Explore', 'Wetterbericht'][i % 6] + ' ' + (i + 1),
      loading: i === 3,
    }));
    ui.activeId = 'v0';
    renderTabs(); renderToolbar();
    true;
  `);
  await pause(520);
  await shoot(win, 'tabstrip-voll-dark');

  await win.webContents.executeJavaScript(`
    ui.activeId = 'v23';
    renderTabs();
    true;
  `);
  await pause(900);
  await shoot(win, 'tabstrip-ende-dark');

  // 8: die Meldung ueber ein blockiertes Fenster, samt Knopf
  await win.webContents.executeJavaScript(`
    document.documentElement.dataset.theme = 'dark';
    closePanel();
    toast('Fenster blockiert: popads.net (Werbenetzwerk)', false, {
      icon: 'ph-prohibit',
      label: 'Trotzdem öffnen',
      onClick: () => {},
    });
    true;
  `);
  await pause(520);
  await shoot(win, 'popup-blocked-dark');
  await win.webContents.executeJavaScript(`
    document.querySelector('#toast').classList.remove('is-visible');
    true;
  `);

  // --- Regression: die Omnibox muss das Getippte schicken -------------------
  // blur() feuert den blur-Handler synchron, und der setzt das Feld ueber
  // renderToolbar() auf die aktuelle Tab-URL zurueck. Wird der Wert danach
  // gelesen, navigiert Nula dorthin, wo man ohnehin schon ist. Auf einem neuen
  // Tab heisst das nula://newtab - sichtbar passiert dann gar nichts.
  navigated.length = 0;
  await win.webContents.executeJavaScript(`
    ui.tabs = [{ id: 'omni-t', url: 'nula://newtab', title: 'Neuer Tab', loading: false }];
    ui.activeId = 'omni-t';
    renderToolbar();
    const o = document.querySelector('#omni-input');
    o.focus();
    o.value = 'example.com';
    o.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    true;
  `);
  await pause(200);
  if (navigated.length !== 1 || navigated[0].input !== 'example.com') {
    problems.push(
      'Omnibox schickt "' + (navigated[0] ? navigated[0].input : '(nichts)') + '" statt "example.com"'
    );
  } else {
    console.log('  ok   Omnibox schickt das Getippte');
  }


  console.log(`\n${problems.length ? 'FEHLER' : 'Sauber'}: ${problems.length} Konsolenfehler`);
  problems.forEach((p) => console.log(`  - ${p}`));
  console.log(`Screenshots: ${SHOTS}\n`);

  try {
    fs.rmSync(RUN_PROFILE, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* Chromium haelt unter Windows noch Handles; der Ordner liegt im Temp-Verzeichnis */
  }
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
  /*
   * capturePage() haengt, wenn das Fenster gerade nicht zusammengesetzt wird -
   * verdeckt, ausserhalb des Bildschirms, gesperrter Desktop. Ohne Frist stand
   * der ganze Lauf dann stumm mit offenem Fenster da. Lieber ein gemeldeter
   * Fehlschlag als kein Ergebnis.
   */
  const image = await Promise.race([
    win.webContents.capturePage(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('capturePage antwortet nicht')), 15000)
    ),
  ]).catch((err) => {
    problems.push(`${name}: ${err.message}`);
    return null;
  });
  if (!image) {
    console.log(`  FEHLER ${name}.png nicht aufgenommen`);
    return;
  }
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), image.toPNG());
  console.log(`  gespeichert ${name}.png`);
}
