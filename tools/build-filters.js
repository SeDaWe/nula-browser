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

async function fetchList(name, url) {
  const res = await fetch(url, { headers: { 'user-agent': 'nula-browser build' } });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length < 1000) throw new Error(`${name}: verdaechtig kurz (${text.length} Zeichen)`);
  return text;
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
