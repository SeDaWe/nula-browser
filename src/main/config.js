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

const CONFIG_DIR = path.join(os.homedir(), '.nula');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  serverUrl: null,
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

module.exports = { load, save, ensureDeviceId, CONFIG_DIR };
