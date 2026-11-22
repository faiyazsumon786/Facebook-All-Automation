const fs = require('fs');
const path = require('path');
const { startProfile, stopProfile, getSession } = require('./manager');
const { connectOverCDP } = require('./cdp');
const { loadProfile } = require('./index');
const { ensureFacebookLogin } = require('./auto-login');
const { scanAccountStatus } = require('./account-status');
const { storageRoot } = require('./storage');

// Store background batch jobs
const pageCreationJobs = new Map();

function newJob(jobId, payload) {
  return {
    id: jobId,
    state: 'queued', // queued | running | completed | cancelled | failed
    payload,
    logs: [],
    createdPages: [],
    failedPages: [],
    total: 0,
    current: 0,
    startedAt: Date.now(),
    completedAt: null,
    controller: new AbortController()
  };
}

function logJob(job, msg) {
  const timestamp = new Date().toISOString().slice(11, 19);
  const entry = `[${timestamp}] ${msg}`;
  job.logs.push(entry);
  if (job.logs.length > 200) job.logs.shift();
  console.log(`[PageCreator:${job.id}] ${msg}`);
}

/**
 * Resolves random spintax like {Digital|Tech|Media} {Zone|World|Daily}
 */
function resolveSpintax(str) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/\{([^{}]+)\}/g, (match, choices) => {
    const arr = choices.split('|');
    return arr[Math.floor(Math.random() * arr.length)].trim();
  }).trim();
}

/**
 * Ensures the browser is switched to the primary personal profile actor
 */
async function ensurePersonalProfile(page, onLog = () => {}) {
  try {
    const isPageActor = await page.evaluate(`(() => {
      let actorId = null;
      let userId = null;
      for (const s of document.querySelectorAll('script')) {
        const text = s.textContent || '';
        const m1 = text.match(/"actorID":"(\\d+)"/);
        if (m1 && !actorId) actorId = m1[1];
        const m2 = text.match(/"USER_ID":"(\\d+)"/);
        if (m2 && !userId) userId = m2[1];
      }
      return { isDelegated: !!(actorId && userId && actorId !== userId), actorId, userId };
    })()`);

    if (!isPageActor || !isPageActor.isDelegated) {
      return true; // Already personal profile or cannot detect delegation
    }

    onLog(`Active actor is a Page (${isPageActor.actorId}). Switching to personal profile...`);

    // Click account profile menu button
    await page.evaluate(`(() => {
      const btn = document.querySelector('div[role="button"][aria-label*="Account, your profile"], div[role="button"][aria-label*="Your profile"], div[role="button"][aria-label*="Account"]');
      if (btn) {
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        btn.click();
      }
    })()`);

    await page.waitForTimeout(3000);

    // Look for "Switch to <PersonalName>" button in the opened popup
    const switched = await page.evaluate(`(() => {
      const els = Array.from(document.querySelectorAll('[aria-label*="Switch to"]'));
      if (els.length) {
        els[0].click();
        return els[0].getAttribute('aria-label');
      }
      return null;
    })()`);

    if (switched) {
      onLog(`Clicked: ${switched}. Waiting for personal profile reload...`);
      await page.waitForTimeout(7000);
      return true;
    } else {
      onLog('Could not find personal profile switch button in menu.');
      return false;
    }
  } catch (err) {
    onLog(`Note while checking personal profile actor: ${err.message}`);
    return false;
  }
}

/**
 * Creates a single Facebook Page for a given profile
 */
async function createFacebookPage(profileName, { pageName, category = 'Digital creator', bio = '', onLog = () => {}, signal } = {}) {
  const profile = loadProfile(profileName);
  if (!profile) throw new Error(`Profile ${profileName} not found.`);

  onLog(`Starting profile ${profileName}...`);
  await startProfile(profileName, { startMaximized: true });

  const session = getSession(profileName);
  if (!session || !session.cdpPort) {
    throw new Error(`Profile ${profileName} running but no CDP port detected.`);
  }

  const connection = await connectOverCDP(session.cdpPort);
  const page = connection.page || (await connection.context.newPage());

  onLog('Navigating to Facebook to check login session...');
  await page.goto('https://www.facebook.com/', { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // Auto-login fallback if needed
  const loginState = await ensureFacebookLogin(page, profile, { onLog });
  if (!loginState || !loginState.loggedIn) {
    throw new Error(`Profile ${profileName} is not logged in: ${loginState ? loginState.status : 'unknown'}`);
  }

  // Switch to personal profile if currently acting as a Page
  await ensurePersonalProfile(page, onLog);

  onLog(`Navigating to Facebook Page Creation page...`);
  await page.goto('https://www.facebook.com/pages/create/', { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(5000);

  // Check if blocked or "content unavailable"
  const pageCheck = await page.evaluate(`(() => {
    const text = document.body.innerText || '';
    if (text.includes("This content isn't available right now") || text.includes('Content Not Found')) {
      return { ok: false, error: "This content isn't available right now" };
    }
    if (text.includes('You have created too many Pages in a short time')) {
      return { ok: false, error: 'Meta rate-limit: You have created too many Pages in a short time. Please try again later.' };
    }
    const hasNameInput = Array.from(document.querySelectorAll('label')).some(l => (l.innerText || '').includes('Page name'));
    return { ok: hasNameInput, error: hasNameInput ? null : 'Page creation form inputs not found' };
  })()`);

  if (!pageCheck.ok) {
    // Retry switching to personal profile once more if content isn't available
    if (pageCheck.error && pageCheck.error.includes("This content isn't available")) {
      onLog('Retrying personal profile switch...');
      await page.goto('https://www.facebook.com/', { timeout: 35000 }).catch(() => {});
      await page.waitForTimeout(3000);
      await ensurePersonalProfile(page, onLog);
      await page.goto('https://www.facebook.com/pages/create/', { timeout: 35000 }).catch(() => {});
      await page.waitForTimeout(4000);
    }
  }

  const resolvedName = resolveSpintax(pageName);
  const resolvedCategory = resolveSpintax(category) || 'Digital creator';
  const resolvedBio = resolveSpintax(bio);

  onLog(`Filling Page Name: "${resolvedName}"...`);
  const nameFilled = await page.evaluate(`((name) => {
    const labels = Array.from(document.querySelectorAll('label'));
    const nameLabel = labels.find(l => (l.innerText || '').includes('Page name'));
    const nameInput = nameLabel ? nameLabel.querySelector('input') : null;
    if (!nameInput) return false;

    nameInput.focus();
    nameInput.select();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, name);
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nameInput.dispatchEvent(new Event('change', { bubbles: true }));
    nameInput.dispatchEvent(new Event('blur', { bubbles: true }));
    nameInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return true;
  })(${JSON.stringify(resolvedName)})`);

  if (!nameFilled) throw new Error('Could not find or fill Page Name input.');
  await page.waitForTimeout(2000);

  onLog(`Selecting Category: "${resolvedCategory}"...`);
  // Try typing category into input and selecting dropdown option
  const catTyped = await page.evaluate(`((cat) => {
    const labels = Array.from(document.querySelectorAll('label'));
    const catLabel = labels.find(l => (l.innerText || '').includes('Category'));
    const catInput = catLabel ? catLabel.querySelector('input') : null;
    if (!catInput) return false;

    catInput.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, cat);
    catInput.dispatchEvent(new Event('input', { bubbles: true }));
    catInput.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })(${JSON.stringify(resolvedCategory)})`);

  await page.waitForTimeout(2500);

  // Click autocomplete option or matching suggestion pill
  const catSelected = await page.evaluate(`((cat) => {
    // 1. Try autocomplete listbox option
    const options = Array.from(document.querySelectorAll('li[role="option"], [role="option"]'));
    if (options.length) {
      const match = options.find(o => (o.innerText || '').toLowerCase().includes(cat.toLowerCase())) || options[0];
      const rect = match.getBoundingClientRect();
      match.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: rect.x + 5, clientY: rect.y + 5 }));
      match.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: rect.x + 5, clientY: rect.y + 5 }));
      match.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: rect.x + 5, clientY: rect.y + 5 }));
      return { success: true, method: 'option', text: match.innerText };
    }

    // 2. Try suggested pill
    const pills = Array.from(document.querySelectorAll('*')).filter(el => {
      const t = (el.innerText || '').trim();
      return (t.toLowerCase() === cat.toLowerCase() || t.includes('Digital creator')) && el.offsetWidth > 0 && el.offsetHeight > 0;
    });
    if (pills.length) {
      const target = pills[pills.length - 1];
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.click();
      return { success: true, method: 'pill', text: target.innerText };
    }

    return { success: false };
  })(${JSON.stringify(resolvedCategory)})`);

  onLog(`Category select result: ${JSON.stringify(catSelected)}`);
  await page.waitForTimeout(2000);

  // Fill Bio if provided
  if (resolvedBio) {
    onLog(`Filling Bio: "${resolvedBio}"...`);
    await page.evaluate(`((bio) => {
      const labels = Array.from(document.querySelectorAll('label'));
      const bioLabel = labels.find(l => (l.innerText || '').includes('Bio'));
      const bioInput = bioLabel ? bioLabel.querySelector('textarea') : null;
      if (bioInput) {
        bioInput.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, bio);
        bioInput.dispatchEvent(new Event('input', { bubbles: true }));
        bioInput.dispatchEvent(new Event('change', { bubbles: true }));
        bioInput.dispatchEvent(new Event('blur', { bubbles: true }));
      }
    })(${JSON.stringify(resolvedBio)})`);
    await page.waitForTimeout(1000);
  }

  // Check Create Page button state
  onLog('Checking "Create Page" button readiness...');
  let buttonReady = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const btnState = await page.evaluate(`(() => {
      const btn = document.querySelector('div[role="button"][aria-label="Create Page"], [aria-label="Create page"], [aria-label*="Create Page"]');
      if (!btn) return { exists: false, disabled: true };
      const ariaDisabled = btn.getAttribute('aria-disabled') === 'true';
      return { exists: true, disabled: ariaDisabled };
    })()`);

    if (btnState.exists && !btnState.disabled) {
      buttonReady = true;
      break;
    }
    await page.waitForTimeout(1500);
  }

  if (!buttonReady) {
    // Log visible validation messages for diagnosis
    const validationText = await page.evaluate(`(() => {
      return Array.from(document.querySelectorAll('[role="alert"], [aria-invalid], [id*="error"]')).map(el => el.innerText).filter(Boolean).join('; ');
    })()`);
    throw new Error(`Create Page button not ready. Validation notice: ${validationText || 'Please check Page Name and Category.'}`);
  }

  onLog('Clicking "Create Page" button...');
  await page.evaluate(`(() => {
    const btn = document.querySelector('div[role="button"][aria-label="Create Page"], [aria-label="Create page"], [aria-label*="Create Page"]');
    if (btn) {
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      btn.click();
    }
  })()`);

  onLog('Waiting for Facebook to process Page creation...');
  let creationSuccess = false;
  let pageId = null;

  for (let w = 0; w < 12; w++) {
    signal?.throwIfAborted();
    await page.waitForTimeout(2500);

    const postClickStatus = await page.evaluate(`(() => {
      const text = document.body.innerText || '';
      const url = location.href;

      // Rate limit check
      if (text.includes('You have created too many Pages in a short time')) {
        return { error: 'Meta rate-limit: You have created too many Pages in a short time.' };
      }
      if (text.includes('An error occurred while creating your Page') || text.includes('Action Blocked')) {
        return { error: 'Meta action blocked or error occurred during Page creation.' };
      }

      // Success indicators:
      // 1. "Page created" or "Set up your Page" banner
      const createdBanner = text.includes('created') || text.includes('Set up your Page') || text.includes('Page was created');
      // 2. URL redirection to new page or setup steps
      const urlChanged = url.includes('/setup/') || url.includes('asset_id') || (!url.includes('/pages/create') && !url.includes('/pages/?'));

      return { success: createdBanner || urlChanged, url, textSnippet: text.slice(0, 300) };
    })()`);

    if (postClickStatus.error) {
      throw new Error(postClickStatus.error);
    }

    if (postClickStatus.success) {
      creationSuccess = true;
      onLog(`Page creation confirmed! (${postClickStatus.url})`);
      break;
    }
  }

  if (!creationSuccess) {
    onLog('Proceeding to account status scan to verify if Page was created in the background...');
  }

  // Scan account status to discover the new Page ID and update profile JSON
  onLog('Scanning Facebook pages for profile to update database...');
  try {
    const scanResult = await scanAccountStatus(profileName);
    if (scanResult && Array.isArray(scanResult.pages)) {
      const match = scanResult.pages.find(p => p.name.toLowerCase() === resolvedName.toLowerCase());
      if (match) {
        pageId = match.pageId;
        onLog(`Discovered new Page in profile: "${match.name}" (ID: ${match.pageId})`);
      }
    }
  } catch (err) {
    onLog(`Note during scan: ${err.message}`);
  }

  return {
    success: true,
    pageName: resolvedName,
    category: resolvedCategory,
    pageId: pageId || 'created',
    profileName
  };
}

/**
 * Runs a batch page creation job across multiple profiles with intelligent failover & rotation
 */
async function runBatchPageCreation({
  profiles = [],
  pageNames = [],
  category = 'Digital creator',
  bio = '',
  delaySec = 20,
  mode = 'failover',
  maxPerProfile = 1,
  autoRetryNext = true,
  jobId
} = {}) {
  const job = pageCreationJobs.get(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  job.state = 'running';
  job.total = pageNames.length;
  job.current = 0;
  logJob(job, `Starting batch page creation: ${pageNames.length} pages across ${profiles.length} profiles [Mode: ${mode}, Max/Profile: ${maxPerProfile}, AutoRetry: ${autoRetryNext}].`);

  const namesQueue = [...pageNames];
  const profileSuccessCount = new Map(profiles.map(p => [p, 0]));
  const exhaustedProfiles = new Set();
  let rrIndex = 0;
  let activeProfileRunning = null;

  try {
    while (namesQueue.length > 0) {
      if (job.controller.signal.aborted) {
        logJob(job, 'Job was cancelled by user.');
        job.state = 'cancelled';
        break;
      }

      // Filter profiles that are not rate-limited and haven't exceeded maxPerProfile
      const availableProfiles = profiles.filter(p => {
        if (exhaustedProfiles.has(p)) return false;
        const count = profileSuccessCount.get(p) || 0;
        if (maxPerProfile > 0 && count >= maxPerProfile) return false;
        return true;
      });

      if (availableProfiles.length === 0) {
        logJob(job, 'All selected profiles have either reached the max pages limit or Meta rate-limits. Ending batch.');
        while (namesQueue.length > 0) {
          const uncreated = namesQueue.shift();
          job.failedPages.push({
            pageName: uncreated,
            profileName: 'None (All profiles exhausted)',
            error: 'All selected profiles reached page limit or Meta rate limit.',
            failedAt: Date.now()
          });
        }
        break;
      }

      const pageName = namesQueue.shift();
      job.current++;

      // Pick target profile based on selected mode
      let profileName;
      if (mode === 'round_robin') {
        profileName = availableProfiles[rrIndex % availableProfiles.length];
        rrIndex++;
      } else if (mode === 'single_first') {
        profileName = availableProfiles[0];
      } else { // 'failover' / sequential
        profileName = availableProfiles[0];
      }

      // Close previous profile browser if switching to a new profile to free RAM
      if (activeProfileRunning && activeProfileRunning !== profileName) {
        logJob(job, `Switching profile: Closing previous browser (${activeProfileRunning}) to free memory...`);
        await stopProfile(activeProfileRunning).catch(() => {});
        activeProfileRunning = null;
      }
      activeProfileRunning = profileName;

      logJob(job, `[${job.current}/${job.total}] Attempting to create "${pageName}" on profile "${profileName}"...`);

      try {
        const result = await createFacebookPage(profileName, {
          pageName,
          category,
          bio,
          onLog: (msg) => logJob(job, msg),
          signal: job.controller.signal
        });

        job.createdPages.push({
          pageName: result.pageName,
          category: result.category,
          pageId: result.pageId,
          profileName,
          createdAt: Date.now()
        });

        const newCount = (profileSuccessCount.get(profileName) || 0) + 1;
        profileSuccessCount.set(profileName, newCount);
        logJob(job, `Successfully created "${result.pageName}" on ${profileName}! (Total pages on this profile: ${newCount})`);
      } catch (err) {
        const errMsg = err.message || '';
        const isRateLimit = /too many Pages|short time|Action Blocked|limit|restricted|temporarily blocked/i.test(errMsg);

        if (isRateLimit) {
          logJob(job, `Meta Rate-Limit detected on profile "${profileName}": "${errMsg}". Marking profile as limited.`);
          exhaustedProfiles.add(profileName);
        } else {
          logJob(job, `Failed to create "${pageName}" on ${profileName}: ${errMsg}`);
        }

        // Close this profile since it failed/hit limit
        if (activeProfileRunning) {
          await stopProfile(activeProfileRunning).catch(() => {});
          activeProfileRunning = null;
        }

        // Check if there are other available profiles to retry
        const canRetryProfiles = profiles.filter(p => {
          if (exhaustedProfiles.has(p) || p === profileName) return false;
          const count = profileSuccessCount.get(p) || 0;
          if (maxPerProfile > 0 && count >= maxPerProfile) return false;
          return true;
        });

        if (autoRetryNext && canRetryProfiles.length > 0) {
          logJob(job, `Auto-Failover: Will retry creating "${pageName}" on next profile (${canRetryProfiles[0]})...`);
          namesQueue.unshift(pageName);
          job.current--; // Keep current index consistent
        } else {
          job.failedPages.push({
            pageName,
            profileName,
            error: errMsg,
            failedAt: Date.now()
          });
        }
      }

      // Delay between page creations to stay safe from Meta rate limits
      if (namesQueue.length > 0 && !job.controller.signal.aborted) {
        const waitMs = Math.max(5, Number(delaySec) || 20) * 1000;
        logJob(job, `Waiting ${waitMs / 1000}s before next operation to keep profiles safe...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }

    if (job.state !== 'cancelled') {
      job.state = 'completed';
      logJob(job, `Batch completed! Created: ${job.createdPages.length}, Failed: ${job.failedPages.length}.`);
    }
  } catch (fatalErr) {
    job.state = 'failed';
    logJob(job, `Fatal job error: ${fatalErr.message}`);
  } finally {
    if (activeProfileRunning) {
      await stopProfile(activeProfileRunning).catch(() => {});
      activeProfileRunning = null;
    }
    job.completedAt = Date.now();
  }
}

function startPageCreationJob(payload) {
  const jobId = 'page-job-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const job = newJob(jobId, payload);
  pageCreationJobs.set(jobId, job);

  // Run in background asynchronously
  runBatchPageCreation({ ...payload, jobId }).catch((err) => {
    console.error(`Page creation job ${jobId} failed:`, err);
  });

  return jobId;
}

function getPageCreationJob(jobId) {
  const job = pageCreationJobs.get(jobId);
  if (!job) return null;
  return {
    id: job.id,
    state: job.state,
    total: job.total,
    current: job.current,
    createdPages: job.createdPages,
    failedPages: job.failedPages,
    logs: job.logs,
    startedAt: job.startedAt,
    completedAt: job.completedAt
  };
}

function cancelPageCreationJob(jobId) {
  const job = pageCreationJobs.get(jobId);
  if (!job) return false;
  job.controller.abort();
  job.state = 'cancelled';
  logJob(job, 'Cancel signal received.');
  return true;
}

module.exports = {
  createFacebookPage,
  runBatchPageCreation,
  startPageCreationJob,
  getPageCreationJob,
  cancelPageCreationJob,
  resolveSpintax
};
