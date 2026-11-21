const fs = require('fs');
const path = require('path');
const { storageRoot } = require('./storage');
const { startUpload, allJobs } = require('./uploader');

const CAMPAIGNS_FILE = path.join(storageRoot, 'data', 'campaigns.json');
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm']);

function ensureDataDir() {
  const dir = path.join(storageRoot, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

function scanFolderVideos(folderPath) {
  if (!folderPath || !fs.existsSync(folderPath)) return [];
  try {
    const entries = fs.readdirSync(folderPath);
    return entries
      .filter(f => VIDEO_EXTS.has(path.extname(f).toLowerCase()))
      .map(f => path.join(folderPath, f));
  } catch {
    return [];
  }
}

function loadCampaigns() {
  ensureDataDir();
  if (!fs.existsSync(CAMPAIGNS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(CAMPAIGNS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveCampaigns(campaigns) {
  ensureDataDir();
  fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify(campaigns, null, 2));
}

function getCampaignWithStats(camp) {
  const allVideos = scanFolderVideos(camp.folder);
  const postedSet = new Set(camp.postedVideos || []);
  const remaining = allVideos.filter(v => !postedSet.has(v) && !postedSet.has(path.basename(v)));

  let status = camp.status || 'active';
  if (!camp.active) {
    status = 'paused';
  } else if (allVideos.length > 0 && remaining.length === 0) {
    status = 'completed';
  } else if (camp.active) {
    status = 'active';
  }

  return {
    ...camp,
    status,
    totalVideos: allVideos.length,
    postedCount: allVideos.length - remaining.length,
    remainingCount: remaining.length
  };
}

function listCampaigns() {
  return loadCampaigns().map(getCampaignWithStats);
}

function saveCampaign(data) {
  const campaigns = loadCampaigns();
  const id = data.id || ('camp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  const existingIndex = campaigns.findIndex(c => c.id === id);

  const folder = (data.folder || '').trim();
  const intervalHours = Math.max(0.5, Number(data.intervalHours) || 4);
  const videosPerRun = Math.max(1, Math.min(10, Number(data.videosPerRun) || 1));

  const camp = {
    id,
    name: (data.name || 'Auto-Pilot Campaign').trim(),
    folder,
    profiles: Array.isArray(data.profiles) && data.profiles.length ? data.profiles : 'all',
    intervalHours,
    videosPerRun,
    title: (data.title || '').trim(),
    description: (data.description || '').trim(),
    firstComment: (data.firstComment || '').trim(),
    antiCopyright: data.antiCopyright !== false,
    humanize: data.humanize !== false,
    active: data.active !== false,
    parallel: Math.max(1, Math.min(5, Number(data.parallel) || 1)),
    lastRunAt: data.lastRunAt || null,
    nextRunAt: data.nextRunAt || (Date.now() + (data.active !== false ? 30000 : intervalHours * 3600 * 1000)),
    postedVideos: Array.isArray(data.postedVideos) ? data.postedVideos : [],
    createdAt: data.createdAt || Date.now()
  };

  if (existingIndex >= 0) {
    campaigns[existingIndex] = { ...campaigns[existingIndex], ...camp };
  } else {
    campaigns.push(camp);
  }

  saveCampaigns(campaigns);
  return getCampaignWithStats(camp);
}

function toggleCampaign(id, active) {
  const campaigns = loadCampaigns();
  const camp = campaigns.find(c => c.id === id);
  if (!camp) throw new Error('Campaign not found');

  camp.active = Boolean(active);
  if (camp.active) {
    camp.nextRunAt = Date.now() + 15000;
  }
  saveCampaigns(campaigns);
  return getCampaignWithStats(camp);
}

function deleteCampaign(id) {
  let campaigns = loadCampaigns();
  campaigns = campaigns.filter(c => c.id !== id);
  saveCampaigns(campaigns);
  return { ok: true };
}

async function triggerCampaignRun(id) {
  const campaigns = loadCampaigns();
  const camp = campaigns.find(c => c.id === id);
  if (!camp) throw new Error('Campaign not found');

  const allVideos = scanFolderVideos(camp.folder);
  if (!allVideos.length) throw new Error('No video files found in folder: ' + camp.folder);

  const postedSet = new Set(camp.postedVideos || []);
  let unposted = allVideos.filter(v => !postedSet.has(v) && !postedSet.has(path.basename(v)));

  // If all posted, reset loop or fail
  if (!unposted.length) {
    if (camp.loopFolder) {
      camp.postedVideos = [];
      unposted = allVideos;
    } else {
      camp.status = 'completed';
      saveCampaigns(campaigns);
      throw new Error('All videos in folder have already been posted.');
    }
  }

  const batchCount = camp.videosPerRun || 1;
  const pickedVideos = unposted.slice(0, batchCount);

  // Evaluate spintax for title, description, and firstComment
  const evaluatedTitle = parseSpintax(camp.title || '');
  const evaluatedDesc = parseSpintax(camp.description || '');
  const evaluatedComment = parseSpintax(camp.firstComment || '');

  const uploadResult = startUpload({
    videoPaths: pickedVideos,
    title: evaluatedTitle,
    description: evaluatedDesc,
    firstComment: evaluatedComment,
    antiCopyright: camp.antiCopyright !== false,
    humanize: camp.humanize !== false,
    profiles: camp.profiles,
    parallel: camp.parallel || 1
  });

  // Mark picked videos as posted
  camp.postedVideos = (camp.postedVideos || []).concat(pickedVideos);
  camp.lastRunAt = Date.now();
  camp.nextRunAt = Date.now() + (camp.intervalHours * 3600 * 1000);
  saveCampaigns(campaigns);

  return {
    ok: true,
    jobId: uploadResult.jobId,
    videoCount: pickedVideos.length,
    videos: pickedVideos,
    nextRunAt: camp.nextRunAt
  };
}

let schedulerTimer = null;
function checkScheduler() {
  try {
    const runningJobs = allJobs().filter(j => j.state === 'running');
    if (runningJobs.length > 0) return; // Wait until current active upload finishes

    const campaigns = loadCampaigns();
    const now = Date.now();

    for (const camp of campaigns) {
      if (!camp.active) continue;
      if (camp.nextRunAt && now >= camp.nextRunAt) {
        console.log(`[Auto-Pilot] Triggering scheduled run for campaign: "${camp.name}"`);
        triggerCampaignRun(camp.id).catch(err => {
          console.error(`[Auto-Pilot] Error running campaign "${camp.name}":`, err.message);
          // Postpone next run by 15 mins on error
          camp.nextRunAt = now + 15 * 60 * 1000;
          saveCampaigns(campaigns);
        });
        break; // Run one campaign batch at a time
      }
    }
  } catch (err) {
    console.error('[Auto-Pilot Scheduler Error]:', err.message);
  }
}

function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(checkScheduler, 30000);
}

module.exports = {
  listCampaigns,
  saveCampaign,
  toggleCampaign,
  deleteCampaign,
  triggerCampaignRun,
  scanFolderVideos,
  parseSpintax,
  startScheduler
};
