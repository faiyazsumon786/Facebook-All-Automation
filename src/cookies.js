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
      // Split preserving empty columns (e.g. blank NUM column in Excel)
      const rawParts = rawLine.split(sep).map(p => p.trim());
      
      let cookieIdx = rawParts.findIndex(p => p.includes('c_user=') || p.includes('datr=') || p.includes('xs='));
      if (cookieIdx === -1) {
        if (rawParts[rawParts.length - 1].includes('=')) {
          cookieIdx = rawParts.length - 1;
        }
      }

      let meta = [];
      if (cookieIdx !== -1) {
        cookies = rawParts.slice(cookieIdx).join(sep);
        meta = rawParts.slice(0, cookieIdx);
      } else {
        meta = rawParts;
        cookies = '';
      }

      const is2FA = s => /^[A-Z2-7]{16,64}$/i.test((s || '').replace(/[\s=-]/g, ''));
      const isDigits = s => /^\+?\d{6,18}$/.test((s || '').trim());

      // If Excel had an empty NUM column: e.g. [UID, "", Pass]
      if (meta.length === 3 && meta[1] === '') {
        uid = meta[0] || null;
        phone = null;
        password = meta[2];
      } else if (meta.length === 4 && meta[1] === '') {
        // [UID, "", Pass, 2FA]
        uid = meta[0] || null;
        phone = null;
        password = meta[2];
        twoFactor = meta[3];
      } else {
        const cleanMeta = meta.filter(Boolean);

        if (cleanMeta.length === 1) {
          password = cleanMeta[0];
        } else if (cleanMeta.length === 2) {
          // [UID, Pass] or [Pass, 2FA]
          if (is2FA(cleanMeta[1])) {
            password = cleanMeta[0];
            twoFactor = cleanMeta[1];
          } else {
            uid = cleanMeta[0];
            password = cleanMeta[1];
          }
        } else if (cleanMeta.length === 3) {
          // Case A: [UID, Pass, 2FA]
          // Case B: [UID, NUM, Pass] (where middle item is phone number)
          if (is2FA(cleanMeta[2])) {
            uid = cleanMeta[0];
            password = cleanMeta[1];
            twoFactor = cleanMeta[2];
          } else if (isDigits(cleanMeta[1])) {
            uid = cleanMeta[0];
            phone = cleanMeta[1];
            password = cleanMeta[2];
          } else {
            uid = cleanMeta[0];
            password = cleanMeta[1];
          }
        } else if (cleanMeta.length >= 4) {
          // [UID, NUM, Pass, 2FA]
          uid = cleanMeta[0];
          if (isDigits(cleanMeta[1])) phone = cleanMeta[1];
          password = cleanMeta[2];
          twoFactor = cleanMeta[3];
        }
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
