const { fillFields, uploadProgress, sessionView, publishFeedback } = require('./composer-dom');
const http = require('http');

function httpJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('invalid JSON from ' + path)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout: ' + path)); });
  });
}

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  static connect(wsUrl) {
    const c = new CDP(wsUrl);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      c.ws = ws;
      const timer = setTimeout(() => {
        try { ws.close(); } catch (e) {}
        reject(new Error('CDP connect timeout'));
      }, 10000);
      const done = () => clearTimeout(timer);
      ws.onopen = () => { done(); resolve(c); };
      ws.onerror = (err) => { done(); reject(new Error('CDP connect failed: ' + (err && err.message))); };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.id && c.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = c.pending.get(msg.id);
          c.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message + ' (' + msg.error.code + ')'));
          else res(msg.result);
        } else if (msg.method) {
          const cbs = c.listeners.get(msg.method) || [];
          for (const cb of cbs) {
            try { cb(msg.params || {}); } catch (e) {}
          }
        }
      };
      ws.onclose = () => {
        done();
        reject(new Error('CDP connection closed before opening'));
        for (const [, { reject: rej }] of c.pending) {
          rej(new Error('CDP connection closed'));
        }
        c.pending.clear();
      };
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error('CDP not connected'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        clearTimeout(timer);
        this.pending.delete(id);
        fn(value);
      };
      const timer = setTimeout(() => {
        const err = new Error('CDP timeout: ' + method);
        err.code = 'CDP_TIMEOUT';
        finish(reject, err);
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => finish(resolve, value),
        reject: (err) => finish(reject, err)
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (err) { finish(reject, err); }
    });
  }

  isOpen() {
    return !!(this.ws && this.ws.readyState === 1);
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
    return () => {
      const callbacks = this.listeners.get(method);
      const index = callbacks.indexOf(cb);
      if (index !== -1) callbacks.splice(index, 1);
    };
  }

  close() {
    try { this.ws.close(); } catch (e) {}
  }
}

async function browserWs(port) {
  const info = await httpJson(port, '/json/version');
  if (!info.webSocketDebuggerUrl) throw new Error('no webSocketDebuggerUrl');
  return info.webSocketDebuggerUrl;
}

async function listPages(port) {
  const list = await httpJson(port, '/json/list');
  return list.filter((t) => t.type === 'page');
}

class Page {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.session = null;
  }

  async init() {
    this.session = await CDP.connect(this.wsUrl);
    return this;
  }

  static async connect(wsUrl) {
    return new Page(wsUrl).init();
  }

  async windowState() {
    const { windowId, bounds } = await this.session.send('Browser.getWindowForTarget');
    return { windowId, bounds };
  }

  // Brings the window into a normal OS window state. `maximized` keeps the
  // title bar and standard window controls visible, unlike F11 fullscreen.
  async setWindowState(state) {
    const { windowId, bounds } = await this.windowState();
    if (bounds.windowState === state) return;
    if (state === 'maximized' && bounds.windowState === 'fullscreen') {
      await this.session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    }
    await this.session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: state } });
  }

  async forceActive() {
    try { await this.session.send('Emulation.setFocusEmulationEnabled', { enabled: true }, 5000); } catch (e) {}
    try { await this.session.send('Page.setWebLifecycleState', { state: 'active' }, 5000); } catch (e) {}
  }

  goto(url, options) {
    return this.waitForNavigation('Page.navigate', { url }, url, options);
  }

  reload(options = {}) {
    return this.waitForNavigation('Page.reload', {ignoreCache: Boolean(options.ignoreCache)}, 'composer reload', {waitUntil:'domcontentloaded',timeout:45000});
  }

  async waitForNavigation(method, params, url, { waitUntil = 'load', timeout = 30000 } = {}) {
    await this.session.send('Page.enable');
    const event = waitUntil === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired';
    let unsubscribe = () => {};
    let timer;
    const wait = ['load', 'domcontentloaded'].includes(waitUntil)
      ? new Promise((resolve, reject) => {
          unsubscribe = this.session.on(event, resolve);
          timer = setTimeout(() => reject(new Error('navigation timeout: ' + url)), timeout);
        })
      : Promise.resolve();
    // Attach a handler immediately: navigation itself may fail before the event arrives.
    wait.catch(() => {});
    try {
      const { errorText } = await this.session.send(method, params);
      if (errorText) throw new Error('navigation failed: ' + errorText);
      await wait;
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  }

  async evaluate(expression, timeoutMs = 30000) {
    if (typeof expression === 'function') {
      expression = `(${expression.toString()})()`;
    }
    const r = await this.session.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, timeoutMs);
    if (r.exceptionDetails) {
      const text = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
      throw new Error('evaluate failed: ' + (text || r.exceptionDetails.text));
    }
    return r.result ? r.result.value : undefined;
  }

  async addInitScript(source) {
    await this.session.send('Page.enable');
    await this.session.send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  async waitForTimeout(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async setFileInputFiles(selector, filePaths) {
    const files = Array.isArray(filePaths) ? filePaths : [filePaths];
    await this.evaluate(`(() => {
      if (window.__react_dom_patched) return;
      window.__react_dom_patched = true;
      const origRemove = Node.prototype.removeChild;
      Node.prototype.removeChild = function(child) {
        if (!child || child.parentNode !== this) return child;
        return origRemove.apply(this, arguments);
      };
      const origInsert = Node.prototype.insertBefore;
      Node.prototype.insertBefore = function(newNode, refNode) {
        if (refNode && refNode.parentNode !== this) return newNode;
        return origInsert.apply(this, arguments);
      };
    })()`).catch(() => {});
    await this.session.send('DOM.enable');
    const { root } = await this.session.send('DOM.getDocument');
    const res = await this.session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!res.nodeId) return false;
    await this.session.send('DOM.setFileInputFiles', { nodeId: res.nodeId, files });
    return true;
  }

  async clickText(texts, { timeout = 8000, exact = false, composerOnly = false } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const hit = await this.evaluate(`(() => {
        if (${composerOnly} && (!location.pathname.includes('/bulk_upload_composer') || location.hostname !== 'business.facebook.com')) return false;
        var matches = [];
        var t = ${JSON.stringify(texts)};
        var els = document.querySelectorAll('[role=button], button, input[type=submit]');
        for (var i = 0; i < els.length; i++) {
          if (els[i].matches(':disabled') || els[i].closest('[aria-disabled=true],[inert]') || !els[i].checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) continue;
          const labels = (els[i].getAttribute('aria-labelledby') || '').split(' ').filter(Boolean);
          const name = els[i].getAttribute('aria-label') || labels.map(id=>document.getElementById(id)?.textContent || '').join(' ') || els[i].value || els[i].innerText || els[i].textContent || '';
          const text = name.replace(/[\\u200b\\ufeff]/g,'').replace(/\\s+/g,' ').trim().toLowerCase();
          for (var j = 0; j < t.length; j++) {
            const wanted = t[j].toLowerCase();
            const m = ${exact ? "text === wanted || text === wanted + ' ' + wanted || text === wanted + wanted" : "text.includes(wanted)"};
            if (m) { matches.push(els[i]); break; }
          }
        }
        if (matches.length !== 1) return false;
        const button = matches[0];
        button.scrollIntoView({block:'nearest'});
        const r = button.getBoundingClientRect();
        if (!button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))) return false;
        button.click(); return true;
      })()`, Math.max(1, timeout - (Date.now() - started)));
      if (hit) return true;
      await this.waitForTimeout(500);
    }
    return false;
  }

  async fillContentEditable(text, expectedRows = 0, timeoutMs = 5000, title = text) {
    return this.evaluate(`(${fillFields})(${JSON.stringify(text)},${expectedRows},${expectedRows > 0},${JSON.stringify(title)})`, timeoutMs);
  }

  async progressStatus(files, timeoutMs = 3000) {
    return this.evaluate(`(${uploadProgress})(${JSON.stringify(files)})`, timeoutMs);
  }

  async composerSession(timeoutMs = 3000) { return this.evaluate(sessionView, timeoutMs); }

  isOpen() {
    return this.session ? (typeof this.session.isOpen === 'function' ? this.session.isOpen() : true) : false;
  }

  async documentHasSessionMarker() {
    const { frameTree } = await this.session.send('Page.getFrameTree', {}, 1500);
    const { content, base64Encoded } = await this.session.send('Page.getResourceContent', { frameId: frameTree.frame.id, url: frameTree.frame.url }, 1500);
    return /"DTSGInitialData"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"[^"\s]+"/.test(base64Encoded ? Buffer.from(content,'base64').toString('utf8') : content);
  }

  async publishFeedback(timeoutMs = 1500) { return this.evaluate(publishFeedback, timeoutMs); }

  async screenshot(timeoutMs = 30000) {
    const { data } = await this.session.send('Page.captureScreenshot', { format: 'png' }, timeoutMs);
    return Buffer.from(data, 'base64');
  }

  async close() {
    try { await this.session.send('Page.close'); } catch (e) {}
    this.session.close();
  }
}

class Browser {
  constructor(port) {
    this.port = port;
    this.session = null;
  }

  async init() {
    this.session = await CDP.connect(await browserWs(this.port));
    return this;
  }

  static async connect(port) {
    return new Browser(port).init();
  }

  async newPage() {
    const { targetId } = await this.session.send('Target.createTarget', { url: 'about:blank' });
    const started = Date.now();
    while (Date.now() - started < 10000) {
      const pages = await listPages(this.port);
      const found = pages.find((p) => p.id === targetId);
      if (found) {
        const page = await Page.connect(found.webSocketDebuggerUrl);
        await page.forceActive().catch(() => {});
        return page;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('newPage target not found');
  }

  async pages() {
    const list = await listPages(this.port);
    return Promise.all(list.map((p) => Page.connect(p.webSocketDebuggerUrl)));
  }

  async firstPage() {
    const list = await listPages(this.port);
    if (!list.length) return null;
    return Page.connect(list[0].webSocketDebuggerUrl);
  }

  async close() {
    try { await this.session.send('Browser.close'); } catch (e) {}
    this.session.close();
  }
}

class Context {
  constructor(browser) {
    this.browser = browser;
    this.initScripts = [];
  }

  async addInitScript(source) {
    this.initScripts.push(source);
    for (const page of await this.browser.pages()) {
      try { await page.addInitScript(source); } finally { page.session.close(); }
    }
  }

  async newPage() {
    const page = await this.browser.newPage();
    for (const src of this.initScripts) {
      await page.addInitScript(src).catch(() => {});
    }
    return page;
  }

  async close() {
    await this.browser.close();
  }
}

async function connectOverCDP(port) {
  const browser = await Browser.connect(port);
  const context = new Context(browser);
  const page = await browser.firstPage();
  return { browser, context, page };
}

module.exports = { CDP, Browser, Page, Context, connectOverCDP, browserWs, httpJson, listPages };
