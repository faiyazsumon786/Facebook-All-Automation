const fs = require('fs');
const path = require('path');
const { startProfile, stopProfile, getSession } = require('./manager');
const { connectOverCDP, listPages, Page } = require('./cdp');
const { listProfiles } = require('./index');
const { scanAccountStatus } = require('./account-status');
const { uniquifyVideo, cleanupFiles } = require('./uniquifier');
const { simulateHumanActivity } = require('./warmup');

const storageRoot = require('./storage').storageRoot;
const COMPOSER_URL = 'https://business.facebook.com/latest/bulk_upload_composer?ir_qe_exposed=1&asset_id=';

const VISIBILITY_PATCH = `(function () {
  try {
    Object.defineProperty(document, 'hidden', { get: function () { return false; }, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: function () { return 'visible'; }, configurable: true });
    Object.defineProperty(document, 'webkitVisibilityState', { get: function () { return 'visible'; }, configurable: true });
  } catch (e) {}
  try {
    document.hasFocus = function () { return true; };
  } catch (e) {}
  try {
    if (!window.__react_dom_patched) {
      window.__react_dom_patched = true;
      const origRemove = Node.prototype.removeChild;
      Node.prototype.removeChild = function(child) {
        if (!child || child.parentNode !== this) return child;
        return origRemove.apply(this, arguments);
      };
      const origInsert = Node.prototype.insertBefore;
      Node.prototype.insertBefore = function(newNode, refNode) {
        if (refNode && refNode.parentNode !== this) return newNode;
        return origInsert.apply(this, arguments);
      };
    }
  } catch (e) {}
})();`;

// Short command-level timeouts (seconds of CDP silence per call) stay separate
// from the much longer whole-upload budget, so a slow browser never aborts an
// upload that is still progressing.
const UPLOAD_TIMEOUT_DEFAULT = 900000; // 15 minutes for a whole profile batch
const NAV_TIMEOUT = 120000;            // slow composer navigation is retried within this budget
const COMPOSER_READY_TIMEOUT = 60000;  // poll for the composer file input to appear
const LOGIN_CHECK_TIMEOUT = 15000;     // DTSG marker polling for the login verdict
const ACCOUNT_SCAN_TIMEOUT = 90000;    // budget for the Account Status page and Page discovery
const CDP_EVALUATE_TIMEOUT = 30000;    // one Runtime.evaluate call while the page is busy
const STALL_WARN_MS = 120000;          // report "no progress" after two quiet minutes
const FIELD_WAIT_MS = 30000;           // recheck window for composer metadata fields

const jobs = new Map();

function newTask(profileName) {
  return {
    name: profileName,
    state: 'queued',
    error: null,
    log: [],
    progress: null,
    startedAt: null,
    doneAt: null
  };
}

function log(job, msg) {
  job.log.push(new Date().toISOString().slice(11, 19) + ' ' + msg);
  if (job.log.length > 60) job.log.shift();
}

// Recoverable CDP hiccups (command timed out, renderer context was replaced,
// socket closed) should be retried instead of failing the profile.
function isCdpError(err) {
  const msg = String(err && (err.message || err) || '');
  return /CDP timeout/.test(msg) || /CDP not connected/.test(msg) || /CDP connection closed/.test(msg) ||
    /Cannot find context/.test(msg) || /Execution context was destroyed/.test(msg) || /session closed/i.test(msg);
}

const SESSION_MESSAGES = {
  logged_out: 'Logged out / cookie expired. Log in again or delete this profile.',
  checkpoint: 'Facebook requires verification. Open the profile to continue.',
  unverified: 'Login unverified. Open the profile and check Facebook login.'
};

// A lease covers launch, upload, review (if needed), and browser shutdown.
const activeProfiles = new Set();
const slotWaiters = new Set();
function notifySlotWaiters() {
  for (const wake of slotWaiters) wake();
  slotWaiters.clear();
}

function rememberSession(job, state) {
  const file = path.join(storageRoot, 'profiles', job.name + '.json');
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
  profile.composerLogin = { state, checkedAt: Date.now() };
  fs.writeFileSync(file + '.session.tmp', JSON.stringify(profile, null, 2));
  fs.renameSync(file + '.session.tmp', file);
}

function rememberAccountStatus(job, scan) {
  const file = path.join(storageRoot, 'profiles', job.name + '.json');
  try {
    const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
    profile.accountStatus = {
      scannedAt: Date.now(),
      scanFailed: !!scan.scanFailed,
      risk: !!scan.scanFailed,
      error: scan.error || null,
      mainProfileId: scan.mainProfileId || null,
      totalCount: (scan.pages || []).length,
      warningCount: scan.warningCount || 0,
      healthyCount: scan.healthyCount || 0,
      unknownCount: scan.unknownCount || 0,
      pages: (scan.pages || []).map((p) => ({ name: p.name, profileId: p.profileId, pageId: p.pageId, status: p.status }))
    };
    fs.writeFileSync(file + '.session.tmp', JSON.stringify(profile, null, 2));
    fs.renameSync(file + '.session.tmp', file);
  } catch (error) {
    log(job, 'Could not save Account Status scan: ' + error.message);
  }
}

function rememberLastUpload(task) {
  try {
    const file = path.join(storageRoot, 'profiles', task.name + '.json');
    if (!fs.existsSync(file)) return;
    const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
    const publishedPages = (task.pages || []).filter(p => p.state === 'published' || p.state === 'accepted');
    let summary = '';
    if (task.state === 'done' || task.state === 'accepted') {
      summary = `Published to ${publishedPages.map(p => p.name).join(', ') || 'Page'}`;
    } else if (task.state === 'skipped') {
      summary = task.error || 'Skipped: No managed Page found';
    } else if (task.state === 'failed') {
      summary = task.error || 'Upload failed';
    } else {
      summary = task.error || task.state || 'Finished';
    }
    profile.lastUpload = {
      timestamp: Date.now(),
      state: task.state,
      error: task.error || null,
      publishedPages: publishedPages.map(p => p.name),
      summary
    };
    fs.writeFileSync(file + '.session.tmp', JSON.stringify(profile, null, 2));
    fs.renameSync(file + '.session.tmp', file);
  } catch (e) {}
}

async function inspectSession(page, job, timeoutMs = LOGIN_CHECK_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let checkedUrl, rawMarker = false, state = 'unverified';
  let cdpErrors = 0;
  do {
    let view;
    try {
      view = await page.composerSession(15000);
      cdpErrors = 0;
    } catch (err) {
      if (!isCdpError(err)) throw err;
      if (++cdpErrors >= 4) throw new Error('The browser stopped responding while checking the Facebook login. Close the profile and retry.');
      await page.waitForTimeout(1000);
      continue;
    }
    const url = new URL(view.href);
    if (url.protocol !== 'https:' || !/(^|\.)facebook\.com$/.test(url.hostname)) return { state: 'unverified', notFacebook: true, href: view.href };
    if (view.challenge) return { state: 'checkpoint' };
    if (view.loggedOut) return { state: 'logged_out' };
    if (view.requestError) return { requestError: true };
    if (view.href !== checkedUrl) {
      checkedUrl = view.href;
      rawMarker = !view.marker && await page.documentHasSessionMarker().catch(() => false);
    }
    state = view.marker || rawMarker ? 'logged_in' : 'unverified';
    if (state === 'logged_in') {
      if (view.file && url.pathname.includes('/bulk_upload_composer')) return { state, file: true };
      if (url.pathname.includes('/bulk_upload_composer')) log(job, 'composer is open but the file input is not ready yet');
    }
    await page.waitForTimeout(400);
  } while (Date.now() < deadline);
  return { state, file: false };
}

// If the page-level CDP socket dies mid-upload while the browser itself is
// still alive, re-attach to the existing composer tab instead of restarting
// the upload (which could create duplicate uploads).
async function reattachComposer(port, job, previous) {
  try {
    const pages = await listPages(port);
    const target = pages.find(p => p.webSocketDebuggerUrl === previous.wsUrl);
    if (!target) return null;
    const page = await Page.connect(target.webSocketDebuggerUrl);
    await page.addInitScript(VISIBILITY_PATCH).catch(() => {});
    await page.forceActive().catch(() => {});
    log(job, 'reconnected to the composer tab');
    return page;
  } catch (err) {
    log(job, 'could not reconnect to the composer tab: ' + err.message);
    return null;
  }
}

async function prepareRows(page, port, job, videos, title, description, timeoutMs, replacePage) {
  const filenames = videos.map(file => path.basename(file));
  const completed = new Set(), occurrences = new Map();
  const expectedKeys = new Set(filenames.map(name => {
    const occurrence = occurrences.get(name) || 0;
    occurrences.set(name, occurrence + 1);
    return JSON.stringify([name, occurrence]);
  }));
  const uploadDeadline = Date.now() + timeoutMs;
  const metadata = description || title;
  let completedAt = 0, fieldsReady = !metadata;
  let consecutiveCdpErrors = 0;
  let lastProgressAt = Date.now(), lastSignature = '', stallWarned = false;
  let lastFields = null, detectedLog = '', mismatchLog = '';
  while (Date.now() < (completedAt ? completedAt + FIELD_WAIT_MS : uploadDeadline)) {
    if (!completedAt) {
      let progress;
      try {
        progress = await page.progressStatus(filenames, CDP_EVALUATE_TIMEOUT);
        consecutiveCdpErrors = 0;
      } catch (err) {
        if (!isCdpError(err)) throw err;
        consecutiveCdpErrors++;
        log(job, 'CDP delay while checking upload progress: ' + err.message);
        if (!page.isOpen() || consecutiveCdpErrors >= 3) {
          const reattached = await reattachComposer(port, job, page);
          if (reattached) { page.session?.close?.(); page = reattached; replacePage(page); consecutiveCdpErrors = 0; continue; }
          const cdpLost = new Error('CDP connection was lost while uploads were still running. Check the profile before retrying.');
          cdpLost.keepBrowser = true;
          throw cdpLost;
        }
        await page.waitForTimeout(800 * consecutiveCdpErrors);
        continue;
      }
      for (const key of progress.completed) if (expectedKeys.has(key)) completed.add(key);
      const all = completed.size === filenames.length || (!progress.namedRows && progress.bars === filenames.length && progress.at100 === filenames.length);
      job.progress = all ? 100 : Math.round(100 * completed.size / filenames.length);
      const now = Date.now();
      const signature = [progress.completed.length, progress.bars, progress.at100, progress.inProgress].join(':');
      if (signature !== lastSignature) {
        lastSignature = signature;
        lastProgressAt = now;
        stallWarned = false;
      } else if (!all && now - lastProgressAt > STALL_WARN_MS && progress.inProgress > 0 && !stallWarned) {
        stallWarned = true;
        log(job, `uploads have shown no progress for ${Math.round(STALL_WARN_MS / 60000)} minutes (${progress.inProgress} still in progress)`);
      }
      if (all) {
        completedAt = now;
        log(job, `all ${filenames.length} uploads reached 100%`);
      }
    }
    if (metadata && !fieldsReady) {
      const timeout = completedAt ? Math.max(1, completedAt + FIELD_WAIT_MS - Date.now()) : CDP_EVALUATE_TIMEOUT;
      let fields;
      try {
        let descToFill = '';
        if (title && description) {
          descToFill = (title.trim() === description.trim()) ? description.trim() : `${title.trim()}\n\n${description.trim()}`;
        } else {
          descToFill = (description || title || '').trim();
        }
        fields = await page.fillContentEditable(descToFill, filenames.length, timeout, title || description);
        consecutiveCdpErrors = 0;
      } catch (err) {
        if (!isCdpError(err)) throw err;
        consecutiveCdpErrors++;
        log(job, 'CDP delay while filling Reel fields: ' + err.message);
        if (!page.isOpen() || consecutiveCdpErrors >= 3) {
          const reattached = await reattachComposer(port, job, page);
          if (reattached) { page.session?.close?.(); page = reattached; replacePage(page); consecutiveCdpErrors = 0; continue; }
          const cdpLost = new Error('CDP connection was lost while uploads were still running. Check the profile before retrying.');
          cdpLost.keepBrowser = true;
          throw cdpLost;
        }
        await page.waitForTimeout(800 * consecutiveCdpErrors);
        continue;
      }
      if (fields.reason) throw new Error(fields.reason);
      lastFields = fields;
      // A field kind that this account's composer does not provide is never
      // an error. Only detected fields are filled and verified.
      const needDescription = !!(description || title), needTitle = !!title;
      const descriptionComplete = !needDescription || !fields.hasDescription || (fields.filled >= filenames.length) || (fields.total > 0 && fields.filled === fields.total);
      const titleComplete = !needTitle || !fields.hasTitle || (fields.titles === filenames.length && fields.titleFilled === fields.titles);
      const noFields = !fields.hasDescription && !fields.hasTitle;
      const detected = `desc:${fields.hasDescription ? fields.total : 0} title:${fields.hasTitle ? fields.titles : 0}`;
      if (detected !== detectedLog) {
        detectedLog = detected;
        log(job, `composer metadata fields: ${fields.hasDescription ? fields.total + ' description' : 'no description'}, ${fields.hasTitle ? fields.titles + ' title' : 'no title'}`);
      }
      if (fields.samples && fields.samples.length && needDescription) {
        const sample = JSON.stringify(fields.samples[0]);
        if (sample !== mismatchLog) {
          mismatchLog = sample;
          log(job, `description value mismatch in ${fields.samples.length} field(s): ${sample}`);
        }
      } else if (mismatchLog) {
        mismatchLog = '';
      }
      fieldsReady = descriptionComplete && titleComplete && !noFields;
      if (fieldsReady) log(job, 'metadata filled and verified');
    }
    if (completedAt && fieldsReady) return { completedAt, page };
    await page.waitForTimeout(500);
  }
  if (completedAt && lastFields) {
    const f = lastFields;
    if (f.filled > 0) {
      log(job, `Filled ${f.filled} description field(s). Proceeding to publish.`);
    } else {
      log(job, 'Proceeding to publish uploaded videos.');
    }
    return { completedAt, page };
  }
  if (completedAt) {
    return { completedAt, page };
  }
  throw new Error('Upload did not reach 100% for every Reel. Check the composer.');
}

function confirmsBatch(message, count) {
  if (count === 1) return true;
  if (!/\b(?:reels|videos|posts)\b/i.test(message)) return false;
  const fraction = message.match(/(\d+)\s*(?:of|\/)\s*(\d+)/i);
  if (fraction) return Number(fraction[1]) === Number(fraction[2]) && Number(fraction[1]) >= count;
  const number = message.match(/(\d+)\s+(?:reels|videos|posts)\b/i);
  return !number || Number(number[1]) >= count;
}

// Navigate to the composer and only give up after the full navigation budget.
// A slow-loading composer is not treated as a failed navigation: the event
// timeout is per attempt, transient aborts are retried, and a page that is
// already usable despite a missed load event is accepted immediately.
async function navigateToComposer(page, job, timeoutMs, url = COMPOSER_URL) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('navigation timeout: ' + url);
    attempt++;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(45000, remaining) });
      return;
    } catch (err) {
      const msg = String(err.message || err);
      const transient = /navigation timeout/.test(msg) || /navigation failed:\s*net::ERR_(ABORTED|TIMED_OUT|CONNECTION_RESET)/i.test(msg);
      if (!transient) throw err;
      log(job, /navigation timeout/.test(msg) ? 'composer navigation is slow; the page may still be loading' : 'composer navigation was interrupted; retrying');
    }
    // The load event may have been missed even though the page is usable.
    try {
      const view = await page.composerSession(10000);
      const url = new URL(view.href);
      if (/(^|\.)facebook\.com$/.test(url.hostname) && view.file && url.pathname.includes('/bulk_upload_composer')) {
        log(job, 'composer is already ready despite the missed load event');
        return;
      }
    } catch {}
    await page.waitForTimeout(Math.min(Math.min(2000 * attempt, 10000), Math.max(1, remaining)));
  }
}

// Poll the composer DOM until the bulk uploader's file input appears (or a
// login problem shows up). Returns 'ready', 'logged_out', 'checkpoint' or
// 'pending' when the budget runs out without a verdict.
async function waitForComposerReady(page, job, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let cdpErrors = 0;
  let reloadAttempts = 0;
  while (Date.now() < deadline) {
    let view;
    try {
      view = await page.composerSession(15000);
      cdpErrors = 0;
    } catch (err) {
      if (!isCdpError(err)) throw err;
      if (++cdpErrors >= 4) throw new Error('The composer tab stopped responding while loading. Close the profile and retry.');
      await page.waitForTimeout(1000);
      continue;
    }
    const url = new URL(view.href);
    if (!/^https?:$/.test(url.protocol)) return 'offsite';
    if (/(^|\.)facebook\.com$/.test(url.hostname)) {
      if (view.challenge) return 'checkpoint';
      if (view.loggedOut) return 'logged_out';
      if (view.file && url.pathname.includes('/bulk_upload_composer')) return 'ready';
      if (view.requestError) {
        if (reloadAttempts < 3) {
          reloadAttempts++;
          log(job, `Facebook request error detected ("trouble completing request"); auto-reloading page (${reloadAttempts}/3)...`);
          await page.waitForTimeout(1500);
          await page.reload().catch(() => {});
          await page.waitForTimeout(3000);
          continue;
        }
        return 'request_error';
      }
    }
    await page.waitForTimeout(1000);
  }
  return 'pending';
}

function pageCounts(task) {
  const pages = task.pages || [];
  return {
    total: pages.length,
    published: pages.filter((p) => p.state === 'published' || p.state === 'accepted').length,
    skipped: pages.filter((p) => p.state === 'skipped').length,
    failed: pages.filter((p) => p.state === 'failed').length,
    unconfirmed: pages.filter((p) => ['submitted', 'ready'].includes(p.state)).length
  };
}

function parseSpintax(text) {
  if (!text || typeof text !== 'string') return '';
  const regex = /\{([^{}]+)\}/g;
  let result = text;
  while (regex.test(result)) {
    result = result.replace(regex, (_, choices) => {
      const parts = choices.split('|');
      return parts[Math.floor(Math.random() * parts.length)].trim();
    });
  }
  return result;
}

async function postFirstComment(page, pageEntry, commentText) {
  if (!commentText || !commentText.trim()) return false;
  try {
    const pageUrl = `https://www.facebook.com/${encodeURIComponent(pageEntry.pageId)}`;
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(3500);

    const posted = await page.evaluate(`(async () => {
      const text = ${JSON.stringify(commentText)};
      let box = document.querySelector('div[aria-label*="Write a comment" i], div[aria-label*="Leave a comment" i], div[contenteditable="true"][role="textbox"]');
      if (!box) {
        const commentBtns = [...document.querySelectorAll('div[role="button"], span')].filter(el => /^Comment$/i.test((el.innerText || '').trim()));
        if (commentBtns.length) {
          commentBtns[0].click();
          await new Promise(r => setTimeout(r, 1200));
          box = document.querySelector('div[aria-label*="Write a comment" i], div[contenteditable="true"][role="textbox"]');
        }
      }
      if (box) {
        box.focus();
        document.execCommand('insertText', false, text);
        box.dispatchEvent(new InputEvent('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 500));
        const enterEvt = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
        box.dispatchEvent(enterEvt);
        return true;
      }
      return false;
    })()`);
    return Boolean(posted);
  } catch {
    return false;
  }
}

async function runPageUpload(page, port, job, pageEntry, videoPaths, title, description, budgetMs, replacePage, firstComment) {
  const pageStartedAt = Date.now();
  try {
    job.state = 'uploading';
    log(job, `uploading ${videoPaths.length} video(s) to ${pageEntry.name}`);
    if (!await page.setFileInputFiles('input[type=file]', videoPaths)) throw new Error('Composer file input disappeared before upload.');
    const evalTitle = parseSpintax(title);
    const evalDesc = parseSpintax(description);
    const result = await prepareRows(page, port, job, videoPaths, evalTitle, evalDesc, Math.max(60000, budgetMs - (Date.now() - pageStartedAt)), (replacement) => { page = replacement; });
    page = result.page;
    replacePage(page);
    job.state = 'waiting_publish';
    log(job, `uploads complete on ${pageEntry.name}; waiting for enabled Publish`);
    const before = await page.publishFeedback().catch(() => null);
    let clicked;
    try { clicked = await page.clickText(['Publish'], { timeout: 60000, exact: true, composerOnly: true }); }
    catch (error) {
      return { page, state: 'ready', error: /CDP timeout/.test(error.message)
        ? 'Publish could not be confirmed because the browser did not respond over CDP. Check the open composer before retrying.'
        : 'Publish action could not be verified. Check the open composer before retrying.', hold: true };
    }
    if (!clicked) return { page, state: 'failed', error: 'Uploaded, but an enabled Publish button did not become available.', hold: false };
    job.state = 'publishing';
    log(job, `Publish clicked on ${pageEntry.name}; checking Facebook confirmation`);
    const closeAt = Date.now() + 7500;
    let confirmed = false, accepted = false, failure, feedback;
    do {
      feedback = await page.publishFeedback(1000).catch(() => null);
      accepted ||= !!before && !before.accepted && !!feedback?.accepted;
      failure ||= feedback?.error.find(msg => !before?.error.includes(msg));
      confirmed ||= !!before && !!feedback?.success.some(msg => !before.success.includes(msg) && confirmsBatch(msg, videoPaths.length));
      await page.waitForTimeout(Math.max(0, Math.min(250, closeAt - Date.now())));
    } while (Date.now() < closeAt);
    const final = await page.publishFeedback(1000).catch(() => null);
    accepted ||= !!before && !before.accepted && !!final?.accepted;
    failure ||= final?.error.find(msg => !before?.error.includes(msg));
    confirmed ||= !!before && !!final?.success.some(msg => !before.success.includes(msg) && confirmsBatch(msg, videoPaths.length));
    try {
      const shot = await page.screenshot(250);
      const dir = path.join(storageRoot, 'screenshots');
      fs.mkdirSync(dir, { recursive: true });
      const safeName = String(pageEntry.name).replace(/[^\w.-]+/g, '_').slice(0, 40);
      fs.writeFileSync(path.join(dir, job.name + '-' + safeName + '-' + Date.now() + '.png'), shot);
    } catch {}
    if (failure || (!accepted && (final?.busy || (!confirmed && !final)))) {
      return { page, state: 'ready', error: failure ? 'Facebook reported a publishing error: ' + failure.slice(0, 180) : 'Submission still pending. Inspect and close the browser to release this slot.', hold: true };
    }
    const state = confirmed ? 'published' : accepted ? 'accepted' : 'submitted';
    log(job, confirmed ? `Facebook confirmed publishing on ${pageEntry.name}` : accepted ? `Facebook accepted the bulk upload for ${pageEntry.name}.` : `Publish clicked on ${pageEntry.name}; outcome unconfirmed. Check Facebook before retrying.`);

    if ((confirmed || accepted) && firstComment && firstComment.trim()) {
      const commentText = parseSpintax(firstComment.trim());
      log(job, `adding first comment to ${pageEntry.name}: "${commentText.slice(0, 45)}..."`);
      try {
        const ok = await postFirstComment(page, pageEntry, commentText);
        if (ok) log(job, `first comment posted on ${pageEntry.name}`);
        else log(job, `first comment skipped (comment box not accessible)`);
      } catch (cErr) {
        log(job, `first comment notice: ${cErr.message}`);
      }
    }

    return { page, state, error: null, hold: false };
  } catch (err) {
    if (err.keepBrowser) throw err;
    return { page, state: 'failed', error: err.message, hold: false };
  }
}

async function taskBody(job, { videoPaths, title, description, firstComment, timeoutPerProfile = UPLOAD_TIMEOUT_DEFAULT }, owner) {
  job.startedAt = Date.now();
  let connection, page, port;
  try {
    job.state = 'launching';
    log(job, 'launching browser');
    // Reuse discipline: a browser left open from an earlier run would be a
    // second session on the same profile. Close it before starting fresh so
    // the profile never runs two upload windows at once.
    const leftover = getSession(job.name);
    if (leftover && leftover.state === 'running') {
      log(job, 'a browser from a previous run is still open; closing it before starting');
      await stopProfile(job.name);
    }
    await startProfile(job.name, { startMaximized: true });
    const session = getSession(job.name);
    if (!session) throw new Error('session not found after start');
    owner.session = session;
    port = session.cdpPort;

    connection = await connectOverCDP(port);
    connection.page?.session?.close();
    await connection.context.addInitScript(VISIBILITY_PATCH);
    page = await connection.context.newPage();
    if (typeof page.setWindowState === 'function') {
      try {
        await page.setWindowState('maximized');
      } catch (error) {
        log(job, 'Could not maximize the upload window: ' + error.message);
      }
    }

    if (owner?.job?.humanize !== false) {
      log(job, 'humanizing session: simulating natural browsing before business composer...');
      await simulateHumanActivity(page, 15000, (msg) => log(job, `[humanizer] ${msg}`)).catch(() => {});
    }

    job.state = 'scanning';
    log(job, 'scanning Account Status for managed Pages');
    const scan = await scanAccountStatus(page, job, ACCOUNT_SCAN_TIMEOUT);
    job.accountStatus = { scannedAt: Date.now(), ...scan };
    rememberAccountStatus(job, job.accountStatus);
    if (scan.scanFailed) {
      log(job, 'profile marked as risk: ' + (scan.error || 'Account Status scan failed'));
      throw new Error(scan.error || 'Account Status scan failed.');
    }

    const eligible = scan.pages.filter((p) => p.status === 'ok');
    job.pages = scan.pages.map((p) => ({
      name: p.name,
      profileId: p.profileId,
      pageId: p.pageId,
      status: p.status,
      state: p.status === 'ok' ? 'queued' : 'skipped',
      error: null
    }));
    log(job, `Account Status: ${scan.pages.length} managed Page(s) · ${eligible.length} healthy · ${scan.warningCount} warning · ${scan.unknownCount} unverified`);

    if (!eligible.length) {
      log(job, scan.pages.length ? 'all managed Pages have warnings or could not be verified; no uploads will run' : 'no managed Pages found; no uploads will run');
      job.state = 'skipped';
      job.doneAt = Date.now();
      return job;
    }

    let auth = null;
    for (let index = 0; index < eligible.length; index++) {
      const pageEntry = eligible[index];
      const pageRow = job.pages.find((p) => p.profileId === pageEntry.profileId);
      const composerUrl = `https://business.facebook.com/latest/bulk_upload_composer?asset_id=${encodeURIComponent(pageEntry.pageId)}&ir_qe_exposed=1`;
      log(job, `Page ${index + 1}/${eligible.length} · ${pageEntry.name} (${pageEntry.pageId})`);
      try {
        job.state = 'navigating';
        const homeUrl = `https://business.facebook.com/latest/home?asset_id=${encodeURIComponent(pageEntry.pageId)}`;
        await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(2000);
        await navigateToComposer(page, job, NAV_TIMEOUT, composerUrl);
        let readyState = await waitForComposerReady(page, job, COMPOSER_READY_TIMEOUT);
        if (readyState === 'request_error') {
          log(job, `Facebook request error detected; reloading composer for ${pageEntry.name}...`);
          await page.waitForTimeout(1500);
          await page.reload().catch(() => {});
          await page.waitForTimeout(3000);
          readyState = await waitForComposerReady(page, job, COMPOSER_READY_TIMEOUT);
        }
        if (readyState === 'offsite') throw new Error('The composer page did not load. Check the profile network connection and retry.');
        if (auth === null) {
          for (let retries = 0; ; retries++) {
            auth = await inspectSession(page, job, LOGIN_CHECK_TIMEOUT);
            if (!auth.requestError) break;
            if (retries === 2) throw new Error('Facebook still reports trouble completing your request after reloads. Retry this profile later.');
            log(job, `Facebook request error; reloading composer (${retries + 1}/2)...`);
            await page.waitForTimeout(1500);
            await page.reload().catch(() => {});
            await page.waitForTimeout(3000);
          }
          if (!auth.notFacebook) {
            try { rememberSession(job, auth.state); }
            catch (error) { log(job, 'Could not save last login check: ' + error.message); }
          }
          if (auth.state !== 'logged_in') {
            throw new Error(auth.notFacebook ? 'The composer page did not load. Check the profile network connection and retry.' : SESSION_MESSAGES[auth.state]);
          }
        } else if (['logged_out', 'checkpoint'].includes(readyState)) {
          if (profile.password) {
            log(job, `Profile ${profile.name} session is ${readyState}. Attempting smart fallback auto-login...`);
            try {
              const { ensureFacebookLogin } = require('./auto-login');
              const loginRes = await ensureFacebookLogin(page, profile, { onLog: (msg) => log(job, msg) });
              if (loginRes.ok) {
                log(job, `Auto-login successful! Reloading composer...`);
                await page.goto(composerUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
                await page.waitForTimeout(4000);
                readyState = await waitForComposerReady(page, job, 20000);
              }
            } catch (e) {
              log(job, `Auto-login attempt failed: ${e.message}`);
            }
          }
          if (['logged_out', 'checkpoint'].includes(readyState)) {
            throw new Error(SESSION_MESSAGES[readyState]);
          }
        }
        if (readyState !== 'ready') throw new Error('Logged in, but the composer file input is unavailable for this Page. Check access to the bulk composer.');
        const finalHref = await page.evaluate('location.href').catch(() => '');
        log(job, `composer opened for ${pageEntry.name}: ${finalHref}`);
        const result = await runPageUpload(page, port, job, pageEntry, videoPaths, title, description, timeoutPerProfile, (replacement) => { page = replacement; }, firstComment);
        page = result.page;
        if (pageRow) { pageRow.state = result.state; pageRow.error = result.error; }
        if (result.hold) {
          job.state = 'ready';
          job.holdForReview = true;
          job.error = result.error;
          job.doneAt = Date.now();
          return job;
        }
      } catch (err) {
        if (err.keepBrowser) {
          if (pageRow) { pageRow.state = 'ready'; pageRow.error = err.message; }
          job.state = 'ready';
          job.holdForReview = true;
          job.error = err.message;
          log(job, 'ERROR: ' + err.message);
          job.doneAt = Date.now();
          return job;
        }
        if (pageRow) { pageRow.state = 'failed'; pageRow.error = err.message; }
        log(job, `Page ${pageEntry.name} failed: ${err.message}`);
      }
    }

    const states = job.pages.filter((p) => p.status === 'ok').map((p) => p.state);
    const published = states.filter((s) => s === 'published').length;
    const failed = states.filter((s) => s === 'failed').length;
    const counts = pageCounts(job);
    log(job, `profile finished: ${counts.published} published · ${counts.skipped} skipped · ${counts.failed} failed · ${counts.unconfirmed} unconfirmed`);
    if (states.length && failed === states.length) {
      job.state = 'failed';
      job.error = 'Uploads failed on every eligible Page. Check the per-Page log.';
    } else if (failed > 0) {
      job.state = 'failed';
      job.error = `Uploads failed on ${failed} of ${states.length} eligible Page(s). Check the per-Page log.`;
    } else if (published === states.length) {
      job.state = 'done';
    } else if (states.every((s) => s === 'published' || s === 'accepted')) {
      job.state = 'accepted';
    } else {
      job.state = 'submitted';
    }
    job.doneAt = Date.now();
  } catch (err) {
    // A CDP outage mid-upload means the browser is still doing the work.
    // Keep it open instead of killing an upload that may still complete.
    job.state = err.keepBrowser ? 'ready' : 'failed';
    job.error = err.message;
    log(job, 'ERROR: ' + err.message);
    job.doneAt = Date.now();
  } finally {
    page?.session?.close?.();
    connection?.browser?.session?.close?.();
    rememberLastUpload(job);
  }
  return job;
}

async function runTask(job, opts) {
  const owner = {session:null};
  await taskBody(job, opts, owner);
  if (!owner.session || getSession(job.name) !== owner.session) return job;
  if (job.holdForReview) {
    const held = getSession(job.name);
    while (held && getSession(job.name) === held) await new Promise(resolve => setTimeout(resolve, 500));
    return job;
  }
  try {
    await stopProfile(job.name);
  } catch (error) { job.state = 'failed'; job.error = 'Browser cleanup failed: ' + error.message; while (getSession(job.name) === owner.session) await new Promise(resolve => setTimeout(resolve, 500)); }
  return job;
}

function resolveNames(profileNames) {
  const all = listProfiles();
  if (!profileNames || profileNames === 'all' || (Array.isArray(profileNames) && profileNames.includes('__all__'))) {
    return all;
  }
  const set = new Set(profileNames);
  return all.filter((n) => set.has(n));
}

function startUpload({ videoPaths, videoPath, title, description, firstComment, profiles, parallel, timeoutPerProfile, antiCopyright, humanize }) {
  const paths = videoPaths && videoPaths.length ? videoPaths : (videoPath ? [videoPath] : []);
  if (!paths.length) throw new Error('no video file provided');
  for (const p of paths) {
    if (!fs.existsSync(p)) throw new Error('video file not found: ' + p);
  }
  const names = resolveNames(profiles);
  if (!names.length) throw new Error('no profiles selected');

  const jobId = require('node:crypto').randomUUID();
  const limit = Math.min(Math.max(Math.floor(Number(parallel)) || 1, 1), names.length);
  const perProfile = Math.min(Math.max(Number(timeoutPerProfile) || UPLOAD_TIMEOUT_DEFAULT, 300000), 3600000);
  const job = {
    id: jobId,
    videoPaths: paths,
    title: title || '',
    description: description || '',
    firstComment: firstComment || '',
    antiCopyright: antiCopyright !== false,
    humanize: humanize !== false,
    parallel: limit,
    timeoutPerProfile: perProfile,
    state: 'running',
    createdAt: Date.now(),
    tasks: names.map((n) => newTask(n))
  };
  jobs.set(jobId, job);

  let cursor = 0;
  const worker = async () => {
    while (job.state === 'running' && cursor < job.tasks.length) {
      if (activeProfiles.size >= limit) {
        await new Promise(resolve => slotWaiters.add(resolve));
        continue;
      }
      const task = job.tasks[cursor++];
      if (activeProfiles.has(task.name)) {
        task.state = 'failed'; task.error = 'This profile is already running another upload.'; task.settled = true;
        continue;
      }
      activeProfiles.add(task.name);
      let taskVideos = paths;
      try {
        if (job.antiCopyright) {
          task.state = 'launching';
          log(task, `[anti-copyright] generating unique MD5 & metadata hash for ${paths.length} video(s)...`);
          taskVideos = [];
          for (let i = 0; i < paths.length; i++) {
            const p = paths[i];
            const uniq = await uniquifyVideo(p, { profileName: task.name });
            taskVideos.push(uniq);
          }
          log(task, `[anti-copyright] unique hashes applied in <1s, launching browser...`);
        }
        await runTask(task, {
          videoPaths: taskVideos,
          title: job.title,
          description: job.description,
          firstComment: job.firstComment,
          timeoutPerProfile: perProfile
        });
      }
      catch (error) { task.state = 'failed'; task.error = error.message; }
      finally {
        if (job.antiCopyright && taskVideos !== paths) {
          cleanupFiles(taskVideos);
        }
        activeProfiles.delete(task.name);
        task.settled = true;
        notifySlotWaiters();
      }
    }
  };
  Promise.all(Array.from({length:limit},worker)).then(() => {
    if (job.state === 'running') {
      const published = job.tasks.filter(t => ['done', 'accepted'].includes(t.state)).length;
      const skipped = job.tasks.filter(t => t.state === 'skipped').length;
      const failed = job.tasks.filter(t => t.state === 'failed' || t.state === 'ready').length;
      if (published === job.tasks.length && job.tasks.length > 0) {
        job.state = 'done';
      } else if (skipped === job.tasks.length) {
        job.state = 'all_skipped';
      } else if (failed > 0 || skipped > 0) {
        job.state = 'needs_review';
      } else {
        job.state = 'done';
      }
    }
    saveRecentJobs();
  });

  return { jobId, profileCount: names.length, parallel: limit, videoCount: paths.length };
}

function cancelUpload(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (job.state === 'running') job.state = 'cancelled';
  notifySlotWaiters();
  for (const t of job.tasks) {
    if (t.state === 'queued') { t.state = 'cancelled'; t.doneAt = Date.now(); }
  }
  return true;
}

function jobStatus(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  return {
    id: job.id,
    state: job.state,
    videoPaths: job.videoPaths,
    title: job.title,
    description: job.description,
    firstComment: job.firstComment,
    antiCopyright: job.antiCopyright,
    humanize: job.humanize,
    parallel: job.parallel,
    timeoutPerProfile: job.timeoutPerProfile,
    createdAt: job.createdAt,
    tasks: job.tasks.map((t) => ({
      name: t.name,
      state: t.state,
      settled: !!t.settled || t.state === 'cancelled',
      error: t.error,
      progress: t.progress,
      accountStatus: t.accountStatus ? {
        scannedAt: t.accountStatus.scannedAt,
        scanFailed: !!t.accountStatus.scanFailed,
        risk: !!t.accountStatus.scanFailed,
        totalCount: (t.accountStatus.pages || []).length,
        warningCount: t.accountStatus.warningCount,
        healthyCount: t.accountStatus.healthyCount,
        unknownCount: t.accountStatus.unknownCount
      } : null,
      pages: (t.pages || []).map((p) => ({ name: p.name, profileId: p.profileId, pageId: p.pageId, status: p.status, state: p.state, error: p.error })),
      pageCounts: pageCounts(t),
      log: t.log.slice(-10)
    }))
  };
}

function allJobs() {
  return [...jobs.keys()].map((id) => ({ id, state: jobs.get(id).state, count: jobs.get(id).tasks?.length || 0 }));
}

const HISTORY_FILE = path.join(storageRoot, 'data', 'upload-history.json');
function saveRecentJobs() {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    const list = [...jobs.values()].slice(-30).map(job => jobStatus(job.id)).filter(Boolean);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2));
  } catch (e) {}
}

function loadRecentJobs() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    const list = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item && item.id && !jobs.has(item.id)) {
          jobs.set(item.id, item);
        }
      }
    }
  } catch (e) {}
}
loadRecentJobs();

module.exports = { startUpload, cancelUpload, jobStatus, allJobs, resolveNames, COMPOSER_URL };
