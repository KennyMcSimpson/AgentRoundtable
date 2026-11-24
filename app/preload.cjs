// AgentRoundtable desktop app: sandboxed preload (CommonJS). Exposes exactly one object to the page,
// window.roomApp, and nothing else: no Node, no ipcRenderer, no file access.
//
//   roomApp.isApp                      true (ui/lobby.js and ui/app.js switch to the app behaviour)
//   roomApp.pickFolder(defaultPath)    -> Promise<string|null>  native folder picker dialog (main window only)
//   roomApp.copyText(text)             -> Promise<boolean>      system clipboard
//   roomApp.saveEvidence(name, text)   -> Promise<{saved, path} | {saved: false, canceled} | {saved: false, error}>
//                                         native save dialog for Export Evidence (room windows only)
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const str = (v) => String(v === undefined || v === null ? '' : v);

contextBridge.exposeInMainWorld('roomApp', Object.freeze({
  isApp: true,
  pickFolder(defaultPath) {
    return ipcRenderer.invoke('room:pickFolder', typeof defaultPath === 'string' ? defaultPath : null);
  },
  copyText(text) {
    return ipcRenderer.invoke('room:copyText', str(text));
  },
  saveEvidence(name, text) {
    return ipcRenderer.invoke('room:saveEvidence', str(name), str(text));
  },
}));
