'use strict';

/*
 * Portable encrypted exports.
 *
 * The backup key is derived from the in-memory vault key with a fresh salt and
 * a dedicated HKDF context. This keeps backup encryption separate from normal
 * vault writes even though both ultimately come from the master password.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BACKUP_FORMAT = 'nula-encrypted-backup';
const PAYLOAD_FORMAT = 'nula-backup-payload';
const BACKUP_VERSION = 1;
const BLOB_VERSION = 1;
const MAX_BACKUP_BYTES = 32 * 1024 * 1024;
const AAD = Buffer.from(`${BACKUP_FORMAT}:v${BACKUP_VERSION}`, 'utf8');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCanonicalBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value;
}

function validateKey(encKey) {
  if (!Buffer.isBuffer(encKey) || encKey.length !== 32) {
    throw new Error('Backup-Schlüssel ist ungültig');
  }
}

function validateKdf(kdf) {
  if (
    !isObject(kdf) ||
    kdf.algorithm !== 'argon2id' ||
    typeof kdf.clientSalt !== 'string' ||
    !/^[0-9a-f]{32}$/.test(kdf.clientSalt) ||
    !Number.isInteger(kdf.memoryKiB) ||
    kdf.memoryKiB < 8 * 1024 ||
    kdf.memoryKiB > 1024 * 1024 ||
    !Number.isInteger(kdf.passes) ||
    kdf.passes < 1 ||
    kdf.passes > 10 ||
    !Number.isInteger(kdf.parallelism) ||
    kdf.parallelism < 1 ||
    kdf.parallelism > 16
  ) {
    throw new Error('Backup enthält ungültige Argon2id-Parameter');
  }
}

function deriveBackupKey(encKey, salt) {
  return Buffer.from(crypto.hkdfSync('sha256', encKey, salt, 'nula-backup-v1', 32));
}

function encryptPayload(encKey, payload) {
  validateKey(encKey);
  if (!isObject(payload)) throw new Error('Backup-Nutzdaten fehlen');

  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  if (plain.length > MAX_BACKUP_BYTES) {
    plain.fill(0);
    throw new Error('Backup ist größer als 32 MiB');
  }

  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const key = deriveBackupKey(encKey, salt);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([
      Buffer.from([BLOB_VERSION]),
      salt,
      iv,
      cipher.getAuthTag(),
      ciphertext,
    ]).toString('base64');
  } finally {
    key.fill(0);
    plain.fill(0);
  }
}

function parseBackup(document) {
  let value = document;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_BACKUP_BYTES * 2) {
      throw new Error('Backup-Datei ist zu groß');
    }
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error('Backup-Datei enthält kein gültiges JSON');
    }
  }
  if (
    !isObject(value) ||
    value.format !== BACKUP_FORMAT ||
    value.version !== BACKUP_VERSION ||
    typeof value.exportedAt !== 'string' ||
    Number.isNaN(Date.parse(value.exportedAt)) ||
    !isObject(value.encryption) ||
    value.encryption.algorithm !== 'AES-256-GCM+HKDF-SHA256' ||
    !isCanonicalBase64(value.encryption.blob)
  ) {
    throw new Error('Unbekanntes oder beschädigtes Nula-Backup');
  }
  validateKdf(value.kdf);
  const raw = Buffer.from(value.encryption.blob, 'base64');
  if (raw.length < 62 || raw.length > MAX_BACKUP_BYTES + 61 || raw[0] !== BLOB_VERSION) {
    throw new Error('Backup-Chiffrat ist ungültig');
  }
  return value;
}

function decryptBackup(encKey, document) {
  validateKey(encKey);
  const backup = parseBackup(document);
  const raw = Buffer.from(backup.encryption.blob, 'base64');
  const salt = raw.subarray(1, 33);
  const iv = raw.subarray(33, 45);
  const tag = raw.subarray(45, 61);
  const ciphertext = raw.subarray(61);
  const key = deriveBackupKey(encKey, salt);
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = JSON.parse(plain.toString('utf8'));
    if (
      !isObject(payload) ||
      payload.format !== PAYLOAD_FORMAT ||
      payload.version !== BACKUP_VERSION ||
      !isObject(payload.vault) ||
      !isObject(payload.localConfig)
    ) {
      throw new Error('Backup-Nutzdaten sind unvollständig');
    }
    return payload;
  } catch (err) {
    if (err.message === 'Backup-Nutzdaten sind unvollständig') throw err;
    throw new Error('Backup konnte nicht entschlüsselt oder verifiziert werden');
  } finally {
    key.fill(0);
    if (plain) plain.fill(0);
  }
}

function createBackup({ encKey, clientSalt, argon2, payload, exportedAt = new Date().toISOString() }) {
  validateKdf({
    algorithm: 'argon2id',
    clientSalt,
    memoryKiB: argon2?.memoryKiB,
    passes: argon2?.passes,
    parallelism: argon2?.parallelism,
  });
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    kdf: {
      algorithm: 'argon2id',
      clientSalt,
      memoryKiB: argon2.memoryKiB,
      passes: argon2.passes,
      parallelism: argon2.parallelism,
    },
    encryption: {
      algorithm: 'AES-256-GCM+HKDF-SHA256',
      blob: encryptPayload(encKey, payload),
    },
  };
}

function writeBackupFile(filePath, document) {
  const backup = parseBackup(document);
  const target = path.resolve(filePath);
  const dir = path.dirname(target);
  const base = path.basename(target);
  const tmp = path.join(dir, `.${base}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const data = JSON.stringify(backup, null, 2) + '\n';
  let fd;
  try {
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
      throw new Error('Backup-Ziel darf kein symbolischer Link sein');
    }
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      /* Windows and some removable filesystems do not expose POSIX modes. */
    }
    return target;
  } catch (err) {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

module.exports = {
  createBackup,
  decryptBackup,
  parseBackup,
  writeBackupFile,
  BACKUP_FORMAT,
  PAYLOAD_FORMAT,
  BACKUP_VERSION,
  MAX_BACKUP_BYTES,
};
