'use strict';

/*
 * Nula - privacy browser main process.
 *
 * Disk policy: Chromium's profile directory is redirected to a per-run temp
 * folder and deleted on exit. The browsing session itself uses a non-persistent
 * partition, so history, cookies, cache and storage never reach the disk at all.
 * The only file Nula writes to the home directory is ~/.nula/config.json, which
 * holds the server URL and a random device id. Nothing else.
 */

const { app, BrowserWindow, session, ipcMain, protocol, net, shell, globalShortcut, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const config = require('./config');
const vaultcrypto = require('./vaultcrypto');
const { NulaApi } = require('./api');
const { SyncEngine } = require('./sync');
const { emptyVault, newId } = require('./vault');
const blocker = require('./blocker');
const { TabManager, CHROME_HEIGHT } = require('./tabs');
const { resolveInput } = require('./urls');

// ---------------------------------------------------------------------------
// Disk hygiene, applied before anything Chromium does
// ---------------------------------------------------------------------------

const RUN_PROFILE = path.join(os.tmpdir(), `nula-${crypto.randomBytes(6).toString('hex')}`);
fs.mkdirSync(RUN_PROFILE, { recursive: true });
app.setPath('userData', RUN_PROFILE);
app.setPath('sessionData', RUN_PROFILE);
app.setPath('cache', path.join(RUN_PROFILE, 'cache'));

app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-features', 'MediaRouter,OptimizationHints,InterestFeedContentSuggestions');
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-breakpad');
app.commandLine.appendSwitch('disable-crash-reporter');

/*
 * Deleting the profile from inside the shutdown handler loses a race with
 * Chromium, which still holds leveldb handles. So we try once inline for the
 * happy path, and hand any remainder to a detached cleaner that outlives us.
 */
let cleanerSpawned = false;

/*
 * Spawned from before-quit, while the process is still healthy. Spawning during
 * will-quit or process exit is unreliable: the handoff races with teardown and
 * the child sometimes never starts.
 */
function spawnCleaner() {
  if (cleanerSpawned) return;
  cleanerSpawned = true;
  try {
    require('node:child_process')
      .spawn(process.execPath, [path.join(__dirname, 'cleanup.js'), RUN_PROFILE], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
      .unref();
  } catch {
    /* nothing else we can do; the folder sits in the OS temp dir */
  }
}

/** Fast path for the case where Chromium has already let go. */
function wipeProfile() {
  try {
    fs.rmSync(RUN_PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* expected on Windows; the detached cleaner finishes the job */
  }
}

/** Remove profiles a previous run could not delete, e.g. after a crash. */
function sweepStaleProfiles() {
  const tmp = os.tmpdir();
  let entries = [];
  try {
    entries = fs.readdirSync(tmp, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^nula-[0-9a-f]{12}$/.test(entry.name)) continue;
    const full = path.join(tmp, entry.name);
    if (full === RUN_PROFILE) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      /* another Nula instance may still own it */
    }
  }
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

const state = {
  win: null,
  api: null,
  keys: null,
  sync: null,
  tabs: null,
  browseSession: null,
  blockStats: { blocked: 0 },
  locked: true,
  lockTimer: null,
  syncStatus: { state: 'idle', detail: null },
  quitting: false,
};

function chromeSend(channel, payload) {
  if (state.win && !state.win.isDestroyed()) {
    state.win.webContents.send(channel, payload);
  }
}

function pushVaultState() {
  if (!state.sync) return;
  chromeSend('nula:vault', {
    bookmarks: state.sync.vault.bookmarks,
    settings: state.sync.vault.settings,
    remoteTabs: state.sync.vault.tabs.filter((t) => t.deviceId !== config.load().deviceId),
  });
}

function pushTabState(payload) {
  chromeSend('nula:tabs', payload || (state.tabs ? state.tabs.serialize() : { tabs: [], activeId: null }));
}

function pushStatus() {
  chromeSend('nula:status', {
    locked: state.locked,
    sync: state.syncStatus,
    blocked: state.blockStats.blocked,
    device: config.load().deviceName,
    serverUrl: config.load().serverUrl,
  });
}

// ---------------------------------------------------------------------------
// Auto lock
// ---------------------------------------------------------------------------

function resetLockTimer() {
  clearTimeout(state.lockTimer);
  if (state.locked || !state.sync) return;
  const minutes = state.sync.vault.settings.autoLockMinutes;
  if (!minutes || minutes <= 0) return;
  state.lockTimer = setTimeout(() => lock('auto'), minutes * 60 * 1000);
}

async function lock(reason) {
  if (state.locked) return;
  if (state.sync) {
    captureTabsIntoVault();
    await state.sync.flush().catch(() => {});
    state.sync.stop();
  }
  if (state.tabs) state.tabs.closeAll();
  vaultcrypto.wipeKeys(state.keys);
  state.keys = null;
  state.sync = null;
  state.api = null;
  state.locked = true;
  clearTimeout(state.lockTimer);
  // Drop everything Chromium is still holding for the browsing session.
  if (state.browseSession) {
    await state.browseSession.clearStorageData().catch(() => {});
    await state.browseSession.clearCache().catch(() => {});
    await state.browseSession.clearAuthCache().catch(() => {});
  }
  chromeSend('nula:locked', { reason: reason || 'manual' });
  pushStatus();
}

// ---------------------------------------------------------------------------
// Vault <-> tabs bridge
// ---------------------------------------------------------------------------

function captureTabsIntoVault() {
  if (!state.sync || !state.tabs) return;
  const deviceId = config.load().deviceId;
  const now = new Date().toISOString();
  const mine = state.tabs.order
    .map((id) => state.tabs.tabs.get(id))
    .filter((t) => t && t.url && !t.url.startsWith('nula://'))
    .map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      deviceId,
      pinned: t.pinned,
      updatedAt: now,
    }));
  const others = state.sync.vault.tabs.filter((t) => t.deviceId !== deviceId);
  state.sync.vault.tabs = [...others, ...mine];
  state.sync.touch();
}

function restoreTabsFromVault() {
  const deviceId = config.load().deviceId;
  const mine = state.sync.vault.tabs.filter((t) => t.deviceId === deviceId);
  if (!mine.length) {
    state.tabs.create(newId(), 'nula://newtab');
    return;
  }
  mine.forEach((t, i) => {
    state.tabs.create(t.id, t.url, { activate: i === mine.length - 1, pinned: t.pinned });
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0a0b0d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 20 } : undefined,
    frame: process.platform === 'darwin',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'chrome.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.on('resize', () => state.tabs && state.tabs.layout());
  win.on('enter-full-screen', () => state.tabs && state.tabs.layout());
  win.on('leave-full-screen', () => state.tabs && state.tabs.layout());

  win.on('close', (e) => {
    if (state.quitting || state.locked || !state.sync) return;
    // Final flush on quit, as requested: live sync plus a guaranteed save on close.
    e.preventDefault();
    state.quitting = true;
    captureTabsIntoVault();
    state.sync
      .flush()
      .catch(() => {})
      .finally(() => win.destroy());
  });

  // The chrome UI must never navigate away from itself.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

// ---------------------------------------------------------------------------
// Browsing session
// ---------------------------------------------------------------------------

function createBrowseSession() {
  // No "persist:" prefix means the partition is in-memory only.
  const ses = session.fromPartition('nula-ephemeral');

  ses.setUserAgent(
    ses.getUserAgent().replace(/Electron\/[\d.]+\s*/, '').replace(/nula-browser\/[\d.]+\s*/i, '')
  );

  state.blockStats = blocker.attach(ses, () => state.sync?.vault.settings.blockTrackers !== false);

  ses.setPreloads([]);
  ses.setSpellCheckerEnabled(false);

  // Downloads are the one place data intentionally hits the disk. Always ask.
  ses.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ title: 'Download speichern' });
  });

  // Serve nula:// internal pages from this session.
  ses.protocol.handle('nula', (request) => {
    const url = new URL(request.url);
    const page = url.hostname || 'newtab';
    const file = path.join(__dirname, '..', 'pages', `${page.replace(/[^a-z0-9-]/gi, '')}.html`);
    if (!fs.existsSync(file)) {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    return net.fetch('file://' + file.replace(/\\/g, '/'));
  });

  return ses;
}

// ---------------------------------------------------------------------------
// Unlock / setup flow
// ---------------------------------------------------------------------------

/*
 * The inbox uses a hybrid key agreement, so the account needs two public keys on
 * the server: the X25519 half comes from the password, the ML-KEM half is
 * generated once and kept inside the encrypted vault. A fresh identity is pushed
 * straight away so a second device cannot create a competing one.
 */
async function ensureInboxIdentity(info, setupToken) {
  const sync = state.sync;
  if (!sync.vault.identity) {
    sync.vault.identity = vaultcrypto.createKemIdentity();
    sync.touch();
    await sync.flush();
  }
  const kemPublic = sync.vault.identity.kemPublic;
  if (info.x25519Public !== state.keys.x25519PubHex || info.kemPublic !== kemPublic) {
    await state.api.registerIdentity(state.keys.x25519PubHex, kemPublic, setupToken);
  }
}

async function connectAndUnlock({ serverUrl, password, setupToken, rememberUrl }) {
  const url = (serverUrl || config.load().serverUrl || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('Keine Server-Adresse konfiguriert');
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('Server-Adresse ist ungültig');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error('Server-Adresse muss eine HTTP(S)-Adresse ohne Zugangsdaten sein');
  }
  if (parsedUrl.search || parsedUrl.hash) {
    throw new Error('Server-Adresse darf keine Query-Parameter oder URL-Fragmente enthalten');
  }
  const localHttp =
    parsedUrl.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname.toLowerCase());
  if (parsedUrl.protocol !== 'https:' && !localHttp) {
    throw new Error('Außerhalb von localhost ist für den Sync-Server HTTPS erforderlich');
  }
  if (!password || password.length < 8) throw new Error('Passwort muss mindestens 8 Zeichen haben');
  const setupCode = (setupToken || '').trim();
  if (setupCode && !/^[0-9a-f]{64}$/.test(setupCode)) {
    throw new Error('Setup-Code muss aus genau 64 kleingeschriebenen Hex-Zeichen bestehen');
  }

  const api = new NulaApi(url);
  const info = await api.info();

  let clientSalt = info.clientSalt;
  let firstRun = false;
  if (!info.initialized) {
    if (info.setupTokenRequired && !setupCode) {
      throw new Error('Beim ersten Verbinden ist der Setup-Code aus der Server-.env erforderlich');
    }
    clientSalt = vaultcrypto.generateSalt();
    firstRun = true;
  }

  // Argon2id takes about a second on purpose; the renderer shows a busy state.
  const argon2 = firstRun ? vaultcrypto.ARGON2_DEFAULTS : info.argon2;
  const keys = await vaultcrypto.deriveKeys(password, clientSalt, argon2);
  try {
    api.authKeyHex = keys.authKeyHex;

    if (firstRun) {
      await api.setup(clientSalt, keys.authKeyHex, keys.argon2, setupCode);
    } else {
      try {
        await api.verify();
      } catch (err) {
        if (err.status === 401) throw new Error('Falsches Passwort');
        throw err;
      }
    }

    // Only the address is optional here. The device id has to persist either way,
    // otherwise every start would look like a new device and pile up stale tabs.
    const remember = rememberUrl !== false;
    config.save({ serverUrl: remember ? url : null, rememberServerUrl: remember });
    config.ensureDeviceId();

    state.api = api;
    state.keys = keys;
    state.sync = new SyncEngine(
      api,
      keys,
      (s) => {
        state.syncStatus = s;
        pushStatus();
      },
      () => pushVaultState()
    );

    await state.sync.start();
    await ensureInboxIdentity(info, setupCode);
    state.locked = false;

    state.tabs = new TabManager(state.win, state.browseSession, (payload) => pushTabState(payload));
    state.tabs.newTabRequestHandler = (target) => {
      state.tabs.create(newId(), target);
    };
    state.tabs.setVisible(true);
    restoreTabsFromVault();

    state.sync.drainInbox().catch(() => {});
    resetLockTimer();
    pushVaultState();
    pushStatus();

    return { firstRun };
  } catch (err) {
    if (state.keys === keys) {
      state.sync?.stop();
      state.tabs?.closeAll();
      state.api = null;
      state.keys = null;
      state.sync = null;
      state.tabs = null;
      state.locked = true;
    }
    vaultcrypto.wipeKeys(keys);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function guard(fn) {
  return async (...args) => {
    try {
      const result = await fn(...args);
      return { ok: true, data: result === undefined ? null : result };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  };
}

function requireUnlocked() {
  if (state.locked || !state.sync) throw new Error('Browser ist gesperrt');
}

function registerIpc() {
  ipcMain.handle('nula:bootstrap', guard(async () => {
    const cfg = config.load();
    return {
      serverUrl: cfg.serverUrl,
      rememberServerUrl: cfg.rememberServerUrl !== false,
      deviceName: cfg.deviceName,
      locked: state.locked,
      platform: process.platform,
      version: app.getVersion(),
    };
  }));

  ipcMain.handle('nula:unlock', guard(async (_e, payload) => connectAndUnlock(payload)));

  ipcMain.handle('nula:lock', guard(async () => lock('manual')));

  ipcMain.handle('nula:activity', guard(async () => resetLockTimer()));

  // ---- tabs ----
  ipcMain.handle('nula:tab:new', guard(async (_e, url) => {
    requireUnlocked();
    const target = url ? resolveInput(url, state.sync.vault.settings) : 'nula://newtab';
    const tab = state.tabs.create(newId(), target);
    captureTabsIntoVault();
    return tab.id;
  }));

  ipcMain.handle('nula:tab:close', guard(async (_e, id) => {
    requireUnlocked();
    state.tabs.close(id);
    if (!state.tabs.order.length) state.tabs.create(newId(), 'nula://newtab');
    captureTabsIntoVault();
  }));

  ipcMain.handle('nula:tab:activate', guard(async (_e, id) => {
    requireUnlocked();
    state.tabs.activate(id);
  }));

  ipcMain.handle('nula:tab:navigate', guard(async (_e, { id, input }) => {
    requireUnlocked();
    const target = resolveInput(input, state.sync.vault.settings);
    state.tabs.navigate(id || state.tabs.activeId, target);
    captureTabsIntoVault();
  }));

  ipcMain.handle('nula:tab:back', guard(async () => {
    requireUnlocked();
    state.tabs.withActive((wc) => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack());
  }));

  ipcMain.handle('nula:tab:forward', guard(async () => {
    requireUnlocked();
    state.tabs.withActive((wc) => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward());
  }));

  ipcMain.handle('nula:tab:reload', guard(async () => {
    requireUnlocked();
    state.tabs.withActive((wc) => wc.reload());
  }));

  ipcMain.handle('nula:tab:stop', guard(async () => {
    requireUnlocked();
    state.tabs.withActive((wc) => wc.stop());
  }));

  ipcMain.handle('nula:tab:reopenRemote', guard(async (_e, id) => {
    requireUnlocked();
    const remote = state.sync.vault.tabs.find((t) => t.id === id);
    if (!remote) throw new Error('Tab nicht gefunden');
    state.tabs.create(newId(), remote.url);
    captureTabsIntoVault();
  }));

  // ---- bookmarks ----
  ipcMain.handle('nula:bookmark:add', guard(async (_e, payload) => {
    requireUnlocked();
    let url = payload?.url;
    let title = payload?.title;
    if (!url) {
      state.tabs.withActive((_wc, tab) => {
        url = tab.url;
        title = tab.title;
      });
    }
    if (!url || url.startsWith('nula://')) throw new Error('Diese Seite kann nicht gespeichert werden');
    state.sync.vault.bookmarks.push({
      id: newId(),
      url,
      title: title || url,
      folder: payload?.folder || null,
      updatedAt: new Date().toISOString(),
    });
    state.sync.touch();
    pushVaultState();
  }));

  ipcMain.handle('nula:bookmark:remove', guard(async (_e, id) => {
    requireUnlocked();
    state.sync.vault.bookmarks = state.sync.vault.bookmarks.filter((b) => b.id !== id);
    state.sync.vault.tombstones.push({ id, deletedAt: new Date().toISOString() });
    state.sync.touch();
    pushVaultState();
  }));

  // ---- settings ----
  ipcMain.handle('nula:settings:set', guard(async (_e, patch) => {
    requireUnlocked();
    Object.assign(state.sync.vault.settings, patch);
    state.sync.touch();
    resetLockTimer();
    pushVaultState();
  }));

  // ---- sync ----
  ipcMain.handle('nula:sync:now', guard(async () => {
    requireUnlocked();
    captureTabsIntoVault();
    await state.sync.push();
    await state.sync.pull();
    const applied = await state.sync.drainInbox();
    pushVaultState();
    return { inboxApplied: applied };
  }));

  // ---- API tokens ----
  ipcMain.handle('nula:tokens:list', guard(async () => {
    requireUnlocked();
    return state.api.listTokens();
  }));

  ipcMain.handle('nula:tokens:create', guard(async (_e, name) => {
    requireUnlocked();
    return state.api.createToken(name);
  }));

  ipcMain.handle('nula:tokens:delete', guard(async (_e, id) => {
    requireUnlocked();
    return state.api.deleteToken(id);
  }));

  // ---- window controls ----
  ipcMain.handle('nula:window', guard(async (_e, action) => {
    if (!state.win) return;
    if (action === 'minimize') state.win.minimize();
    else if (action === 'maximize') state.win.isMaximized() ? state.win.unmaximize() : state.win.maximize();
    else if (action === 'close') state.win.close();
  }));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

protocol.registerSchemesAsPrivileged([
  { scheme: 'nula', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (state.win) {
      if (state.win.isMinimized()) state.win.restore();
      state.win.focus();
    }
  });

  app.whenReady().then(() => {
    sweepStaleProfiles();

    // DNS-over-HTTPS so the local resolver and the network see as little as possible.
    try {
      app.configureHostResolver({
        secureDnsMode: 'secure',
        secureDnsServers: ['https://dns.quad9.net/dns-query', 'https://mozilla.cloudflare-dns.com/dns-query'],
      });
    } catch {
      /* older Electron, fall back to system DNS */
    }

    Menu.setApplicationMenu(buildMenu());
    state.browseSession = createBrowseSession();
    registerIpc();
    state.win = createWindow();
    pushStatus();

    globalShortcut.register('CommandOrControl+Shift+L', () => lock('shortcut'));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) state.win = createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (event) => {
    if (!state.quitting && !state.locked && state.sync) {
      event.preventDefault();
      state.quitting = true;
      captureTabsIntoVault();
      state.sync
        .flush()
        .catch(() => {})
        .finally(() => {
          state.sync?.stop();
          app.quit();
        });
      return;
    }
    state.quitting = true;
    if (state.sync) state.sync.stop();
    globalShortcut.unregisterAll();
    spawnCleaner();
  });

  app.on('will-quit', wipeProfile);
  process.on('exit', wipeProfile);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (channel) => () => chromeSend(channel);
  return Menu.buildFromTemplate([
    ...(isMac
      ? [{
          label: 'Nula',
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { label: 'Sperren', accelerator: 'Cmd+Shift+L', click: () => lock('menu') },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'Datei',
      submenu: [
        { label: 'Neuer Tab', accelerator: 'CmdOrCtrl+T', click: send('nula:cmd:newtab') },
        { label: 'Tab schließen', accelerator: 'CmdOrCtrl+W', click: send('nula:cmd:closetab') },
        { type: 'separator' },
        { label: 'Sperren', accelerator: 'CmdOrCtrl+Shift+L', click: () => lock('menu') },
        isMac ? { role: 'close' } : { role: 'quit', label: 'Beenden' },
      ],
    },
    {
      label: 'Bearbeiten',
      submenu: [
        { role: 'undo', label: 'Rückgängig' },
        { role: 'redo', label: 'Wiederholen' },
        { type: 'separator' },
        { role: 'cut', label: 'Ausschneiden' },
        { role: 'copy', label: 'Kopieren' },
        { role: 'paste', label: 'Einfügen' },
        { role: 'selectAll', label: 'Alles auswählen' },
        { type: 'separator' },
        { label: 'Adressleiste fokussieren', accelerator: 'CmdOrCtrl+L', click: send('nula:cmd:focusomni') },
      ],
    },
    {
      label: 'Ansicht',
      submenu: [
        { label: 'Neu laden', accelerator: 'CmdOrCtrl+R', click: () => state.tabs?.withActive((wc) => wc.reload()) },
        { type: 'separator' },
        { label: 'Lesezeichen', accelerator: 'CmdOrCtrl+B', click: send('nula:cmd:bookmarks') },
        { label: 'Einstellungen', accelerator: 'CmdOrCtrl+,', click: send('nula:cmd:settings') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild' },
      ],
    },
  ]);
}
