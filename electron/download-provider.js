const { BrowserWindow, session } = require('electron');
const { setTimeout: delay } = require('node:timers/promises');
const { chooseQuality } = require('../src/downloads');

// The captured provider uses a normal form POST with a fresh Turnstile token.
// Let its own page generate that token; never replay captured cookies or tokens.
class DownloadProvider {
  constructor() { this.tail = Promise.resolve(); this.window = null; }
  show() { if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); } }
  resolve(url, quality, signal, state) {
    state('waiting');
    const result = this.tail.then(() => this.visit(url, quality, signal, state));
    this.tail = result.catch(() => {});
    return result;
  }
  async visit(url, quality, signal, state) {
    signal.throwIfAborted();
    state('resolving');
    const providerSession = session.fromPartition('video-download-provider');
    providerSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    providerSession.setPermissionCheckHandler(() => false);
    const win = new BrowserWindow({ show: false, width: 920, height: 760, title: 'Video provider verification', autoHideMenuBar: true,
      webPreferences: { session: providerSession, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    this.window = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (event, target) => {
      try { if (new URL(target).origin !== 'https://fdown.net') event.preventDefault(); }
      catch { event.preventDefault(); }
    };
    win.webContents.on('will-navigate', guard);
    win.webContents.on('will-redirect', guard);
    win.webContents.session.on('will-download', preventDownload);
    const abort = () => { if (!win.isDestroyed()) win.destroy(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      let loadError;
      win.loadURL('https://fdown.net/').catch(error => { loadError = error; });
      const started = Date.now();
      let submitted = false, submittedAt = 0;
      while (Date.now() - started < 180000) {
        signal.throwIfAborted();
        if (win.isDestroyed()) throw new Error('Verification window closed. Retry the video.');
        if (loadError) throw new Error('Could not reach fdown.net. Check your connection and retry.');
        const page = await win.webContents.executeJavaScript(`(() => {
          const form = document.querySelector('#downloadform');
          const token = document.querySelector('[name="cf-turnstile-response"]');
          return { hd: document.querySelector('#hdlink')?.href, sd: document.querySelector('#sdlink')?.href,
            form: !!form, ready: !!form && (!document.querySelector('.cf-turnstile, [src*="turnstile"]') || !!token?.value),
            path: location.pathname };
        })()`).catch(() => null);
        if (page?.hd || page?.sd) return chooseQuality(page, quality);
        if (!submitted && page?.ready) {
          await win.webContents.executeJavaScript(`(() => {
            const form = document.querySelector('#downloadform');
            const input = form?.querySelector('[name="URLz"]');
            if (!form || !input) throw new Error('Provider form changed.');
            input.value = ${JSON.stringify(url)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            form.requestSubmit();
          })()`);
          submitted = true;
          submittedAt = Date.now();
          state('resolving');
          win.hide();
        }
        if ((!submitted && Date.now() - started > 7000) || (submitted && Date.now() - submittedAt > 12000)) {
          if (!win.isVisible()) win.show();
          state('verification');
        }
        if (submitted && page?.path === '/download.php' && !win.webContents.isLoading() && Date.now() - submittedAt > 20000) {
          throw new Error('Provider did not return a video. The link may be private, unavailable, or verification failed.');
        }
        await delay(500, undefined, { signal });
      }
      throw new Error('Provider verification timed out. Retry and complete verification in the provider window.');
    } finally {
      signal.removeEventListener('abort', abort);
      providerSession.removeListener('will-download', preventDownload);
      if (!win.isDestroyed()) win.destroy();
      if (this.window === win) this.window = null;
    }
  }
}
function preventDownload(event) { event.preventDefault(); }
module.exports = { DownloadProvider };
