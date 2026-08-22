'use strict';

/*
 * Client-side cryptography.
 *
 * Mechanisms follow BSI TR-02102-1, version 2026-01:
 *   - Argon2id for password-based key derivation      (Section B.1.2)
 *   - HKDF-SHA256 for key derivation and hybridising  (Table B.1, Section 2.2)
 *   - AES-256-GCM with 96-bit IV and 128-bit tag      (Table 3.2, Section 3.1.2)
 *   - Hybrid key agreement X25519 + ML-KEM-1024       (Sections 2.1, 2.2, Table 2.7)
 *
 * Two notes on choices that are not obvious:
 *
 * 1. Every vault write derives a FRESH message key from a random 32-byte salt.
 *    TR-02102-1 requires a key change after at most 2^32 GCM invocations, and the
 *    vault key itself never changes while the password stays the same. Deriving
 *    per write means each key is used exactly once, so the limit cannot be
 *    reached and an IV collision cannot leak anything. AES-GCM-SIV would be the
 *    other documented answer, but Electron's BoringSSL does not expose it.
 *
 * 2. Argon2id runs in WebAssembly, because BoringSSL has no Argon2 either.
 *    The implementation is verified byte-for-byte against Node's native
 *    (OpenSSL) argon2id in the test suite.
 */

const crypto = require('node:crypto');
const { argon2id } = require('hash-wasm');

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/*
 * Argon2id parameters. 256 MiB with 3 passes costs roughly one second on a
 * current desktop, which is the right order of magnitude for an interactive
 * unlock and far above the usual minimums. TR-02102-1 deliberately gives no
 * fixed numbers here, so they are stored on the server and can be raised later
 * without breaking older clients.
 */
const ARGON2_DEFAULTS = { memoryKiB: 256 * 1024, passes: 3, parallelism: 1 };

const VAULT_FORMAT = 2;
const MLKEM_PUBLIC_BYTES = 1568;

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function normaliseArgon2(params) {
  const p = { ...ARGON2_DEFAULTS, ...(params || {}) };
  if (!Number.isInteger(p.memoryKiB) || p.memoryKiB < 8 * 1024) throw new Error('Argon2: memoryKiB zu klein');
  if (!Number.isInteger(p.passes) || p.passes < 1) throw new Error('Argon2: passes ungueltig');
  if (!Number.isInteger(p.parallelism) || p.parallelism < 1) throw new Error('Argon2: parallelism ungueltig');
  return p;
}

/**
 * Derive every client secret from the master password.
 * The ML-KEM key pair is NOT derived here: Node cannot generate ML-KEM keys
 * deterministically from a seed, so that key lives inside the encrypted vault.
 */
async function deriveKeys(password, clientSaltHex, argon2Params) {
  const params = normaliseArgon2(argon2Params);
  const salt = Buffer.from(clientSaltHex, 'hex');

  const master = Buffer.from(
    await argon2id({
      password: password.normalize('NFKC'),
      salt,
      parallelism: params.parallelism,
      memorySize: params.memoryKiB,
      iterations: params.passes,
      hashLength: 32,
      outputType: 'binary',
    })
  );

  const authKey = Buffer.from(crypto.hkdfSync('sha256', master, salt, 'nula-auth-v2', 32));
  const encKey = Buffer.from(crypto.hkdfSync('sha256', master, salt, 'nula-enc-v2', 32));
  const xSeed = Buffer.from(crypto.hkdfSync('sha256', master, salt, 'nula-x25519-v2', 32));

  const x25519Priv = crypto.createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, xSeed]),
    format: 'der',
    type: 'pkcs8',
  });
  const x25519PubHex = crypto
    .createPublicKey(x25519Priv)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('hex');

  master.fill(0);
  xSeed.fill(0);

  return { authKeyHex: authKey.toString('hex'), encKey, x25519Priv, x25519PubHex, argon2: params };
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

function encryptVault(encKey, obj) {
  const fileSalt = crypto.randomBytes(32);
  const msgKey = Buffer.from(crypto.hkdfSync('sha256', encKey, fileSalt, 'nula-vault-v2', 32));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', msgKey, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  msgKey.fill(0);
  return Buffer.concat([Buffer.from([VAULT_FORMAT]), fileSalt, iv, cipher.getAuthTag(), ct]).toString('base64');
}

function decryptVault(encKey, blobB64) {
  const raw = Buffer.from(blobB64, 'base64');
  if (raw.length < 61) throw new Error('Vault-Blob ist zu kurz');
  if (raw[0] !== VAULT_FORMAT) throw new Error('Unbekanntes Vault-Format (' + raw[0] + ')');
  const fileSalt = raw.subarray(1, 33);
  const iv = raw.subarray(33, 45);
  const tag = raw.subarray(45, 61);
  const ct = raw.subarray(61);
  const msgKey = Buffer.from(crypto.hkdfSync('sha256', encKey, fileSalt, 'nula-vault-v2', 32));
  const decipher = crypto.createDecipheriv('aes-256-gcm', msgKey, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  msgKey.fill(0);
  return JSON.parse(plain.toString('utf8'));
}

// ---------------------------------------------------------------------------
// Inbox identity: X25519 comes from the password, ML-KEM lives in the vault
// ---------------------------------------------------------------------------

/** Create the ML-KEM half of the inbox identity. Called once per account. */
function createKemIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ml-kem-1024');
  return {
    kemPublic: publicKey
      .export({ format: 'der', type: 'spki' })
      .subarray(-MLKEM_PUBLIC_BYTES)
      .toString('base64'),
    kemPrivate: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    createdAt: new Date().toISOString(),
  };
}

function kemPrivateKeyFrom(identity) {
  return crypto.createPrivateKey({
    key: Buffer.from(identity.kemPrivate, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
}

/*
 * Hybridisation in the shape TR-02102-1 Section 2.2 asks for: concatenate both
 * shared secrets and bind the full public context into the derivation, so the
 * result stays secure as long as either X25519 or ML-KEM is unbroken.
 * seal() in nula-server/server.js computes exactly this; the two must stay in step.
 */
function combineSecrets(ssPq, ssClassic, ephPub, recipientXPub, kemCt, recipientKemPub) {
  const ikm = Buffer.concat([ssPq, ssClassic]);
  // HKDF caps info at 1024 bytes and the raw context is over 3 KB, so bind a
  // collision-resistant digest of it instead. Same binding, legal length.
  const context = crypto
    .createHash('sha256')
    .update(ephPub)
    .update(recipientXPub)
    .update(kemCt)
    .update(recipientKemPub)
    .digest();
  const info = Buffer.concat([Buffer.from('nula-inbox-v2', 'utf8'), context]);
  const key = Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32));
  ikm.fill(0);
  return key;
}

/** Open an item the server sealed to this account. */
async function unseal(keys, identity, sealed) {
  if (sealed.v !== 2) throw new Error('Unbekanntes Inbox-Format (' + sealed.v + ')');

  const ephRaw = Buffer.from(sealed.epk, 'base64');
  const ephPub = crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, ephRaw]),
    format: 'der',
    type: 'spki',
  });
  const ssClassic = crypto.diffieHellman({ privateKey: keys.x25519Priv, publicKey: ephPub });

  const kemCt = Buffer.from(sealed.kemCt, 'base64');
  const ssPq = await new Promise((resolve, reject) => {
    crypto.decapsulate(kemPrivateKeyFrom(identity), kemCt, (err, out) =>
      err ? reject(err) : resolve(Buffer.from(out.sharedKey ?? out))
    );
  });

  const key = combineSecrets(
    ssPq,
    ssClassic,
    ephRaw,
    Buffer.from(keys.x25519PubHex, 'hex'),
    kemCt,
    Buffer.from(identity.kemPublic, 'base64')
  );

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]);
  key.fill(0);
  return JSON.parse(plain.toString('utf8'));
}

/** Best-effort key wipe when locking. */
function wipeKeys(keys) {
  if (keys?.encKey) keys.encKey.fill(0);
  // KeyObjects and strings cannot be zeroed in place; dropping references is the
  // best JS can do. The mitigation is that Nula never writes them to disk.
}

module.exports = {
  generateSalt,
  deriveKeys,
  encryptVault,
  decryptVault,
  createKemIdentity,
  kemPrivateKeyFrom,
  unseal,
  combineSecrets,
  wipeKeys,
  ARGON2_DEFAULTS,
  VAULT_FORMAT,
  MLKEM_PUBLIC_BYTES,
};
