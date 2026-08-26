'use strict';

/*
 * Popup- und Pop-under-Waechter.
 *
 * Das Problem, das dieses Modul loest: eine Seite haengt an jeden Klick ein
 * window.open() mit Werbung. Der Klick selbst fuehrt danach ganz normal weiter,
 * also faellt der Werbe-Tab dem Browser nicht als boesartig auf - er sieht aus
 * wie ein voellig regulaeres target="_blank".
 *
 * Chromium loest den einfachen Teil ueber "user activation": ein Klick oder
 * Tastendruck berechtigt zu genau EINEM neuen Fenster, danach ist die
 * Berechtigung verbraucht. Electron gibt dem setWindowOpenHandler diese
 * Information nicht mit, also wird sie hier selbst gefuehrt - gespeist aus dem
 * input-event der WebContents, das nur bei echter Eingabe feuert und nicht bei
 * einem per Skript ausgeloesten element.click().
 *
 * Das allein reicht aber nicht, und in 2.12 tat es das auch nicht: die
 * Berechtigung geht an das ERSTE Fenster des Klicks, und genau das ist bei
 * einem Pop-under die Werbung. Der eigentliche Link ist gar kein zweites
 * Fenster, sondern eine ganz normale Navigation im selben Tab. Die Regel
 * "hoechstens ein Fenster pro Klick" laeuft dabei ins Leere.
 *
 * Was den Fall wirklich verraet, ist die Gleichzeitigkeit: ein Fenster geht auf
 * UND der oeffnende Tab navigiert im selben Wimpernschlag. Ein ehrliches
 * target="_blank" tut das nicht - dort bleibt die Ausgangsseite stehen.
 * Deshalb wird ein Fenster von einem noch unbekannten Host kurz zurueckgehalten
 * (HOLD_MS). Navigiert der Opener in dieser Zeit, war es ein Pop-under: das
 * Fenster faellt weg und der Host ist fuer den Rest der Sitzung als
 * Pop-under-Seite vermerkt, ab dann ohne Wartezeit. Bleibt der Opener stehen,
 * gilt der Host als unauffaellig und darf ab dann sofort oeffnen. Die Wartezeit
 * faellt also nur beim allerersten Fenster einer Seite an.
 *
 * Regeln, in dieser Reihenfolge:
 *
 *   1. Ziel ist ein bekanntes Werbe- oder Pop-under-Netz -> immer blockieren.
 *      Diese Regel haengt an der Werbesperre, nicht an der Popup-Sperre.
 *   2. Popup-Sperre aus, oder die oeffnende Seite steht auf der Ausnahmeliste
 *      dieser Sitzung -> durchlassen.
 *   3. Mittelklick oder Strg-Klick -> durchlassen. Diese Absicht kann ein
 *      Skript nicht vortaeuschen, siehe unten.
 *   4. Die oeffnende Seite ist schon als Pop-under-Seite aufgefallen
 *      -> blockieren.
 *   5. Kein Klick und kein Tastendruck in den letzten GESTURE_WINDOW_MS
 *      -> blockieren. Das faengt alles, was ein Timer aufmacht.
 *   6. Die Eingabe hat schon ein Fenster geoeffnet -> blockieren.
 *   7. Sonst durchlassen, bei unbekanntem Host mit Rueckhalt.
 *
 * Nichts davon ist endgueltig. Jedes blockierte Fenster behaelt seine URL und
 * kann aus der Meldung heraus doch geoeffnet werden.
 */

const { isSafeNavigationUrl, NEW_TAB } = require('./urls');

// Chromium selbst rechnet mit rund 5 Sekunden, das ist grosszuegig genug, dass
// ein Skript den Klick noch nachtraeglich einsammeln kann. Eine Sekunde deckt
// jede ehrliche Reaktion auf einen Klick ab.
const GESTURE_WINDOW_MS = 1000;

// Wie lange ein Fenster von einem unbekannten Host zurueckgehalten wird, um zu
// sehen, ob der Opener gleich mitnavigiert. Lang genug fuer den Pop-under, der
// unmittelbar nach dem window.open() den Link ausfuehrt, und kurz genug, dass
// es beim ehrlichen target="_blank" nicht auffaellt. Faellt pro Host genau
// einmal an.
const HOLD_MS = 400;

const REASONS = {
  ad: 'Werbenetzwerk',
  popunder: 'Pop-under-Seite',
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
    // Was wir ueber einzelne Seiten gelernt haben: 'popunder' oder 'benign'.
    this.reputation = new Map(); // host -> string
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

  /** Der Opener hat waehrend des Rueckhalts selbst navigiert: Pop-under. */
  markPopunder(openerUrl) {
    const host = hostOf(openerUrl);
    if (host) this.reputation.set(host, 'popunder');
    return host;
  }

  /** Der Rueckhalt lief ab, ohne dass der Opener navigiert hat. */
  confirmBenign(openerUrl) {
    const host = hostOf(openerUrl);
    if (host && !this.reputation.has(host)) this.reputation.set(host, 'benign');
  }

  reputationOf(url) {
    const host = hostOf(url);
    return (host && this.reputation.get(host)) || null;
  }

  /**
   * @param {string} tabId          Tab, der das Fenster oeffnen will.
   * @param {object} request
   * @param {string} request.url    Ziel des neuen Fensters.
   * @param {string} [request.openerUrl]   Aktuelle Adresse des oeffnenden Tabs.
   * @param {string} [request.disposition] Von Chromium: wie das Fenster gemeint ist.
   * @returns {{allow: boolean, reason?: string, detail?: string, hold?: boolean}}
   */
  decide(tabId, { url, openerUrl = null, disposition = null }) {
    if (!isSafeNavigationUrl(url) || url === NEW_TAB) {
      return { allow: false, reason: 'unsafe', detail: REASONS.unsafe };
    }

    const block = (reason) => {
      this.stats.popups++;
      return { allow: false, reason, detail: REASONS[reason] };
    };

    // Regel 1: Werbenetz als Ziel. Gilt auch fuer erlaubte Seiten, denn erlaubt
    // wurde die Seite, nicht das Werbenetz.
    if (this.adsBlocked() && this.blocker.isAdHost(hostOf(url))) return block('ad');

    // Regel 2: Sperre aus oder Ausnahme fuer diese Seite.
    if (!this.popupsBlocked()) return { allow: true };
    if (openerUrl && this.isOpenerAllowed(openerUrl)) return { allow: true };

    /*
     * Regel 3: Mittelklick und Strg-Klick. Chromium meldet dafuer
     * 'background-tab', und diese Disposition kann eine Seite nicht erzeugen:
     * window.open() liefert immer 'foreground-tab' oder 'new-window'. Sie ist
     * damit ein Beleg fuer eine bewusste Entscheidung und braucht weder
     * Rueckhalt noch weitere Pruefung.
     */
    if (disposition === 'background-tab') return { allow: true };

    // Regel 4: Die Seite ist schon einmal als Pop-under aufgefallen.
    if (this.reputationOf(openerUrl) === 'popunder') return block('popunder');

    const gesture = this.gestures.get(tabId);

    // Regel 5: gar keine Eingabe in Sichtweite.
    if (!gesture || this.now() - gesture.at > GESTURE_WINDOW_MS) return block('noGesture');

    // Regel 6: die Eingabe hat ihr Fenster schon bekommen.
    if (gesture.used) return block('burst');

    gesture.used = true;

    /*
     * Regel 7: erlaubt. Bei einem Host, ueber den wir noch nichts wissen, wird
     * das Fenster kurz zurueckgehalten - navigiert der Opener in der Zeit
     * selbst, war es doch ein Pop-under. Bekannt unauffaellige Hosts oeffnen
     * ohne Wartezeit.
     */
    return { allow: true, hold: this.reputationOf(openerUrl) !== 'benign' };
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

module.exports = { PopupGuard, GESTURE_WINDOW_MS, HOLD_MS, REASONS };
