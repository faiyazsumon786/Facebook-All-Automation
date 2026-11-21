const fs = require('fs');
const path = require('path');
const { resolveGeo } = require('./geo');
const { launchKernel, waitForCdp } = require('./kernel');
const { connectOverCDP } = require('./cdp');

const { storageRoot, packaged } = require('./storage');

const DEFAULT_UAS = {
  Android: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.52 Mobile Safari/537.36',
  iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  Windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.52 Safari/537.36',
  macOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.52 Safari/537.36',
  MacOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.52 Safari/537.36',
  Linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.52 Safari/537.36'
};

function defaultUserAgent(p) {
  const platform = p.browserPlatform || (p.isMobile ? 'Android' : 'Windows');
  return p.userAgent || DEFAULT_UAS[platform] || DEFAULT_UAS.Windows;
}

function loadProfile(name) {
  const file = name.endsWith('.json') ? name : `${name}.json`;
  const candidates = [
    path.join(storageRoot, 'profiles', file),
    ...(packaged ? [] : [path.resolve(process.cwd(), file)])
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    }
  }
  throw new Error(`profile not found: ${name}`);
}

function listProfiles() {
  const dir = path.join(storageRoot, 'profiles');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}

function resolveAuto(p, geo) {
  const out = { ...p };
  if (p.locale === 'auto' || p.language === 'auto' || p.displayLanguage === 'auto') {
    out.locale = geo.locale;
  }
  if (p.timezoneId === 'auto') out.timezoneId = geo.timezone;
  if (out.timezoneId && out.timezoneId !== 'auto') out.timezone = out.timezoneId;
  if (p.geolocation === 'auto') out.geolocation = geo.geolocation;
  return out;
}

function kernelUaDataPatch(p) {
  const major = ((p.userAgent || '').match(/Chrome\/(\d+)\./) || [])[1] || '153';
  const full = ((p.userAgent || '').match(/Chrome\/([\d.]+)/) || [])[1] || `${major}.0.8010.52`;
  const ram = p.hardware && p.hardware.ram ? Number(p.hardware.ram) : 8;
  const dnt = p.dnt ? '1' : null;
  const platform = p.browserPlatform || (p.isMobile ? 'Android' : 'Windows');
  const isMobile = !!p.isMobile;
  const ch = p.clientHints || {};
  let uaMeta;
  if (isMobile) {
    const model = (p.device && p.device.model) || 'SM-M145F';
    const isIos = platform === 'iPhone';
    uaMeta = {
      brands: [{ brand: 'Google Chrome', version: major }, { brand: 'Not_A Brand', version: '8' }, { brand: 'Chromium', version: major }],
      mobile: true,
      platform: isIos ? 'iOS' : 'Android',
      platformVersion: isIos ? (ch.platform_version || '18.5') : (ch.platform_version || '10'),
      architecture: ch.architecture || 'arm',
      model,
      bitness: ch.bitness || '64',
      wow64: false
    };
  } else {
    const isMac = platform === 'macOS' || platform === 'MacOS';
    const isLinux = platform === 'Linux';
    uaMeta = {
      brands: [{ brand: 'Google Chrome', version: major }, { brand: 'Not_A Brand', version: '8' }, { brand: 'Chromium', version: major }],
      mobile: false,
      platform: isMac ? 'macOS' : (isLinux ? 'Linux' : 'Windows'),
      platformVersion: ch.platform_version || (isMac ? '15.1.1' : (isLinux ? '6.12.0' : '10.0.0')),
      architecture: ch.architecture || (isMac ? 'arm' : (isLinux ? 'x86_64' : 'x86')),
      model: ch.model || '',
      bitness: ch.bitness || '64',
      wow64: ch.wow64 === '1'
    };
  }
  return `(function(){
    var major=${JSON.stringify(major)}, full=${JSON.stringify(full)}, ram=${Number(ram)}, dnt=${dnt ? JSON.stringify(dnt) : 'null'};
    var meta=${JSON.stringify(uaMeta)};
    try {
      var uad = {
        brands: meta.brands,
        mobile: meta.mobile,
        platform: meta.platform,
        model: meta.model,
        getHighEntropyValues: function() {
          return Promise.resolve({
            architecture: meta.architecture, bitness: meta.bitness, model: meta.model,
            platform: meta.platform, platformVersion: meta.platformVersion,
            uaFullVersion: full,
            fullVersionList: [
              { brand: 'Google Chrome', version: full },
              { brand: 'Not_A Brand', version: '8.0.0.0' },
              { brand: 'Chromium', version: full }
            ],
            wow64: meta.wow64
          });
        },
        toJSON: function() { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; }
      };
      Object.defineProperty(navigator, 'userAgentData', { get: function(){ return uad; }, configurable: true });
    } catch(e) {}
    try { Object.defineProperty(navigator, 'deviceMemory', { get: function(){ return ram; } }); } catch(e) {}
    if (dnt) {
      try { Object.defineProperty(navigator, 'doNotTrack', { get: function(){ return dnt; } }); } catch(e) {}
    }
  })();`;
}

async function launchProfileObject(profile, overrides = {}, { signal } = {}) {
  signal?.throwIfAborted();
  const p = { ...profile, ...overrides };
  const geo = await resolveGeo(p);
  signal?.throwIfAborted();
  const resolved = resolveAuto(p, geo);
  if (!resolved.userAgent) {
    resolved.userAgent = defaultUserAgent(resolved);
  }
  if ((resolved.webrtc === 'proxy' || resolved.webrtc === 'proxy-udp') && resolved.webrtcIp === 'auto') {
    resolved.webrtcIp = geo.ip || undefined;
  }
  const dataName = resolved.name || String(resolved.id || Date.now());
  if (typeof dataName !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(dataName) || dataName.endsWith('.')) throw new Error('Invalid profile data directory name');
  const userDataDir = path.join(storageRoot, 'data', dataName);
  fs.mkdirSync(userDataDir, { recursive: true });

  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const autoPort = overrides.startMaximized === true;
  const oldEndpoint = autoPort && fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8') : '';
  const launched = launchKernel(resolved, userDataDir, {ephemeralDebugPort:autoPort});
  const { proc } = launched;
  let cdpPort = launched.cdpPort;
  let browser;
  const abort = () => { try { proc.kill(); } catch {} };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (autoPort) {
      const deadline = Date.now() + 40000;
      let spawnError;
      const failed = error => { spawnError = error; };
      proc.once('error', failed);
      try {
        while (!cdpPort && Date.now() < deadline) {
          signal?.throwIfAborted();
          if (spawnError) throw spawnError;
          if (proc.exitCode !== null || proc.signalCode) throw new Error('Upload browser exited during launch');
          let endpoint;
          try { endpoint = fs.readFileSync(portFile, 'utf8'); } catch (error) { if (!['ENOENT','EBUSY','EACCES'].includes(error.code)) throw error; }
          if (endpoint && endpoint !== oldEndpoint && /^\d+\r?\n\/devtools\/browser\/[\w-]+$/.test(endpoint.trim())) cdpPort = Number(endpoint.split('\n')[0]);
          if (!cdpPort) await new Promise(resolve => setTimeout(resolve, 100));
        }
      } finally { proc.removeListener('error', failed); }
      if (!cdpPort) throw new Error('Upload browser did not provide its CDP endpoint');
    }
    await waitForCdp(cdpPort, 40000, { signal, proc });
    const connection = await connectOverCDP(cdpPort);
    browser = connection.browser;
    signal?.throwIfAborted();
    await connection.context.addInitScript(kernelUaDataPatch(resolved));
    signal?.throwIfAborted();

    if (resolved.importCookie && connection.page) {
      try {
        const { cookiesFromLine } = require('./cookies');
        const lines = Array.isArray(resolved.importCookie) ? resolved.importCookie : [resolved.importCookie];
        const all = [];
        for (const line of lines) {
          if (typeof line === 'string') all.push(...cookiesFromLine(line));
        }
        if (all.length) {
          await connection.page.session.send('Network.enable').catch(() => {});
          for (const c of all) {
            let val = String(c.value);
            if (val.includes(';')) val = val.replace(/;/g, '%3B');
            try {
              await connection.page.session.send('Network.setCookie', {
                name: c.name,
                value: val,
                domain: c.domain || '.facebook.com',
                path: c.path || '/',
                secure: true
              });
            } catch (e) {}
          }
        }
      } catch (err) {
        console.warn('Cookie injection error:', err.message);
      }
    }
    if (connection.page) {
      const targetUrl = resolved.openUrl || 'https://www.facebook.com/';
      await connection.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    }
    return { ...connection, proc, cdpPort, profile: resolved, geo, userDataDir };
  } catch (err) {
    abort();
    browser?.session?.close();
    throw err;
  } finally { signal?.removeEventListener('abort', abort); }
}

async function launchProfile(name, overrides = {}, options = {}) {
  return launchProfileObject(loadProfile(name), overrides, options);
}

module.exports = { launchProfile, launchProfileObject, loadProfile, listProfiles, defaultUserAgent };
