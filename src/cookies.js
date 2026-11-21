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
    const line = lines[i].trimStart();
    if (!line.trim()) continue;
    const invalid = message => Object.assign(new Error(`Line ${i + 1}: ${message}`), { status: 400 });
    const prefix = /^(\d{1,32})[ ]*([\t|])/.exec(line);
    let cookies = line.trim(), password = null, uid;
    if (prefix) {
      const second = line.indexOf(prefix[2], prefix[0].length);
      if (second < 0) throw invalid('Expected UID, password and cookies using the same separator.');
      uid = prefix[1];
      password = line.slice(prefix[0].length, second);
      if (!password) throw invalid('Missing password. Use a cookie-only line to skip password saving.');
      cookies = line.slice(second + 1).trim();
    }
    const parts = cookies.split(';').map(part => part.trim()).filter(Boolean);
    if (!parts.length || !/^[\w.-]+\s*=/.test(parts[0]) || !parts.every(part => /^[\w.-]+\s*=/.test(part) || /^(secure|httponly|partitioned)$/i.test(part))) throw invalid('Expected Facebook cookie name=value pairs. Use tabs if the password contains a pipe.');
    const cookieUids = parts.filter(part => /^c_user\s*=/.test(part)).map(part => part.slice(part.indexOf('=') + 1).trim());
    if (cookieUids.some(id => !/^\d{1,32}$/.test(id)) || new Set(cookieUids).size > 1) throw invalid('Invalid or conflicting c_user cookie.');
    if (uid && cookieUids.length && uid !== cookieUids[0]) throw invalid('The UID does not match the c_user cookie.');
    // A wrapped trailing viewport cookie belongs to the preceding account row.
    const previous = records.at(-1);
    if (!prefix && previous?.password && parts.length === 1 && /^vpd=/.test(parts[0])) {
      previous.cookies = previous.cookies.replace(/;\s*$/, '') + '; ' + cookies;
      continue;
    }
    records.push({ uid: uid || cookieUids[0] || null, password, cookies, lineNumber: i + 1 });
  }
  if (!records.length) throw Object.assign(new Error('No cookie lines provided.'), { status: 400 });
  return records;
}

function cookiesFilePath(userDataDir, fbccId) {
  const path = require('path');
  const md5 = crypto.createHash('md5').update(fbccId + '_cookies').digest('hex');
  return path.join(userDataDir, md5);
}

module.exports = { parseCookieLine, cookiesFromLine, accountIdFromLine, cookiesFilePath, parseImportRecords };
