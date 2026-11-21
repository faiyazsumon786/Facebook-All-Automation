const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fsApp', {
  apiBase: `http://127.0.0.1:${process.env.PORT || 8899}`,
  isElectron: true,
  integratedTitleBar: process.platform === 'win32',
  windowControl: action => ipcRenderer.invoke('window-control', action),
  onWindowState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('window-state', listener);
    return () => ipcRenderer.removeListener('window-state', listener);
  },
  downloads: {
    status: () => ipcRenderer.invoke('downloads-status'),
    start: options => ipcRenderer.invoke('downloads-start', options),
    cancel: id => ipcRenderer.invoke('downloads-cancel', id),
    folder: () => ipcRenderer.invoke('downloads-folder'),
    open: id => ipcRenderer.invoke('downloads-open', id),
    verify: sourceUrl => ipcRenderer.invoke('downloads-verify', sourceUrl)
  },
  pickVideo: () => ipcRenderer.invoke('pick-video'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openExternal: url => ipcRenderer.invoke('open-external', url)
});
