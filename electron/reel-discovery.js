const { BrowserWindow, session } = require('electron');
const { setTimeout: delay } = require('node:timers/promises');
const { extractReelConnection } = require('../src/reel-links');

class ReelDiscovery {
  constructor() { this.windows = new Map(); }
  show(sourceUrl) {
    const win = sourceUrl ? this.windows.get(sourceUrl) : this.windows.values().next().value;
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  }
  async collect(source, signal, progress) {
    signal.throwIfAborted();
    const browserSession = session.fromPartition('facebook-reel-discovery');
    browserSession.setPermissionRequestHandler((_wc, _permission, reply) => reply(false));
    browserSession.setPermissionCheckHandler(() => false);
    const win = new BrowserWindow({ show: false, width: 1000, height: 850, title: 'Facebook Reels discovery', autoHideMenuBar: true,
      webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    this.windows.set(source.url, win);
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (event, url) => { try { const u = new URL(url); if (u.protocol !== 'https:' || !/(^|\.)facebook\.com$/.test(u.hostname)) event.preventDefault(); } catch { event.preventDefault(); } };
    wc.on('will-navigate', guard); wc.on('will-redirect', guard);
    const urls = new Set(), pending = new Set();
    let hasNext = null, found = false, updated = Date.now(), error, authShown = false, domReady = false, htmlRead = false;
    wc.on('dom-ready', () => { domReady = true; htmlRead = false; });
    const ingest = text => {
      const result = extractReelConnection(text, source.id);
      if (!result.found) return;
      found = true;
      const previousCount = urls.size;
      for (const url of result.urls) urls.add(url);
      if (result.hasNext !== null) hasNext = result.hasNext;
      if (urls.size > previousCount) updated = Date.now();
      progress({ state: 'extracting', count: urls.size });
    };
    const abort = () => { if (!win.isDestroyed()) win.destroy(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await wc.loadURL('about:blank');
      signal.throwIfAborted();
      domReady = false; htmlRead = false;
      wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Network.enable');
      wc.debugger.on('message', (_event, method, params) => {
        if (method === 'Network.responseReceived') {
          try {
            const u = new URL(params.response.url);
            if (/(^|\.)facebook\.com$/.test(u.hostname) && (params.type === 'Document' || u.pathname.startsWith('/api/graphql'))) pending.add(params.requestId);
          } catch {}
        }
        if (method === 'Network.loadingFinished' && pending.delete(params.requestId)) {
          wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId }).then(body => {
            if (!signal.aborted) ingest(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body);
          }).catch(() => {});
        }
        if (method === 'Network.loadingFailed') pending.delete(params.requestId);
      });
      wc.loadURL(source.url).catch(e => { error = e; });
      const started = Date.now();
      while (true) {
        signal.throwIfAborted();
        if (win.isDestroyed()) throw new Error('Facebook window closed. Retry the profile.');
        if (error) throw new Error('Could not open Facebook. Check the connection and retry.');
        if (domReady && !htmlRead) {
          ingest(await wc.executeJavaScript('document.documentElement.outerHTML'));
          htmlRead = true;
        }
        if (found && hasNext === false) return { urls: [...urls], complete: true };
        if (!found && Date.now() - started > 10000 && !authShown) {
          authShown = true;
          this.show(source.url);
          progress({ state: 'verification', count: urls.size, message: 'Open the Reels tab or complete Facebook login/verification in the window.' });
        }
        if (found && Date.now() - updated > 20000 && (!pending.size || Date.now() - updated > 90000)) return { urls: [...urls], complete: false, message: 'Facebook stopped loading more Reels. This may be a partial list; retry the profile to collect more.' };
        if (!found && Date.now() - started > 5 * 60 * 1000) throw new Error('Could not read this profile’s Reels. Login or verification may be required.');
        if (found) {
          await wc.executeJavaScript(`(() => { const main = document.querySelector('[role="main"]') || document.body;
            const containers = [document.scrollingElement, ...main.querySelectorAll('div')].filter(e => e && e.scrollHeight > e.clientHeight + 100 && (e === document.scrollingElement || /auto|scroll/.test(getComputedStyle(e).overflowY)));
            for (const e of containers) e.scrollTop = e.scrollHeight;
          })()`);
        }
        await delay(1200, undefined, { signal });
      }
    } finally {
      signal.removeEventListener('abort', abort);
      if (!win.isDestroyed()) win.destroy();
      if (this.windows.get(source.url) === win) this.windows.delete(source.url);
    }
  }
}
module.exports = { ReelDiscovery };
