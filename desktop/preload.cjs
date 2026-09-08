const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tigerGateDesktop', Object.freeze({
  chooseFolders: () => ipcRenderer.invoke('choose-health-folders'),
}));
