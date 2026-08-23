'use strict';

/* Nula chrome UI. No framework, no build step: this file owns all rendering. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const ui = {
  tabs: [],
  activeId: null,
  bookmarks: [],
  remoteTabs: [],
  settings: {},
  status: { locked: true, sync: { state: 'idle' }, blocked: 0 },
  omniDirty: false,
  panelView: 'bookmarks',
  version: null,
  announcedUpdate: null,
  bmFilter: '',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toast(message, isError = false) {
  const el = $('#toast');
  el.innerHTML = `<i class="ph ${isError ? 'ph-warning-circle' : 'ph-check-circle'}"></i><span></span>`;
  el.querySelector('span').textContent = message;
  el.classList.toggle('is-error', isError);
  el.classList.add('is-visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('is-visible'), 3200);
}

function prettyUrl(url) {
  if (!url) return '';
  if (url.startsWith('nula://')) return '';
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname) + u.search;
  } catch {
    return url;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url || '';
  }
}

/*
 * Ein Fehler im Renderer blieb bisher vollständig unsichtbar: kein Menüeintrag
 * für die Entwicklerwerkzeuge, keine Meldung im Fenster. Genau deshalb sah ein
 * kaputter Render-Durchlauf aus wie "es passiert einfach nichts".
 */
function reportRendererError(what) {
  const message = what?.message || String(what || 'Unbekannter Fehler');
  console.error('[nula] Renderer-Fehler:', what);
  try {
    toast(`Fehler in der Oberfläche: ${message}`, true);
  } catch {
    /* Wenn selbst der Toast nicht geht, bleibt nur die Konsole. */
  }
}

window.addEventListener('error', (e) => reportRendererError(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportRendererError(e.reason));

/**
 * Führt einen Handler aus, ohne dass sein Scheitern die folgenden mitreißt.
 * Ein IPC-Ereignis ruft mehrere Render-Funktionen nacheinander auf; ohne diese
 * Klammer beendet die erste Ausnahme den ganzen Durchlauf, und zwar bei jedem
 * weiteren Ereignis erneut.
 */
function safely(name, fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      reportRendererError(new Error(`${name}: ${err?.message || err}`));
      return undefined;
    }
  };
}

async function call(promise, { silent = false, slowAfterMs = 8000 } = {}) {
  // Antwortet der Hauptprozess gar nicht, gab es bisher keinerlei Rückmeldung.
  const slow =
    slowAfterMs > 0
      ? setTimeout(() => toast('Der Hauptprozess antwortet nicht.', true), slowAfterMs)
      : null;
  let res;
  try {
    res = await promise;
  } catch (err) {
    res = { ok: false, error: err?.message || 'Interner Fehler' };
  } finally {
    if (slow) clearTimeout(slow);
  }
  if (!res.ok && !silent) toast(res.error, true);
  return res;
}

// ---------------------------------------------------------------------------
// Tab strip
// ---------------------------------------------------------------------------

function renderTabs() {
  const host = $('#tabs');
  host.innerHTML = '';
  for (const tab of ui.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === ui.activeId ? ' is-active' : '') + (tab.loading ? ' is-loading' : '');
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(tab.id === ui.activeId));
    el.title = tab.title || '';

    const icon = document.createElement(tab.favicon && !tab.loading ? 'img' : 'span');
    icon.className = 'tab-favicon' + (tab.favicon && !tab.loading ? '' : ' placeholder');
    if (tab.favicon && !tab.loading) {
      icon.src = tab.favicon;
      icon.alt = '';
      icon.onerror = () => {
        icon.replaceWith(Object.assign(document.createElement('span'), { className: 'tab-favicon placeholder' }));
      };
    }

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || hostOf(tab.url) || 'Neuer Tab';

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.setAttribute('aria-label', 'Tab schließen');
    close.innerHTML = '<i class="ph ph-x"></i>';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      call(window.nula.tab.close(tab.id));
    });

    el.append(icon, title, close);
    el.addEventListener('click', () => call(window.nula.tab.activate(tab.id)));
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) call(window.nula.tab.close(tab.id));
    });
    host.appendChild(el);
  }
}

function renderToolbar() {
  const active = ui.tabs.find((t) => t.id === ui.activeId);
  $('#btn-back').disabled = !active?.canGoBack;
  $('#btn-forward').disabled = !active?.canGoForward;

  const reload = $('#btn-reload');
  reload.innerHTML = active?.loading ? '<i class="ph ph-x"></i>' : '<i class="ph ph-arrow-clockwise"></i>';
  reload.title = active?.loading ? 'Laden abbrechen' : 'Neu laden';

  const bar = $('#loadbar');
  if (active?.loading) {
    bar.classList.add('is-active');
    bar.style.width = '72%';
  } else {
    bar.style.width = '100%';
    setTimeout(() => {
      bar.classList.remove('is-active');
      bar.style.width = '0';
    }, 220);
  }

  if (!ui.omniDirty && document.activeElement !== $('#omni-input')) {
    const url = active?.url || '';
    $('#omni-input').value = url.startsWith('nula://') ? '' : url;
    const scheme = $('#omni-scheme');
    if (!url || url.startsWith('nula://')) {
      scheme.className = 'omni-scheme neutral';
      scheme.innerHTML = '<i class="ph ph-magnifying-glass"></i>';
    } else if (url.startsWith('https://')) {
      scheme.className = 'omni-scheme';
      scheme.innerHTML = '<i class="ph ph-lock-simple"></i>';
    } else {
      scheme.className = 'omni-scheme insecure';
      scheme.innerHTML = '<i class="ph ph-lock-simple-open"></i>';
    }
  }

  const bookmarked = active && ui.bookmarks.some((b) => b.url === active.url);
  $('#btn-bookmark').classList.toggle('is-on', !!bookmarked);
  $('#btn-bookmark').innerHTML = bookmarked
    ? '<i class="ph ph-bookmark-simple" style="font-weight:700"></i>'
    : '<i class="ph ph-bookmark-simple"></i>';
}

// ---------------------------------------------------------------------------
// Panel: bookmarks
// ---------------------------------------------------------------------------

function renderBookmarks() {
  const host = $('#bm-list');
  const filter = ui.bmFilter.toLowerCase();
  const list = ui.bookmarks
    .filter((b) => !filter || (b.title + ' ' + b.url).toLowerCase().includes(filter))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  if (!list.length) {
    host.innerHTML = filter
      ? `<div class="empty"><i class="ph ph-magnifying-glass"></i><p>Keine Treffer für "${escapeHtml(ui.bmFilter)}".</p></div>`
      : `<div class="empty"><i class="ph ph-bookmark-simple"></i><p>Noch keine Lesezeichen. Speichere die aktuelle Seite über das Symbol in der Adressleiste.</p></div>`;
    return;
  }

  host.innerHTML = '';
  for (const bm of list) {
    const el = document.createElement('div');
    el.className = 'entry';

    const icon = document.createElement('span');
    icon.className = 'entry-icon';
    icon.innerHTML = '<i class="ph ph-globe-simple"></i>';

    const text = document.createElement('div');
    text.className = 'entry-text';
    const t = document.createElement('span');
    t.className = 'entry-title';
    t.textContent = bm.title || bm.url;
    const s = document.createElement('span');
    s.className = 'entry-sub';
    s.textContent = bm.folder ? `${prettyUrl(bm.url)} · ${bm.folder}` : prettyUrl(bm.url);
    text.append(t, s);

    const del = document.createElement('button');
    del.className = 'entry-del';
    del.setAttribute('aria-label', 'Lesezeichen löschen');
    del.innerHTML = '<i class="ph ph-trash"></i>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      call(window.nula.bookmarks.remove(bm.id));
    });

    el.append(icon, text, del);
    el.addEventListener('click', () => {
      call(window.nula.tab.create(bm.url));
      closePanel();
    });
    host.appendChild(el);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Panel: devices
// ---------------------------------------------------------------------------

function renderDevices() {
  const host = $('#dev-list');
  if (!ui.remoteTabs.length) {
    host.innerHTML = `<div class="empty"><i class="ph ph-devices"></i><p>Auf anderen Geräten sind gerade keine Tabs offen. Entsperre Nula dort mit demselben Passwort.</p></div>`;
    return;
  }

  const groups = new Map();
  for (const tab of ui.remoteTabs) {
    // Ein Tab ohne deviceId liess hier bisher die ganze Render-Kette auflaufen.
    const device = typeof tab.deviceId === 'string' && tab.deviceId ? tab.deviceId : 'unbekannt';
    const key = device === 'inbox' ? 'Über die API hinzugefügt' : `Gerät ${device.slice(0, 6)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tab);
  }

  host.innerHTML = '';
  for (const [label, tabs] of groups) {
    const heading = document.createElement('div');
    heading.className = 'group-label';
    heading.textContent = `${label} · ${tabs.length}`;
    host.appendChild(heading);

    for (const tab of tabs) {
      const el = document.createElement('div');
      el.className = 'entry';
      el.innerHTML = `<span class="entry-icon"><i class="ph ph-monitor"></i></span>
        <div class="entry-text"><span class="entry-title"></span><span class="entry-sub"></span></div>
        <span class="entry-del" aria-hidden="true"><i class="ph ph-arrow-up-right"></i></span>`;
      el.querySelector('.entry-title').textContent = tab.title || tab.url;
      el.querySelector('.entry-sub').textContent = prettyUrl(tab.url);
      el.addEventListener('click', () => {
        call(window.nula.tab.reopenRemote(tab.id));
        closePanel();
      });
      host.appendChild(el);
    }
  }
}

// ---------------------------------------------------------------------------
// Panel: settings
// ---------------------------------------------------------------------------

function renderSettings() {
  $('#set-engine').value = ui.settings.searchEngine || 'duckduckgo';
  $('#set-autolock').value = String(ui.settings.autoLockMinutes ?? 15);
  $('#set-blocker').checked = ui.settings.blockTrackers !== false;
  $('#set-theme').checked = ui.settings.theme === 'light';
  document.documentElement.dataset.theme = ui.settings.theme === 'light' ? 'light' : 'dark';

  $('#stat-blocked').textContent = new Intl.NumberFormat('de-DE').format(ui.status.blocked || 0);
  $('#stat-device').textContent = ui.status.device || '-';
  $('#stat-server').textContent = ui.status.serverUrl ? hostOf(ui.status.serverUrl) : '-';
}

// ---------------------------------------------------------------------------
// Panel: API tokens
// ---------------------------------------------------------------------------

async function renderTokens() {
  const host = $('#token-list');
  host.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  const res = await window.nula.tokens.list();
  if (!res.ok) {
    host.innerHTML = `<div class="error-box"><i class="ph ph-warning-circle"></i><span></span></div>`;
    host.querySelector('span').textContent = res.error;
    return;
  }
  const tokens = res.data.tokens || [];
  if (!tokens.length) {
    host.innerHTML = `<div class="empty"><i class="ph ph-key"></i><p>Noch keine Tokens. Erstelle unten eins, um Nula von außen zu befüllen.</p></div>`;
    return;
  }

  host.innerHTML = '';
  for (const t of tokens) {
    const card = document.createElement('div');
    card.className = 'token-card';
    card.innerHTML = `<div class="token-top">
        <span class="token-name"></span>
        <button class="entry-del" style="opacity:1" aria-label="Token widerrufen"><i class="ph ph-trash"></i></button>
      </div>
      <div class="token-meta"></div>`;
    card.querySelector('.token-name').textContent = t.name;
    card.querySelector('.token-meta').textContent = t.lastUsedAt
      ? `Zuletzt genutzt ${new Date(t.lastUsedAt).toLocaleString('de-DE')}`
      : `Erstellt ${new Date(t.createdAt).toLocaleDateString('de-DE')}, noch nicht genutzt`;
    card.querySelector('button').addEventListener('click', async () => {
      const res = await call(window.nula.tokens.remove(t.id));
      if (res.ok) {
        toast('Token widerrufen');
        renderTokens();
      }
    });
    host.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// Panel plumbing
// ---------------------------------------------------------------------------

function openPanel(view) {
  ui.panelView = view || ui.panelView;
  $$('.panel-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.view === ui.panelView));
  $$('.panel-view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === ui.panelView));
  const panel = $('#panel');
  panel.hidden = false;
  requestAnimationFrame(() => panel.classList.add('is-open'));
  // Der Hauptprozess muss der nativen Tab-Ansicht Platz abziehen, sonst liegt
  // das Panel dahinter.
  call(window.nula.panel(true), { silent: true, slowAfterMs: 0 });
  if (ui.panelView === 'api') renderTokens();
  if (ui.panelView === 'settings') renderSettings();
  if (ui.panelView === 'devices') renderDevices();
  if (ui.panelView === 'bookmarks') renderBookmarks();
}

function closePanel() {
  $('#panel').classList.remove('is-open');
  call(window.nula.panel(false), { silent: true, slowAfterMs: 0 });
}

function togglePanel(view) {
  const panel = $('#panel');
  if (panel.classList.contains('is-open') && ui.panelView === view) closePanel();
  else openPanel(view);
}

// ---------------------------------------------------------------------------
// Lock screen
// ---------------------------------------------------------------------------

/** Blendet das Setup-Code-Feld wieder ein, etwa zur Schlüsselreparatur. */
function revealSetupField(focus) {
  $('#lock-setup-field').hidden = false;
  $('#lock-setup-toggle').hidden = true;
  if (focus) $('#lock-setup-token').focus();
}

function showLock(message) {
  $('#lock').classList.remove('is-hidden');
  $('#lock-pass').value = '';
  const err = $('#lock-error');
  if (message) {
    err.textContent = message;
    err.hidden = false;
  } else {
    err.hidden = true;
  }
  setTimeout(() => $('#lock-pass').focus(), 60);
}

function hideLock() {
  $('#lock').classList.add('is-hidden');
  $('#lock-error').hidden = true;
}

/** Say plainly what the checkbox does, so nobody has to guess. */
function updateRememberHint() {
  const remember = $('#lock-remember').checked;
  const hint = $('#server-hint');
  if (remember) {
    hint.textContent = $('#lock-server').value
      ? 'Wird in ~/.nula/config.json abgelegt, damit du sie nicht jedes Mal eintippen musst.'
      : 'Adresse deines eigenen Nula-Servers.';
  } else {
    hint.textContent = 'Bleibt nur im Arbeitsspeicher. Beim nächsten Start ist das Feld wieder leer.';
  }
}

async function submitUnlock(e) {
  e.preventDefault();
  const btn = $('#btn-unlock');
  const label = btn.querySelector('.btn-label');
  const err = $('#lock-error');
  err.hidden = true;
  btn.classList.add('is-busy');
  btn.disabled = true;
  // Argon2id needs about a second by design, so say what is happening.
  label.textContent = 'Schlüssel werden abgeleitet';

  const res = await window.nula.unlock({
    serverUrl: $('#lock-server').value,
    password: $('#lock-pass').value,
    setupToken: $('#lock-setup-token').value,
    rememberUrl: $('#lock-remember').checked,
  });

  btn.classList.remove('is-busy');
  btn.disabled = false;
  label.textContent = 'Entsperren';

  if (!res.ok) {
    err.textContent = res.error;
    err.hidden = false;
    // Verlangt der Server den Code doch, nuetzt eine blosse Meldung nichts,
    // solange das Feld eingeklappt ist.
    if (/Setup-Code/i.test(res.error || '')) revealSetupField(true);
    else $('#lock-pass').select();
    return;
  }

  $('#lock-pass').value = '';
  $('#lock-setup-token').value = '';
  hideLock();
  if (res.data?.firstRun) toast('Konto angelegt. Dieses Passwort ist ab jetzt der einzige Schlüssel.');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** Zeigt an, wo die Selbstaktualisierung gerade steht. */
function renderUpdate(update) {
  if (!update) return;
  const text = $('#update-status');
  const install = $('#update-install');
  const check = $('#update-check');
  const version = ui.version ? `Version ${ui.version}` : 'Diese Version';

  const messages = {
    dev: 'Im Entwicklungsmodus wird nicht nach Updates gesucht.',
    off: `${version} · automatische Suche ist aus`,
    idle: `${version} · noch nicht geprüft`,
    checking: 'Suche nach Updates …',
    current: `${version} · aktuell`,
    downloading: `Version ${update.version || ''} wird geladen … ${update.percent || 0} %`,
    ready: `Version ${update.version || ''} ist bereit`,
    // macOS: gefunden, aber ohne Signatur nicht selbst installierbar.
    manual: `Version ${update.version || ''} ist verfügbar`,
    error: update.detail || 'Die Update-Suche ist fehlgeschlagen.',
  };
  text.textContent = messages[update.state] || messages.idle;
  text.classList.toggle('is-error', update.state === 'error');

  install.hidden = update.state !== 'ready';
  $('#update-download').hidden = update.state !== 'manual';
  check.disabled = update.state === 'checking' || update.state === 'downloading';

  // Ein fertiges Update stand bisher nur in dieser Karte. Wer sie nicht oeffnet,
  // erfuhr nie davon - die App "sagte einfach nichts". Deshalb ein Abzeichen am
  // Einstellungen-Knopf und genau eine Meldung je Version.
  const waiting = update.state === 'ready' || update.state === 'manual';
  $('#update-badge').hidden = !waiting;
  if (waiting && update.version && ui.announcedUpdate !== update.version) {
    ui.announcedUpdate = update.version;
    toast(
      update.state === 'ready'
        ? `Version ${update.version} ist bereit — Einstellungen öffnen zum Installieren`
        : `Version ${update.version} ist verfügbar — Einstellungen öffnen zum Laden`
    );
  }
  if (!waiting) ui.announcedUpdate = null;
}

function wire() {
  // Window controls
  $$('[data-win]').forEach((b) => b.addEventListener('click', () => window.nula.window(b.dataset.win)));

  // Navigation
  $('#btn-back').addEventListener('click', () => call(window.nula.tab.back()));
  $('#btn-forward').addEventListener('click', () => call(window.nula.tab.forward()));
  $('#btn-reload').addEventListener('click', () => {
    const active = ui.tabs.find((t) => t.id === ui.activeId);
    call(active?.loading ? window.nula.tab.stop() : window.nula.tab.reload());
  });
  $('#btn-newtab').addEventListener('click', () => call(window.nula.tab.create()).then(focusOmni));

  // Omnibox
  const omni = $('#omni-input');
  omni.addEventListener('input', () => (ui.omniDirty = true));
  omni.addEventListener('focus', () => omni.select());
  omni.addEventListener('blur', () => {
    ui.omniDirty = false;
    renderToolbar();
  });
  omni.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      ui.omniDirty = false;
      omni.blur();
      call(window.nula.tab.navigate(ui.activeId, omni.value));
    } else if (e.key === 'Escape') {
      ui.omniDirty = false;
      omni.blur();
      renderToolbar();
    }
  });

  // Bookmark toggle
  $('#btn-bookmark').addEventListener('click', async () => {
    const active = ui.tabs.find((t) => t.id === ui.activeId);
    const existing = active && ui.bookmarks.find((b) => b.url === active.url);
    if (existing) {
      const res = await call(window.nula.bookmarks.remove(existing.id));
      if (res.ok) toast('Lesezeichen entfernt');
    } else {
      const res = await call(window.nula.bookmarks.add({}));
      if (res.ok) toast('Lesezeichen gespeichert');
    }
  });

  // Sync + panels + lock
  $('#btn-sync').addEventListener('click', async () => {
    const res = await call(window.nula.sync.now());
    if (res.ok) {
      const n = res.data?.inboxApplied || 0;
      toast(n ? `Synchronisiert, ${n} neue Einträge über die API` : 'Synchronisiert');
    }
  });
  $('#btn-panel-bookmarks').addEventListener('click', () => togglePanel('bookmarks'));
  $('#btn-panel-settings').addEventListener('click', () => togglePanel('settings'));
  $('#btn-panel-close').addEventListener('click', closePanel);
  $('#btn-lock').addEventListener('click', () => window.nula.lock());
  $$('.panel-tab').forEach((b) => b.addEventListener('click', () => openPanel(b.dataset.view)));

  // Bookmarks panel
  $('#bm-search').addEventListener('input', (e) => {
    ui.bmFilter = e.target.value;
    renderBookmarks();
  });
  $('#bm-add-current').addEventListener('click', async () => {
    const res = await call(window.nula.bookmarks.add({}));
    if (res.ok) toast('Lesezeichen gespeichert');
  });

  // Settings
  $('#set-engine').addEventListener('change', (e) => window.nula.settings.set({ searchEngine: e.target.value }));
  $('#set-autolock').addEventListener('change', (e) =>
    window.nula.settings.set({ autoLockMinutes: parseInt(e.target.value, 10) })
  );
  $('#set-blocker').addEventListener('change', (e) => window.nula.settings.set({ blockTrackers: e.target.checked }));
  $('#set-theme').addEventListener('change', (e) => {
    document.documentElement.dataset.theme = e.target.checked ? 'light' : 'dark';
    window.nula.settings.set({ theme: e.target.checked ? 'light' : 'dark' });
  });
  $('#update-check').addEventListener('click', async () => {
    const btn = $('#update-check');
    btn.disabled = true;
    const res = await call(window.nula.update.check());
    btn.disabled = false;
    if (res.ok && res.data) renderUpdate(res.data);
  });
  $('#update-install').addEventListener('click', async () => {
    const btn = $('#update-install');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Wird vorbereitet …';
    const res = await call(window.nula.update.install());
    // Klappt es, ist das Fenster gleich weg. Sonst zuruecksetzen.
    if (!res.ok) {
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Neu starten und installieren';
    }
  });
  $('#update-download').addEventListener('click', async () => {
    await call(window.nula.update.download());
  });
  $('#update-auto').addEventListener('change', async (e) => {
    const res = await call(window.nula.update.setEnabled(e.target.checked));
    if (res.ok && res.data) renderUpdate(res.data);
  });
  $('#backup-export').addEventListener('click', async () => {
    const btn = $('#backup-export');
    const label = btn.querySelector('span');
    btn.disabled = true;
    label.textContent = 'Backup wird erstellt';
    const res = await call(window.nula.backup.exportAll(), { slowAfterMs: 0 });
    btn.disabled = false;
    label.textContent = 'Backup exportieren';
    if (!res.ok || res.data?.canceled) return;
    const counts = res.data.counts;
    const unavailable = res.data.unavailable || [];
    const total = counts.tabs + counts.bookmarks + counts.notes;
    const suffix = unavailable.length ? ' (Server-Metadaten teilweise nicht erreichbar)' : '';
    toast(`${res.data.fileName}: ${total} Vault-Einträge exportiert${suffix}`);
  });
  $('#backup-import').addEventListener('click', async () => {
    const btn = $('#backup-import');
    const label = btn.querySelector('span');
    btn.disabled = true;
    label.textContent = 'Backup wird gelesen';
    const res = await call(window.nula.backup.importAll(), { slowAfterMs: 0 });
    btn.disabled = false;
    label.textContent = 'Backup importieren';
    if (!res.ok || res.data?.canceled) return;
    // added zählt bereits alles, was im Vault gelandet ist, die entsiegelten
    // Inbox-Einträge eingeschlossen. Sie noch einmal zu addieren wäre doppelt.
    const added = res.data.added || { tabs: 0, bookmarks: 0, notes: 0 };
    const removed = res.data.removed || { tabs: 0, bookmarks: 0, notes: 0 };
    const total = added.tabs + added.bookmarks + added.notes;
    const gone = removed.tabs + removed.bookmarks + removed.notes;
    const parts = [total === 1 ? '1 neuer Eintrag' : `${total} neue Einträge`];
    if (gone) parts.push(gone === 1 ? '1 gelöschter übernommen' : `${gone} Löschungen übernommen`);
    if (res.data.inboxApplied) parts.push(`davon ${res.data.inboxApplied} aus der Inbox`);
    if (res.data.settingsRestored) parts.push('Einstellungen übernommen');
    if (res.data.pendingUpload) parts.push('Upload steht noch aus');
    toast(`${res.data.fileName}: ${parts.join(', ')}`);
  });

  // Tokens
  $('#token-create').addEventListener('click', async () => {
    const name = $('#token-name').value.trim();
    const btn = $('#token-create');
    btn.classList.add('is-busy');
    btn.disabled = true;
    const res = await call(window.nula.tokens.create(name || 'Unbenannt'));
    btn.classList.remove('is-busy');
    btn.disabled = false;
    if (!res.ok) return;
    $('#token-name').value = '';
    const reveal = $('#token-reveal');
    reveal.hidden = false;
    reveal.innerHTML = `<div class="token-card">
        <div class="token-top"><span class="token-name"></span></div>
        <div class="token-meta">Einmalig sichtbar. Jetzt kopieren und sicher ablegen.</div>
        <div class="token-secret"></div>
      </div>`;
    reveal.querySelector('.token-name').textContent = res.data.name;
    reveal.querySelector('.token-secret').textContent = res.data.token;
    renderTokens();
  });

  // Lock screen
  $('#lock-form').addEventListener('submit', submitUnlock);
  $('#lock-setup-toggle').addEventListener('click', () => revealSetupField(true));
  $('#lock-remember').addEventListener('change', updateRememberHint);
  $('#btn-reveal').addEventListener('click', () => {
    const input = $('#lock-pass');
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    $('#btn-reveal').innerHTML = shown ? '<i class="ph ph-eye"></i>' : '<i class="ph ph-eye-slash"></i>';
    input.focus();
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'l' && !e.shiftKey) {
      e.preventDefault();
      focusOmni();
    } else if (mod && e.key.toLowerCase() === 't') {
      e.preventDefault();
      call(window.nula.tab.create()).then(focusOmni);
    } else if (mod && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      if (ui.activeId) call(window.nula.tab.close(ui.activeId));
    } else if (mod && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      togglePanel('bookmarks');
    } else if (e.key === 'Escape') {
      closePanel();
    } else if (mod && e.key === 'Tab') {
      e.preventDefault();
      const i = ui.tabs.findIndex((t) => t.id === ui.activeId);
      const next = ui.tabs[(i + (e.shiftKey ? -1 : 1) + ui.tabs.length) % ui.tabs.length];
      if (next) call(window.nula.tab.activate(next.id));
    }
  });

  // Keep the auto-lock timer honest about real activity.
  let lastPing = 0;
  const ping = () => {
    const now = Date.now();
    if (now - lastPing > 30000) {
      lastPing = now;
      window.nula.activity();
    }
  };
  document.addEventListener('mousemove', ping, { passive: true });
  document.addEventListener('keydown', ping);
}

function focusOmni() {
  const omni = $('#omni-input');
  omni.focus();
  omni.select();
}

// ---------------------------------------------------------------------------
// Main-process events
// ---------------------------------------------------------------------------

function subscribe() {
  window.nula.on('tabs', safely('tabs', (payload) => {
    ui.tabs = payload.tabs;
    ui.activeId = payload.activeId;
    renderTabs();
    renderToolbar();
  }));

  window.nula.on('vault', safely('vault', (payload) => {
    ui.bookmarks = payload.bookmarks || [];
    ui.remoteTabs = payload.remoteTabs || [];
    ui.settings = payload.settings || {};
    renderBookmarks();
    renderDevices();
    renderSettings();
    renderToolbar();
  }));

  window.nula.on('status', safely('status', (payload) => {
    ui.status = payload;
    const dot = $('#sync-dot');
    const label = $('#sync-label');
    const map = { idle: 'Bereit', syncing: 'Sync läuft', synced: 'Synchron', error: 'Sync-Fehler' };
    dot.dataset.state = payload.sync?.state || 'idle';
    label.textContent = map[payload.sync?.state] || 'Bereit';
    $('#btn-sync').title = payload.sync?.detail || 'Jetzt synchronisieren';
    if ($('#panel').classList.contains('is-open') && ui.panelView === 'settings') renderSettings();
  }));

  window.nula.on('update', safely('update', (payload) => renderUpdate(payload)));
  window.nula.on('locked', safely('locked', (payload) => {
    ui.tabs = [];
    ui.activeId = null;
    ui.bookmarks = [];
    ui.remoteTabs = [];
    renderTabs();
    renderToolbar();
    closePanel();
    showLock(payload?.reason === 'auto' ? 'Automatisch gesperrt nach Inaktivität.' : null);
  }));

  window.nula.on('newtab', () => call(window.nula.tab.create()).then(focusOmni));
  window.nula.on('closetab', () => ui.activeId && call(window.nula.tab.close(ui.activeId)));
  window.nula.on('focusomni', focusOmni);
  window.nula.on('bookmarksPanel', () => togglePanel('bookmarks'));
  window.nula.on('settingsPanel', () => togglePanel('settings'));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  wire();
  subscribe();

  const res = await call(window.nula.bootstrap(), { silent: true });
  if (res.ok) {
    document.body.dataset.platform = res.data.platform;
    ui.version = res.data.version || null;
    // Wer sich hier schon einmal angemeldet hat, braucht den Setup-Code nicht
    // mehr. Er bleibt über den Link erreichbar, falls doch.
    const setupDone = res.data.setupDone === true;
    $('#lock-setup-field').hidden = setupDone;
    $('#lock-setup-toggle').hidden = !setupDone;
    $('#update-auto').checked = res.data.autoUpdate !== false;
    renderUpdate(res.data.update);
    $('#lock-remember').checked = res.data.rememberServerUrl !== false;
    if (res.data.serverUrl) {
      $('#lock-server').value = res.data.serverUrl;
      $('#server-hint').textContent = 'Gespeicherte Adresse. Änderbar, falls dein Server umgezogen ist.';
    } else if (res.data.rememberServerUrl === false) {
      $('#server-hint').textContent = 'Wird nicht gespeichert und muss jedes Mal eingetragen werden.';
    }
    updateRememberHint();
    if (!res.data.locked) {
      hideLock();
      return;
    }
  }
  showLock();
})();
