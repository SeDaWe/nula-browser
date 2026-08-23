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
      searchEngine: 'google',
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
 * Every merge unions two tombstone lists, so without this the count is
 * |local| + |remote| each time and grows without bound: two devices that both
 * sync keep re-appending their own copy to the other's. One deleted bookmark
 * reaches five figures within a dozen rounds, the vault blob crosses the
 * server's 8 MB limit, and the resulting 413 leaves the device permanently
 * unable to push. Merging is not idempotent unless this runs.
 */
function dedupeTombstones(tombstones) {
  const newest = new Map();
  for (const stone of tombstones || []) {
    if (!stone || typeof stone.id !== 'string') continue;
    const seen = newest.get(stone.id);
    if (!seen || String(stone.deletedAt) > String(seen.deletedAt)) newest.set(stone.id, stone);
  }
  return [...newest.values()];
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

  const tombstones = pruneTombstones(dedupeTombstones([...(local.tombstones || []), ...(remote.tombstones || [])]));
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

/*
 * A backup is authenticated as a whole but not structurally validated, so coerce
 * it into the shape mergeVaults() expects. A hand-edited file then cannot throw
 * halfway through a merge and leave the running vault torn. updatedAt is pinned
 * to the epoch on purpose: which settings survive is decided explicitly in
 * mergeBackupVault(), never by whichever side carries the newer timestamp.
 */
function importableVault(value) {
  const source = value && typeof value === 'object' ? value : {};
  // mergeList compares timestamps with >, and NaN makes that false, so an item
  // with a missing or unparseable updatedAt would win every comparison and
  // silently overwrite a newer local entry. Pinning it to the epoch means it is
  // only taken when nothing local carries that id.
  const stamp = (candidate) => {
    // Date.parse() coerces to string, which a JSON object with a non-callable
    // toString would make throw. Anything that is not already a string or a
    // number cannot be a timestamp anyway.
    if (typeof candidate !== 'string' && typeof candidate !== 'number') {
      return new Date(0).toISOString();
    }
    const parsed = Date.parse(candidate);
    return Number.isNaN(parsed) ? new Date(0).toISOString() : new Date(parsed).toISOString();
  };
  const list = (candidate) =>
    Array.isArray(candidate)
      ? candidate
          .filter((item) => item && typeof item === 'object' && typeof item.id === 'string')
          .map((item) => ({ ...item, updatedAt: stamp(item.updatedAt) }))
      : [];
  return {
    schema: 1,
    identity: source.identity && typeof source.identity === 'object' ? source.identity : null,
    // The device panel groups remote tabs by deviceId and slices that string, so
    // a tab without one would throw there on every single vault push.
    tabs: list(source.tabs).map((tab) => ({
      ...tab,
      deviceId: typeof tab.deviceId === 'string' && tab.deviceId ? tab.deviceId : 'backup',
    })),
    bookmarks: list(source.bookmarks),
    notes: list(source.notes),
    settings: source.settings && typeof source.settings === 'object' ? source.settings : {},
    tombstones: Array.isArray(source.tombstones)
      ? source.tombstones.filter((stone) => stone && typeof stone.id === 'string')
      : [],
    updatedAt: new Date(0).toISOString(),
  };
}

/**
 * Fold a vault that came out of an encrypted backup into the running one.
 *
 * Merging rather than replacing is what makes an import safe to repeat and keeps
 * local deletions deleted, because tombstones beat any incoming item regardless
 * of its timestamp -- for as long as the tombstone exists. mergeVaults prunes
 * them after 30 days, so a backup older than that can bring back items that were
 * deleted long ago. Three things the generic merge would get wrong here:
 *
 *   - pickIdentity() prefers the OLDER createdAt, so a stale backup would roll
 *     the inbox keys back and make everything sealed since then undecryptable.
 *     A running identity therefore always wins.
 *   - tabs the backup recorded for THIS device would be wiped again by the next
 *     captureTabsIntoVault(), which owns this device's slice outright. They are
 *     filed under a device of their own so they stay reachable under "Geräte",
 *     the same trick inbox tabs already use.
 *   - settings are an explicit choice, not a timestamp race.
 */
function mergeBackupVault(current, incoming, { deviceId = null, withSettings = false } = {}) {
  const staged = importableVault(incoming);
  staged.tabs = staged.tabs.map((tab) =>
    deviceId && tab.deviceId === deviceId ? { ...tab, deviceId: 'backup' } : tab
  );

  const merged = mergeVaults(current, staged);
  merged.identity = current.identity || merged.identity;
  merged.settings = withSettings
    ? { ...emptyVault().settings, ...staged.settings }
    : { ...current.settings };
  return merged;
}

module.exports = {
  emptyVault,
  newId,
  mergeVaults,
  mergeBackupVault,
  importableVault,
  dedupeTombstones,
  pruneTombstones,
  pickIdentity,
};
