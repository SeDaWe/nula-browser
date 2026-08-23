'use strict';

/*
 * The vault is the entire synced state: tabs, bookmarks, settings.
 * It lives in RAM here and is encrypted before it touches the network or an
 * explicitly selected backup file.
 *
 * Merge strategy: last-write-wins per entity, driven by an `updatedAt` timestamp
 * and a tombstone list for deletions. Good enough for a single user across a
 * handful of devices, and it never silently loses a bookmark.
 */

const crypto = require('node:crypto');

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function emptyVault() {
  return {
    schema: 1,
    tabs: [],       // { id, url, title, deviceId, updatedAt, pinned }
    bookmarks: [],  // { id, url, title, folder, updatedAt }
    notes: [],      // { id, title, text, source, updatedAt }
    settings: {
      searchEngine: 'duckduckgo',
      homepage: null,
      autoLockMinutes: 15,
      blockTrackers: true,
      theme: 'dark',
      clearOnQuit: true,
      dohEnabled: true,
    },
    tombstones: [], // { id, deletedAt }
    // ML-KEM half of the inbox identity. Node cannot derive ML-KEM keys from a
    // seed, so unlike the X25519 half it cannot come from the password and has
    // to travel inside the encrypted vault instead.
    identity: null, // { kemPublic, kemPrivate, createdAt }
    updatedAt: new Date().toISOString(),
  };
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function indexBy(list) {
  const map = new Map();
  for (const item of list) map.set(item.id, item);
  return map;
}

function pruneTombstones(tombstones) {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  return tombstones.filter((t) => new Date(t.deletedAt).getTime() > cutoff);
}

/*
 * The inbox identity is write-once. If two devices both generated one before
 * either had synced, the older wins so every device converges on the same key;
 * items sealed to the loser are unreadable, which is why the browser pushes a
 * freshly created identity immediately.
 */
function pickIdentity(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(a.createdAt) <= new Date(b.createdAt) ? a : b;
}

function mergeList(localList, remoteList, tombstoneIds) {
  const merged = indexBy(remoteList);
  for (const item of localList) {
    const existing = merged.get(item.id);
    if (!existing || new Date(item.updatedAt) > new Date(existing.updatedAt)) {
      merged.set(item.id, item);
    }
  }
  return [...merged.values()].filter((item) => !tombstoneIds.has(item.id));
}

/**
 * Three-way-ish merge of two vault snapshots. Tabs are merged per device: each
 * device owns its own tab list, so two machines never fight over the same tabs
 * while still seeing each other's.
 */
function mergeVaults(local, remote) {
  if (!remote) return local;
  if (!local) return remote;

  const tombstones = pruneTombstones([...(local.tombstones || []), ...(remote.tombstones || [])]);
  const tombstoneIds = new Set(tombstones.map((t) => t.id));

  const localNewer = new Date(local.updatedAt) >= new Date(remote.updatedAt);

  return {
    schema: 1,
    identity: pickIdentity(local.identity, remote.identity),
    tabs: mergeList(local.tabs || [], remote.tabs || [], tombstoneIds),
    bookmarks: mergeList(local.bookmarks || [], remote.bookmarks || [], tombstoneIds),
    notes: mergeList(local.notes || [], remote.notes || [], tombstoneIds),
    settings: { ...emptyVault().settings, ...(localNewer ? remote.settings : local.settings), ...(localNewer ? local.settings : remote.settings) },
    tombstones,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { emptyVault, newId, mergeVaults, pruneTombstones, pickIdentity };
