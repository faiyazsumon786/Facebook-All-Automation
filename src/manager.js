const { launchProfile } = require('./index');
const { spawn } = require('child_process');

const sessions = new Map();

async function startProfile(name, overrides = {}) {
  const existing = sessions.get(name);
  if (existing && existing.state === 'stopping') {
    await existing.stopPromise;
    return startProfile(name, overrides);
  }
  if (existing && existing.state === 'starting') return existing.launchPromise;
  if (existing && existing.state === 'running') {
    return { name, state: 'running', startedAt: existing.startedAt, pid: existing.proc ? existing.proc.pid : null };
  }
  const startedAt = Date.now();
  const controller = new AbortController();
  const s = { state: 'starting', startedAt, proc: null, controller };
  sessions.set(name, s);
  const timer = setTimeout(() => controller.abort(new Error('launch timed out after 120s')), 120000);
  s.launchPromise = (async () => {
    try {
      const res = await launchProfile(name, overrides, { signal: controller.signal });
      Object.assign(s, res);
      controller.signal.throwIfAborted();
      if (res.proc.exitCode !== null || res.proc.signalCode) throw new Error('Browser exited during startup');
      s.state = 'running';
      res.proc.once('exit', () => {
        if (sessions.get(name) === s && s.state !== 'stopping') sessions.delete(name);
      });
      return { name, state: 'running', startedAt, pid: res.proc ? res.proc.pid : null };
    } catch (err) {
      if (s.proc) { try { s.proc.kill(); } catch {} }
      if (sessions.get(name) === s && s.state !== 'stopping') sessions.delete(name);
      throw err;
    } finally { clearTimeout(timer); }
  })();
  return s.launchPromise;
}

function waitExit(proc, ms) {
  if (!proc || proc.exitCode !== null || proc.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); proc.removeListener('exit', done); resolve(); };
    const t = setTimeout(done, ms);
    proc.once('exit', done);
  });
}

function procAlive(proc) {
  return !!(proc && proc.exitCode === null && proc.signalCode == null);
}

function forceKillTree(proc) {
  if (!procAlive(proc)) return Promise.resolve();
  if (process.platform !== 'win32') {
    try { proc.kill('SIGKILL'); } catch {}
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let child;
    let t;
    try {
      child = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      return resolve();
    }
    const done = () => { clearTimeout(t); resolve(); };
    t = setTimeout(done, 4000);
    child.once('error', done);
    child.once('exit', done);
  });
}

async function stopProfile(name) {
  const s = sessions.get(name);
  if (!s) return { name, state: 'stopped' };
  if (s.stopPromise) return s.stopPromise;
  s.state = 'stopping';
  s.controller.abort(new Error('Launch cancelled'));
  s.stopPromise = (async () => {
    await s.launchPromise.catch(() => {});
    if (s.browser) await s.browser.close().catch(() => {});
    await waitExit(s.proc, 8000);
    if (procAlive(s.proc)) {
      try { s.proc.kill(); } catch {}
      await waitExit(s.proc, 4000);
    }
    if (procAlive(s.proc)) await forceKillTree(s.proc);
    await waitExit(s.proc, 2000);
    if (procAlive(s.proc)) {
      s.state = 'running';
      s.stopPromise = null;
      throw new Error('Browser is still open. Close it to release the profile.');
    }
    if (sessions.get(name) === s) sessions.delete(name);
    return { name, state: 'stopped' };
  })();
  return s.stopPromise;
}

async function stopAll() {
  await Promise.all([...sessions.keys()].map(stopProfile));
}

function listSessions() {
  return [...sessions.entries()].map(([name, s]) => ({
    name,
    state: s.state,
    startedAt: s.startedAt,
    pid: s.proc ? s.proc.pid : null
  }));
}

function getSession(name) {
  return sessions.get(name) || null;
}

module.exports = { startProfile, stopProfile, stopAll, listSessions, getSession };
