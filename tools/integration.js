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
const { PopupGuard } = require('../src/main/popupguard');
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
  check('Pop-under-Netz wird als solches erkannt', blocker.classify('https://popads.net/pop.js') === 'popup');
  check('Anzeigenauslieferung wird als Werbung erkannt',
    blocker.classify('https://ad.doubleclick.net/x') === 'ad');
  check('Analysedienst bleibt Tracker', blocker.classify('https://in.hotjar.com/api') === 'tracker');
  check('Werbepfad auf harmlosem Host wird erkannt',
    blocker.classify('https://cdn.example.org/pagead/js/adsbygoogle.js') === 'path');
  check('Normale Seite wird durchgelassen',
    blocker.classify('https://developer.mozilla.org/de/docs/Web/API') === null);
  check('"advertising" im Pfad ist kein Treffer',
    blocker.classify('https://agentur.example.org/advertising-team/') === null);
  check('isAdHost trennt Werbung von Analyse',
    blocker.isAdHost('popads.net') && blocker.isAdHost('doubleclick.net') && !blocker.isAdHost('hotjar.com'));
  // Suchmaschine ausdruecklich setzen: der Test prueft, dass file:// zur Suche
  // wird, nicht welche Suchmaschine voreingestellt ist.
  check('file:// wird als Suchtext behandelt',
    resolveInput('file:///etc/passwd', { searchEngine: 'duckduckgo' }).startsWith('https://duckduckgo.com/'));
  check('Ohne Einstellung wird Google gesucht',
    resolveInput('hallo welt', {}).startsWith('https://www.google.com/search'));
  check('Frischer Vault ist auf Google voreingestellt',
    require('../src/main/vault').emptyVault().settings.searchEngine === 'google');
  check('javascript:// wird nicht als Navigation akzeptiert',
    !isSafeNavigationUrl('javascript://alert(1)'));

  ses.protocol.handle('nula', (request) => {
    const url = new URL(request.url);
    const page = (url.hostname || 'newtab').replace(/[^a-z0-9-]/gi, '');
    const file = path.join(__dirname, '..', 'src', 'pages', `${page}.html`);
    if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
    return net.fetch('file://' + file.replace(/\\/g, '/'));
  });

  // --- popup guard ---------------------------------------------------------
  console.log('\nPopup-Waechter');
  {
    // Eigene Uhr, damit das Zeitfenster ohne echtes Warten geprueft werden kann.
    let clock = 1000000;
    const flags = { popups: true, ads: true };
    const g = new PopupGuard({
      popupsBlocked: () => flags.popups,
      adsBlocked: () => flags.ads,
      blocker,
      now: () => clock,
    });
    const SITE = 'https://shop.example.org/artikel/4';
    const ask = (url) => g.decide('t1', { url, openerUrl: SITE });

    check('Ohne Klick kein Fenster', ask('https://ziel.example.net/').reason === 'noGesture');

    g.noteGesture('t1');
    check('Nach einem Klick geht ein Fenster auf', ask('https://ziel.example.net/').allow);
    check('Das zweite Fenster zum selben Klick wird gestoppt',
      ask('https://werbung.example.net/').reason === 'burst');

    clock += 1500;
    g.noteGesture('t1');
    clock += 1500;
    check('Ein alter Klick berechtigt nicht mehr',
      ask('https://ziel.example.net/').reason === 'noGesture');

    g.noteGesture('t1');
    check('Werbenetz wird auch mit frischem Klick gestoppt',
      ask('https://popads.net/x').reason === 'ad');
    check('Der abgewiesene Versuch verbraucht den Klick nicht',
      ask('https://ziel.example.net/').allow);

    const zwischenstand = g.stats.popups;
    flags.popups = false;
    g.forget('t1');
    check('Ausgeschaltet laesst der Waechter alles durch', ask('https://ziel.example.net/').allow);
    check('Ausgeschaltet bleibt Werbung trotzdem gesperrt',
      ask('https://propellerads.com/x').reason === 'ad');
    flags.popups = true;

    g.allowOpener(SITE);
    check('Freigestellte Seite darf ohne Klick oeffnen', ask('https://ziel.example.net/').allow);
    check('Die Freistellung gilt nicht fuer ihr Werbenetz',
      ask('https://adsterra.com/x').reason === 'ad');
    check('Ein anderer Tab profitiert nicht von der Freistellung',
      g.decide('t2', { url: 'https://ziel.example.net/', openerUrl: 'https://andere.example.org/' })
        .reason === 'noGesture');

    check('Blockierte Fenster werden gezaehlt', g.stats.popups > zwischenstand);
    check('Navigation ins Werbenetz wird gestoppt', g.blocksNavigation('https://popads.net/land'));
    check('Normale Navigation laeuft durch',
      !g.blocksNavigation('https://developer.mozilla.org/de/'));

    flags.ads = false;
    check('Ohne Werbesperre ist auch die Navigation frei',
      !g.blocksNavigation('https://popads.net/land'));
    flags.ads = true;

    check('nula://newtab kommt nie als Popup durch',
      !g.decide('t3', { url: 'nula://newtab' }).allow);
    check('Fremde Schemata werden abgewiesen',
      !g.decide('t3', { url: 'javascript:alert(1)' }).allow);
  }

  // --- window and tabs -----------------------------------------------------
  console.log('\nTabs');
  const win = new BrowserWindow({ width: 1280, height: 800, show: true, backgroundColor: '#0a0b0d' });

  let lastState = null;
  // Der Waechter haengt hier mit an, damit auch der echte Weg durch
  // setWindowOpenHandler geprueft wird und nicht nur die Entscheidungslogik.
  const blockedPopups = [];
  const liveGuard = new PopupGuard({
    popupsBlocked: () => true,
    adsBlocked: () => true,
    blocker,
  });
  const openedByPage = [];
  const tabs = new TabManager(win, ses, (s) => (lastState = s), {
    guard: liveGuard,
    onBlocked: (info) => blockedPopups.push(info),
  });
  tabs.newTabRequestHandler = (url) => openedByPage.push(url);

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

  // --- popups im echten Tab ------------------------------------------------
  console.log('\nPopups im laufenden Tab');
  {
    // Der Tab muss sichtbar sein, sonst laeuft sendInputEvent ins Leere.
    tabs.activate(idA);
    await pause(300);
    const wc = tabs.tabs.get(idA).view.webContents;
    wc.focus();
    // executeJavaScript(code, true) setzt zwar die user activation der Seite,
    // erzeugt aber kein Eingabeereignis - fuer den Waechter ist das also
    // weiterhin ein Fenster, das niemand angeklickt hat.
    await wc.executeJavaScript(`window.open('https://ziel.example.net/', '_blank')`, true).catch(() => {});
    await pause(200);
    check('window.open ohne Eingabe wird im echten Tab gestoppt',
      blockedPopups.length === 1 && blockedPopups[0].reason === 'noGesture',
      JSON.stringify(blockedPopups));
    check('Das gestoppte Fenster wird nicht als Tab geoeffnet', openedByPage.length === 0);

    // input-event ist die Quelle, aus der der Waechter echte Klicks lernt.
    let sawInputEvent = false;
    wc.once('input-event', () => (sawInputEvent = true));
    wc.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 });
    await pause(200);
    check('input-event meldet echte Eingaben an den Waechter', sawInputEvent);

    await wc.executeJavaScript(`window.open('https://ziel.example.net/', '_blank')`, true).catch(() => {});
    await pause(200);
    check('Nach echtem Klick darf ein Fenster aufgehen',
      openedByPage.length === 1 && openedByPage[0] === 'https://ziel.example.net/',
      JSON.stringify(openedByPage));

    await wc.executeJavaScript(`window.open('https://werbung.example.net/', '_blank')`, true).catch(() => {});
    await pause(200);
    check('Das zweite Fenster zum selben Klick bleibt zu',
      openedByPage.length === 1 && blockedPopups.at(-1)?.reason === 'burst',
      JSON.stringify(blockedPopups.at(-1)));

    check('Der Waechter merkt sich die blockierte Adresse',
      blockedPopups.at(-1)?.url === 'https://werbung.example.net/');

    // Der Layout-Test danach erwartet idB als aktiven Tab.
    tabs.activate(idB);
    await pause(200);
  }

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

  // Die Tab-Ansicht ist eine native View ueber dem HTML. Nimmt sie die volle
  // Breite ein, liegt das Panel dahinter und ist unsichtbar - genau das war bis
  // 2.10 der Fall, und Einstellungen liessen sich dadurch nie oeffnen.
  const fullWidth = tabs.tabs.get(tabs.activeId).view.getBounds().width;
  tabs.setPanelOpen(true);
  const shrunk = tabs.tabs.get(tabs.activeId).view.getBounds().width;
  check('Bei offenem Panel macht die Tab-Ansicht Platz',
    shrunk === fullWidth - 384, `voll=${fullWidth} mit Panel=${shrunk}`);
  tabs.setPanelOpen(false);
  check('Nach dem Schliessen nimmt sie wieder die volle Breite',
    tabs.tabs.get(tabs.activeId).view.getBounds().width === fullWidth);

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

  // --- encrypted full backup -----------------------------------------------
  console.log('\nVollständiger Datenexport');
  const backup = require('../src/main/backup');
  const exportedAt = new Date().toISOString();
  const backupPayload = {
    format: backup.PAYLOAD_FORMAT,
    version: backup.BACKUP_VERSION,
    exportedAt,
    application: { name: 'Nula', version: 'test', platform: process.platform },
    connection: { serverUrl: 'https://private.example', syncVersion: 7, syncDirty: false },
    localConfig: { serverUrl: null, rememberServerUrl: false, deviceId: 'abc', deviceName: 'TEST' },
    vault: {
      schema: 1,
      tabs: [{ id: 't1', url: 'https://secret.example/tab' }],
      bookmarks: [{ id: 'b1', url: 'https://secret.example/bookmark' }],
      notes: [{ id: 'n1', text: 'streng geheim' }],
      settings: { searchEngine: 'duckduckgo' },
      tombstones: [],
      identity,
      updatedAt: exportedAt,
    },
    serverData: {
      apiTokenMetadata: [{ id: 'token1', name: 'Handy' }],
      apiTokenSecretsIncluded: false,
      pendingInbox: [],
      unavailable: [],
    },
  };
  const backupDoc = backup.createBackup({
    encKey: keys.encKey,
    clientSalt: keys.clientSaltHex,
    argon2: keys.argon2,
    payload: backupPayload,
    exportedAt,
  });
  const backupText = JSON.stringify(backupDoc);
  check('Backup trägt eine eindeutige Formatversion',
    backupDoc.format === backup.BACKUP_FORMAT && backupDoc.version === 1);
  check('URLs, Notizen und private Inbox-Schlüssel stehen nicht im Klartext',
    !backupText.includes('secret.example') &&
    !backupText.includes('streng geheim') &&
    !backupText.includes(identity.kemPrivate));

  const restoredBackup = backup.decryptBackup(keys.encKey, backupDoc);
  check('Vollständiger Vault und lokale Konfiguration überstehen den Roundtrip',
    restoredBackup.vault.notes[0].text === 'streng geheim' &&
    restoredBackup.vault.identity.kemPrivate === identity.kemPrivate &&
    restoredBackup.localConfig.deviceId === 'abc');

  const tamperedBackup = structuredClone(backupDoc);
  const tamperedRaw = Buffer.from(tamperedBackup.encryption.blob, 'base64');
  tamperedRaw[tamperedRaw.length - 1] ^= 1;
  tamperedBackup.encryption.blob = tamperedRaw.toString('base64');
  let tamperRejected = false;
  try {
    backup.decryptBackup(keys.encKey, tamperedBackup);
  } catch {
    tamperRejected = true;
  }
  check('Manipuliertes Backup wird abgelehnt', tamperRejected);

  const backupDir = path.join(os.tmpdir(), `nula-backup-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, 'export.nula-backup.json');
  backup.writeBackupFile(backupFile, backupDoc);
  backup.writeBackupFile(backupFile, backupDoc);
  check('Backup wird sicher geschrieben und kann ersetzt werden',
    backup.parseBackup(fs.readFileSync(backupFile, 'utf8')).exportedAt === exportedAt);
  check('Keine temporäre Klartext- oder Backup-Datei bleibt liegen',
    fs.readdirSync(backupDir).join(',') === 'export.nula-backup.json');

  // --- reading a backup back in ---------------------------------------------
  console.log('\nBackup-Import');
  const reread = backup.readBackupFile(backupFile);
  check('Backup wird von der Platte gelesen und geprüft', reread.exportedAt === exportedAt);

  const otherKeys = await vc.deriveKeys('ein-voellig-anderes-passwort', salt, { memoryKiB: 32 * 1024, passes: 2, parallelism: 1 });
  let wrongPasswordRejected = false;
  try {
    backup.decryptBackup(otherKeys.encKey, reread);
  } catch {
    wrongPasswordRejected = true;
  }
  check('Ein fremdes Master-Passwort kann das Backup nicht öffnen', wrongPasswordRejected);
  fs.rmSync(backupDir, { recursive: true, force: true });

  const { mergeBackupVault, emptyVault: freshVault } = require('../src/main/vault');
  const deletedAt = new Date().toISOString();
  const running = {
    ...freshVault(),
    identity: { kemPublic: 'aktuell', kemPrivate: 'aktuell-priv', createdAt: '2026-08-01T00:00:00.000Z' },
    bookmarks: [{ id: 'lokal', url: 'https://lokal.example', updatedAt: deletedAt }],
    tabs: [{ id: 'offen', url: 'https://offen.example', deviceId: 'dieses-geraet', updatedAt: deletedAt }],
    tombstones: [{ id: 'geloescht', deletedAt }],
    settings: { ...freshVault().settings, searchEngine: 'startpage' },
  };
  const fromBackup = {
    identity: { kemPublic: 'alt', kemPrivate: 'alt-priv', createdAt: '2020-01-01T00:00:00.000Z' },
    bookmarks: [
      { id: 'geloescht', url: 'https://geloescht.example', updatedAt: '2026-08-02T00:00:00.000Z' },
      { id: 'neu', url: 'https://neu.example', updatedAt: '2026-08-02T00:00:00.000Z' },
    ],
    tabs: [{ id: 'gesichert', url: 'https://gesichert.example', deviceId: 'dieses-geraet', updatedAt: '2026-08-02T00:00:00.000Z' }],
    notes: [{ id: 'notiz', text: 'aus dem Backup', updatedAt: '2026-08-02T00:00:00.000Z' }],
    tombstones: [{ id: 'geloescht', deletedAt }],
    settings: { searchEngine: 'google' },
  };

  const mergedData = mergeBackupVault(running, fromBackup, { deviceId: 'dieses-geraet', withSettings: false });
  check('Importiertes Lesezeichen landet im Vault',
    mergedData.bookmarks.some((b) => b.id === 'neu'));
  check('Ein hier gelöschter Eintrag wird nicht wiederbelebt',
    !mergedData.bookmarks.some((b) => b.id === 'geloescht'));
  check('Vorhandene Einträge bleiben erhalten',
    mergedData.bookmarks.some((b) => b.id === 'lokal') && mergedData.notes.some((n) => n.id === 'notiz'));
  check('Die aktuelle Inbox-Identität wird nicht auf die ältere zurückgedreht',
    mergedData.identity.kemPrivate === 'aktuell-priv');
  check('Gesicherte Tabs dieses Geräts werden als eigenes Gerät geführt',
    mergedData.tabs.find((t) => t.id === 'gesichert')?.deviceId === 'backup');
  check('Der aktuell offene Tab behält sein Gerät',
    mergedData.tabs.find((t) => t.id === 'offen')?.deviceId === 'dieses-geraet');
  check('Doppelte Tombstones werden zusammengefasst',
    mergedData.tombstones.filter((t) => t.id === 'geloescht').length === 1);
  check('Ohne Zustimmung bleiben die Einstellungen unverändert',
    mergedData.settings.searchEngine === 'startpage');

  const withSettings = mergeBackupVault(running, fromBackup, { deviceId: 'dieses-geraet', withSettings: true });
  check('Mit Zustimmung kommen die Einstellungen aus dem Backup',
    withSettings.settings.searchEngine === 'google' && withSettings.settings.autoLockMinutes === 15);

  // mergeVaults vereinigt beide Tombstone-Listen. Ohne Dedup waechst sie bei zwei
  // aktiven Geraeten mit jeder Runde (|local|+|remote|), sprengt das 8-MB-Limit des
  // Servers und der 413 laesst das Geraet nie wieder pushen.
  const { mergeVaults: rawMerge } = require('../src/main/vault');
  const oneStone = { id: 'weg', deletedAt: new Date().toISOString() };
  let devA = { ...freshVault(), tombstones: [oneStone] };
  let devB = { ...freshVault(), tombstones: [oneStone] };
  for (let round = 0; round < 14; round++) {
    devB = rawMerge(devB, devA);
    devA = rawMerge(devA, devB);
  }
  check('Wiederholtes Zusammenführen vervielfacht Tombstones nicht',
    devA.tombstones.length === 1, String(devA.tombstones.length) + ' nach 14 Runden');

  const twice = mergeBackupVault(mergedData, fromBackup, { deviceId: 'dieses-geraet', withSettings: false });
  check('Ein zweiter Import ändert nichts mehr',
    twice.bookmarks.length === mergedData.bookmarks.length &&
    twice.tabs.length === mergedData.tabs.length &&
    twice.tombstones.length === mergedData.tombstones.length);

  const brokenBackup = { tabs: 'kein Array', bookmarks: [{ ohneId: true }], settings: 'auch kein Objekt' };
  let survivedGarbage = true;
  let repaired = null;
  try {
    repaired = mergeBackupVault(running, brokenBackup, { deviceId: 'dieses-geraet', withSettings: true });
  } catch {
    survivedGarbage = false;
  }
  check('Ein strukturell kaputtes Backup reisst den Merge nicht ab',
    survivedGarbage && repaired?.bookmarks.length === 1 && repaired.tabs.length === 1);

  // Ein Backup ist als Ganzes authentifiziert, aber strukturell ungeprueft. Items
  // ohne brauchbares updatedAt gewinnen in mergeList jeden Vergleich (NaN), und
  // Tabs ohne deviceId lassen die Geraeteliste im Renderer auflaufen.
  const sloppy = {
    bookmarks: [
      { id: 'lokal', url: 'https://alt.example', title: 'alter Stand' },
      { id: 'ohnezeit', url: 'https://ohnezeit.example', updatedAt: 'gestern' },
    ],
    tabs: [{ id: 'ohnegeraet', url: 'https://ohnegeraet.example', updatedAt: '2026-08-02T00:00:00.000Z' }],
  };
  const normalised = mergeBackupVault(running, sloppy, { deviceId: 'dieses-geraet', withSettings: false });
  check('Ein Backup-Eintrag ohne gültiges updatedAt überschreibt den neueren lokalen nicht',
    normalised.bookmarks.find((b) => b.id === 'lokal')?.url === 'https://lokal.example');
  check('Er wird trotzdem übernommen, wenn es lokal nichts gibt',
    normalised.bookmarks.some((b) => b.id === 'ohnezeit'));
  check('Ein Tab ohne deviceId bekommt eins, statt die Geräteliste zu sprengen',
    typeof normalised.tabs.find((t) => t.id === 'ohnegeraet')?.deviceId === 'string');

  const { SyncEngine } = require('../src/main/sync');
  const engine = new SyncEngine({}, keys, () => {}, () => {});
  engine.vault = { ...freshVault(), identity, bookmarks: [{ id: 'schonda', url: 'https://x.example', updatedAt: deletedAt }] };
  const foreign = await engine.applyInboxEntries([
    { id: 'schonda', sealed: { v: 2 }, createdAt: deletedAt },
    { id: 'fremd', sealed: { v: 2, epk: 'AA==', kemCt: 'AA==', iv: 'AA==', ct: 'AA==', tag: 'AA==' }, createdAt: deletedAt },
  ]);
  // Ein Eintrag muss erst entsiegelbar sein, bevor er ueberhaupt betrachtet wird:
  // was dieses Konto nicht lesen kann, wird auch nicht auf dem Server geloescht.
  check('Nicht entsiegelbare Inbox-Einträge werden weder übernommen noch gelöscht',
    foreign.applied === 0 && foreign.deletable.length === 0);
  check('Der Vault bleibt dabei unverändert', engine.vault.bookmarks.length === 1);

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

  // Der Setup-Code-Merker gehoert zum gemerkten Server. Ohne gemerkte Adresse
  // ist nicht bekannt, fuer welchen Server er gaelte - also wird er mit fallen
  // gelassen, damit das Feld beim naechsten Mal wieder erscheint.
  config.reset();
  check('Frisch ist die Einrichtung nicht als erledigt vermerkt', config.load().setupDone === false);
  config.save({ serverUrl: 'https://sync.example.com', rememberServerUrl: true, setupDone: true });
  config.reset();
  check('Mit gemerkter Adresse wird die Einrichtung vermerkt', config.load().setupDone === true);
  config.save({ serverUrl: null, rememberServerUrl: false, setupDone: false });
  config.reset();
  check('Ohne gemerkte Adresse faellt der Vermerk weg', config.load().setupDone === false);

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
