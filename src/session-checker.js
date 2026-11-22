const fs = require('fs');
const path = require('path');
const { storageRoot } = require('./storage');
const { loadProfile } = require('./index');

/**
 * Checks Facebook session status directly using saved cookies.
 * Super fast, no GUI browser launching required.
 */
async function checkCookieSession(profileName, profileData = null) {
  let profile = profileData;
  if (!profile) {
    try { profile = loadProfile(profileName); }
    catch { return { state: 'error', message: 'Could not load profile' }; }
  }

  const cookieStr = typeof profile.importCookie === 'string'
    ? profile.importCookie
    : (Array.isArray(profile.importCookie) ? profile.importCookie.join('; ') : '');

  if (!cookieStr || !cookieStr.includes('c_user=')) {
    return { state: 'unverified', message: 'No Facebook cookies saved in profile' };
  }

  const ua = profile.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  try {
    const res = await fetch('https://www.facebook.com/me', {
      method: 'GET',
      headers: {
        'cookie': cookieStr,
        'user-agent': ua,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'sec-fetch-site': 'same-origin'
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(12000)
    });

    const location = res.headers.get('location') || '';

    // If 302 redirecting to profile page (e.g. https://www.facebook.com/profile.php?id=...)
    if (res.status === 302 && (location.includes('profile.php') || location.includes('facebook.com/'))) {
      if (location.includes('/login') || location.includes('login_form')) {
        return { state: 'logged_out', message: 'Session expired (redirected to login)' };
      }
      if (location.includes('/checkpoint')) {
        return { state: 'checkpoint', message: 'Checkpoint detected: verification required' };
      }
      return { state: 'logged_in', location, message: 'Active Facebook session confirmed' };
    }

    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { state: 'logged_out', message: 'Cookies expired or invalidated by Facebook' };
    }

    // Secondary fallback: check homepage
    const wwwRes = await fetch('https://www.facebook.com/', {
      headers: { 'cookie': cookieStr, 'user-agent': ua },
      redirect: 'follow',
      signal: AbortSignal.timeout(14000)
    });

    if (wwwRes.url.includes('/checkpoint')) {
      return { state: 'checkpoint', message: 'Checkpoint detected' };
    }
    if (wwwRes.url.includes('/login') || wwwRes.status === 400) {
      return { state: 'logged_out', message: 'Session expired or logged out' };
    }

    const text = await wwwRes.text();
    if (text.includes('DTSGInitialData') || text.includes('c_user')) {
      return { state: 'logged_in', message: 'Active Facebook session confirmed' };
    }

    return { state: 'logged_out', message: 'Login session expired' };
  } catch (err) {
    return { state: 'error', message: err.message || 'Network request failed' };
  }
}

/**
 * Updates the composerLogin state in the profile's JSON file atomically.
 */
function updateProfileLoginState(profileName, sessionResult) {
  const file = path.join(storageRoot, 'profiles', profileName + '.json');
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.composerLogin = {
      state: sessionResult.state,
      checkedAt: Date.now(),
      message: sessionResult.message || ''
    };
    const tmp = file + '.session.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    return data.composerLogin;
  } catch (err) {
    return null;
  }
}

/**
 * Checks a single profile and saves the result to disk.
 */
async function checkProfileSession(profileName) {
  const result = await checkCookieSession(profileName);
  const updated = updateProfileLoginState(profileName, result);
  return {
    name: profileName,
    session: updated || { state: result.state, checkedAt: Date.now(), message: result.message }
  };
}

/**
 * Concurrently checks sessions for multiple profiles with controlled concurrency.
 */
async function checkBatchSessions(profileNames, concurrency = 4) {
  const results = {};
  const counts = { logged_in: 0, logged_out: 0, checkpoint: 0, unverified: 0, error: 0 };
  let idx = 0;

  async function worker() {
    while (idx < profileNames.length) {
      const name = profileNames[idx++];
      try {
        const res = await checkProfileSession(name);
        results[name] = res.session;
        counts[res.session.state] = (counts[res.session.state] || 0) + 1;
      } catch (err) {
        results[name] = { state: 'error', message: err.message, checkedAt: Date.now() };
        counts.error = (counts.error || 0) + 1;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, profileNames.length) }, () => worker());
  await Promise.all(workers);

  return { results, counts, total: profileNames.length };
}

module.exports = {
  checkCookieSession,
  updateProfileLoginState,
  checkProfileSession,
  checkBatchSessions
};
