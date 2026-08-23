'use strict';

/*
 * Integration test for the Electron-specific parts that the pure-Node test
 * cannot reach: the in-memory session, the nula:// protocol handler, the tab
 * manager and the tracker blocker.
 *
 *   npx electron tools/integration.js [https://example.com]
 *
 * It also proves the disk claim: after browsing, nothing readable is written
 * into the run profile directory.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const RUN_PROFILE = path.join(os.tmpdir(), `nula-itest-${crypto.randomBytes(5).toString('hex')}`);
fs.mkdirSync(RUN_PROFILE, { recursive: true });

const { app, BrowserWindow, session, protocol, net } = require('electron');
app.setPath('userData', RUN_PROFILE);
app.setPath('sessionData', RUN_PROFILE);

const blocker = require('../src/main/blocker');
const { TabManager } = require('../src/main/tabs');
const { newId } = require('../src/main/vault');
const { resolveInput, isSafeNavigationUrl } = require('../src/main/urls');

const TARGET = process.argv.find((a) => a.startsWith('http')) || 'https://example.com';

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

protocol.registerSchemesAsPrivileged([
  { scheme: 'nula', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

app.whenReady().then(async () => {
  console.log('\nNula Electron-Integrationstest\n');

  // --- session -------------------------------------------------------------
  console.log('Sitzung');
  const ses = session.fromPartition('nula-ephemeral');
  check('Sitzung ist nicht persistent', !ses.isPersistent());

  const stats = blocker.attach(ses, () => true);
  check('Blocker angehängt', typeof stats.blocked === 'number');
  check('Tracker-Host wird erkannt', blocker.hostMatches('www.google-analytics.com'));
  check('Subdomain eines Trackers wird erkannt', blocker.hostMatches('cdn.doubleclick.net'));
  check('Normaler Host wird durchgelassen', !blocker.hostMatches('developer.mozilla.org'));
  check('Kein False-Positive bei ähnlichem Namen', !blocker.hostMatches('notdoubleclick.example.com'));
  check('file:// wird als Suchtext behandelt',
    resolveInput('file:///etc/passwd', {}).startsWith('https://duckduckgo.com/'));
  check('javascript:// wird nicht als Navigation akzeptiert',
    !isSafeNavigationUrl('javascript://alert(1)'));

  ses.protocol.handle('nula', (request) => {
    const url = new URL(request.url);
    const page = (url.hostname || 'newtab').replace(/[^a-z0-9-]/gi, '');
    const file = path.join(__dirname, '..', 'src', 'pages', `${page}.html`);
    if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
    return net.fetch('file://' + file.replace(/\\/g, '/'));
  });

  // --- window and tabs -----------------------------------------------------
  console.log('\nTabs');
  const win = new BrowserWindow({ width: 1280, height: 800, show: true, backgroundColor: '#0a0b0d' });

  let lastState = null;
  const tabs = new TabManager(win, ses, (s) => (lastState = s));

  const idA = newId();
  tabs.create(idA, 'nula://newtab');
  check('Tab angelegt', tabs.tabs.size === 1);
  check('Tab ist aktiv', tabs.activeId === idA);
  check('Status wird gemeldet', lastState?.tabs?.length === 1);

  await pause(1500);
  const newtabTitle = await tabs.tabs.get(idA).view.webContents.executeJavaScript('document.title');
  check('nula://newtab wird ausgeliefert', newtabTitle === 'Neuer Tab', newtabTitle);

  const idB = newId();
  tabs.create(idB, TARGET);
  check('Zweiter Tab angelegt', tabs.tabs.size === 2);
  check('Zweiter Tab ist aktiv', tabs.activeId === idB);

  await pause(4000);
  const wcB = tabs.tabs.get(idB).view.webContents;
  const loadedUrl = wcB.getURL();
  check('Externe Seite geladen', loadedUrl.startsWith('http'), loadedUrl);
  const bodyLen = await wcB.executeJavaScript('document.body.innerText.length').catch(() => 0);
  check('Seite hat Inhalt gerendert', bodyLen > 0, `innerText: ${bodyLen} Zeichen`);

  // --- bounds --------------------------------------------------------------
  console.log('\nLayout');
  const active = tabs.tabs.get(tabs.activeId).view.getBounds();
  check('Aktiver Tab liegt unter der Chrome-Leiste', active.y === 88 && active.height > 0,
    JSON.stringify(active));
  const inactive = tabs.tabs.get(idA).view.getBounds();
  check('Inaktiver Tab ist auf null gesetzt', inactive.width === 0 && inactive.height === 0);

  tabs.setVisible(false);
  check('Beim Sperren wird auch der aktive Tab verborgen',
    tabs.tabs.get(tabs.activeId).view.getBounds().width === 0);
  tabs.setVisible(true);

  // --- closing -------------------------------------------------------------
  console.log('\nSchließen');
  tabs.close(idB);
  check('Tab geschlossen', tabs.tabs.size === 1);
  check('Fokus fällt auf den verbleibenden Tab', tabs.activeId === idA);

  tabs.closeAll();
  check('Alle Tabs geschlossen', tabs.tabs.size === 0 && tabs.order.length === 0);

  // --- disk hygiene --------------------------------------------------------
  console.log('\nSpuren auf der Platte');
  await ses.clearStorageData();
  await ses.clearCache();
  await pause(600);

  const host = new URL(TARGET).hostname;
  const hits = [];
  walk(RUN_PROFILE, (file) => {
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch {
      return;
    }
    if (buf.includes(Buffer.from(host, 'utf8')) || buf.includes(Buffer.from(host, 'utf16le'))) {
      hits.push(path.relative(RUN_PROFILE, file));
    }
  });
  check(`Besuchte Domain steht in keiner Profildatei (${host})`, hits.length === 0, hits.join(', '));

  const cookieFiles = [];
  walk(RUN_PROFILE, (file) => {
    if (/^Cookies$/i.test(path.basename(file))) cookieFiles.push(path.relative(RUN_PROFILE, file));
  });
  check('Keine Cookie-Datenbank angelegt', cookieFiles.length === 0, cookieFiles.join(', '));

  const cookies = await ses.cookies.get({});
  check('Sitzung hält nach dem Leeren keine Cookies', cookies.length === 0, `${cookies.length} übrig`);

  // --- crypto inside Electron ----------------------------------------------
  // Electron ships BoringSSL, which lacks Argon2 and AES-GCM-SIV. Everything the
  // crypto design depends on has to be proven available HERE, not just in Node.
  console.log('\nKryptographie unter Electron');
  const vc = require('../src/main/vaultcrypto');
  const cryptoMod = require('node:crypto');

  const salt = vc.generateSalt();
  const tA = Date.now();
  const keys = await vc.deriveKeys('ein-test-passwort', salt, { memoryKiB: 32 * 1024, passes: 2, parallelism: 1 });
  check('Argon2id laeuft unter Electron (WASM)', /^[0-9a-f]{64}$/.test(keys.authKeyHex), `${Date.now() - tA} ms`);

  const keysAgain = await vc.deriveKeys('ein-test-passwort', salt, { memoryKiB: 32 * 1024, passes: 2, parallelism: 1 });
  check('Ableitung ist deterministisch', keysAgain.authKeyHex === keys.authKeyHex);
  check('X25519 wird aus dem Passwort abgeleitet', keysAgain.x25519PubHex === keys.x25519PubHex);

  const sample = { hello: 'welt', n: 42 };
  const enc = vc.encryptVault(keys.encKey, sample);
  check('Vault-Verschluesselung laeuft unter Electron', vc.decryptVault(keys.encKey, enc).hello === 'welt');

  const identity = vc.createKemIdentity();
  check('ML-KEM-1024 laeuft unter Electron',
    Buffer.from(identity.kemPublic, 'base64').length === vc.MLKEM_PUBLIC_BYTES);

  // Seal locally exactly as the server does, then open it through unseal().
  const kemPub = cryptoMod.createPublicKey({
    key: Buffer.concat([
      cryptoMod.generateKeyPairSync('ml-kem-1024').publicKey
        .export({ format: 'der', type: 'spki' })
        .subarray(0, -vc.MLKEM_PUBLIC_BYTES),
      Buffer.from(identity.kemPublic, 'base64'),
    ]),
    format: 'der', type: 'spki',
  });
  const encaps = await new Promise((res, rej) =>
    cryptoMod.encapsulate(kemPub, (e, v) => (e ? rej(e) : res(v))));
  const eph = cryptoMod.generateKeyPairSync('x25519');
  const ephRaw = eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const ssClassic = cryptoMod.diffieHellman({
    privateKey: eph.privateKey,
    publicKey: cryptoMod.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(keys.x25519PubHex, 'hex')]),
      format: 'der', type: 'spki',
    }),
  });
  const kemCt = Buffer.from(encaps.ciphertext);
  const combined = vc.combineSecrets(
    Buffer.from(encaps.sharedKey), ssClassic, ephRaw,
    Buffer.from(keys.x25519PubHex, 'hex'), kemCt, Buffer.from(identity.kemPublic, 'base64'));
  const iv = cryptoMod.randomBytes(12);
  const cipher = cryptoMod.createCipheriv('aes-256-gcm', combined, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify({ type: 'note', text: 'geheim' })), cipher.final()]);
  const opened = await vc.unseal(keys, identity, {
    v: 2, epk: ephRaw.toString('base64'), kemCt: kemCt.toString('base64'),
    iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
  });
  check('Hybride Versiegelung laesst sich unter Electron oeffnen', opened.text === 'geheim');

  // --- optional server URL --------------------------------------------------
  console.log('\nGemerkte Server-Adresse');
  const cfgDir = path.join(os.tmpdir(), `nula-cfg-${crypto.randomBytes(4).toString('hex')}`);
  process.env.NULA_CONFIG_DIR = cfgDir;
  const config = require('../src/main/config');

  check('Voreinstellung merkt die Adresse', config.load().rememberServerUrl === true);
  check('Ohne Zutun ist keine Adresse gespeichert', config.load().serverUrl === null);

  config.save({ serverUrl: 'https://sync.example.com', rememberServerUrl: true });
  config.reset();
  check('Mit Haken landet die Adresse in der Konfiguration',
    config.load().serverUrl === 'https://sync.example.com');

  config.save({ serverUrl: null, rememberServerUrl: false });
  config.reset();
  check('Ohne Haken wird sie entfernt', config.load().serverUrl === null);
  check('Die Wahl selbst bleibt erhalten', config.load().rememberServerUrl === false);
  check('Sie steht auch nicht mehr in der Datei',
    !fs.readFileSync(config.CONFIG_FILE, 'utf8').includes('sync.example.com'));

  config.ensureDeviceId();
  const keptId = config.load().deviceId;
  config.save({ serverUrl: null, rememberServerUrl: false });
  config.reset();
  check('Die Geraete-ID ueberlebt das Abwaehlen', config.load().deviceId === keptId);

  fs.rmSync(cfgDir, { recursive: true, force: true });
  delete process.env.NULA_CONFIG_DIR;

  // --- detached cleaner ----------------------------------------------------
  // Chromium holds handles into the profile until well after quit, so the
  // cleaner has to survive the app. Verify it actually removes a locked tree.
  console.log('\nAufräumen');
  const { spawnSync } = require('node:child_process');
  const probe = path.join(os.tmpdir(), `nula-cleanprobe-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(path.join(probe, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(probe, 'nested', 'file.bin'), Buffer.alloc(1024));

  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'main', 'cleanup.js'), probe], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 20000,
  });
  check('Cleaner läuft ohne Fehler durch', result.status === 0, String(result.stderr || ''));
  check('Cleaner entfernt das Verzeichnis', !fs.existsSync(probe));

  console.log(`\nBlockierte Anfragen in diesem Lauf: ${stats.blocked}`);
  console.log(`${passed} bestanden, ${failed} fehlgeschlagen\n`);

  // Same path the app uses: hand the profile to the detached cleaner first,
  // then try inline as a fast path.
  require('node:child_process')
    .spawn(process.execPath, [path.join(__dirname, '..', 'src', 'main', 'cleanup.js'), RUN_PROFILE], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    .unref();
  try {
    fs.rmSync(RUN_PROFILE, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the cleaner will get it */
  }
  await pause(400);
  app.exit(failed ? 1 : 0);
});

function walk(dir, fn) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, fn);
    else if (entry.isFile()) fn(full);
  }
}
