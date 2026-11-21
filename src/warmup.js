const { startProfile, stopProfile, getSession } = require('./manager');
const { connectOverCDP } = require('./cdp');

// Active warmup jobs tracker for UI feedback
const activeWarmups = new Map();

/**
 * Simulates human-like browsing on Facebook:
 * - Smooth random scrolling
 * - Pauses simulating reading posts or watching video
 * - Small micro-scrolls up and down (human jitter)
 * - Navigation between newsfeed and reels
 */
async function simulateHumanActivity(page, durationMs = 25000, log = () => {}) {
  const started = Date.now();
  const targetEnd = started + durationMs;

  log(`Navigating to Facebook feed for human simulation...`);
  try {
    await page.goto('https://www.facebook.com/', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
  } catch (e) {
    log(`Feed navigation notice: ${e.message}`);
  }

  // Check if checkpoint or login screen
  const isLoginPage = await page.evaluate(`(() => {
    return !!document.querySelector('#email, input[name="email"], #loginbutton');
  })()`).catch(() => false);

  if (isLoginPage) {
    log(`Notice: Profile is at login page. Continuing warm-up session...`);
  }

  let step = 0;
  while (Date.now() < targetEnd) {
    step++;
    const remainingSec = Math.max(0, Math.round((targetEnd - Date.now()) / 1000));
    
    // Choose human action
    const actionRoll = Math.random();
    
    if (actionRoll < 0.65) {
      // Natural smooth scroll down
      const distance = Math.floor(Math.random() * 320) + 180;
      log(`Human scroll (step ${step}) - browsing feed (${remainingSec}s remaining)...`);
      await page.evaluate(`(() => {
        window.scrollBy({ top: ${distance}, behavior: 'smooth' });
      })()`).catch(() => {});
      
      // Pause 2.5 - 5 seconds simulating reading
      const pause = Math.floor(Math.random() * 2500) + 2500;
      await page.waitForTimeout(Math.min(pause, targetEnd - Date.now()));
    } else if (actionRoll < 0.85) {
      // Micro-scroll up (user re-checking something they just scrolled past)
      const upDist = Math.floor(Math.random() * 140) + 60;
      await page.evaluate(`(() => {
        window.scrollBy({ top: -${upDist}, behavior: 'smooth' });
      })()`).catch(() => {});
      await page.waitForTimeout(1500);
    } else {
      // Visit reels / watch tab for brief video view
      if (step === 3 && targetEnd - Date.now() > 8000) {
        log(`Switching to Reels feed for video watch simulation...`);
        await page.goto('https://www.facebook.com/reel', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(Math.min(6000, targetEnd - Date.now()));
        // Scroll to next reel
        await page.evaluate(`(() => {
          window.scrollBy({ top: window.innerHeight, behavior: 'smooth' });
        })()`).catch(() => {});
        await page.waitForTimeout(3000);
      } else {
        // Natural small pause
        await page.waitForTimeout(2000);
      }
    }
  }

  log(`Humanizer warm-up completed successfully (${Math.round((Date.now() - started) / 1000)}s).`);
  return { ok: true, duration: Date.now() - started };
}

/**
 * Runs standalone warm-up for a single profile
 */
async function warmupProfile(profileName, { durationMs = 30000, onLog = () => {} } = {}) {
  const log = (msg) => {
    onLog(`[${profileName}] ${msg}`);
  };

  log(`Starting profile browser for warm-up session...`);
  let session = getSession(profileName);
  let wasAlreadyRunning = session && session.state === 'running';

  if (!wasAlreadyRunning) {
    await startProfile(profileName, { startMaximized: true });
    session = getSession(profileName);
  }

  if (!session || !session.cdpPort) {
    throw new Error(`Could not get CDP port for profile ${profileName}`);
  }

  let connection;
  try {
    connection = await connectOverCDP(session.cdpPort);
    const page = await connection.context.newPage();
    await simulateHumanActivity(page, durationMs, log);
    try { page.session?.close(); } catch {}
  } finally {
    if (!wasAlreadyRunning) {
      log(`Stopping warm-up browser session...`);
      await stopProfile(profileName).catch(() => {});
    }
  }

  return { ok: true, profile: profileName };
}

/**
 * Runs warm-up across multiple profiles with concurrency
 */
async function warmupBatch(profileNames, { parallel = 2, durationSeconds = 30, onUpdate = () => {} } = {}) {
  const jobId = 'warmup_' + Date.now();
  const job = {
    id: jobId,
    profiles: profileNames,
    parallel,
    durationSeconds,
    status: 'running',
    startedAt: Date.now(),
    results: {},
    logs: []
  };
  activeWarmups.set(jobId, job);

  const durationMs = Math.max(15, Math.min(180, durationSeconds)) * 1000;
  let cursor = 0;
  const limit = Math.min(parallel, profileNames.length);

  const worker = async () => {
    while (cursor < profileNames.length && job.status === 'running') {
      const pName = profileNames[cursor++];
      job.results[pName] = { status: 'running', message: 'Warming up...' };
      onUpdate(job);

      try {
        await warmupProfile(pName, {
          durationMs,
          onLog: (line) => {
            job.logs.push(line);
            if (job.logs.length > 50) job.logs.shift();
            onUpdate(job);
          }
        });
        job.results[pName] = { status: 'done', message: 'Warm-up complete' };
      } catch (err) {
        job.results[pName] = { status: 'error', message: err.message };
      }
      onUpdate(job);
    }
  };

  Promise.all(Array.from({ length: limit }, worker)).then(() => {
    job.status = 'finished';
    job.finishedAt = Date.now();
    onUpdate(job);
  });

  return jobId;
}

function getWarmupStatus(jobId) {
  return activeWarmups.get(jobId) || null;
}

module.exports = {
  simulateHumanActivity,
  warmupProfile,
  warmupBatch,
  getWarmupStatus
};
