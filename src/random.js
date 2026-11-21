const crypto = require('crypto');
const { LIB, pickWebgl } = require('./presets');

const LOCALES = ['en-US', 'en-GB', 'es-419', 'pt-BR', 'de-DE', 'fr-FR', 'ja-JP', 'zh-CN', 'ar-SA', 'tr-TR', 'hi-IN', 'id-ID', 'vi-VN', 'th-TH', 'ru-RU', 'it-IT', 'pl-PL', 'nl-NL', 'sv-SE', 'ko-KR'];
const DESKTOP_RES = ['1920_1080', '1366_768', '2560_1440', '1536_864', '1280_720', '3840_2160', '1680_1050', '1600_900'];
const MOBILE_RES = ['1080_2408', '1080_2340', '1080_1920', '720_1600', '720_1280', '1440_3120', '2400_1080', '2340_1080'];
const ANDROID_DPR = [2.625, 2.75, 2.8125, 3, 3.5];
const DESKTOP_DPR = [1, 1, 1, 1, 1.25, 1.5, 2];
const DESKTOP_CPU = [2, 4, 4, 6, 8, 8, 8, 12, 16];
const DESKTOP_RAM = [8, 8, 8, 16, 16, 16, 32, 32, 64];
const MOBILE_CPU = [4, 6, 8, 8, 8, 10, 10, 12];
const MOBILE_RAM = [3, 4, 4, 6, 6, 8, 8, 8, 12];
const ANDROID_VERSIONS = ['10', '11', '12', '13', '14', '15'];
const KERNEL_MAJOR = '153';

const SAMSUNG_MODELS = {
  'Samsung Galaxy S8+': 'SM-G955F',
  'Samsung Galaxy S20 Ultra': 'SM-G988B',
  'Samsung Galaxy A55': 'SM-A556E',
  'Samsung Galaxy A51/71': 'SM-A515F',
  'Galaxy Z Fold 6': 'SM-F956B',
  'Galaxy Z Fold 5': 'SM-F946B',
  'Galaxy Tab S4': 'SM-T830'
};

const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const chance = (p) => Math.random() < p;
const hexBytes = (n) => Array.from(crypto.randomBytes(n)).map((b) => b.toString(16).padStart(2, '0'));

function randomMac() {
  const b = crypto.randomBytes(6);
  b[0] = (b[0] & 0xfe) | 0x02;
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(':');
}

function randomDesktopName() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 7; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return 'DESKTOP-' + s;
}

function androidUa(model) {
  const ver = rnd(ANDROID_VERSIONS);
  return `Mozilla/5.0 (Linux; Android ${ver}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.8010.52 Mobile Safari/537.36`;
}

function mobileFromDevice(platform) {
  let pool = LIB.standardDevices.filter((d) => d.type === 'phone');
  if (platform === 'iPhone') pool = pool.filter((d) => /^iPhone/.test(d.title));
  else pool = pool.filter((d) => !/^iPhone/.test(d.title) && !/JioPhone|Facebook|Nest/.test(d.title));
  if (!pool.length) pool = LIB.standardDevices.filter((d) => d.type === 'phone');
  const d = rnd(pool);
  const vertical = d.screen ? d.screen.vertical : { width: 360, height: 800 };
  const dpr = d.screen && d.screen['device-pixel-ratio'] ? d.screen['device-pixel-ratio'] : rnd(ANDROID_DPR);
  const res = `${Math.round(vertical.width * dpr)}_${Math.round(vertical.height * dpr)}`;
  if (platform === 'iPhone') {
    return {
      userAgent: d.userAgent,
      dpr,
      screenResolution: res,
      model: d.model || d.title.replace(/ /g, ''),
      name: d.title
    };
  }
  const model = SAMSUNG_MODELS[d.title] || d.title.replace(/ /g, '').replace(/[()]/g, '');
  return {
    userAgent: androidUa(model),
    dpr,
    screenResolution: res,
    model,
    name: d.title
  };
}

function voicesFor(locale) {
  const base = String(locale || 'en-US');
  const tag = base.split('-')[0].toUpperCase();
  return [
    { name: `Google ${base}`, lang: base },
    { name: `Google ${tag} English`, lang: base },
    { name: `Google ${base} Female`, lang: base }
  ];
}

function generateRandomProfile(opts = {}) {
  const platforms = opts.platforms && opts.platforms.length ? opts.platforms : ['Android', 'iPhone', 'Windows', 'macOS', 'Linux'];
  const platform = rnd(platforms);
  const isMobile = platform === 'Android' || platform === 'iPhone';
  const seed = crypto.randomBytes(8).toString('hex');

  const locale = platform === 'Windows' ? 'en-US' : rnd(LOCALES);

  const profile = {
    engine: 'kernel',
    id: 'pf_' + seed,
    browserPlatform: platform,
    isMobile,
    locale,
    timezoneId: 'auto',
    geolocation: 'auto',
    hardware: {
      cpu: isMobile ? rnd(MOBILE_CPU) : rnd(DESKTOP_CPU),
      ram: isMobile ? rnd(MOBILE_RAM) : rnd(DESKTOP_RAM)
    },
    canvas: { mode: chance(0.5) ? 'noise' : 'real' },
    audioContext: { mode: chance(0.5) ? 'noise' : 'real' },
    clientRects: chance(0.6) ? { mode: 'noise' } : { mode: 'real' },
    mediaDevices: { mode: isMobile ? 'real' : 'noise' },
    webrtc: rnd(['real', 'proxy-udp', 'proxy-udp', 'disabled']),
    connectionType: isMobile ? rnd(['default', 'default', 'wifi', 'cellular']) : 'default',
    dnt: chance(0.3),
    portScanProtection: chance(0.7),
    gyroscope: isMobile && chance(0.7),
    hardwareAcceleration: chance(0.9) ? 'default' : 'off',
    webgpu: chance(0.8) ? 'on' : 'off',
    tlsFeaturesDisabled: chance(0.15),
    headless: false,
    openHiddenDevTools: false
  };

  if (isMobile && chance(0.5)) {
    profile.speechVoices = voicesFor(locale);
  }

  const webgl = pickWebgl(platform === 'iPhone' ? 'MacOS' : platform, randInt(0, 100000));
  profile.webgl = chance(0.5)
    ? { mode: 'noise', vendor: webgl.vendor, renderer: webgl.renderer, architecture: webgl.architecture }
    : { mode: 'real', vendor: webgl.vendor, renderer: webgl.renderer, architecture: webgl.architecture };

  if (isMobile) {
    const dev = mobileFromDevice(platform);
    profile.userAgent = dev.userAgent;
    profile.dpr = dev.dpr;
    profile.screenResolution = dev.screenResolution;
    profile.device = { name: dev.name, model: dev.model, mac: randomMac() };
  } else {
    profile.screenResolution = rnd(DESKTOP_RES);
    profile.dpr = rnd(DESKTOP_DPR);
    profile.userAgent = {
      Windows: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.8010.52 Safari/537.36`,
      macOS: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.8010.52 Safari/537.36`,
      Linux: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.8010.52 Safari/537.36`
    }[platform];
    profile.device = { name: randomDesktopName(), model: '', mac: randomMac() };
  }

  if (opts.namePrefix) profile._namePrefix = opts.namePrefix;
  return profile;
}

function generateBatch(count, opts = {}) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = generateRandomProfile(opts);
    const prefix = opts.namePrefix || 'profile';
    p.name = `${prefix}-${String(i + 1).padStart(2, '0')}-${hexBytes(2).join('')}`;
    delete p._namePrefix;
    out.push(p);
  }
  return out;
}

module.exports = { generateRandomProfile, generateBatch, randomMac };
