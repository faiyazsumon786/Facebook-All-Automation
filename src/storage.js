const path = require('path');
const fs = require('fs');

// Development and CLI runs keep using the original workspace.
const projectRoot = path.resolve(__dirname, '..');
const packaged = process.type === 'browser' && require('electron').app.isPackaged;
const appData = process.env.LOCALAPPDATA || require('electron').app.getPath('appData');
const legacyRoot = path.join(appData, 'Facebook Reels Kit', 'Workspace');
const storageRoot = packaged
  ? (fs.existsSync(legacyRoot) ? legacyRoot : path.join(appData, 'AdXtreme Reels Kit', 'Workspace'))
  : projectRoot;

module.exports = { storageRoot, packaged };
