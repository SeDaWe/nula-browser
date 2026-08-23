'use strict';

/*
 * Nula - privacy browser main process.
 *
 * Disk policy: Chromium's profile directory is redirected to a per-run temp
 * folder and deleted on exit. The browsing session itself uses a non-persistent
 * partition, so history, cookies, cache and storage never reach the disk at all.
 * The only file Nula writes automatically to the home directory is
 * ~/.nula/config.json, which holds the server URL and a random device id.
 * Explicit exports are encrypted and go only to the path the user chooses.
 */

const { app, BrowserWindow, dialog, session, ipcMain, protocol, net, shell, globalShortcut, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const config = require('./config');
const backup = require('./backup');
const vaultcrypto = require('./vaultcrypto');
const { NulaApi } = require('./api');
const { SyncEngine } = require('./sync');
const { importableVault, mergeBackupVault, newId } = require('./vault');
const blocker = require('./blocker');
const { TabManager, CHROME_HEIGHT } = require('./tabs');
const updater = require('./updater');
const { resolveInput } = require('./urls');

// A final push must not keep a closing window or a locking session waiting on an
// unreachable server. The push keeps running, it just stops being awaited.
const FLUSH_TIMEOUT_MS = 8000;

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
  exportInProgress: false,
  importInProgress: false,
  locking: false,
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

/*
 * Der Installer fragt beim Einrichten, ob Nula selbst nach Updates suchen soll,
 * und legt die Antwort neben die EXE. Sie wird nur angewendet, wenn sie neuer
 * ist als die Konfiguration: eine frische Installation gewinnt damit gegen eine
 * alte Einstellung, eine spaetere Aenderung in den Einstellungen aber ebenso
 * gegen die Installer-Vorgabe. Stille Updates schreiben die Datei gar nicht.
 */
function applyInstallerUpdateChoice() {
  if (process.platform !== 'win32') return;
  try {
    const flag = path.join(path.dirname(app.getPath('exe')), 'auto-update.default');
    const flagTime = fs.statSync(flag).mtimeMs;
    let configTime = 0;
    try {
      configTime = fs.statSync(config.CONFIG_FILE).mtimeMs;
    } catch {
      /* noch keine Konfiguration, dann zaehlt die Vorgabe in jedem Fall */
    }
    if (flagTime <= configTime) return;
    config.save({ autoUpdate: fs.readFileSync(flag, 'utf8').trim() === '1' });
  } catch {
    /* keine Vorgabe vom Installer, dann bleibt es bei der Konfiguration */
  }
}

function pushUpdateStatus(payload) {
  chromeSend('nula:update', payload || updater.getStatus());
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
  if (state.locked || state.locking) return;
  // lock() only clears state.keys and state.sync after its own flush has been
  // awaited. Without this flag anything running in parallel -- an open import
  // dialog, say -- would still see an unlocked browser and go on to merge into a
  // SyncEngine that lock() is about to throw away.
  state.locking = true;
  try {
    await runLock(reason);
  } finally {
    state.locking = false;
  }
}

async function runLock(reason) {
  if (state.sync) {
    captureTabsIntoVault();
    await state.sync.flush(FLUSH_TIMEOUT_MS).catch(() => {});
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
    if (state.quitting || state.locked || state.locking || !state.sync) return;
    // Final flush on quit, as requested: live sync plus a guaranteed save on close.
    e.preventDefault();
    state.quitting = true;
    captureTabsIntoVault();
    state.sync
      .flush(FLUSH_TIMEOUT_MS)
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
    config.save({ serverUrl: remember ? url : null, rememberServerUrl: remember, setupDone: remember });
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
  if (state.locked || state.locking || !state.sync) throw new Error('Browser ist gesperrt');
}

async function exportAllData() {
  requireUnlocked();
  if (state.exportInProgress) throw new Error('Ein Export läuft bereits');
  state.exportInProgress = true;
  resetLockTimer();
  try {
    const timestamp = new Date().toISOString();
    const fileStamp = timestamp.replace(/[:.]/g, '-');
    const result = await dialog.showSaveDialog(state.win, {
      title: 'Verschlüsseltes Nula-Backup exportieren',
      defaultPath: path.join(app.getPath('documents'), `Nula-Backup-${fileStamp}.nula-backup.json`),
      buttonLabel: 'Backup exportieren',
      filters: [{ name: 'Nula-Backup', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    requireUnlocked();
    const keys = state.keys;
    const api = state.api;
    const sync = state.sync;
    captureTabsIntoVault();
    await sync.flush();

    const [tokenResult, inboxResult] = await Promise.allSettled([
      api.listTokens(),
      api.getInbox(),
    ]);
    requireUnlocked();
    if (state.keys !== keys || state.api !== api || state.sync !== sync) {
      throw new Error('Browser wurde während des Exports gesperrt');
    }

    const unavailable = [];
    let tokenMetadata = [];
    if (tokenResult.status === 'fulfilled' && Array.isArray(tokenResult.value?.tokens)) {
      tokenMetadata = tokenResult.value.tokens.map((token) => ({
        id: token.id,
        name: token.name,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
      }));
    } else {
      unavailable.push('apiTokenMetadata');
    }

    let pendingInbox = [];
    if (inboxResult.status === 'fulfilled' && Array.isArray(inboxResult.value?.items)) {
      pendingInbox = inboxResult.value.items.map((entry) => ({
        id: entry.id,
        sealed: entry.sealed,
        createdAt: entry.createdAt,
      }));
    } else {
      unavailable.push('pendingInbox');
    }

    const cfg = config.load();
    const payload = {
      format: backup.PAYLOAD_FORMAT,
      version: backup.BACKUP_VERSION,
      exportedAt: timestamp,
      application: {
        name: 'Nula',
        version: app.getVersion(),
        platform: process.platform,
      },
      connection: {
        serverUrl: api.base,
        syncVersion: sync.version,
        syncDirty: sync.dirty,
      },
      localConfig: {
        serverUrl: cfg.serverUrl,
        rememberServerUrl: cfg.rememberServerUrl,
        deviceId: cfg.deviceId,
        deviceName: cfg.deviceName,
      },
      vault: structuredClone(sync.vault),
      serverData: {
        apiTokenMetadata: tokenMetadata,
        apiTokenSecretsIncluded: false,
        pendingInbox,
        unavailable,
      },
    };
    const document = backup.createBackup({
      encKey: keys.encKey,
      clientSalt: keys.clientSaltHex,
      argon2: keys.argon2,
      payload,
      exportedAt: timestamp,
    });

    // Never report success for a blob that this process cannot authenticate.
    const verified = backup.decryptBackup(keys.encKey, document);
    if (verified.exportedAt !== timestamp) throw new Error('Backup-Selbstprüfung fehlgeschlagen');

    // The save dialog only confirmed the path the user actually picked. Appending
    // the full extension afterwards points at a different file, so a collision on
    // that adjusted path has to be confirmed separately instead of overwriting it.
    let filePath = result.filePath;
    if (!/\.nula-backup\.json$/i.test(filePath)) {
      const adjusted = `${filePath.replace(/\.json$/i, '')}.nula-backup.json`;
      if (fs.existsSync(adjusted)) {
        const overwrite = await dialog.showMessageBox(state.win, {
          type: 'warning',
          buttons: ['Ersetzen', 'Abbrechen'],
          defaultId: 1,
          cancelId: 1,
          title: 'Datei ersetzen?',
          message: `${path.basename(adjusted)} existiert bereits.`,
          detail: 'Nula ergänzt die vollständige Endung .nula-backup.json. Soll die vorhandene Datei ersetzt werden?',
        });
        if (overwrite.response !== 0) return { canceled: true };
      }
      filePath = adjusted;
    }
    backup.writeBackupFile(filePath, document);
    return {
      canceled: false,
      fileName: path.basename(filePath),
      counts: {
        tabs: payload.vault.tabs?.length || 0,
        bookmarks: payload.vault.bookmarks?.length || 0,
        notes: payload.vault.notes?.length || 0,
        tokens: tokenMetadata.length,
        pendingInbox: pendingInbox.length,
      },
      unavailable,
    };
  } finally {
    state.exportInProgress = false;
    resetLockTimer();
  }
}

function countEntries(vault) {
  return {
    tabs: vault.tabs?.length || 0,
    bookmarks: vault.bookmarks?.length || 0,
    notes: vault.notes?.length || 0,
  };
}

/**
 * Read an encrypted export back in and merge it into the running vault. Merging
 * rather than replacing keeps local deletions deleted (tombstones win) and makes
 * a repeated import a no-op. Only the master password that produced the backup
 * can open it, so this always runs against the currently unlocked session.
 */
async function importAllData() {
  requireUnlocked();
  if (state.importInProgress) throw new Error('Ein Import läuft bereits');
  state.importInProgress = true;
  resetLockTimer();
  try {
    const chosen = await dialog.showOpenDialog(state.win, {
      title: 'Verschlüsseltes Nula-Backup importieren',
      buttonLabel: 'Backup einlesen',
      filters: [{ name: 'Nula-Backup', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (chosen.canceled || !chosen.filePaths?.length) return { canceled: true };
    const sourcePath = chosen.filePaths[0];

    requireUnlocked();
    const keys = state.keys;
    const sync = state.sync;

    const document = backup.readBackupFile(sourcePath);
    let payload;
    try {
      payload = backup.decryptBackup(keys.encKey, document);
    } catch {
      throw new Error(
        'Backup gehört zu einem anderen Master-Passwort oder ist beschädigt und lässt sich nicht öffnen'
      );
    }

    const incoming = payload.vault;
    const pending = Array.isArray(payload.serverData?.pendingInbox)
      ? payload.serverData.pendingInbox
      : [];
    const offered = countEntries(importableVault(incoming));

    const answer = await dialog.showMessageBox(state.win, {
      type: 'question',
      buttons: ['Alles übernehmen', 'Nur Daten übernehmen', 'Abbrechen'],
      defaultId: 0,
      cancelId: 2,
      title: 'Backup importieren',
      message: `Backup vom ${new Date(document.exportedAt).toLocaleString('de-DE')}`,
      detail: [
        `Enthalten: ${offered.bookmarks} Lesezeichen, ${offered.tabs} Tabs, ${offered.notes} Notizen`,
        pending.length ? `sowie ${pending.length} noch nicht abgeholte Inbox-Einträge` : null,
        '',
        'Der Inhalt wird mit dem aktuellen Vault zusammengeführt. Vor weniger als 30 Tagen',
        'gelöschte Einträge kommen nicht zurück, und die Inbox-Identität bleibt unverändert.',
        'Löschungen aus dem Backup gelten dabei auch hier: Einträge, die auf dem anderen',
        'Gerät gelöscht wurden, verschwinden dann ebenfalls.',
        '',
        '"Alles übernehmen" setzt zusätzlich die Einstellungen aus dem Backup.',
      ]
        .filter((line) => line !== null)
        .join('\n'),
    });
    if (answer.response === 2) return { canceled: true };
    const withSettings = answer.response === 0;

    requireUnlocked();
    if (state.keys !== keys || state.sync !== sync) {
      throw new Error('Browser wurde während des Imports gesperrt');
    }

    const before = countEntries(sync.vault);
    const merged = mergeBackupVault(sync.vault, incoming, {
      deviceId: config.load().deviceId,
      withSettings,
    });
    sync.vault = merged;

    // Inbox entries that were still queued when the export ran are sealed to this
    // identity, so they can be opened and folded in exactly like a live drain.
    let inboxApplied = 0;
    if (pending.length && merged.identity) {
      ({ applied: inboxApplied } = await sync.applyInboxEntries(pending));
    }

    const after = countEntries(sync.vault);
    sync.touch();
    await sync.flush(FLUSH_TIMEOUT_MS).catch(() => {});

    // A lock can still have started during those awaits and thrown this engine
    // away. Reporting success then would claim a merge that no longer exists
    // anywhere, so say plainly that it did not stick.
    if (state.keys !== keys || state.sync !== sync || state.locked) {
      throw new Error('Browser wurde während des Imports gesperrt, der Import wurde verworfen');
    }

    pushVaultState();
    pushStatus();
    resetLockTimer();

    // A backup carries its own tombstones, so a merge can also REMOVE entries
    // that this device still held. Reporting after - before unclamped would
    // print a negative count and hide the deletion entirely.
    const delta = (key) => after[key] - before[key];
    return {
      canceled: false,
      fileName: path.basename(sourcePath),
      settingsRestored: withSettings,
      inboxApplied,
      pendingUpload: sync.dirty,
      added: {
        tabs: Math.max(0, delta('tabs')),
        bookmarks: Math.max(0, delta('bookmarks')),
        notes: Math.max(0, delta('notes')),
      },
      removed: {
        tabs: Math.max(0, -delta('tabs')),
        bookmarks: Math.max(0, -delta('bookmarks')),
        notes: Math.max(0, -delta('notes')),
      },
    };
  } finally {
    state.importInProgress = false;
    resetLockTimer();
  }
}

function registerIpc() {
  ipcMain.handle('nula:bootstrap', guard(async () => {
    const cfg = config.load();
    return {
      serverUrl: cfg.serverUrl,
      rememberServerUrl: cfg.rememberServerUrl !== false,
      setupDone: cfg.setupDone === true,
      deviceName: cfg.deviceName,
      locked: state.locked,
      platform: process.platform,
      version: app.getVersion(),
      autoUpdate: cfg.autoUpdate !== false,
      update: updater.getStatus(),
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
    const result = state.tabs.navigate(id || state.tabs.activeId, target);
    // Bis 2.6 kehrte navigate() bei unbekanntem Tab oder abgelehnter Adresse
    // wortlos zurück - die Eingabe verschwand einfach, ohne jeden Hinweis.
    if (result && !result.ok) throw new Error(result.reason);
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

  ipcMain.handle('nula:backup:export', guard(async () => exportAllData()));
  ipcMain.handle('nula:backup:import', guard(async () => importAllData()));

  // ---- updates ----
  ipcMain.handle('nula:update:check', guard(async () => updater.check({ manual: true })));

  ipcMain.handle('nula:update:setEnabled', guard(async (_e, on) => {
    config.save({ autoUpdate: !!on });
    updater.setEnabled(!!on);
    return updater.getStatus();
  }));

  ipcMain.handle('nula:update:download', guard(async () => updater.openDownload()));

  ipcMain.handle('nula:update:install', guard(async () => {
    // quitAndInstall() ersetzt den Prozess und geht dabei an before-quit und am
    // Fenster-close vorbei. Der Vault muss also HIER weg, sonst ist alles seit
    // dem letzten Push verloren - er liegt nur im Arbeitsspeicher.
    if (!state.locked && state.sync) {
      captureTabsIntoVault();
      await state.sync.flush(FLUSH_TIMEOUT_MS).catch(() => {});
      if (state.sync.dirty) {
        throw new Error('Der Vault konnte nicht gesichert werden. Update abgebrochen.');
      }
      state.sync.stop();
    }
    // Verhindert, dass die Quit-Handler ein zweites Mal flushen wollen.
    state.quitting = true;
    updater.install();
    return { installing: true };
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
  ipcMain.handle('nula:panel', guard(async (_e, open) => {
    state.tabs?.setPanelOpen(open);
  }));

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
    applyInstallerUpdateChoice();
    updater.start({
      onStatus: pushUpdateStatus,
      enabled: config.load().autoUpdate !== false,
    });
    pushStatus();

    globalShortcut.register('CommandOrControl+Shift+L', () => lock('shortcut'));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) state.win = createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (event) => {
    if (!state.quitting && !state.locked && !state.locking && state.sync) {
      event.preventDefault();
      state.quitting = true;
      captureTabsIntoVault();
      state.sync
        .flush(FLUSH_TIMEOUT_MS)
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
        { type: 'separator' },
        // Ohne diese beiden Einträge gibt es in einem gebauten Nula keinerlei
        // Möglichkeit, an eine Fehlermeldung zu kommen.
        {
          label: 'Entwicklerwerkzeuge',
          accelerator: 'CmdOrCtrl+Shift+I',
          // Abgedockt, sonst liegen sie hinter der nativen Tab-Ansicht.
          click: () => state.win?.webContents.openDevTools({ mode: 'detach' }),
        },
        {
          label: 'Entwicklerwerkzeuge für die Seite',
          accelerator: 'CmdOrCtrl+Shift+J',
          click: () => state.tabs?.withActive((wc) => wc.openDevTools({ mode: 'detach' })),
        },
      ],
    },
  ]);
}
