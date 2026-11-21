const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { storageRoot } = require('./storage');

/**
 * Decodes a base32 string into a Buffer
 */
function base32Decode(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let cleaned = String(base32 || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = '';
  for (let i = 0; i < cleaned.length; i++) {
    const val = alphabet.indexOf(cleaned[i]);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substr(i, 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * Generates a 6-digit RFC 6238 TOTP code from a 2FA base32 secret
 */
function generateTOTP(secret) {
  if (!secret) return null;
  try {
    const key = base32Decode(secret);
    if (!key.length) return null;
    const epoch = Math.floor(Date.now() / 1000);
    const timeStep = Math.floor(epoch / 30);
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeBigInt64BE(BigInt(timeStep));

    const hmac = crypto.createHmac('sha1', key).update(timeBuffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = (
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)
    ) % 1000000;

    return code.toString().padStart(6, '0');
  } catch (err) {
    return null;
  }
}

/**
 * Checks if the current page is logged in to Facebook
 */
async function checkLoginState(page) {
  return page.evaluate(`(() => {
    const path = location.pathname;
    const href = location.href;
    const isLoginPage = /\\/(login|login_form)(\\.php)?(\\/?|$)/i.test(path);
    const isCheckpoint = /\\/(checkpoint|two_step_verification|two_factor)(\\/?|$)/i.test(path);
    
    // Check if password input is present and visible
    const passInput = Array.from(document.querySelectorAll('input[type="password"]'))
      .some(el => el.offsetWidth > 0 && el.offsetHeight > 0);

    // Check for logged-in indicators
    const hasDTSG = [...document.scripts].some(s => s.textContent && s.textContent.includes('DTSGInitialData'));
    const hasFeed = !!document.querySelector('div[role="feed"], div[role="navigation"], [aria-label*="Your profile"], [aria-label*="Account"], [aria-label*="Facebook"]');
    const hasCookieUser = document.cookie.includes('c_user=');

    if (isCheckpoint) {
      return { status: 'checkpoint', isCheckpoint: true, isLoginPage: false, loggedIn: false };
    }

    if (isLoginPage || passInput) {
      return { status: 'logged_out', isCheckpoint: false, isLoginPage: true, loggedIn: false };
    }

    if (hasDTSG || hasFeed || hasCookieUser) {
      return { status: 'logged_in', isCheckpoint: false, isLoginPage: false, loggedIn: true };
    }

    // Default assume not logged in if password or login markers exist
    return { status: 'unknown', isCheckpoint: false, isLoginPage: false, loggedIn: !passInput && !isLoginPage };
  })()`).catch(() => ({ status: 'error', loggedIn: false }));
}

/**
 * Saves fresh cookies extracted from CDP back into the profile JSON file
 */
async function saveFreshCookies(page, profileName) {
  try {
    if (!page.session) return;
    const res = await page.session.send('Network.getCookies').catch(() => ({ cookies: [] }));
    const fbCookies = (res.cookies || []).filter(c => c.domain && c.domain.includes('facebook.com'));
    if (!fbCookies.length) return;

    const cookieLine = fbCookies.map(c => `${c.name}=${c.value}`).join('; ') + ';';
    const profileFile = path.join(storageRoot, 'profiles', profileName + '.json');
    if (fs.existsSync(profileFile)) {
      const data = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
      data.importCookie = cookieLine;
      data.lastCookieRefresh = Date.now();
      fs.writeFileSync(profileFile, JSON.stringify(data, null, 2));
    }
  } catch (err) {
    // Non-critical background refresh
  }
}

/**
 * Ensures Facebook is logged in:
 * 1. Checks if cookies already work (no action needed).
 * 2. If cookies are expired, auto-fills UID/Phone and Password.
 * 3. If 2FA checkpoint appears, generates and submits TOTP code.
 * 4. Extracts and saves fresh cookies for future sessions.
 */
async function ensureFacebookLogin(page, profile, { onLog = () => {} } = {}) {
  const log = (msg) => onLog(`[auto-login] ${msg}`);
  const profileName = profile.name || 'profile';

  try {
    // 1. Check current login state
    const state = await checkLoginState(page);

    if (state.loggedIn) {
      log(`Active Facebook session confirmed via cookies.`);
      return { ok: true, method: 'cookies' };
    }

    log(`Cookies expired or not logged in. Starting Smart Fallback Auto-Login for ${profileName}...`);

    const username = profile.phone || profile.uid;
    const password = profile.password;

    if (!username || !password) {
      log(`No username/password saved for ${profileName}. Cannot perform fallback login.`);
      return { ok: false, error: 'No credentials saved' };
    }

    // Navigate to login page if not already there
    if (!state.isLoginPage && !state.isCheckpoint) {
      log(`Navigating to Facebook login page...`);
      await page.goto('https://www.facebook.com/login.php', { timeout: 35000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }

    // Check if on login page
    const onLogin = await page.evaluate(`(() => {
      const email = document.querySelector('input[name="email"], input[id="email"], #email');
      const pass = document.querySelector('input[name="pass"], input[id="pass"], #pass, input[type="password"]');
      return !!(email && pass);
    })()`).catch(() => false);

    if (onLogin) {
      log(`Entering login credentials (Account: ${username})...`);
      
      const filled = await page.evaluate(`((user, pass) => {
        function triggerInput(el, val) {
          el.focus();
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const emailEl = document.querySelector('input[name="email"], input[id="email"], #email');
        const passEl = document.querySelector('input[name="pass"], input[id="pass"], #pass, input[type="password"]');

        if (emailEl && passEl) {
          triggerInput(emailEl, user);
          triggerInput(passEl, pass);

          // Click login button
          const btn = document.querySelector('button[name="login"], [data-testid="royal_login_button"], button[type="submit"]');
          if (btn) {
            btn.click();
            return true;
          }
        }
        return false;
      })(${JSON.stringify(username)}, ${JSON.stringify(password)})`).catch(() => false);

      if (filled) {
        log(`Submitted credentials. Waiting for authentication response...`);
        await page.waitForTimeout(6000);
      }
    }

    // Check if 2FA Checkpoint appeared
    const checkpointState = await page.evaluate(`(() => {
      const isCp = /\\/(checkpoint|two_step_verification|two_factor)(\\/?|$)/i.test(location.pathname);
      const codeInput = document.querySelector('input[name="approvals_code"], input[id="approvals_code"], input[autocomplete="one-time-code"]');
      return { isCp, hasCodeInput: !!codeInput };
    })()`).catch(() => ({ isCp: false, hasCodeInput: false }));

    if (checkpointState.isCp || checkpointState.hasCodeInput) {
      log(`2FA Two-Factor Authentication checkpoint detected!`);

      if (profile.twoFactorSecret) {
        const totpCode = generateTOTP(profile.twoFactorSecret);
        if (totpCode) {
          log(`Generated live 2FA code: ${totpCode}. Entering code...`);

          const entered = await page.evaluate(`((code) => {
            const input = document.querySelector('input[name="approvals_code"], input[id="approvals_code"], input[autocomplete="one-time-code"]');
            if (input) {
              input.focus();
              input.value = code;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));

              const submitBtn = document.querySelector('button[id="checkpointSubmitButton"], button[type="submit"], button[name="submit[Continue]"]');
              if (submitBtn) {
                submitBtn.click();
                return true;
              }
            }
            return false;
          })(${JSON.stringify(totpCode)})`).catch(() => false);

          if (entered) {
            log(`2FA code submitted. Waiting for session approval...`);
            await page.waitForTimeout(5000);

            // Handle "Save Browser" / "Remember Browser" secondary checkpoint if present
            await page.evaluate(`(() => {
              const continueBtn = document.querySelector('button[id="checkpointSubmitButton"], button[type="submit"]');
              if (continueBtn) continueBtn.click();
            })()`).catch(() => {});

            await page.waitForTimeout(4000);
          }
        }
      } else {
        log(`⚠️ 2FA required on account, but no 2FA secret key was saved. Please approve manually from your device.`);
        return { ok: false, error: '2FA required without secret key' };
      }
    }

    // Final check: is user logged in now?
    const finalState = await checkLoginState(page);
    if (finalState.loggedIn) {
      log(`✅ Fallback login successful! Updating saved cookies...`);
      await saveFreshCookies(page, profileName);
      return { ok: true, method: 'password_fallback' };
    }

    log(`⚠️ Could not confirm login state after credentials entry.`);
    return { ok: false, error: 'Login not confirmed' };
  } catch (err) {
    log(`❌ Auto-login error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  generateTOTP,
  ensureFacebookLogin,
  checkLoginState,
  saveFreshCookies
};
