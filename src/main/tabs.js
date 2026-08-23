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

class TabManager {
  constructor(win, session, onChange) {
    this.win = win;
    this.session = session;
    this.onChange = onChange;
    this.tabs = new Map(); // id -> { id, view, url, title, loading, canGoBack, canGoForward, pinned }
    this.order = [];
    this.activeId = null;
    this.visible = true;
  }

  bounds() {
    const [width, height] = this.win.getContentSize();
    return { x: 0, y: CHROME_HEIGHT, width, height: Math.max(0, height - CHROME_HEIGHT) };
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
      if (!isSafeNavigationUrl(target)) event.preventDefault();
    };
    wc.on('will-navigate', guardNavigation);
    wc.on('will-redirect', guardNavigation);

    // Popups open as regular tabs; external protocols never touch the OS silently.
    wc.setWindowOpenHandler(({ url: target }) => {
      if (isSafeNavigationUrl(target) && target !== NEW_TAB) this.emitNewTabRequest(target);
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

  navigate(id, input) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (!isSafeNavigationUrl(input)) return;
    tab.view.webContents.loadURL(input).catch(() => {
      tab.title = 'Seite nicht erreichbar';
      tab.loading = false;
      this.emit();
    });
  }

  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    this.tabs.delete(id);
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
