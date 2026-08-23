'use strict';

/* Bridge for the browser chrome UI. Explicit surface, no remote module, no Node in the renderer. */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('nula', {
  bootstrap: () => invoke('nula:bootstrap'),
  unlock: (payload) => invoke('nula:unlock', payload),
  lock: () => invoke('nula:lock'),
  activity: () => invoke('nula:activity'),

  tab: {
    create: (url) => invoke('nula:tab:new', url),
    close: (id) => invoke('nula:tab:close', id),
    activate: (id) => invoke('nula:tab:activate', id),
    navigate: (id, input) => invoke('nula:tab:navigate', { id, input }),
    back: () => invoke('nula:tab:back'),
    forward: () => invoke('nula:tab:forward'),
    reload: () => invoke('nula:tab:reload'),
    stop: () => invoke('nula:tab:stop'),
    reopenRemote: (id) => invoke('nula:tab:reopenRemote', id),
  },

  bookmarks: {
    add: (payload) => invoke('nula:bookmark:add', payload),
    remove: (id) => invoke('nula:bookmark:remove', id),
  },

  settings: {
    set: (patch) => invoke('nula:settings:set', patch),
  },

  backup: {
    exportAll: () => invoke('nula:backup:export'),
    importAll: () => invoke('nula:backup:import'),
  },

  sync: {
    now: () => invoke('nula:sync:now'),
  },

  update: {
    check: () => invoke('nula:update:check'),
    install: () => invoke('nula:update:install'),
    download: () => invoke('nula:update:download'),
    setEnabled: (on) => invoke('nula:update:setEnabled', on),
  },

  tokens: {
    list: () => invoke('nula:tokens:list'),
    create: (name) => invoke('nula:tokens:create', name),
    remove: (id) => invoke('nula:tokens:delete', id),
  },

  window: (action) => invoke('nula:window', action),
  panel: (open) => invoke('nula:panel', open),

  on: (event, handler) => {
    const channels = {
      tabs: 'nula:tabs',
      vault: 'nula:vault',
      status: 'nula:status',
      locked: 'nula:locked',
      update: 'nula:update',
      newtab: 'nula:cmd:newtab',
      closetab: 'nula:cmd:closetab',
      focusomni: 'nula:cmd:focusomni',
      bookmarksPanel: 'nula:cmd:bookmarks',
      settingsPanel: 'nula:cmd:settings',
    };
    const channel = channels[event];
    if (!channel) return () => {};
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
