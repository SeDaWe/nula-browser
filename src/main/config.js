'use strict';

/*
 * Local config. This is the ONLY file Nula persists on disk, and it deliberately
 * contains no browsing data: just the sync server URL and a device identity.
 * Everything else lives in RAM or in the encrypted vault on the server.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// NULA_CONFIG_DIR keeps the tests away from the real home directory and lets a
// portable install put its config next to the executable.
const CONFIG_DIR = process.env.NULA_CONFIG_DIR || path.join(os.homedir(), '.nula');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  serverUrl: null,
  // Whether the server address may be kept on disk at all. The choice itself is
  // stored so the lock screen can show the checkbox in the right state; the
  // address is only written when this is true.
  rememberServerUrl: true,
  deviceId: null,
  deviceName: os.hostname(),
};

let cache = null;

function load() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    stored = {};
  }
  cache = { ...DEFAULTS, ...stored };
  return cache;
}

function save(patch) {
  cache = { ...load(), ...patch };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cache, null, 2));
  return cache;
}

function ensureDeviceId() {
  const cfg = load();
  if (!cfg.deviceId) {
    save({ deviceId: crypto.randomBytes(8).toString('hex') });
  }
  return load().deviceId;
}

/** Drop the in-memory copy. Only used by the tests. */
function reset() {
  cache = null;
}

module.exports = { load, save, ensureDeviceId, reset, CONFIG_DIR, CONFIG_FILE };
