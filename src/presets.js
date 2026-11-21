const path = require('path');
const LIB = require(path.join(__dirname, 'assets', 'fingerprint-library.json'));

function webglPresets(platform) {
  const p = String(platform || '').toLowerCase();
  if (p === 'iphone' || p === 'macos' || p === 'macintel') return LIB.webglPresets.macos;
  if (p === 'android' || p === 'iphone') return LIB.webglPresets.mobile;
  if (p === 'android') return LIB.webglPresets.mobile;
  return LIB.webglPresets.windows;
}

function pickWebgl(platform, seed) {
  const list = webglPresets(platform);
  const idx = Math.abs(seed % list.length);
  const p = list[idx] || list[0];
  return {
    vendor: p.UNMASKED_VENDOR_WEBGL,
    renderer: p.UNMASKED_RENDERER_WEBGL,
    architecture: /Adreno/.test(p.UNMASKED_RENDERER_WEBGL) ? 'adreno' : (/Mali/.test(p.UNMASKED_RENDERER_WEBGL) ? 'mali' : undefined)
  };
}

function pickDevice(title) {
  const d = LIB.standardDevices.find((x) => x.title === title);
  if (!d) return null;
  return {
    title: d.title,
    type: d.type,
    userAgent: d.userAgent,
    capabilities: d.capabilities,
    dpr: d.screen['device-pixel-ratio'],
    vertical: d.screen.vertical,
    horizontal: d.screen.horizontal,
    platform: d.platform,
    model: d.model,
    mobile: d.mobile
  };
}

function profileFromDevice(title, overrides = {}) {
  const d = pickDevice(title);
  if (!d) throw new Error('unknown device: ' + title);
  const isIos = /iPhone/.test(title);
  const profile = {
    isMobile: d.mobile !== false,
    userAgent: d.userAgent,
    dpr: d.dpr,
    screenResolution: `${d.vertical.width * d.dpr}_${d.vertical.height * d.dpr}`,
    browserPlatform: isIos ? 'iPhone' : 'Android',
    device: {
      name: title,
      model: d.model || title.replace(/ /g, '')
    },
    webgl: isIos ? null : pickWebgl('Android', Math.floor(Math.random() * 1e6)),
    ...overrides
  };
  return profile;
}

function listDevices() {
  return LIB.standardDevices.map((d) => d.title);
}

module.exports = {
  LIB,
  webglPresets,
  pickWebgl,
  pickDevice,
  profileFromDevice,
  listDevices
};
