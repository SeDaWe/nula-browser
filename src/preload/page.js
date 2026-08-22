'use strict';

/*
 * Preload for web page views. Runs sandboxed with no bridge to the app: its only
 * job is to reduce passive fingerprinting surface a little before the page runs.
 * Nothing here is a substitute for Tor; it just removes the cheapest signals.
 */

// Report a plausible, common hardware profile instead of the real machine.
try {
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
  Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
} catch {
  /* some pages freeze navigator first; not worth failing over */
}

// The battery API is a pure tracking vector for a browser like this.
try {
  if ('getBattery' in navigator) {
    Object.defineProperty(navigator, 'getBattery', {
      value: () => Promise.reject(new Error('unavailable')),
      configurable: true,
    });
  }
} catch {
  /* ignore */
}
