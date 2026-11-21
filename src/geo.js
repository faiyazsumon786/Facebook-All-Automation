const net = require('net');
const tls = require('tls');

const LOCALES = {
  AF: 'fa-AF', AL: 'sq-AL', DZ: 'ar-DZ', AR: 'es-AR', AM: 'hy-AM', AU: 'en-AU',
  AT: 'de-AT', AZ: 'az-AZ', BD: 'bn-BD', BY: 'be-BY', BE: 'nl-BE', BO: 'es-BO',
  BA: 'bs-BA', BR: 'pt-BR', BG: 'bg-BG', KH: 'km-KH', CA: 'en-CA', CL: 'es-CL',
  CN: 'zh-CN', CO: 'es-CO', CR: 'es-CR', HR: 'hr-HR', CZ: 'cs-CZ', DK: 'da-DK',
  DO: 'es-DO', EC: 'es-EC', EG: 'ar-EG', SV: 'es-SV', EE: 'et-EE', FI: 'fi-FI',
  FR: 'fr-FR', GE: 'ka-GE', DE: 'de-DE', GR: 'el-GR', GT: 'es-GT', HN: 'es-HN',
  HK: 'zh-HK', HU: 'hu-HU', IS: 'is-IS', IN: 'en-IN', ID: 'id-ID', IR: 'fa-IR',
  IQ: 'ar-IQ', IE: 'en-IE', IL: 'he-IL', IT: 'it-IT', JM: 'en-JM', JP: 'ja-JP',
  JO: 'ar-JO', KZ: 'kk-KZ', KE: 'sw-KE', KR: 'ko-KR', KW: 'ar-KW', LV: 'lv-LV',
  LB: 'ar-LB', LT: 'lt-LT', LU: 'fr-LU', MY: 'ms-MY', MT: 'mt-MT', MX: 'es-MX',
  MD: 'ro-MD', MN: 'mn-MN', ME: 'sr-ME', MA: 'ar-MA', NP: 'ne-NP', NL: 'nl-NL',
  NZ: 'en-NZ', NI: 'es-NI', NG: 'en-NG', MK: 'mk-MK', NO: 'nb-NO', OM: 'ar-OM',
  PK: 'ur-PK', PA: 'es-PA', PY: 'es-PY', PE: 'es-PE', PH: 'en-PH', PL: 'pl-PL',
  PT: 'pt-PT', PR: 'es-PR', QA: 'ar-QA', RO: 'ro-RO', RU: 'ru-RU', SA: 'ar-SA',
  RS: 'sr-RS', SG: 'en-SG', SK: 'sk-SK', SI: 'sl-SI', ZA: 'en-ZA', ES: 'es-ES',
  LK: 'si-LK', SE: 'sv-SE', CH: 'de-CH', TW: 'zh-TW', TZ: 'sw-TZ', TH: 'th-TH',
  TN: 'ar-TN', TR: 'tr-TR', UA: 'uk-UA', AE: 'ar-AE', GB: 'en-GB', US: 'en-US',
  UY: 'es-UY', UZ: 'uz-UZ', VE: 'es-VE', VN: 'vi-VN', YE: 'ar-YE', ZW: 'en-ZW'
};

function parseProxy(proxy) {
  if (!proxy) return null;
  if (typeof proxy === 'string') return new URL(proxy);
  if (proxy.server) return new URL(proxy.server);
  if (proxy.host) {
    const u = new URL(`${proxy.scheme || 'http'}://${proxy.host}:${proxy.port || 80}`);
    u.username = proxy.username || '';
    u.password = proxy.password || '';
    return u;
  }
  throw new Error('Invalid proxy configuration');
}

function decodeChunked(raw) {
  let out = '';
  let data = raw;
  while (data.length) {
    const lineEnd = data.indexOf('\r\n');
    if (lineEnd === -1) return out + data;
    const size = parseInt(data.slice(0, lineEnd), 16);
    if (!size) return out;
    out += data.slice(lineEnd + 2, lineEnd + 2 + size);
    data = data.slice(lineEnd + 2 + size + 2);
  }
  return out;
}

function httpsViaProxy(proxyUrl, host, port, request) {
  return new Promise((resolve, reject) => {
    const u = new URL(proxyUrl);
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('Geo lookup does not support this proxy scheme'));
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; socket?.destroy(); reject(err); } };
    const done = (body) => { if (!settled) { settled = true; resolve(body); } };
    let connectHead = '';
    let socket;
    const onConnectData = (chunk) => {
      connectHead += chunk.toString('latin1');
      const idx = connectHead.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const status = connectHead.split('\r\n')[0] || '';
      if (!status.includes(' 200 ')) return fail(new Error('proxy CONNECT failed: ' + status));
      socket.removeListener('data', onConnectData);
      const secure = tls.connect({ socket, servername: host, rejectUnauthorized: true }, () => {
        secure.write(request);
      });
      let headBuf = Buffer.alloc(0);
      let bodyBuf = Buffer.alloc(0);
      let inBody = false;
      let chunked = false;
      secure.on('data', (c) => {
        if (!inBody) {
          headBuf = Buffer.concat([headBuf, c]);
          const sep = headBuf.indexOf('\r\n\r\n');
          if (sep === -1) return;
          chunked = /transfer-encoding:\s*chunked/i.test(headBuf.slice(0, sep).toString('latin1'));
          bodyBuf = headBuf.slice(sep + 4);
          inBody = true;
        } else {
          bodyBuf = Buffer.concat([bodyBuf, c]);
        }
      });
      secure.on('error', fail);
      secure.on('end', () => {
        let latin = bodyBuf.toString('latin1');
        if (chunked) latin = decodeChunked(latin);
        done(Buffer.from(latin, 'latin1').toString('utf8'));
      });
    };
    const connect = u.protocol === 'https:' ? tls.connect : net.connect;
    socket = connect({ host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)), ...(u.protocol === 'https:' ? { servername: u.hostname } : {}) }, () => {
      let connectLine = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
      if (u.username) {
        const auth = Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password || '')).toString('base64');
        connectLine += `Proxy-Authorization: Basic ${auth}\r\n`;
      }
      socket.write(connectLine + '\r\n');
    });
    socket.setTimeout(8000, () => fail(new Error('Proxy lookup timed out')));
    socket.on('data', onConnectData);
    socket.on('error', fail);
  });
}

async function fetchIpInfo(proxyUrl) {
  const fields = 'status,message,countryCode,timezone,lat,lon,city,query';
  let text;
  if (proxyUrl) {
    const request = `GET /json/?fields=${fields} HTTP/1.1\r\nHost: ip-api.com\r\nUser-Agent: fingerprint-studio\r\nAccept: */*\r\nConnection: close\r\n\r\n`;
    text = await withTimeout(httpsViaProxy(proxyUrl, 'ip-api.com', 443, request), 8000, 'geo lookup via proxy timed out');
  } else {
    const res = await fetch(`http://ip-api.com/json/?fields=${fields}`, { signal: AbortSignal.timeout(8000) });
    text = await res.text();
  }
  return JSON.parse(text.trim());
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

async function resolveGeo(profile) {
  const fallback = { locale: 'en-US', timezone: 'UTC', geolocation: null, ip: null };
  try {
    const proxy = parseProxy(profile.proxy);
    const info = await fetchIpInfo(proxy ? proxy.toString() : null);
    if (info.status !== 'success') return fallback;
    return {
      locale: LOCALES[info.countryCode] || 'en-US',
      timezone: info.timezone || 'UTC',
      geolocation: (info.lat !== undefined && info.lon !== undefined) ? { latitude: info.lat, longitude: info.lon, accuracy: 20 } : null,
      countryCode: info.countryCode,
      city: info.city || null,
      ip: info.query || null
    };
  } catch (err) {
    console.warn('[geo] lookup failed, using defaults:', err.message);
    return fallback;
  }
}

module.exports = { resolveGeo, parseProxy };
