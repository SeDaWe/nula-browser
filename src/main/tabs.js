'use strict';

/*
 * Tab manager. Each tab is a WebContentsView sharing one in-memory session, so
 * cookies, cache and storage die with the process. Tab metadata is mirrored into
 * the vault so the sync engine can ship it to other devices.
 */

const { WebContentsView, shell } = require('electron');
const path = require('node:path');
const { isSafeNavigationUrl, NEW_TAB } = require('./urls');

const CHROME_HEIGHT = 88; // title bar + tab strip + toolbar, keep in sync with renderer CSS
const PANEL_WIDTH = 384; // .panel in the renderer CSS, keep in sync

class TabManager {
  constructor(win, session, onChange, { guard = null, onBlocked = () => {} } = {}) {
    this.win = win;
    this.session = session;
    this.onChange = onChange;
    // Popup-Waechter. Optional, damit der TabManager auch ohne ihn testbar
    // bleibt; fehlt er, verhaelt sich alles wie vorher.
    this.guard = guard;
    this.onBlocked = onBlocked;
    this.tabs = new Map(); // id -> { id, view, url, title, loading, canGoBack, canGoForward, pinned }
    this.order = [];
    this.activeId = null;
    this.visible = true;
    // Die Tab-Ansicht ist eine native View ueber dem HTML der Oberflaeche. Waere
    // sie immer volle Breite, laege das Panel dahinter und bliebe unsichtbar -
    // der Hauptprozess muss also wissen, ob es offen ist.
    this.panelOpen = false;
  }

  bounds() {
    const [width, height] = this.win.getContentSize();
    const reserved = this.panelOpen ? Math.min(PANEL_WIDTH, width) : 0;
    return {
      x: 0,
      y: CHROME_HEIGHT,
      width: Math.max(0, width - reserved),
      height: Math.max(0, height - CHROME_HEIGHT),
    };
  }

  /** Blendet das Panel ein oder aus und gibt der Tab-Ansicht entsprechend Platz. */
  setPanelOpen(open) {
    const next = !!open;
    if (this.panelOpen === next) return;
    this.panelOpen = next;
    this.layout();
  }

  layout() {
    const b = this.bounds();
    for (const tab of this.tabs.values()) {
      tab.view.setBounds(tab.id === this.activeId && this.visible ? b : { x: 0, y: 0, width: 0, height: 0 });
    }
  }

  serialize() {
    return {
      activeId: this.activeId,
      tabs: this.order.map((id) => {
        const t = this.tabs.get(id);
        return {
          id: t.id,
          url: t.url,
          title: t.title,
          loading: t.loading,
          canGoBack: t.canGoBack,
          canGoForward: t.canGoForward,
          pinned: t.pinned,
          favicon: t.favicon || null,
        };
      }),
    };
  }

  emit() {
    this.onChange(this.serialize());
  }

  create(id, url, { activate = true, pinned = false } = {}) {
    const initialUrl = url && isSafeNavigationUrl(url) ? url : NEW_TAB;
    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, '..', 'preload', 'page.js'),
        spellcheck: false,
      },
    });

    const tab = {
      id,
      view,
      url: initialUrl,
      title: 'Neuer Tab',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      pinned,
      favicon: null,
    };
    this.tabs.set(id, tab);
    this.order.push(id);
    this.win.contentView.addChildView(view);

    const wc = view.webContents;
    const refresh = () => {
      tab.canGoBack = wc.navigationHistory.canGoBack();
      tab.canGoForward = wc.navigationHistory.canGoForward();
      this.emit();
    };

    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      this.emit();
    });
    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = favicons[0] || null;
      this.emit();
    });
    wc.on('did-start-loading', () => {
      tab.loading = true;
      this.emit();
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      refresh();
    });
    wc.on('did-navigate', (_e, navUrl) => {
      tab.url = navUrl;
      refresh();
    });
    wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
      if (isMainFrame) {
        tab.url = navUrl;
        refresh();
      }
    });
    wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 = user aborted
      tab.title = 'Seite nicht erreichbar';
      tab.loading = false;
      this.emit();
    });

    const guardNavigation = (event, target) => {
      if (!isSafeNavigationUrl(target)) return event.preventDefault();
      // Der zweite haeufige Trick: nicht das neue Fenster traegt die Werbung,
      // sondern der aktuelle Tab wird dorthin geschickt.
      if (this.guard && this.guard.blocksNavigation(target)) {
        event.preventDefault();
        this.onBlocked({ url: target, reason: 'ad', detail: 'Werbenetzwerk', kind: 'navigation' });
      }
    };
    wc.on('will-navigate', guardNavigation);
    wc.on('will-redirect', guardNavigation);

    /*
     * input-event feuert nur bei echter Eingabe. Ein per Skript ausgeloestes
     * element.click() laeuft komplett im Renderer und kommt hier nie an - genau
     * deshalb taugt es als Beleg fuer einen menschlichen Klick.
     */
    if (this.guard) {
      wc.on('input-event', (_e, input) => {
        if (input && (input.type === 'mouseDown' || input.type === 'keyDown')) {
          this.guard.noteGesture(id);
        }
      });
    }

    // Popups open as regular tabs; external protocols never touch the OS silently.
    wc.setWindowOpenHandler(({ url: target }) => {
      if (!isSafeNavigationUrl(target) || target === NEW_TAB) return { action: 'deny' };
      if (this.guard) {
        const verdict = this.guard.decide(id, { url: target, openerUrl: tab.url });
        if (!verdict.allow) {
          this.onBlocked({ url: target, ...verdict, kind: 'popup', openerUrl: tab.url });
          return { action: 'deny' };
        }
      }
      this.emitNewTabRequest(target);
      return { action: 'deny' };
    });

    // Block permission prompts by default; privacy over convenience.
    wc.session.setPermissionRequestHandler((_wc, permission, callback) => {
      const allowed = ['fullscreen', 'clipboard-sanitized-write'];
      callback(allowed.includes(permission));
    });

    if (activate) this.activate(id);
    this.navigate(id, initialUrl);
    this.emit();
    return tab;
  }

  emitNewTabRequest(url) {
    if (this.newTabRequestHandler) this.newTabRequestHandler(url);
  }

  activate(id) {
    if (!this.tabs.has(id)) return;
    this.activeId = id;

    // Re-stack first: removing and re-adding a child view discards its bounds,
    // so sizing has to happen after the view is back in the tree.
    const tab = this.tabs.get(id);
    this.win.contentView.removeChildView(tab.view);
    this.win.contentView.addChildView(tab.view);

    this.layout();
    this.emit();
  }

  /** Gibt { ok } zurück, damit ein Fehlschlag den Aufrufer erreicht. */
  navigate(id, input) {
    const tab = this.tabs.get(id);
    if (!tab) return { ok: false, reason: `Kein offener Tab mit der ID ${id}` };
    if (!isSafeNavigationUrl(input)) {
      return { ok: false, reason: `Adresse nicht erlaubt: ${input}` };
    }
    tab.view.webContents.loadURL(input).catch((err) => {
      const why = String(err?.message || err).replace(/^Error:\s*/, '');
      tab.title = 'Seite nicht erreichbar';
      tab.loadError = why;
      tab.loading = false;
      console.error(`[nula] Laden fehlgeschlagen (${input}): ${why}`);
      this.emit();
    });
    return { ok: true };
  }

  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    this.tabs.delete(id);
    if (this.guard) this.guard.forget(id);
    this.order = this.order.filter((t) => t !== id);
    if (this.activeId === id) {
      this.activeId = this.order[this.order.length - 1] || null;
      if (this.activeId) this.activate(this.activeId);
    }
    this.layout();
    this.emit();
  }

  closeAll() {
    for (const id of [...this.order]) this.close(id);
  }

  setVisible(visible) {
    this.visible = visible;
    this.layout();
  }

  withActive(fn) {
    const tab = this.tabs.get(this.activeId);
    if (tab) fn(tab.view.webContents, tab);
  }

  openExternal(url) {
    if (isSafeNavigationUrl(url) && url !== NEW_TAB) shell.openExternal(url);
  }
}

module.exports = { TabManager, CHROME_HEIGHT };
