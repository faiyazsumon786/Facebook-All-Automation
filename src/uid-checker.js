const { accountIdFromLine } = require('./cookies');
const ENDPOINT = 'https://check.fb.tools/api/check/facebook';
const MAX_AGE = 15 * 60 * 1000;
const results = new Map();
const pending = new Map();

function profileUid(profile, name = profile?.name || '') {
  if (!profile && name) {
    try { profile = require('./index').loadProfile(name); } catch {}
  }
  if (!profile) {
    const fallback = (/^fb-(\d+)(?:-\d+)?$/.exec(name) || [])[1];
    return fallback && /^\d{1,30}$/.test(fallback) ? fallback : null;
  }
  const lines = Array.isArray(profile.importCookie) ? profile.importCookie : [profile.importCookie];
  const ids = [...new Set(lines.filter(line => typeof line === 'string').map(accountIdFromLine).filter(Boolean))];
  if (ids.length > 1) return null;
  const uid = ids[0] || (/^fb-(\d+)(?:-\d+)?$/.exec(name) || [])[1];
  return uid && /^\d{1,30}$/.test(uid) ? uid : null;
}

// Accept NDJSON as well as adjacent pretty-printed JSON objects from the service.
function parseEvents(text) {
  const events = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (start === -1) {
      if (/\s/.test(ch)) continue;
      if (ch !== '{') throw new Error('Unexpected checker response');
      start = i;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      events.push(JSON.parse(text.slice(start, i + 1)));
      start = -1;
    }
  }
  if (start !== -1) throw new Error('Incomplete checker response');
  return events;
}

async function checkUid(uid, fetchImpl = fetch) {
  if (!/^\d{1,30}$/.test(uid)) throw new Error('Invalid UID');
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(25000),
    headers: { accept: 'application/x-ndjson', 'content-type': 'application/json', origin: 'https://check.fb.tools', referer: 'https://check.fb.tools/' },
    body: JSON.stringify({ inputData: [uid], userLang: 'en', checkFriends: false })
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Checker returned HTTP ${response.status}`); }
  let text = '', size = 0;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 1024 * 1024) throw new Error('Checker response is too large');
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  const matches = parseEvents(text).filter(event => event.event === 'result' && String(event.data?.uid || event.data?.account || '') === uid);
  if (matches.length !== 1) throw new Error('Checker did not return a unique result for this UID');
  const status = matches[0].data.status;
  const providerStatus = typeof status?.name === 'string' ? status.name : '';
  const normalized = providerStatus.toLowerCase();
  const state = normalized === 'valid' ? 'alive' : ['invalid', 'noexist'].includes(normalized) ? 'dead' : 'error';
  return { uid, state, providerStatus, message: String(status?.message || 'Unrecognized checker status').slice(0, 200), checkedAt: Date.now() };
}

function getUidCheck(name, profile) {
  const result = results.get(name);
  return result && result.uid === profileUid(profile, name) ? result : null;
}

function isDeletableDead(name, profile, now = Date.now()) {
  const result = getUidCheck(name, profile);
  return !!result && result.state === 'dead' && now - result.checkedAt < MAX_AGE;
}

async function checkProfileUid(name, profile, fetchImpl = fetch) {
  const uid = profileUid(profile, name);
  if (!uid) {
    const result = { uid: null, state: 'skipped', message: 'No unambiguous UID in cookies or profile name', checkedAt: Date.now() };
    results.set(name, result);
    return result;
  }
  const key = name + ':' + uid;
  if (pending.has(key)) return pending.get(key);
  results.delete(name);
  const task = (async () => {
    let result;
    try { result = await checkUid(uid, fetchImpl); }
    catch (error) { result = { uid, state: 'error', message: error.name === 'TimeoutError' ? 'Checker timed out; retry' : error.message, checkedAt: Date.now() }; }
    results.set(name, result);
    return result;
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}

function forgetUidCheck(name) { results.delete(name); }
module.exports = { profileUid, parseEvents, checkUid, checkProfileUid, getUidCheck, isDeletableDead, forgetUidCheck };
