'use strict';

/*
 * Selbstaktualisierung über GitHub-Releases.
 *
 * Bewusst zurückhaltend gebaut, weil jede Abfrage die IP dieser Installation an
 * GitHub trägt: Sie lässt sich abschalten, die Einstellung liegt in der lokalen
 * config.json statt im Vault (sonst könnte im gesperrten Zustand gar nicht
 * geprüft werden), und es wird nichts installiert, ohne dass jemand darauf
 * klickt. Heruntergeladen wird dagegen automatisch, damit der Neustart später
 * nicht minutenlang wartet.
 *
 * macOS geht einen eigenen Weg. Squirrel.Mac prüft beim ANWENDEN die Signatur und
 * lehnt eine unsignierte App ab — das PRÜFEN läuft dagegen über die GitHub-API und
 * funktioniert dort genauso. Deshalb wird auf dem Mac nur gesucht und dann gezielt
 * zum Download geführt, statt eine Installation zu versprechen, die scheitern muss.
 * Sobald ein Apple-Developer-ID-Zertifikat in den Build einfließt, kann hier auf den
 * normalen Weg umgestellt werden.
 */

const { app, shell } = require('electron');

const IS_MAC = process.platform === 'darwin';
const RELEASES = 'https://github.com/SeDaWe/nula-browser/releases';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // alle sechs Stunden
const FIRST_CHECK_DELAY_MS = 10_000; // nicht in den Start hineinfunken

let autoUpdater = null;
let onStatus = () => {};
let timer = null;
let enabled = true;
let wired = false;

let status = { state: 'idle', version: null, detail: null, percent: 0, url: null };

function publish(next) {
  status = { ...status, ...next };
  onStatus(status);
}

/** electron-updater greift beim Laden auf app zu, deshalb erst hier verlangen. */
function load() {
  if (autoUpdater) return autoUpdater;
  ({ autoUpdater } = require('electron-updater'));
  // Auf dem Mac nichts herunterladen: der Download landete in Squirrel.Mac, und
  // das bricht mangels Signatur ab. Gesucht wird trotzdem.
  autoUpdater.autoDownload = !IS_MAC;
  // Installiert wird ausschließlich auf Knopfdruck, nie beim nächsten Beenden.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;
  return autoUpdater;
}

function wire() {
  if (wired) return;
  wired = true;
  const up = load();

  up.on('checking-for-update', () => publish({ state: 'checking', detail: null }));
  up.on('update-not-available', () => publish({ state: 'current', detail: null, percent: 0 }));
  up.on('update-available', (info) => {
    const version = info?.version || null;
    publish({
      state: IS_MAC ? 'manual' : 'downloading',
      version,
      detail: null,
      percent: 0,
      url: version ? `${RELEASES}/tag/v${version}` : RELEASES,
    });
  });
  up.on('download-progress', (p) =>
    publish({ state: 'downloading', percent: Math.round(p?.percent || 0) })
  );
  up.on('update-downloaded', (info) =>
    publish({ state: 'ready', version: info?.version || null, detail: null, percent: 100 })
  );
  up.on('error', (err) => {
    const message = String(err?.message || err);
    // Der häufigste Fall auf macOS, und er ist erklärungsbedürftig statt kryptisch.
    const signature = /code signature|not signed|Could not get code signature/i.test(message);
    publish({
      state: 'error',
      percent: 0,
      detail: signature
        ? 'Diese Version ist nicht signiert; macOS lässt ein automatisches Update daran nicht zu. Bitte von Hand herunterladen.'
        : message,
    });
  });
}

/** Ohne Paketierung gibt es keine Update-Metadaten, das ist kein Fehler. */
function unavailable() {
  return !app.isPackaged;
}

async function check({ manual = false } = {}) {
  if (unavailable()) {
    publish({ state: 'dev', detail: 'Im Entwicklungsmodus wird nicht nach Updates gesucht.' });
    return status;
  }
  if (!enabled && !manual) return status;

  try {
    // wire() stand frueher vor dem try. Warf es - etwa weil electron-updater
    // gar nicht im Paket liegt -, verschluckte das .catch() in start() den
    // Fehler, und der Status blieb fuer immer auf "noch nicht geprueft".
    wire();
    await load().checkForUpdates();
  } catch (err) {
    publish({ state: 'error', percent: 0, detail: String(err?.message || err) });
  }
  return status;
}

function schedule() {
  clearInterval(timer);
  timer = null;
  if (!enabled || unavailable()) return;
  timer = setInterval(() => {
    check().catch(() => {});
  }, CHECK_INTERVAL_MS);
}

/**
 * Startet die Update-Betreuung. Der erste Blick wartet ein paar Sekunden, damit
 * er sich nicht mit dem Fensteraufbau und dem ersten Sync überschneidet.
 */
function start({ onStatus: cb, enabled: on }) {
  onStatus = cb || (() => {});
  enabled = on !== false;

  if (unavailable()) {
    publish({ state: 'dev', detail: 'Im Entwicklungsmodus wird nicht nach Updates gesucht.' });
    return;
  }
  if (!enabled) {
    publish({ state: 'off', detail: null });
    return;
  }
  setTimeout(() => check().catch(() => {}), FIRST_CHECK_DELAY_MS).unref?.();
  schedule();
}

function setEnabled(on) {
  enabled = !!on;
  if (!enabled) {
    clearInterval(timer);
    timer = null;
    publish({ state: 'off', percent: 0, detail: null });
    return;
  }
  if (unavailable()) {
    publish({ state: 'dev', detail: 'Im Entwicklungsmodus wird nicht nach Updates gesucht.' });
    return;
  }
  publish({ state: 'idle', detail: null });
  schedule();
  check().catch(() => {});
}

/**
 * Ersetzt den laufenden Prozess durch den Installer. Der Aufrufer MUSS den Vault
 * vorher wegschreiben: quitAndInstall() geht am normalen Beenden-Pfad vorbei.
 */
function install() {
  if (status.state !== 'ready') throw new Error('Es ist kein Update bereit');
  load().quitAndInstall(false, true);
}

/** macOS: die Release-Seite der gefundenen Version im Standardbrowser öffnen. */
async function openDownload() {
  await shell.openExternal(status.url || RELEASES);
  return status;
}

function getStatus() {
  return status;
}

function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { start, check, install, openDownload, setEnabled, getStatus, stop };
