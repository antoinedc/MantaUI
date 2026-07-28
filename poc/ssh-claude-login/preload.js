'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('poc', {
  connect: (host) => ipcRenderer.invoke('ssh:connect', host),
  input: (text) => ipcRenderer.invoke('ssh:input', text),
  openUrl: (url) => ipcRenderer.invoke('ssh:open-url', url),
  disconnect: () => ipcRenderer.invoke('ssh:disconnect'),
  check: (host) => ipcRenderer.invoke('ssh:check', host),
  onData: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('ssh:data', handler);
    return () => ipcRenderer.removeListener('ssh:data', handler);
  },
  onUrl: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('ssh:url', handler);
    return () => ipcRenderer.removeListener('ssh:url', handler);
  },
  onOpen: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('ssh:open', handler);
    return () => ipcRenderer.removeListener('ssh:open', handler);
  },
  onClosed: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('ssh:closed', handler);
    return () => ipcRenderer.removeListener('ssh:closed', handler);
  },
});
