const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');
const { pickWebgl, LIB } = require('./presets');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(__dirname, 'assets');
const B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_ALT = 'hTy1bfRJz4nLPcBCO7WtmNIaGvVeul5Zo8kq32UxrYw_-0gsjp96SDFXQiEMKdHA';

const DISABLED_FONTS = JSON.parse(fs.readFileSync(path.join(ASSETS, 'disabled-fonts.json'), 'utf8'));
const FAKE_FONTS = JSON.parse(fs.readFileSync(path.join(ASSETS, 'fake-fonts.json'), 'utf8'));
const DEVTOOLS_TEMPLATE = JSON.parse(fs.readFileSync(path.join(ASSETS, 'devtools-prefs-template.json'), 'utf8'));
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';

function buildDevtoolsPreferences(m, userAgent) {
  const prefs = JSON.parse(JSON.stringify(DEVTOOLS_TEMPLATE));
  const customDevice = {
    title: 'customer',
    type: 'phone',
    'user-agent': userAgent,
    capabilities: ['mobile', 'touch'],
    screen: {
      'device-pixel-ratio': m.dpr,
      vertical: { width: m.width, height: m.height },
      horizontal: { width: m.height, height: m.width }
    },
    modes: [
      { title: '', orientation: 'vertical', insets: { left: 0, top: 0, right: 0, bottom: 0 } },
      { title: '', orientation: 'horizontal', insets: { left: 0, top: 0, right: 0, bottom: 0 } }
    ],
    'show-by-default': true,
    'dual-screen': false,
    'foldable-screen': false,
    show: 'Default',
    'user-agent-metadata': {
      brands: [{ brand: '', version: '' }],
      fullVersionList: [{ brand: '', version: '' }],
      fullVersion: '',
      platform: '',
      platformVersion: '',
      architecture: '',
      model: '',
      mobile: true
    }
  };
  prefs.preferences['custom-emulated-device-list'] = JSON.stringify([customDevice]);
  prefs.preferences['emulation.device-width'] = String(m.width);
  prefs.preferences['emulation.device-height'] = String(m.height);
  prefs.preferences['emulation.device-scale-factor'] = String(m.dpr);
  prefs.preferences['emulation.deviceUserAgent'] = JSON.stringify(userAgent);
  prefs.preferences['emulation.show-device-mode'] = 'true';
  prefs.preferences['emulation.device-mode-value'] = JSON.stringify({ device: 'customer', orientation: 'vertical', mode: '' });
  return prefs;
}

function writePreferences(userDataDir, m, userAgent) {
  const prefsDir = path.join(userDataDir, 'Default');
  fs.mkdirSync(prefsDir, { recursive: true });
  const prefsFile = path.join(prefsDir, 'Preferences');
  let existing = {};
  if (fs.existsSync(prefsFile)) {
    try { existing = JSON.parse(fs.readFileSync(prefsFile, 'utf8')); } catch (e) { existing = {}; }
  }
  existing.devtools = buildDevtoolsPreferences(m, userAgent);
  fs.writeFileSync(prefsFile, JSON.stringify(existing));
}

function sunEncode(str) {
  return Array.from(Buffer.from(str, 'utf8').toString('base64')).map((ch) => {
    const i = B64_STD.indexOf(ch);
    return i < 0 ? ch : B64_ALT[i];
  }).join('');
}

function sunDecode(str) {
  const mapped = Array.from(str).map((ch) => {
    const i = B64_ALT.indexOf(ch);
    return i < 0 ? ch : B64_STD[i];
  }).join('');
  return Buffer.from(mapped, 'base64').toString('utf8');
}

function hashcode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function randomBetween(min, max) {
  return Number((Math.random() * (max - min) + min).toFixed(1));
}

function seededRange(seedStr, salt, min, max) {
  let h = 2166136261;
  const s = String(seedStr) + '|' + salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = ((h >>> 0) % 10000) / 10000;
  const b = ((Math.imul(h, 2654435761) >>> 0) % 10000) / 10000;
  const r1 = Number((min + a * (max - min)).toFixed(1));
  const r2 = Number((min + b * (max - min)).toFixed(1));
  return r1 <= r2 ? [r1, r2] : [r2, r1];
}

function androidMetrics(profile) {
  const res = String(profile.screenResolution || '1080_2408');
  const [rw, rh] = res.split('_').map(Number);
  const dpr = Number(profile.dpr || 2.8125);
  const width = Math.max(1, Math.floor(rw / dpr));
  const height = Math.max(1, Math.floor(rh / dpr));
  return { dpr, width, height, screenWidth: rw, screenHeight: rh };
}

const COMPAT_PAIRS = [['zh-HK', 'zh-TW'], ['en', 'en-US'], ['pt', 'pt-BR'], ['es', 'es-ES']];
const COMPAT_REGEX = [[/en-(?!US)/, 'en-GB'], [/pt-(?!PT)/, 'pt-BR'], [/es-(?!ES)/, 'es-MX']];

function compatLangs(language) {
  const e = Array.isArray(language) ? [...language] : [language || 'en-US'];
  const base = e[0].split(/-|_/)[0];
  for (const [from, to] of COMPAT_PAIRS) {
    if (e.includes(from) && !e.includes(to)) e.push(to);
  }
  for (const [re, to] of COMPAT_REGEX) {
    if (e.some((l) => re.test(l)) && !e.includes(to)) e.push(to);
  }
  if (!e.includes(base)) e.push(base);
  return e;
}

function getAccept(e) {
  let t = '';
  let n = 0;
  const r = [];
  for (let a = 0; a < e.length; a++) {
    const i = e[a];
    const o = e[a + 1] || '';
    const s = i.split('-')[0];
    const l = o.split('-')[0];
    if (a === 0) { t += i; n += 1; }
    if (a > 0 && !r.includes(i)) { t += ',' + i + ';q=0.' + (10 - n < 1 ? 1 : 10 - n); n += 1; }
    if (i === s || s === l || r.includes(s)) { /* noop */ }
    else { t += ',' + s + ';q=0.' + (10 - n < 1 ? 1 : 10 - n); n += 1; r.push(s); }
    r.push(i);
  }
  return t;
}

function desktopMetadata(profile) {
  const platform = profile.browserPlatform || 'Windows';
  const ch = profile.clientHints || {};
  if (platform === 'Windows') {
    return {
      platform: ch.platform || 'Windows',
      platformVersion: ch.platform_version || '10.0.0',
      architecture: ch.architecture || 'x86',
      model: ch.model || '',
      mobile: false,
      wow64: ch.wow64 === '1',
      bitness: ch.bitness || '64'
    };
  }
  if (platform === 'macOS' || platform === 'MacOS') {
    return {
      platform: ch.platform || 'macOS',
      platformVersion: ch.platform_version || '15.1.1',
      architecture: ch.architecture || 'arm',
      model: ch.model || (profile.device && profile.device.model) || '',
      mobile: false,
      wow64: false,
      bitness: ''
    };
  }
  return {
    platform: ch.platform || 'Linux',
    platformVersion: ch.platform_version || '6.12.0',
    architecture: ch.architecture || 'x86_64',
    model: ch.model || '',
    mobile: false,
    wow64: false,
    bitness: ''
  };
}

function buildKernelConfig(profile, userDataDir) {
  const m = androidMetrics(profile);
  const fbccId = profile.id || 'fb_' + Math.random().toString(36).slice(2, 10);
  const isMobile = !!profile.isMobile;
  const platform = profile.browserPlatform || (isMobile ? 'Android' : 'Windows');
  const isAndroid = platform === 'Android';
  const isIphone = platform === 'iPhone';
  const isMac = platform === 'macOS' || platform === 'MacOS';
  const isLinux = platform === 'Linux';

  const langs = compatLangs(Array.isArray(profile.language) ? profile.language : [profile.locale || 'en-US']);

  const staticConfig = {
    CookiesExportPath: path.join(userDataDir, 'sf_cookie.txt'),
    SecurePreferenceSync: true,
    PasswordExportPath: path.join(userDataDir, crypto.createHash('md5').update(fbccId + '_password_import').digest('hex')),
    AutomationControlled: true,
    PersistExtensions: 'extensionCenter',
    GOOGLE_API_KEY,
    ComponentPreinstallPath: path.join(kernelDir(), 'components'),
    RegistryExtensions: 'Software\\AdsPower\\SunBrowser\\Extensions',
    command_line: {
      'do-not-de-elevate': ''
    },
    PasswordImportPath: path.join(userDataDir, crypto.createHash('md5').update(fbccId + '_password_export').digest('hex')),
    WebRTCAllowScanPorts: '',
    DisabledFonts: Array.isArray(profile.disabledFonts) ? profile.disabledFonts : DISABLED_FONTS,
    Fakefonts: FAKE_FONTS,
    TTSEngines: [],
    MacAddress: (profile.device && profile.device.mac) || generateMac(fbccId),
    ExtensionSetting: [],
    RestoreLastSession: true,
    FoceSafeBrowsing: true,
    UserId: String(profile.userId || '1'),
    DisableContainer: true,
    StartTime: Math.floor(Date.now() / 1000),
    LoadExtensionErrorBox: false,
    ForceProcessExit: true,
    AllowScanPorts: profile.scanPortType === '1' ? (profile.allowScanPorts || '') : '',
    GeolocationSetting: 'ask',
    FlashPluginSetting: 'block',
    DisableBackgroundMode: true,
    HardwareConcurrency: profile.hardware && profile.hardware.cpu ? Number(profile.hardware.cpu) : 10,
    DeviceMemory: profile.hardware && profile.hardware.ram ? Number(profile.hardware.ram) : 8,
    ClientRectFp: profile.clientRects && profile.clientRects.seed
      ? Number(profile.clientRects.seed)
      : (hashcode(fbccId) % 20000 - 10000)
  };

  if (isMobile) {
    staticConfig.command_line['enable-blink-features'] = 'NetworkInformation,NetInfoDownlinkMax';
    staticConfig.MaxTouchPoints = 5;
    staticConfig.MediaDevices = [
      { kind: 'audioinput', label: '' },
      { kind: 'videoinput', label: '' },
      { kind: 'audiooutput', label: '' }
    ];
    staticConfig.DevtoolsPreferences = {
      'emulation.deviceHeight': JSON.stringify(m.height),
      'emulation.deviceWidth': JSON.stringify(m.width),
      'emulation.deviceScaleFactor': JSON.stringify(+m.dpr),
      'emulation.deviceUserAgent': JSON.stringify(profile.userAgent),
      'emulation.showDeviceMode': 'true',
      'emulation.deviceModeValue': '{"device":"","orientation":"","mode":""}',
      lastDockState: '"right"',
      currentDockState: '"right"',
      standardEmulatedDeviceList: '[]'
    };
    staticConfig.gyroscope = { x: [-0.15, 0.15], y: [-0.15, 0.15], z: [-0.15, 0.15] };
    staticConfig.deviceorientationdata = {
      alpha: seededRange(fbccId, 'alpha', 0, 360),
      beta: seededRange(fbccId, 'beta', -10, 10),
      gamma: seededRange(fbccId, 'gamma', -5, 5),
      absolute: false
    };
    staticConfig.DeviceMotion = {
      acceleration: { x: [-0.05, 0.05], y: [-0.05, 0.05], z: [-0.05, 0.05] },
      accelerationIncludingGravity: { x: [-0.2, 0.2], y: [-0.2, 0.2], z: [9.78, 9.81] }
    };
    staticConfig.ProductType = (profile.device && (profile.device.model || profile.device.name)) || 'SM-M145F';
    staticConfig.DeviceName = (profile.device && profile.device.name) || ('SM-M145F-' + fbccId);
    staticConfig.UserAgentMetadata = {
      platform: isAndroid ? 'Android' : (profile.clientHints && profile.clientHints.platform) || 'iOS',
      platformVersion: (profile.clientHints && profile.clientHints.platform_version) || (isAndroid ? '14.0.0' : '18.5'),
      architecture: (profile.clientHints && profile.clientHints.architecture) || '',
      model: (profile.device && profile.device.model) || (profile.clientHints && profile.clientHints.model) || '',
      mobile: true,
      wow64: false,
      bitness: ''
    };
    staticConfig.Platform = isAndroid ? 'Linux armv81' : 'iPhone';
  } else {
    staticConfig.MediaDevices = Array.isArray(profile.mediaDevicesConfig) && profile.mediaDevicesConfig.length
      ? profile.mediaDevicesConfig
      : createMediaDevices(fbccId);
    if (profile.mediaDevicesMask) staticConfig.MediaDevicesMask = profile.mediaDevicesMask;
    staticConfig.ProductType = (profile.device && (profile.device.model || profile.device.name)) || ('DESKTOP-' + fbccId.toUpperCase());
    staticConfig.DeviceName = (profile.device && profile.device.name) || ('DESKTOP-' + fbccId.toUpperCase());
    staticConfig.UserAgentMetadata = desktopMetadata(profile);
    staticConfig.Platform = isMac ? 'MacIntel' : (isLinux ? 'Linux x86_64' : 'Win32');
  }

  if (profile.webrtc === 'disabled' || profile.portScanProtection) {
    staticConfig.WebRTCAllowScanPorts = '0';
    staticConfig.AllowScanPorts = '0';
  }
  if (profile.webrtc === 'disabled') {
    staticConfig.DisableWebRTC = true;
  }
  if (profile.webrtc === 'proxy-udp' || profile.webrtc === 'proxy') {
    staticConfig.command_line['webrtc-ip-handling-policy'] = 'disable_non_proxied_udp';
    if (profile.webrtcIp) staticConfig.WebRTCAddress = profile.webrtcIp;
    if (profile.webrtcLocalIp) staticConfig.WebRTCLocalAddress = profile.webrtcLocalIp;
    else if (profile.webrtcLocalIpAuto !== false) staticConfig.WebRTCLocalAddress = generateLocalWebrtc(fbccId);
  }
  if (profile.webrtc === 'forward') {
    if (profile.webrtcStun) staticConfig.WebRTCStun = profile.webrtcStun;
    if (profile.webrtcTurn) staticConfig.WebRTCTurn = profile.webrtcTurn;
  }
  if (profile.disableImage || profile.disableVideo) {
    staticConfig.NetFilters = staticConfig.NetFilters || [];
    if (profile.disableImage) {
      staticConfig.NetFilters.push({
        mimeType: 'image/',
        maxSize: profile.imageSize && Number(profile.imageSize) > 0 ? 1024 * Number(profile.imageSize) : 0,
        whiteList: [],
        unknownSizeBlock: !(profile.imageSize && Number(profile.imageSize) > 0)
      });
    }
    if (profile.disableVideo) {
      for (const mimeType of ['video/', 'application/vnd.yt-ump', 'application/vnd.apple.mpegurl']) {
        staticConfig.NetFilters.push({ mimeType, maxSize: 0, whiteList: [], unknownSizeBlock: true });
      }
    }
  }
  if (profile.speechVoices && Array.isArray(profile.speechVoices) && profile.speechVoices.length) {
    const primary = (Array.isArray(profile.language) ? profile.language[0] : profile.locale) || 'en-US';
    const marked = profile.speechVoices.map((v) => ({
      name: v.name,
      lang: v.lang,
      localService: false,
      default: false,
      voiceURI: v.voiceURI || String(v.name).replace(/ /g, '')
    }));
    let def = marked.find((v) => v.lang.includes(primary));
    if (!def && primary.includes('-')) def = marked.find((v) => v.lang.includes(primary.split('-')[0]));
    if (def) { def.default = true; def.localService = true; }
    staticConfig.TTSEngines = marked;
  }
  if (profile.connectionType && profile.connectionType !== 'default') {
    staticConfig.NetworkInformation = {
      enabled: true,
      type: profile.connectionType === 'wifi' ? 'wifi' : 'cellular'
    };
  }
  if (profile.dnt) staticConfig.EnableDoNotTrack = true;
  if (profile.canvas && profile.canvas.mode === 'noise') {
    const mark = profile.canvas.seed || fbccId;
    staticConfig.CanvasMark = mark;
    staticConfig.CanvasMarkEx = mark;
  }
  if (profile.webgl && profile.webgl.mode === 'noise') {
    const mark = profile.webgl.seed || fbccId;
    staticConfig.WebGLMark = mark;
    staticConfig.WebGLMarkEx = mark;
  }
  if (profile.audioContext && profile.audioContext.mode === 'noise') {
    staticConfig.AudioFp = profile.audioContext.seed ? Number(profile.audioContext.seed) : (hashcode(fbccId) % 2000 - 1000);
  }
  if (profile.proxy && (profile.proxy.host || profile.proxy.server)) {
    const pu = parseProxy(profile);
    const chain = [{
      scheme: pu.scheme || 'http',
      host: pu.host,
      port: String(pu.port),
      account: pu.username || '',
      password: pu.password || ''
    }];
    staticConfig.ProxyChain = chain;
    staticConfig.ProxyUser = pu.username || '';
    staticConfig.ProxyPassword = pu.password || '';
  }
  staticConfig.Langs = langs.join(',');
  staticConfig.AcceptLang = getAccept(langs);

  if (profile.localPasswordStoreOnly) {
    delete staticConfig.PasswordExportPath;
    delete staticConfig.PasswordImportPath;
  }
  return { staticConfig, metrics: m, fbccId };
}

function generateMac(seed) {
  let acc = 0;
  for (let i = 0; i < seed.length; i++) acc += seed.charCodeAt(i);
  const hex = [];
  let state = acc || 1;
  for (let i = 0; i < 6; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    hex.push((state % 256).toString(16).padStart(2, '0'));
  }
  return hex.join(':');
}

function generateLocalWebrtc(fbccId) {
  if (!fbccId) return '';
  let sum = 0;
  for (let i = 0; i < fbccId.length; i++) sum += fbccId.charCodeAt(i);
  return ['192.168', '172.16', '192.168'][sum % 3] + '.' + (sum % 255) + '.' + ((sum % 255) + 1);
}

function createMediaDevices(seedId) {
  const presets = [
    { input: 'Microphone Array (2- Realtek High Definition Audio)', output: 'Speaker/Headphone (2- Realtek High Definition Audio)' },
    { input: 'Microphone Array (Realtek High Definition Audio)', output: 'Speaker/Headphone (Realtek High Definition Audio)' },
    { input: 'Microphone Array (Realtek(R) Audio)', output: 'Speaker (Realtek(R) Audio)' },
    { input: 'Microphone Array (Conexant SmartAudio HD)', output: 'Speaker (Conexant SmartAudio HD)' },
    { input: 'Microphone Array (2- Conexant SmartAudio HD)', output: 'Speaker (2- Conexant SmartAudio HD)' },
    { input: 'Microphone Array (Synaptics Audio)', output: 'Speaker (Synaptics Audio)' }
  ];
  let acc = 0;
  let hex = '';
  for (let i = 0; i < seedId.length; i++) {
    acc += seedId.charCodeAt(i);
    hex += acc.toString(16);
  }
  let o = hex.substr(0, 4);
  let s = hex.substr(-4);
  const fill = ['c', 'd', 'e', 'f'];
  if (o.length < 4) {
    for (let i = 0; i < 4 - o.length; i++) {
      o += fill[i];
      s += fill[fill.length - i];
    }
  }
  const preset = presets[acc % presets.length] || presets[0];
  return [
    { kind: 'audioinput', label: preset.input },
    { kind: 'videoinput', label: 'Integrated Camera (' + o + ':' + s + ')' },
    { kind: 'audiooutput', label: preset.output }
  ];
}

function resolveWebgl(webgl, platform, seedId) {
  if (webgl && webgl.vendor && webgl.renderer) {
    return { vendor: webgl.vendor, renderer: webgl.renderer, architecture: webgl.architecture };
  }
  if (webgl && webgl.preset) {
    for (const group of ['mobile', 'windows', 'macos']) {
      const found = LIB.webglPresets[group].find((p) => p.UNMASKED_RENDERER_WEBGL === webgl.preset);
      if (found) {
        return {
          vendor: found.UNMASKED_VENDOR_WEBGL,
          renderer: found.UNMASKED_RENDERER_WEBGL,
          architecture: /Adreno/.test(found.UNMASKED_RENDERER_WEBGL) ? 'adreno' : (/Mali/.test(found.UNMASKED_RENDERER_WEBGL) ? 'mali' : '')
        };
      }
    }
  }
  return pickWebgl(platform, hashcode(seedId));
}

function parseProxy(profile) {
  const p = profile.proxy || {};
  if (p.server) {
    const u = new URL(p.server);
    return { scheme: u.protocol.replace(':', ''), host: u.hostname, port: u.port || 80, username: p.username || '', password: p.password || '' };
  }
  return { scheme: p.scheme || 'http', host: p.host, port: p.port || 80, username: p.username || '', password: p.password || '' };
}

function findChromeExecutable() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function kernelDir() {
  return path.join(ROOT, 'kernel');
}

function kernelExe() {
  const dir = kernelDir();
  const custom = path.join(dir, 'SunBrowser.exe');
  if (fs.existsSync(custom)) return { exe: custom, isSunBrowser: true };
  const chrome = findChromeExecutable();
  if (chrome) return { exe: chrome, isSunBrowser: false };
  throw new Error('kernel not found at ' + dir + ' (SunBrowser.exe missing) and Google Chrome/Edge not found');
}

function launchKernel(profile, userDataDir, { ephemeralDebugPort = false } = {}) {
  const { exe, isSunBrowser } = kernelExe();
  const { staticConfig, metrics: m, fbccId } = buildKernelConfig(profile, userDataDir);
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

  if (profile.isMobile && profile.writePrefs !== false) {
    writePreferences(userDataDir, m, profile.userAgent);
  }

  const staticPath = path.join(userDataDir, md5(fbccId + '_static'));
  fs.writeFileSync(staticPath, sunEncode(JSON.stringify(staticConfig)));

  let webglPath = null;
  if (profile.webgl) {
    const gl = resolveWebgl(profile.webgl, profile.browserPlatform || (profile.isMobile ? 'Android' : 'Windows'), fbccId);
    webglPath = path.join(userDataDir, md5(fbccId + '_webgl') + '_' + (profile.browserPlatform || 'Android'));
    const webglConfig = {
      UNMASKED_VENDOR_WEBGL: gl.vendor,
      UNMASKED_RENDERER_WEBGL: gl.renderer,
      GPUAdapterInfo: {
        vendor: String(gl.vendor).toLowerCase(),
        architecture: gl.architecture || ''
      },
      SUPPORTED_EXTENSIONS: []
    };
    fs.writeFileSync(webglPath, JSON.stringify(webglConfig));
  }

  const dynamicPath = path.join(userDataDir, md5(fbccId + '_webrtc'));
  const dynamicConfig = { StrongBlockList: { Version: '3', Domains: [] }, BlockList: { Version: '1', Domains: [] } };
  if (profile.timezone) dynamicConfig.TimeZone = profile.timezone;
  if (profile.geolocation && profile.geolocation.latitude !== undefined) {
    dynamicConfig.Geoposition = `${profile.geolocation.latitude},${profile.geolocation.longitude},${profile.geolocation.accuracy || 1000}`;
  }
  fs.writeFileSync(dynamicPath, JSON.stringify(dynamicConfig));

  const sunBrowserParams = {
    UserId: String(profile.userId || '1'),
    DisableContainer: true,
    StartTime: Math.floor(Date.now() / 1000),
    LoadExtensionErrorBox: false,
    ForceProcessExit: true,
    CustomIcon: null,
    AllowScanPorts: staticConfig.AllowScanPorts,
    GeolocationSetting: 'ask',
    FlashPluginSetting: 'block',
    Platform: staticConfig.Platform,
    DisableBackgroundMode: true,
    HardwareConcurrency: staticConfig.HardwareConcurrency,
    DeviceMemory: staticConfig.DeviceMemory,
    ClientRectFp: staticConfig.ClientRectFp,
    CookiesFile: null,
    ProxyUser: staticConfig.ProxyUser,
    ProxyPassword: staticConfig.ProxyPassword,
    Langs: staticConfig.Langs,
    AcceptLang: staticConfig.AcceptLang,
    TimeZone: profile.timezone || '',
    Geoposition: dynamicConfig.Geoposition || null,
    DynamicConfig: dynamicPath,
    StaticConfig: staticPath
  };
  if (webglPath) sunBrowserParams.WebGLFP = webglPath;
  if (staticConfig.DisableWebRTC) sunBrowserParams.DisableWebRTC = true;
  if (staticConfig.WebRTCAddress) sunBrowserParams.WebRTCAddress = staticConfig.WebRTCAddress;
  if (staticConfig.WebRTCLocalAddress) sunBrowserParams.WebRTCLocalAddress = staticConfig.WebRTCLocalAddress;
  if (staticConfig.CanvasMark) sunBrowserParams.CanvasMark = staticConfig.CanvasMark;
  if (staticConfig.WebGLMark) sunBrowserParams.WebGLMark = staticConfig.WebGLMark;
  if (staticConfig.AudioFp !== undefined) sunBrowserParams.AudioFp = staticConfig.AudioFp;

  const featureSupportPath = path.join(userDataDir, md5(fbccId + '_feature_support'));
  fs.writeFileSync(featureSupportPath, JSON.stringify(['CanvasMarkEx', 'WebGLMarkEx']));

  if (profile.importCookie) {
    const { cookiesFromLine, cookiesFilePath } = require('./cookies');
    const lines = Array.isArray(profile.importCookie) ? profile.importCookie : [profile.importCookie];
    const all = [];
    for (const line of lines) {
      if (typeof line === 'string') all.push(...cookiesFromLine(line));
    }
    if (all.length) {
      const file = cookiesFilePath(userDataDir, fbccId);
      fs.writeFileSync(file, JSON.stringify(all));
      sunBrowserParams.CookiesFile = file;
    }
  }

  const cdpPort = ephemeralDebugPort ? 0 : (profile.debugPort || (19700 + Math.floor(Math.random() * 500)));
  const extParam = sunEncode(JSON.stringify(sunBrowserParams));

  const PROTECTED_KEYS = [
    'UserId', 'StaticConfig', 'DynamicConfig', 'WebGLFP', 'TimeZone', 'Geoposition', 'Platform',
    'HardwareConcurrency', 'DeviceMemory', 'ClientRectFp', 'AcceptLang', 'Langs',
    'ProxyUser', 'ProxyPassword', 'AllowScanPorts', 'CookiesFile', 'CustomIcon',
    'DisableBackgroundMode', 'DisableContainer', 'ForceProcessExit', 'FlashPluginSetting',
    'GeolocationSetting', 'StartTime', 'DisableWebRTC', 'WebRTCAddress', 'WebRTCLocalAddress',
    'CanvasMark', 'WebGLMark', 'AudioFp'
  ];
  const EMPTY_SKIP = new Set(['ProxyUser', 'ProxyPassword', 'CookiesFile', 'CustomIcon', 'Geoposition', 'WebGLFP']);
  const protectedArgs = [];
  const kebab = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  for (const key of PROTECTED_KEYS) {
    const v = sunBrowserParams[key];
    if (v === undefined || v === null) continue;
    if (EMPTY_SKIP.has(key) && v === '') continue;
    if (v === true) protectedArgs.push(`--protected${kebab(key)}=1`);
    else if (v === false) protectedArgs.push(`--protected${kebab(key)}`);
    else if (v === '') protectedArgs.push(`--protected${kebab(key)}`);
    else protectedArgs.push(`--protected${kebab(key)}=${v}`);
  }
  if (sunBrowserParams.LoadExtensionErrorBox === false) protectedArgs.push('--protected-loadextensionerrorbox');
  if (sunBrowserParams.AllowScanPorts === '') protectedArgs.push('--protected-allowscanports');

  const args = [
    '--force-color-profile=srgb',
    '--metrics-recording-only',
    '--no-first-run',
    '--password-store=basic',
    '--use-mock-keychain',
    '--export-tagged-pdf',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${cdpPort}`,
    ...(isSunBrowser ? [`--extended-parameters=${extParam}`, ...protectedArgs] : []),
    '--protected-disable-safe-open',
    '--disable-background-mode',
    '--no-default-browser-check',
    '--window-position=0,0',
    '--disable-renderer-accessibility',
    '--disable-legacy-window',
    '--fake-variations-channel=stable',
    '--variations-server-url=https://clientservices.googleapis.com/chrome-variations/seed',
    '--component-updater=initial-delay=6e5',
    '--enable-features=LoadCryptoTokenExtension,NetworkService,NetworkServiceInProcess,PermuteTLSExtensions',
    '--disable-features=EnablePasswordsAccountStorage,FlashDeprecationWarning,HorizontalTabStripComboButton,OptimizationGuideOnDeviceModel,VerticalTabs,VerticalTabsLaunch,CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-ipc-flooding-protection'
  ];
  if (profile.userAgent && !profile.skipUserAgentFlag) args.push(`--user-agent=${profile.userAgent}`);
  if (profile.locale) args.push(`--lang=${profile.locale}`);
  if (profile.startMaximized) {
    // Normal maximized window: the title bar and standard window controls stay
    // visible. `--start-maximized` must not be combined with `--window-size`,
    // which can otherwise override the maximized state at startup.
    args.push('--start-maximized');
  } else if (profile.startFullscreen) {
    args.push('--start-fullscreen');
  } else if (!profile.skipWindowArgs) {
    if (profile.isMobile) {
      const winW = profile.windowOverride ? profile.windowOverride.width : (2 * m.width);
      args.push(`--window-size=${winW}`);
      args.push(`--ash-host-window-bounds=${winW}`);
    } else {
      const res = String(profile.screenResolution || '1920_1080').split('_');
      const winW = profile.windowOverride ? profile.windowOverride.width : Number(res[0]) || 1280;
      const winH = profile.windowOverride ? profile.windowOverride.height : Number(res[1]) || 720;
      args.push(`--window-size=${winW},${winH}`);
      args.push(`--ash-host-window-bounds=${winW}x${winH}`);
    }
  }
  if (profile.webrtc === 'proxy-udp' || profile.webrtc === 'disabled') {
    args.push('--webrtc-ip-handling-policy=disable_non_proxied_udp');
  }
  if (profile.tlsSwitch && profile.tls) {
    args.push('--cipher-suite-blacklist=' + profile.tls);
  } else if (profile.tlsFeaturesDisabled) {
    args.push('--cipher-suite-blacklist=0x1301');
  }
  if (profile.hardwareAcceleration === 'off' || profile.hardwareAcceleration === 'disabled') {
    args.push('--disable-gpu');
  }
  if (profile.webgpu === 'off') {
    const idx = args.findIndex((a) => a.startsWith('--disable-features='));
    if (idx !== -1) args[idx] += ',WebGPU,WebGPUService';
    else args.push('--disable-features=WebGPU,WebGPUService');
  }
  if ((profile.disableImage || profile.disableVideo) && profile.legacyImageBlock) {
    if (profile.disableImage) args.push('--blink-settings=imagesEnabled=false');
  }
  if (profile.windowPosition) {
    args.push(`--window-position=${profile.windowPosition.x},${profile.windowPosition.y}`);
  }
  if (profile.proxy && (profile.proxy.host || profile.proxy.server)) {
    const pu = parseProxy(profile);
    const auth = pu.username ? `${pu.username}:${pu.password || ''}@` : '';
    args.push(`--proxy-server=${pu.scheme}://${auth}${pu.host}:${pu.port}`);
  }
  if (profile.args && profile.args.length) args.push(...profile.args);
  const targetUrl = profile.openUrl || 'https://www.facebook.com/';
  args.push(isSunBrowser ? targetUrl : 'about:blank');

  const env = { ...process.env };
  delete env.AUTH;
  delete env.ELECTRON_RUN_AS_NODE;

  const proc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});

  return { proc, cdpPort, userDataDir, staticPath, dynamicPath, webglPath, sunBrowserParams, args, fbccId };
}

function waitForCdp(port, timeoutMs = 40000, { signal, proc } = {}) {
  return new Promise((resolve, reject) => {
    let req;
    let retry;
    let settled = false;
    const finish = (err, info) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(retry);
      signal?.removeEventListener('abort', onAbort);
      proc?.removeListener('error', onError);
      proc?.removeListener('exit', onExit);
      req?.destroy();
      if (err) reject(err); else resolve(info);
    };
    const onAbort = () => finish(signal.reason || new Error('Launch cancelled'));
    const onError = (err) => finish(err);
    const onExit = () => finish(new Error('Browser exited before CDP was ready'));
    const deadline = setTimeout(() => finish(new Error('SunBrowser CDP not ready within ' + timeoutMs + 'ms')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    proc?.once('error', onError);
    proc?.once('exit', onExit);
    if (signal?.aborted) return onAbort();
    if (proc && (proc.exitCode !== null || proc.signalCode)) return onExit();
    const attempt = () => {
      if (settled) return;
      req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1500 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('error', onError);
        res.on('end', () => {
          try {
            const info = JSON.parse(body);
            if (!info.webSocketDebuggerUrl) throw new Error('Unexpected CDP response');
            finish(null, info);
          } catch (err) { finish(err); }
        });
      });
      req.on('error', () => { if (!settled) retry = setTimeout(attempt, 250); });
      req.on('timeout', () => req.destroy(new Error('CDP request timed out')));
    };
    attempt();
  });
}

module.exports = { launchKernel, waitForCdp, sunEncode, sunDecode, buildKernelConfig, kernelDir, androidMetrics, hashcode, compatLangs, getAccept };
