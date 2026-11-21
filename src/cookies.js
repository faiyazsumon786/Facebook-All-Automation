const crypto = require('crypto');

function parseCookieLine(line) {
  const cookies = [];
  let expires = null;
  for (const part of String(line).split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (name === 'expires') {
      const t = Date.parse(value);
      if (!Number.isNaN(t)) expires = t / 1000;
      continue;
    }
    try { value = decodeURIComponent(value); } catch (e) {}
    if (!name || !value) continue;
    cookies.push({ name, value });
  }
  return { cookies, expires };
}

function cookiesFromLine(line, { domain = '.facebook.com', ttlDays = 30 } = {}) {
  const { cookies, expires } = parseCookieLine(line);
  const fallbackExpiry = Math.floor(Date.now() / 1000) + ttlDays * 86400;
  return cookies.map((c, i) => ({
    name: c.name,
    value: c.value,
    domain,
    path: '/',
    sameSite: 'Unspecified',
    storeId: '0',
    id: String(i),
    httpOnly: false,
    secure: true,
    expires: expires || fallbackExpiry
  }));
}

function accountIdFromLine(line) {
  const m = String(line).match(/(?:^|;\s*)c_user=(\d+)/);
  return m ? m[1] : null;
}

function parseImportRecords(text) {
  const records = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine) continue;

    const invalid = message => Object.assign(new Error(`Line ${i + 1}: ${message}`), { status: 400 });

    let sep = null;
    if (rawLine.includes('\t')) sep = '\t';
    else if (rawLine.includes('|')) sep = '|';

    let cookies = rawLine;
    let uid = null;
    let phone = null;
    let password = null;
    let twoFactor = null;

    if (sep) {
      const parts = rawLine.split(sep).map(p => p.trim()).filter(Boolean);
      
      let cookieIdx = parts.findIndex(p => p.includes('c_user=') || p.includes('datr=') || p.includes('xs='));
      if (cookieIdx === -1) {
        if (parts[parts.length - 1].includes('=')) {
          cookieIdx = parts.length - 1;
        }
      }

      let metaParts = [];
      if (cookieIdx !== -1) {
        cookies = parts.slice(cookieIdx).join(sep);
        metaParts = parts.slice(0, cookieIdx);
      } else {
        metaParts = parts;
        cookies = '';
      }

      const is2FA = s => /^[A-Z2-7]{16,32}$/i.test(s.replace(/[\s=-]/g, ''));

      if (metaParts.length === 1) {
        password = metaParts[0];
      } else if (metaParts.length === 2) {
        if (is2FA(metaParts[1])) {
          password = metaParts[0];
          twoFactor = metaParts[1];
        } else {
          uid = metaParts[0];
          password = metaParts[1];
        }
      } else if (metaParts.length === 3) {
        if (is2FA(metaParts[2])) {
          uid = metaParts[0];
          password = metaParts[1];
          twoFactor = metaParts[2];
        } else {
          uid = metaParts[0];
          phone = metaParts[1];
          password = metaParts[2];
        }
      } else if (metaParts.length >= 4) {
        uid = metaParts[0];
        phone = metaParts[1];
        password = metaParts[2];
        twoFactor = metaParts[3];
      }
    }

    if (cookies) {
      const cookieParts = cookies.split(';').map(p => p.trim()).filter(Boolean);
      const cookieUids = cookieParts.filter(p => /^c_user\s*=/.test(p)).map(p => p.slice(p.indexOf('=') + 1).trim());
      if (cookieUids.length) {
        if (!uid) uid = cookieUids[0];
      }
    }

    if (!cookies && !password) {
      throw invalid('Line must contain cookies or credentials.');
    }

    records.push({
      uid: uid || null,
      phone: phone || null,
      password: password || null,
      twoFactor: twoFactor ? twoFactor.replace(/[\s=-]/g, '').toUpperCase() : null,
      cookies: cookies || '',
      lineNumber: i + 1
    });
  }

  if (!records.length) throw Object.assign(new Error('No valid account rows provided.'), { status: 400 });
  return records;
}

function cookiesFilePath(userDataDir, fbccId) {
  const path = require('path');
  const md5 = crypto.createHash('md5').update(fbccId + '_cookies').digest('hex');
  return path.join(userDataDir, md5);
}

module.exports = { parseCookieLine, cookiesFromLine, accountIdFromLine, cookiesFilePath, parseImportRecords };
