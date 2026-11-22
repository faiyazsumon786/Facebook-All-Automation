const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const { startServer } = require('../src/server');
const { stopAll } = require('../src/manager');

const { DownloadQueue } = require('../src/downloads');
const { DownloadProvider } = require('./download-provider');
const { ReelDiscovery } = require('./reel-discovery');
const discovery = new ReelDiscovery();
const fs = require('node:fs');
let downloads;
const provider = new DownloadProvider();
app.on('browser-window-created', (_event, win) => {
  if (process.platform === 'win32') win.setIcon(path.join(__dirname, '../gui/app-icon.png'));
});

let mainWindow = null;
let serverHandle = null;

async function boot() {
  let folder = path.join(app.getPath('downloads'), 'Luminous Tech');
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'download-settings.json'), 'utf8'));
    if (typeof saved.folder === 'string' && path.isAbsolute(saved.folder)) folder = saved.folder;
  } catch {}
  downloads = new DownloadQueue({ folder, collect: (...args) => discovery.collect(...args), resolve: (...args) => provider.resolve(...args) });
  serverHandle = await startServer(Number(process.env.PORT || 8899));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 660,
    minWidth: 720,
    minHeight: 500,
    center: true,
    backgroundColor: '#090d16',
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden'
    } : {}),
    title: 'Luminous Tech',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Instantly display local splash screen (0ms wait, no network!)
  mainWindow.loadFile(path.join(__dirname, '../gui/splash.html')).catch(() => {});

  for (const event of ['maximize', 'unmaximize']) mainWindow.on(event, () => {
    mainWindow.webContents.send('window-state', { maximized: mainWindow.isMaximized() });
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function loadMainApp() {
  if (!mainWindow || mainWindow.isDestroyed() || !serverHandle) return;
  const appUrl = `http://127.0.0.1:${serverHandle.port}`;
  mainWindow.loadURL(appUrl);
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== appUrl) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
}

ipcMain.handle('window-control', (event, action) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return;
  if (action === 'minimize') mainWindow.minimize();
  else if (action === 'maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  } else if (action === 'close') { mainWindow.close(); return; }
  return { maximized: mainWindow.isMaximized() };
});

ipcMain.handle('pick-video', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Reels videos',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Videos', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'] }]
  });
  if (res.canceled || !res.filePaths.length) return [];
  return res.filePaths;
});

ipcMain.handle('pick-folder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Video Folder for Auto-Pilot Campaign',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('open-external', (event, url) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Untrusted open request');
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('Invalid URL');
  shell.openExternal(url).catch(() => {});
});

// Only the trusted app renderer can manage local download files.
function downloadHandler(name, callback) {
  ipcMain.handle(name, (event, ...args) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Untrusted download request');
    return callback(...args);
  });
}
downloadHandler('downloads-status', () => downloads.status());
downloadHandler('downloads-start', options => downloads.start(options));
downloadHandler('downloads-cancel', id => downloads.cancel(id));
downloadHandler('downloads-verify', sourceUrl => downloads.preparing ? discovery.show(sourceUrl) : provider.show());
downloadHandler('downloads-folder', async () => {
  if (downloads.status().active) throw new Error('Finish or cancel downloads before changing the folder.');
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Save downloaded videos', defaultPath: downloads.folder, properties: ['openDirectory', 'createDirectory'] });
  if (!result.canceled && result.filePaths[0] && !downloads.status().active) {
    downloads.folder = result.filePaths[0];
    fs.writeFileSync(path.join(app.getPath('userData'), 'download-settings.json'), JSON.stringify({ folder: downloads.folder }));
  }
  return downloads.status();
});
downloadHandler('downloads-open', async id => {
  if (id) {
    const task = downloads.tasks.find(t => t.id === id && t.state === 'completed');
    if (!task || !fs.existsSync(task.file)) throw new Error('Downloaded file is no longer available.');
    shell.showItemInFolder(task.file);
  } else {
    fs.mkdirSync(downloads.folder, { recursive: true });
    const error = await shell.openPath(downloads.folder);
    if (error) throw new Error(error);
  }
});

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    // 1. Immediately create window and show splash screen (no blank black window!)
    createWindow();

    // 2. Boot server and queue in parallel
    await boot();

    // 3. Switch window to main application
    loadMainApp();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        loadMainApp();
      }
    });
  }).catch((err) => {
    fs.writeFileSync(path.join(__dirname, '..', 'electron-error.log'), (err && (err.stack || err.message)) || String(err));
    dialog.showErrorBox('Unable to start Luminous Tech', err.message);
    app.quit();
  });
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let quitting = false;
app.on('before-quit', async (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  try {
    await downloads?.close();
    await stopAll();
  } catch (e) {}
  if (serverHandle && serverHandle.server) {
    try { serverHandle.server.close(); } catch (e) {}
  }
  app.quit();
});
