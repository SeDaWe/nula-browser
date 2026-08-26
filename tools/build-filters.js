'use strict';

/*
 * Baut die Filter-Engine, die Nula ausliefert.
 *
 *   node tools/build-filters.js
 *
 * Laedt die Listen einmal HIER, beim Bauen, und legt die fertig uebersetzte
 * Engine als Binaerdatei unter src/main/filters/ ab. Zur Laufzeit wird nur noch
 * diese Datei gelesen - Nula stellt fuer Filter keine einzige Netzwerkanfrage.
 * Das war der ganze Einwand gegen eine Listen-Engine, und beim Bauen faellt er
 * weg: der Rechner, der den Release baut, darf ins Netz, der Browser des
 * Nutzers muss es nicht.
 *
 * Die Release-Werkstatt ruft das vor jedem Build auf, jede Version bringt also
 * frische Listen mit.
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { FiltersEngine } = require('@ghostery/adblocker');

// Im Kern dieselbe Zusammenstellung, die uBlock Origin voreingestellt hat.
const LISTS = [
  ['EasyList', 'https://easylist.to/easylist/easylist.txt'],
  ['EasyPrivacy', 'https://easylist.to/easylist/easyprivacy.txt'],
  ['EasyList Germany', 'https://easylist.to/easylistgermany/easylistgermany.txt'],
  ['uBO Filters', 'https://ublockorigin.github.io/uAssets/filters/filters.txt'],
  ['uBO Badware', 'https://ublockorigin.github.io/uAssets/filters/badware.txt'],
  ['uBO Privacy', 'https://ublockorigin.github.io/uAssets/filters/privacy.txt'],
  ['uBO Quick Fixes', 'https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt'],
  // Haelt Seiten heil, die eine der obigen Listen zu weit trifft. Gehoert
  // zwingend dazu, sonst sind kaputte Seiten programmiert.
  ['uBO Unbreak', 'https://ublockorigin.github.io/uAssets/filters/unbreak.txt'],
  ['Peter Lowe', 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext'],
];

const OUT_DIR = path.join(__dirname, '..', 'src', 'main', 'filters');

/*
 * Bewusst node:https statt fetch. Ein Lauf ist an einem undici-Fehler
 * gestorben - "assert(!this.paused)", geworfen aus einem Socket-Handler
 * heraus, also nicht einmal von einem try/catch um das await zu fangen. Ein
 * Netzwerkschluckauf darf keinen Release kosten.
 */
function get(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'nula-browser build' } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('zu viele Weiterleitungen'));
        return resolve(get(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
      }
      if (status !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${status}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Zeitueberschreitung')));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchList(name, url) {
  let last;
  for (let versuch = 1; versuch <= 4; versuch++) {
    try {
      const text = await get(url);
      // Eine abgeschnittene Liste waere schlimmer als gar keine: sie wuerde
      // stillschweigend einen Teil der Regeln verlieren.
      if (text.length < 1000) throw new Error(`verdaechtig kurz (${text.length} Zeichen)`);
      return text;
    } catch (err) {
      last = err;
      if (versuch < 4) {
        process.stdout.write(`(Versuch ${versuch}: ${err.message}, neuer Versuch) `);
        await wait(versuch * 2000);
      }
    }
  }
  throw new Error(`${name}: ${last.message}`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const sources = [];
  const texts = [];
  for (const [name, url] of LISTS) {
    process.stdout.write(`  ${name} ... `);
    const text = await fetchList(name, url);
    // Nur echte Regeln zaehlen, keine Kommentare und Leerzeilen.
    const lines = text.split('\n')
      .filter((l) => l.trim() && !l.startsWith('!') && !l.startsWith('[')).length;
    console.log(`${lines.toLocaleString('de-DE')} Zeilen`);
    sources.push({ name, url, lines });
    texts.push(text);
  }

  console.log('\n  Engine wird uebersetzt ...');
  const engine = FiltersEngine.parse(texts.join('\n'), {
    // Kosmetische Regeln blenden die leeren Kaesten aus, die reines
    // Netzwerkblocken zurueklaesst. Ohne sie sieht jede Seite kaputt aus.
    loadCosmeticFilters: true,
    loadNetworkFilters: true,
    enableMocking: false,
    enableCompression: true,
  });

  const bin = engine.serialize();
  fs.writeFileSync(path.join(OUT_DIR, 'engine.bin'), bin);

  const meta = {
    builtAt: new Date().toISOString(),
    bytes: bin.length,
    filterRules: sources.reduce((sum, l) => sum + l.lines, 0),
    sources,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

  console.log(`\n  engine.bin: ${(bin.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  ${sources.length} Listen, gebaut ${meta.builtAt}\n`);
}

main().catch((err) => {
  console.error(`\nFEHLGESCHLAGEN: ${err.message}\n`);
  process.exit(1);
});
