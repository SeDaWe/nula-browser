'use strict';

/*
 * Sync engine.
 * - Live sync: a debounced push a few seconds after any local change, plus a
 *   periodic pull so other devices show up.
 * - Flush on quit: a final blocking push before the window closes.
 * - Conflicts: the server rejects a stale baseVersion, we merge and retry.
 */

const { emptyVault, mergeVaults } = require('./vault');
const { encryptVault, decryptVault, unseal } = require('./vaultcrypto');

const PUSH_DEBOUNCE_MS = 2500;
const PUSH_RETRY_MS = 20000;
const PULL_INTERVAL_MS = 20000;
const MAX_RETRIES = 3;

class SyncEngine {
  constructor(api, keys, onStatus, onVaultChanged) {
    this.api = api;
    this.keys = keys;
    this.onStatus = onStatus || (() => {});
    this.onVaultChanged = onVaultChanged || (() => {});
    this.vault = emptyVault();
    this.version = -1;
    this.pushTimer = null;
    this.pullTimer = null;
    this.pushing = false;
    this.pushPromise = null;
    this.dirty = false;
    this.stopped = false;
  }

  status(state, detail) {
    this.onStatus({ state, detail: detail || null, at: new Date().toISOString() });
  }

  /** Initial load: pull the remote vault, or create an empty one if the server has none. */
  async start() {
    this.status('syncing', 'Vault wird geladen');
    const remote = await this.api.getVault(-1);
    this.version = remote.version;
    if (remote.blob) {
      try {
        this.vault = decryptVault(this.keys.encKey, remote.blob);
      } catch {
        throw new Error('Vault konnte nicht entschlüsselt werden. Falsches Passwort?');
      }
    } else {
      this.vault = emptyVault();
      this.dirty = true;
    }
    this.status('synced');
    this.pullTimer = setInterval(() => this.pull().catch(() => {}), PULL_INTERVAL_MS);
    if (this.dirty) this.schedulePush();
    return this.vault;
  }

  /** Mark the vault dirty and schedule a debounced push. */
  touch() {
    this.vault.updatedAt = new Date().toISOString();
    this.dirty = true;
    this.schedulePush();
  }

  schedulePush(delay = PUSH_DEBOUNCE_MS) {
    if (this.stopped) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.push().catch(() => {}), delay);
  }

  async pull() {
    if (this.stopped || this.pushing) return;
    const remote = await this.api.getVault(this.version);
    if (remote.unchanged) return;
    if (!remote.blob) return;
    let remoteVault;
    try {
      remoteVault = decryptVault(this.keys.encKey, remote.blob);
    } catch {
      this.status('error', 'Entschlüsselung fehlgeschlagen');
      return;
    }
    this.vault = mergeVaults(this.vault, remoteVault);
    this.version = remote.version;
    this.onVaultChanged(this.vault);
    this.status('synced');
  }

  async push() {
    if (this.stopped || !this.dirty) return;
    if (this.pushPromise) return this.pushPromise;
    this.pushing = true;
    this.pushPromise = this.runPush(0);
    try {
      return await this.pushPromise;
    } finally {
      this.pushPromise = null;
      this.pushing = false;
    }
  }

  async runPush(attempt) {
    this.status('syncing');
    try {
      const blob = encryptVault(this.keys.encKey, this.vault);
      const res = await this.api.putVault(this.version, blob);
      this.version = res.version;
      this.dirty = false;
      this.status('synced');
    } catch (err) {
      if (err.status === 409 && attempt < MAX_RETRIES) {
        // Someone else wrote first. Merge their state in and try again.
        try {
          const remoteVault = decryptVault(this.keys.encKey, err.payload.blob);
          this.vault = mergeVaults(this.vault, remoteVault);
          this.version = err.payload.version;
          this.onVaultChanged(this.vault);
        } catch {
          this.status('error', 'Konflikt konnte nicht aufgelöst werden');
          return;
        }
        return this.runPush(attempt + 1);
      }
      this.status('error', err.message);
      this.schedulePush(PUSH_RETRY_MS);
    }
  }

  /**
   * Blocking final push, used on quit and on lock. With a timeout the caller
   * stops waiting after that many milliseconds: an unreachable server must not
   * freeze the window on close. The push itself keeps running, it is only no
   * longer awaited, and this.dirty still tells the caller it did not land.
   */
  async flush(timeoutMs = 0) {
    clearTimeout(this.pushTimer);
    const work = (async () => {
      if (this.pushPromise) await this.pushPromise;
      if (!this.dirty) return;
      for (let i = 0; i < MAX_RETRIES && this.dirty; i++) {
        await this.push();
      }
    })();
    if (!timeoutMs) return work;

    let timer;
    try {
      await Promise.race([
        work.catch(() => {}),
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fold sealed inbox entries into the vault. Split out from drainInbox so a
   * backup import can replay the entries that were still pending when the
   * export was taken. Touches nothing but the vault: no server calls, no push.
   * Returns how many were applied and which ids may now be deleted, which
   * includes entries that were already in the vault.
   */
  async applyInboxEntries(entries) {
    const deletable = [];
    let applied = 0;
    if (!this.vault.identity) return { applied, deletable };
    const knownIds = new Set([
      ...(this.vault.bookmarks || []).map((item) => item.id),
      ...(this.vault.tabs || []).map((item) => item.id),
      ...(this.vault.notes || []).map((item) => item.id),
    ]);
    // A tombstone outranks the inbox. Without this an entry that was taken in
    // once and deleted afterwards comes straight back: on a live drain whose
    // server-side delete failed, and on a backup import, where the entries are
    // replayed after the merge and so never meet the merge's tombstone filter.
    const tombstoned = new Set((this.vault.tombstones || []).map((stone) => stone.id));
    for (const entry of entries) {
      let item;
      try {
        item = await unseal(this.keys, this.vault.identity, entry.sealed);
      } catch {
        continue; // not sealed to this identity, leave it where it is
      }
      if (!['bookmark', 'tab', 'note'].includes(item.type)) continue;
      if (knownIds.has(entry.id) || tombstoned.has(entry.id)) {
        deletable.push(entry.id);
        continue;
      }
      const now = new Date().toISOString();
      if (item.type === 'bookmark') {
        this.vault.bookmarks.push({
          id: entry.id,
          url: item.url,
          title: item.title || item.url,
          folder: item.source ? `via ${item.source}` : null,
          updatedAt: now,
        });
        applied++;
      } else if (item.type === 'tab') {
        this.vault.tabs.push({
          id: entry.id,
          url: item.url,
          title: item.title || item.url,
          deviceId: 'inbox',
          pinned: false,
          updatedAt: now,
        });
        applied++;
      } else {
        this.vault.notes = this.vault.notes || [];
        this.vault.notes.push({
          id: entry.id,
          title: item.title || null,
          text: item.text || '',
          source: item.source || null,
          updatedAt: now,
        });
        applied++;
      }
      knownIds.add(entry.id);
      deletable.push(entry.id);
    }
    return { applied, deletable };
  }

  /** Pull items pushed by external tools, fold them into the vault, then delete them. */
  async drainInbox() {
    if (!this.vault.identity) return 0;
    const { items } = await this.api.getInbox();
    if (!items.length) return 0;
    const { applied, deletable } = await this.applyInboxEntries(items);
    if (applied) {
      this.touch();
      this.onVaultChanged(this.vault);
    }
    // Only drop them on the server once the vault that holds them is safely up.
    if ((applied || this.dirty) && deletable.length) await this.flush();
    if (!this.dirty) {
      for (const id of deletable) await this.api.deleteInboxItem(id).catch(() => {});
    }
    return applied;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.pushTimer);
    clearInterval(this.pullTimer);
  }
}

module.exports = { SyncEngine };
