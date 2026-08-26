'use strict';

/*
 * Popup- und Pop-under-Waechter.
 *
 * Das Problem, das dieses Modul loest: eine Seite haengt an jeden Klick ein
 * window.open() mit Werbung. Der Klick selbst fuehrt danach ganz normal weiter,
 * also faellt der Werbe-Tab dem Browser nicht als boesartig auf - er sieht aus
 * wie ein voellig regulaeres target="_blank".
 *
 * Chromium loest das ueber "user activation": ein Klick oder Tastendruck
 * berechtigt zu genau EINEM neuen Fenster, danach ist die Berechtigung
 * verbraucht. Electron gibt dem setWindowOpenHandler diese Information nicht
 * mit, also wird sie hier selbst gefuehrt - gespeist aus dem input-event der
 * WebContents, das nur bei echter Eingabe feuert und nicht bei einem per
 * Skript ausgeloesten element.click().
 *
 * Vier Regeln, in dieser Reihenfolge:
 *
 *   1. Ziel ist ein bekanntes Werbe- oder Pop-under-Netz -> immer blockieren.
 *      Diese Regel haengt an der Werbesperre, nicht an der Popup-Sperre.
 *   2. Popup-Sperre aus, oder die oeffnende Seite steht auf der Ausnahmeliste
 *      dieser Sitzung -> durchlassen.
 *   3. Kein Klick und kein Tastendruck in den letzten GESTURE_WINDOW_MS
 *      -> blockieren. Das faengt alles, was ein Timer aufmacht.
 *   4. Die Eingabe hat schon ein Fenster geoeffnet -> blockieren. Das ist der
 *      eigentliche Pop-under-Fall: zwei Fenster aus einem Klick.
 *
 * Nichts davon ist endgueltig. Jedes blockierte Fenster behaelt seine URL und
 * kann aus der Meldung heraus doch geoeffnet werden.
 */

const { isSafeNavigationUrl, NEW_TAB } = require('./urls');

// Chromium selbst rechnet mit rund 5 Sekunden, das ist grosszuegig genug, dass
// ein Skript den Klick noch nachtraeglich einsammeln kann. Eine Sekunde deckt
// jede ehrliche Reaktion auf einen Klick ab.
const GESTURE_WINDOW_MS = 1000;

const REASONS = {
  ad: 'Werbenetzwerk',
  noGesture: 'ohne Klick geöffnet',
  burst: 'zweites Fenster beim selben Klick',
  unsafe: 'nicht unterstützte Adresse',
};

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

class PopupGuard {
  /**
   * @param {object} deps
   * @param {() => boolean} deps.popupsBlocked  Popup-Sperre aktiv?
   * @param {() => boolean} deps.adsBlocked     Werbesperre aktiv?
   * @param {object} deps.blocker               Modul mit isAdHost()
   * @param {() => number} [deps.now]           Nur fuer Tests.
   */
  constructor({ popupsBlocked, adsBlocked, blocker, now = Date.now }) {
    this.popupsBlocked = popupsBlocked;
    this.adsBlocked = adsBlocked;
    this.blocker = blocker;
    this.now = now;
    this.gestures = new Map(); // tabId -> { at, used }
    // Hosts, denen der Nutzer in dieser Sitzung erlaubt hat, Fenster zu oeffnen.
    // Nur im Arbeitsspeicher, stirbt mit dem Prozess wie alles andere auch.
    this.allowedOpeners = new Set();
    this.stats = { popups: 0 };
  }

  /** Aus dem input-event der WebContents: echte Eingabe gesehen. */
  noteGesture(tabId) {
    this.gestures.set(tabId, { at: this.now(), used: false });
  }

  forget(tabId) {
    this.gestures.delete(tabId);
  }

  /** Nach "Trotzdem öffnen": diese Seite darf in dieser Sitzung Fenster oeffnen. */
  allowOpener(url) {
    const host = hostOf(url);
    if (host) this.allowedOpeners.add(host);
    return host;
  }

  isOpenerAllowed(url) {
    const host = hostOf(url);
    return !!host && this.allowedOpeners.has(host);
  }

  /**
   * @param {string} tabId          Tab, der das Fenster oeffnen will.
   * @param {object} request
   * @param {string} request.url    Ziel des neuen Fensters.
   * @param {string} [request.openerUrl] Aktuelle Adresse des oeffnenden Tabs.
   * @returns {{allow: boolean, reason?: string, detail?: string}}
   */
  decide(tabId, { url, openerUrl = null }) {
    if (!isSafeNavigationUrl(url) || url === NEW_TAB) {
      return { allow: false, reason: 'unsafe', detail: REASONS.unsafe };
    }

    // Regel 1: Werbenetz als Ziel. Gilt auch fuer erlaubte Seiten, denn erlaubt
    // wurde die Seite, nicht das Werbenetz.
    if (this.adsBlocked() && this.blocker.isAdHost(hostOf(url))) {
      this.stats.popups++;
      return { allow: false, reason: 'ad', detail: REASONS.ad };
    }

    // Regel 2: Sperre aus oder Ausnahme fuer diese Seite.
    if (!this.popupsBlocked()) return { allow: true };
    if (openerUrl && this.isOpenerAllowed(openerUrl)) return { allow: true };

    const gesture = this.gestures.get(tabId);

    // Regel 3: gar keine Eingabe in Sichtweite.
    if (!gesture || this.now() - gesture.at > GESTURE_WINDOW_MS) {
      this.stats.popups++;
      return { allow: false, reason: 'noGesture', detail: REASONS.noGesture };
    }

    // Regel 4: die Eingabe hat ihr Fenster schon bekommen.
    if (gesture.used) {
      this.stats.popups++;
      return { allow: false, reason: 'burst', detail: REASONS.burst };
    }

    gesture.used = true;
    return { allow: true };
  }

  /**
   * Navigation im Hauptframe auf ein Werbenetz. Der andere haeufige Fall: die
   * Seite schickt den aktuellen Tab auf die Werbung und oeffnet das eigentliche
   * Ziel daneben. Nur Pop-under- und Auslieferungsnetze, keine Analyse-Hosts -
   * auf denen landet man ohnehin nie im Hauptframe.
   */
  blocksNavigation(url) {
    if (!this.adsBlocked()) return false;
    const host = hostOf(url);
    return !!host && this.blocker.isAdHost(host);
  }
}

module.exports = { PopupGuard, GESTURE_WINDOW_MS, REASONS };
