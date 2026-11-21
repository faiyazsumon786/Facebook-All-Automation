const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { launchKernel } = require('./kernel');
const { Browser, CDP } = require('./cdp');

// Executed only in the browser's privileged password-manager page. The two
// strings arrive as CDP arguments, never as command-line flags or script text.
async function addFacebookLogin(username, password) {
  if (location.origin !== 'chrome://password-manager') return false;
  const url = 'https://www.facebook.com/';
  await this.addPassword({ url, username, password, note: '', useAccountStore: false });
  for (let i = 0; i < 50; i++) {
    const entries = await this.getSavedPasswordList();
    if (entries.some(entry => entry.username === username && entry.storedIn !== 'ACCOUNT' &&
        (entry.affiliatedDomains || [entry.urls]).some(domain => domain?.signonRealm === url))) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

async function saveFacebookPassword(profile, directory, uid, password, signal) {
  signal?.throwIfAborted();
  // Port zero makes Chromium choose its own available port and publish its
  // exact websocket endpoint inside this newly-created, isolated directory.
  const { proc } = launchKernel({ ...profile, importCookie: null,
    openUrl: 'about:blank', proxy: { scheme: 'http', host: '127.0.0.1', port: 9 },
    args: ['--headless=new', '--disable-background-networking'] }, directory, { ephemeralDebugPort: true });
  let browser, page, exited = false;
  const exit = new Promise(resolve => {
    const finish = () => { exited = true; resolve(); };
    proc.once('exit', finish); proc.once('error', finish);
  });
  const kill = () => { if (!exited) proc.kill(); };
  process.once('exit', kill);
  signal?.addEventListener('abort', kill, { once: true });
  try {
    const endpoint = path.join(directory, 'DevToolsActivePort');
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !exited) {
      signal?.throwIfAborted();
      if (fs.existsSync(endpoint)) {
        const [port, route] = fs.readFileSync(endpoint, 'utf8').trim().split(/\r?\n/);
        if (/^\d+$/.test(port) && /^\/devtools\/browser\/[\w-]+$/.test(route)) {
          browser = new Browser(Number(port));
          browser.session = await CDP.connect(`ws://127.0.0.1:${port}${route}`);
          break;
        }
      }
      await delay(100, undefined, { signal });
    }
    if (!browser?.session) throw new Error('Password manager could not start');
    page = await browser.newPage();
    await page.goto('chrome://password-manager/passwords', { waitUntil: 'domcontentloaded', timeout: 10000 });
    const api = await page.session.send('Runtime.evaluate', {
      expression: "location.origin === 'chrome://password-manager' ? chrome.passwordsPrivate : null"
    });
    if (!api.result?.objectId) throw new Error('Native password manager unavailable');
    const saved = await page.session.send('Runtime.callFunctionOn', {
      objectId: api.result.objectId, functionDeclaration: addFacebookLogin.toString(),
      arguments: [{ value: uid }, { value: password }], awaitPromise: true, returnByValue: true
    });
    if (saved.exceptionDetails || saved.result?.value !== true) throw new Error('Password manager did not confirm saving');
    await page.close();
    await browser.close();
    // Wait for normal shutdown so the password database is flushed before the
    // directory becomes the user's final profile. Never commit a killed helper.
    for (let i = 0; i < 60 && !exited; i++) await delay(100);
    if (!exited || proc.exitCode !== 0) throw new Error('Password store did not close cleanly');
  } finally {
    signal?.removeEventListener('abort', kill);
    process.removeListener('exit', kill);
    page?.session?.close(); browser?.session?.close();
    if (!exited) { kill(); await exit; }
  }
}
module.exports = { saveFacebookPassword };
