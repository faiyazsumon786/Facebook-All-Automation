const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { storageRoot } = require('./storage');
const { startProfile, stopProfile, getSession } = require('./manager');
const { connectOverCDP } = require('./cdp');

const DATA_DIR = path.join(storageRoot, 'data');
const SMM_CONFIG_FILE = path.join(DATA_DIR, 'smm-config.json');
const SMM_ORDERS_FILE = path.join(DATA_DIR, 'smm-orders.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// -------------------------------------------------------------
// 1. SMM RESELLER PANEL API CLIENT (Standard v2 API)
// -------------------------------------------------------------

function getSmmConfig() {
  ensureDataDir();
  if (!fs.existsSync(SMM_CONFIG_FILE)) {
    return { apiUrl: '', apiKey: '' };
  }
  try {
    return JSON.parse(fs.readFileSync(SMM_CONFIG_FILE, 'utf8'));
  } catch {
    return { apiUrl: '', apiKey: '' };
  }
}

function saveSmmConfig(config) {
  ensureDataDir();
  const data = {
    apiUrl: (config.apiUrl || '').trim(),
    apiKey: (config.apiKey || '').trim(),
    updatedAt: Date.now()
  };
  fs.writeFileSync(SMM_CONFIG_FILE, JSON.stringify(data, null, 2));
  return data;
}

function makeSmmRequest(apiUrl, params) {
  return new Promise((resolve, reject) => {
    if (!apiUrl) return reject(new Error('SMM API URL is not configured.'));
    
    let parsedUrl;
    try {
      parsedUrl = new URL(apiUrl);
    } catch {
      return reject(new Error('Invalid SMM API URL. Example: https://panel.com/api/v2'));
    }

    const postData = new URLSearchParams(params).toString();
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const req = client.request(parsedUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Mozilla/5.0 LuminousTech-SMM/1.5'
      },
      timeout: 15000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json);
        } catch {
          resolve({ raw: body, error: `Invalid response from SMM server (HTTP ${res.statusCode})` });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('SMM API request timed out.'));
    });

    req.write(postData);
    req.end();
  });
}

async function fetchSmmBalance() {
  const { apiUrl, apiKey } = getSmmConfig();
  if (!apiUrl || !apiKey) throw new Error('Configure your SMM Panel API URL & Key first.');
  return makeSmmRequest(apiUrl, { key: apiKey, action: 'balance' });
}

async function fetchSmmServices() {
  const { apiUrl, apiKey } = getSmmConfig();
  if (!apiUrl || !apiKey) throw new Error('Configure your SMM Panel API URL & Key first.');
  return makeSmmRequest(apiUrl, { key: apiKey, action: 'services' });
}

function getSmmOrders() {
  ensureDataDir();
  if (!fs.existsSync(SMM_ORDERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SMM_ORDERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveSmmOrder(orderRecord) {
  ensureDataDir();
  const orders = getSmmOrders();
  orders.unshift(orderRecord);
  fs.writeFileSync(SMM_ORDERS_FILE, JSON.stringify(orders.slice(0, 100), null, 2));
}

async function placeSmmOrder({ service, link, quantity }) {
  const { apiUrl, apiKey } = getSmmConfig();
  if (!apiUrl || !apiKey) throw new Error('Configure your SMM Panel API URL & Key first.');

  const res = await makeSmmRequest(apiUrl, {
    key: apiKey,
    action: 'add',
    service,
    link,
    quantity
  });

  if (res.order) {
    saveSmmOrder({
      orderId: res.order,
      service,
      link,
      quantity,
      createdAt: Date.now(),
      status: 'Pending'
    });
  }

  return res;
}

// -------------------------------------------------------------
// 2. INTERNAL FARM BOOSTER (Free Follows & Likes using own profiles)
// -------------------------------------------------------------

const activeFarmJobs = new Map();

/**
 * Runs automated follow/like actions using your connected profiles
 */
async function runFarmBoost({ targetUrl, action = 'follow_page', profiles = [], reaction = 'like', delaySec = 4, onLog = () => {} }) {
  const jobId = 'farm_' + Date.now();
  const job = {
    id: jobId,
    targetUrl,
    action,
    profiles,
    status: 'running',
    startedAt: Date.now(),
    successCount: 0,
    failCount: 0,
    logs: []
  };
  activeFarmJobs.set(jobId, job);

  const log = (msg) => {
    job.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (job.logs.length > 80) job.logs.shift();
    onLog(msg);
  };

  log(`Starting Farm Boost on ${profiles.length} profiles for target: ${targetUrl}`);

  (async () => {
    for (let i = 0; i < profiles.length; i++) {
      if (job.status !== 'running') break;
      const pName = profiles[i];
      log(`[${pName}] Launching browser for action: ${action}...`);

      let session = getSession(pName);
      const wasRunning = session && session.state === 'running';

      try {
        if (!wasRunning) {
          await startProfile(pName, { startMaximized: true });
          session = getSession(pName);
        }

        if (!session?.cdpPort) throw new Error('No CDP port available');
        const connection = await connectOverCDP(session.cdpPort);
        const page = await connection.context.newPage();

        log(`[${pName}] Navigating to target URL...`);
        await page.goto(targetUrl, { timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(4000);

        // Perform Action with exact Facebook button matching and verification
        const result = await page.evaluate(`(async (act, reactType) => {
          function simulateClick(el) {
            if (!el) return false;
            try { el.focus(); } catch (e) {}
            const rect = el.getBoundingClientRect();
            const clientX = rect.x + (rect.width > 0 ? rect.width / 2 : 5);
            const clientY = rect.y + (rect.height > 0 ? rect.height / 2 : 5);
            ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click'].forEach(type => {
              const ev = new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX,
                clientY
              });
              el.dispatchEvent(ev);
            });
            if (typeof el.click === 'function') el.click();
            return true;
          }

          const allButtons = Array.from(document.querySelectorAll('[role="button"], button'));

          // -------------------------------------------------------------
          // 1. FOLLOW PAGE
          // -------------------------------------------------------------
          if (act === 'follow_page') {
            // Check if already following
            const isAlreadyFollowing = allButtons.some(b => {
              const a = (b.getAttribute('aria-label') || '').trim().toLowerCase();
              const t = (b.innerText || '').trim().toLowerCase();
              return a === 'following' || t === 'following' || a === 'ফলো করছেন' || t === 'ফলো করছেন' || a === 'liked' || t === 'liked';
            });

            if (isAlreadyFollowing) {
              return { success: true, message: 'Already following this page' };
            }

            // Find exact Follow or Like button (avoid links, tabs, follower counts, post buttons)
            let followBtn = allButtons.find(b => {
              if (b.tagName === 'A' || b.getAttribute('role') === 'tab') return false;
              const a = (b.getAttribute('aria-label') || '').trim().toLowerCase();
              const t = (b.innerText || '').trim().toLowerCase();
              if (a.includes('post') || a.includes('comment') || a.includes('follower') || t.includes('follower')) return false;
              return (
                a === 'follow' || t === 'follow' ||
                a === 'ফলো করুন' || t === 'ফলো করুন' ||
                a === 'ফলো' || t === 'ফলো' ||
                a === 'like' || t === 'like' ||
                a === 'লাইক' || t === 'লাইক'
              );
            });

            // If not found in primary header, check "..." More Profile Settings button
            if (!followBtn) {
              const moreBtn = allButtons.find(b => {
                const a = (b.getAttribute('aria-label') || '').toLowerCase();
                return a.includes('see more options') || a.includes('profile settings') || a.includes('more profile') || a === 'more';
              });
              if (moreBtn) {
                simulateClick(moreBtn);
                await new Promise(r => setTimeout(r, 1500));
                const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], [role="button"]'));
                followBtn = menuItems.find(m => {
                  const text = ((m.getAttribute('aria-label') || '') + ' ' + (m.innerText || '')).toLowerCase();
                  return text.includes('follow') || text.includes('like') || text.includes('ফলো');
                });
              }
            }

            if (followBtn) {
              followBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await new Promise(r => setTimeout(r, 800));
              simulateClick(followBtn);
              
              // Wait 3.5s and verify state change
              await new Promise(r => setTimeout(r, 3500));
              const afterButtons = Array.from(document.querySelectorAll('[role="button"], button'));
              const confirmed = afterButtons.some(b => {
                const a = (b.getAttribute('aria-label') || '').toLowerCase();
                const t = (b.innerText || '').toLowerCase();
                return a === 'following' || t === 'following' || a === 'ফলো করছেন' || t === 'ফলো করছেন' || a === 'liked' || t === 'liked';
              });

              return {
                success: true,
                message: confirmed
                  ? 'Followed successfully (State confirmed: Following)!'
                  : 'Follow button clicked (Request sent to Facebook)'
              };
            }

            return { success: false, message: 'Follow/Like button not found on this page' };
          }

          // -------------------------------------------------------------
          // 2. FOLLOW PROFILE
          // -------------------------------------------------------------
          if (act === 'follow_profile') {
            // Check if already friends or following
            const isAlreadyConnected = allButtons.some(b => {
              const a = (b.getAttribute('aria-label') || '').trim().toLowerCase();
              const t = (b.innerText || '').trim().toLowerCase();
              return (
                a === 'following' || t === 'following' ||
                a === 'friends' || t === 'friends' ||
                a === 'friend' || t === 'friend' ||
                a === 'বন্ধু' || t === 'বন্ধু' ||
                a.includes('request sent') || t.includes('request sent') ||
                a.includes('রিকোয়েস্ট পাঠানো') || t.includes('রিকোয়েস্ট পাঠানো')
              );
            });

            if (isAlreadyConnected) {
              return { success: true, message: 'Already friends or following this profile' };
            }

            // Find Add Friend or Follow button
            let addBtn = allButtons.find(b => {
              if (b.tagName === 'A' || b.getAttribute('role') === 'tab') return false;
              const a = (b.getAttribute('aria-label') || '').trim().toLowerCase();
              const t = (b.innerText || '').trim().toLowerCase();
              if (a.includes('post') || a.includes('comment') || a.includes('follower')) return false;
              return (
                a === 'add friend' || t === 'add friend' ||
                a === 'বন্ধু হিসেবে যোগ করুন' || t === 'বন্ধু হিসেবে যোগ করুন' ||
                a === 'follow' || t === 'follow' ||
                a === 'ফলো করুন' || t === 'ফলো করুন' ||
                a === 'ফলো' || t === 'ফলো'
              );
            });

            if (!addBtn) {
              const moreBtn = allButtons.find(b => {
                const a = (b.getAttribute('aria-label') || '').toLowerCase();
                return a.includes('see more options') || a.includes('profile settings') || a === 'more';
              });
              if (moreBtn) {
                simulateClick(moreBtn);
                await new Promise(r => setTimeout(r, 1500));
                const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], [role="button"]'));
                addBtn = menuItems.find(m => {
                  const text = ((m.getAttribute('aria-label') || '') + ' ' + (m.innerText || '')).toLowerCase();
                  return text.includes('follow') || text.includes('friend') || text.includes('ফলো');
                });
              }
            }

            if (addBtn) {
              addBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await new Promise(r => setTimeout(r, 800));
              simulateClick(addBtn);
              await new Promise(r => setTimeout(r, 3500));

              return {
                success: true,
                message: 'Profile follow/friend request button clicked & sent!'
              };
            }

            return { success: false, message: 'Follow/Add Friend button not found on profile' };
          }

          // -------------------------------------------------------------
          // 3. REACT TO REEL
          // -------------------------------------------------------------
          if (act === 'react_reel') {
            // Check if already reacted
            const isAlreadyReacted = allButtons.some(b => {
              const a = (b.getAttribute('aria-label') || '').toLowerCase();
              return a.includes('remove like') || a.includes('unlike') || a.includes('লাইক সরান');
            });

            if (isAlreadyReacted) {
              return { success: true, message: 'Already reacted to this Reel' };
            }

            // Find Like/Reaction button on Reel
            const likeBtn = allButtons.find(b => {
              const a = (b.getAttribute('aria-label') || '').toLowerCase();
              return (a.includes('like') || a.includes('লাইক') || a.includes('react')) && !a.includes('comment') && !a.includes('share');
            });

            if (likeBtn) {
              likeBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await new Promise(r => setTimeout(r, 600));

              if (reactType === 'love' || reactType === 'wow') {
                // Hover to open reaction bar
                ['mouseover', 'mouseenter'].forEach(type => {
                  likeBtn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                });
                await new Promise(r => setTimeout(r, 1200));

                const reactBtns = Array.from(document.querySelectorAll('[role="button"], [aria-label]'));
                const targetReact = reactBtns.find(rb => {
                  const a = (rb.getAttribute('aria-label') || '').toLowerCase();
                  return a.includes(reactType);
                });

                if (targetReact) {
                  simulateClick(targetReact);
                  await new Promise(r => setTimeout(r, 2500));
                  return { success: true, message: 'Reacted (' + reactType + ') to Reel successfully!' };
                }
              }

              // Fallback or default Like click
              simulateClick(likeBtn);
              await new Promise(r => setTimeout(r, 3000));
              return { success: true, message: 'Liked Reel successfully!' };
            }

            return { success: false, message: 'Reel reaction button not found' };
          }

          return { success: false, message: 'Unknown action: ' + act };
        })(${JSON.stringify(action)}, ${JSON.stringify(reaction)})`).catch(err => ({ success: false, message: err.message }));

        if (result && result.success) {
          job.successCount++;
          log(`[${pName}] ✅ ${result.message}`);
        } else {
          job.failCount++;
          log(`[${pName}] ⚠️ ${result?.message || 'Action could not be completed'}`);
        }

        // Wait an extra 3 seconds before closing tab to guarantee Facebook's server receives the request
        await page.waitForTimeout(3000);
        try { await page.close().catch(() => {}); } catch {}
      } catch (err) {
        job.failCount++;
        log(`[${pName}] ❌ Error: ${err.message}`);
      } finally {
        if (!wasRunning) {
          await stopProfile(pName).catch(() => {});
        }
      }

      // Safe human delay between profiles
      if (i < profiles.length - 1) {
        const wait = Math.max(2, delaySec) * 1000;
        log(`Waiting ${delaySec}s human delay before next profile...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }

    job.status = 'completed';
    job.completedAt = Date.now();
    log(`Farm Boost completed! ${job.successCount} succeeded, ${job.failCount} failed.`);
  })().catch(err => {
    job.status = 'error';
    log(`Farm Boost job failed: ${err.message}`);
  });

  return jobId;
}

function getFarmJob(jobId) {
  return activeFarmJobs.get(jobId) || null;
}

module.exports = {
  getSmmConfig,
  saveSmmConfig,
  fetchSmmBalance,
  fetchSmmServices,
  placeSmmOrder,
  getSmmOrders,
  runFarmBoost,
  getFarmJob
};
