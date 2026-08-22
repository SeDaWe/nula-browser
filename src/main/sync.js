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

  schedulePush() {
    if (this.stopped) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.push().catch(() => {}), PUSH_DEBOUNCE_MS);
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

  async push(attempt = 0) {
    if (this.stopped || !this.dirty || this.pushing) return;
    this.pushing = true;
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
          this.pushing = false;
          return;
        }
        this.pushing = false;
        return this.push(attempt + 1);
      }
      this.status('error', err.message);
    } finally {
      this.pushing = false;
    }
  }

  /** Blocking final push, used on quit and on lock. */
  async flush() {
    clearTimeout(this.pushTimer);
    if (!this.dirty) return;
    for (let i = 0; i < MAX_RETRIES && this.dirty; i++) {
      this.pushing = false;
      await this.push();
    }
  }

  /** Pull items pushed by external tools, fold them into the vault, then delete them. */
  async drainInbox() {
    if (!this.vault.identity) return 0;
    const { items } = await this.api.getInbox();
    if (!items.length) return 0;
    const { newId } = require('./vault');
    let applied = 0;
    for (const entry of items) {
      let item;
      try {
        item = await unseal(this.keys, this.vault.identity, entry.sealed);
      } catch {
        continue; // not sealed to this identity, leave it where it is
      }
      const now = new Date().toISOString();
      if (item.type === 'bookmark') {
        this.vault.bookmarks.push({
          id: newId(),
          url: item.url,
          title: item.title || item.url,
          folder: item.source ? `via ${item.source}` : null,
          updatedAt: now,
        });
        applied++;
      } else if (item.type === 'tab') {
        this.vault.tabs.push({
          id: newId(),
          url: item.url,
          title: item.title || item.url,
          deviceId: 'inbox',
          pinned: false,
          updatedAt: now,
        });
        applied++;
      }
      await this.api.deleteInboxItem(entry.id).catch(() => {});
    }
    if (applied) {
      this.touch();
      this.onVaultChanged(this.vault);
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
