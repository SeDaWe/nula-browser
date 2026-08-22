'use strict';

/*
 * Detached profile cleaner.
 *
 * Chromium still holds handles into its profile directory while the app is
 * shutting down, so deleting it from inside will-quit fails with EBUSY on
 * Windows and can leave leveldb files behind. Nula therefore spawns this script
 * as a plain Node process just before quitting; it outlives the app, waits for
 * the handles to drop and retries until the directory is gone.
 *
 *   node cleanup.js <dir> [<dir> ...]
 */

const fs = require('node:fs');

const ATTEMPTS = 40;
const DELAY_MS = 250;

async function remove(dir) {
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (!fs.existsSync(dir)) return true;
    } catch {
      /* handles still open, wait and try again */
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  return !fs.existsSync(dir);
}

(async () => {
  const targets = process.argv.slice(2).filter(Boolean);
  for (const dir of targets) await remove(dir);
  process.exit(0);
})();
