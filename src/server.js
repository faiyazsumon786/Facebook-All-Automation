const fs = require('fs');
const path = require('path');
const http = require('http');
const { loadProfile, listProfiles } = require('./index');
const { startProfile, stopProfile, stopAll, listSessions } = require('./manager');
const { LIB, listDevices } = require('./presets');
const { generateRandomProfile } = require('./random');
const { startUpload, cancelUpload, jobStatus, allJobs } = require('./uploader');
const {
  startScheduler,
  listCampaigns,
  saveCampaign,
  toggleCampaign,
  deleteCampaign,
  triggerCampaignRun,
  scanFolderVideos
} = require('./campaigns');
startScheduler();
const { profileUid, checkProfileUid, getUidCheck, isDeletableDead, forgetUidCheck } = require('./uid-checker');
const { warmupBatch, getWarmupStatus } = require('./warmup');
const { splitVideo, getVideoDuration } = require('./splitter');
const { createFullBackup, restoreFullBackup } = require('./backup');
const { autoReplyComments } = require('./comment-reply');
const { generateSpeech, mergeVoiceover, VOICEOVER_DIR } = require('./voiceover');
const {
  getSmmConfig,
  saveSmmConfig,
  fetchSmmBalance,
  fetchSmmServices,
  placeSmmOrder,
  getSmmOrders,
  runFarmBoost,
  getFarmJob
} = require('./booster');
const {
  startPageCreationJob,
  getPageCreationJob,
  cancelPageCreationJob
} = require('./page-creator');

const { ensureProfileNumbers, numberNewProfile } = require('./profile-numbers');
const { storageRoot } = require('./storage');
const PROFILES_DIR = path.join(storageRoot, 'profiles');
const GUI_DIR = path.resolve(__dirname, '..', 'gui');
const PORT = Number(process.env.PORT || 8899);

function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        chunks.length = 0;
        reject(Object.assign(new Error('Request body exceeds 2 MB'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const data = body ? JSON.parse(body) : {};
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a JSON object');
        resolve(data);
      } catch { reject(Object.assign(new Error('Expected a valid JSON object'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function validName(name) {
  return typeof name === 'string' && name.length <= 120 && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name) && !name.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'OPTIONS') return send(res, 200, {});

    if (url.pathname === '/api/presets') {
      const platforms = {
        Windows: { webgl: 'windows', mobile: false },
        macOS: { webgl: 'macos', mobile: false },
        Linux: { webgl: 'windows', mobile: false },
        Android: { webgl: 'mobile', mobile: true },
        iPhone: { webgl: 'mobile', mobile: true }
      };
      return send(res, 200, {
        platforms,
        devices: listDevices(),
        webglPresets: {
          mobile: LIB.webglPresets.mobile,
          windows: LIB.webglPresets.windows,
          macos: LIB.webglPresets.macos
        },
        uaDefaults: {
          Android: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.52 Mobile Safari/537.36',
          iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
          Windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.52 Safari/537.36',
          macOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.52 Safari/537.36',
          Linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.52 Safari/537.36'
        },
        resolutions: {
          mobile: ['1080_2408', '1080_2340', '1080_1920', '720_1600', '720_1280', '1440_3120'],
          desktop: ['1920_1080', '1366_768', '2560_1440', '1536_864', '1280_720', '3840_2160']
        },
        locales: ['en-US', 'en-GB', 'es-419', 'pt-BR', 'de-DE', 'fr-FR', 'ja-JP', 'zh-CN', 'ar-SA', 'tr-TR', 'bn-BD', 'hi-IN', 'id-ID', 'vi-VN', 'th-TH', 'ru-RU']
      });
    }

    if (url.pathname === '/api/profiles' && req.method === 'GET') {
      ensureProfileNumbers(PROFILES_DIR);
      const sessions = Object.fromEntries(listSessions().map((s) => [s.name, s]));
      const profiles = listProfiles().map((name) => {
        let p;
        try { p = loadProfile(name); }
        catch { return { name, browserPlatform: 'Unreadable profile', state: 'invalid', running: false }; }
        return {
          name,
          serialNumber: p.serialNumber,
          createdAt: p.createdAt,
          uid: profileUid(p, name),
          composerLogin: p.composerLogin || null,
          uidCheck: getUidCheck(name, p),
          lastUpload: p.lastUpload || null,
          accountStatus: p.accountStatus ? {
            scannedAt: p.accountStatus.scannedAt,
            failed: !!p.accountStatus.scanFailed,
            risk: !!(p.accountStatus.risk || p.accountStatus.scanFailed),
            error: p.accountStatus.error || null,
            totalCount: p.accountStatus.totalCount,
            warningCount: p.accountStatus.warningCount,
            healthyCount: p.accountStatus.healthyCount,
            unknownCount: p.accountStatus.unknownCount
          } : null,
          browserPlatform: p.browserPlatform || (p.isMobile ? 'Android' : 'Windows'),
          isMobile: !!p.isMobile,
          userAgent: p.userAgent || '',
          proxy: p.proxy ? { scheme: p.proxy.scheme, host: p.proxy.host, port: p.proxy.port } : null,
          running: !!sessions[name] && sessions[name].state === 'running',
          state: sessions[name] ? sessions[name].state : 'stopped',
          hardware: p.hardware,
          device: p.device,
          webgl: p.webgl
        };
      });
      return send(res, 200, { list: profiles });
    }

    if (url.pathname === '/api/upload/start' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const result = startUpload({
          videoPaths: body.videoPaths,
          videoPath: body.videoPath,
          title: body.title || '',
          description: body.description || '',
          firstComment: body.firstComment || '',
          antiCopyright: body.antiCopyright !== false && body.antiCopyright !== 'false',
          humanize: body.humanize !== false && body.humanize !== 'false',
          profiles: body.profiles || 'all',
          parallel: body.parallel,
          timeoutPerProfile: body.timeoutPerProfile
        });
        return send(res, 200, { ok: true, ...result });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (url.pathname === '/api/campaigns' && req.method === 'GET') {
      return send(res, 200, { campaigns: listCampaigns() });
    }

    if (url.pathname === '/api/campaigns' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const camp = saveCampaign(body);
        return send(res, 200, { ok: true, campaign: camp });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (url.pathname === '/api/campaigns/run' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const result = await triggerCampaignRun(body.id);
        return send(res, 200, result);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (url.pathname === '/api/campaigns/toggle' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const camp = toggleCampaign(body.id, body.active);
        return send(res, 200, { ok: true, campaign: camp });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (url.pathname === '/api/campaigns/delete' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        return send(res, 200, deleteCampaign(body.id));
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (url.pathname === '/api/campaigns/scan-folder' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const videos = scanFolderVideos(body.folder);
        return send(res, 200, { videos, count: videos.length });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (url.pathname === '/api/profiles/warmup' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const profiles = Array.isArray(body.profiles) && body.profiles.length ? body.profiles : (body.profile ? [body.profile] : []);
        if (!profiles.length) return send(res, 400, { error: 'No profiles specified for warm-up' });
        const durationSeconds = Number(body.durationSeconds) || 30;
        const parallel = Math.max(1, Math.min(5, Number(body.parallel) || 2));
        const jobId = await warmupBatch(profiles, { durationSeconds, parallel });
        return send(res, 200, { ok: true, jobId });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (url.pathname === '/api/profiles/warmup/status' && req.method === 'GET') {
      const jobId = url.searchParams.get('id');
      const status = getWarmupStatus(jobId);
      if (!status) return send(res, 404, { error: 'Warm-up job not found' });
      return send(res, 200, status);
    }

    if (url.pathname === '/api/video/split' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        if (!body.filePath) return send(res, 400, { error: 'No filePath provided' });
        const result = await splitVideo(body.filePath, {
          chunkDuration: body.chunkDuration,
          outputFolder: body.outputFolder
        });
        return send(res, 200, result);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (url.pathname === '/api/video/duration' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const dur = await getVideoDuration(body.filePath);
        return send(res, 200, { ok: true, duration: dur });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    // 1. One-Click Backup & Restore
    if (url.pathname === '/api/backup/export' && req.method === 'GET') {
      try {
        const backup = createFullBackup();
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="LuminousTech-Backup-${new Date().toISOString().slice(0, 10)}.json"`
        });
        return res.end(JSON.stringify(backup, null, 2));
      } catch (err) {
        return send(res, 500, { error: err.message });
      }
    }

    if (url.pathname === '/api/backup/restore' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const result = restoreFullBackup(body);
        return send(res, 200, result);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    // 2. Auto-Reply to Viewer Comments (Engagement Booster)
    if (url.pathname === '/api/comments/reply' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        if (!body.profileName) return send(res, 400, { error: 'profileName is required' });
        const result = await autoReplyComments(body.profileName, {
          pageId: body.pageId,
          reelUrl: body.reelUrl,
          spintaxReply: body.spintaxReply,
          maxReplies: body.maxReplies || 5
        });
        return send(res, 200, result);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    // 3. AI Voiceover Generator & Merger
    if (url.pathname === '/api/voiceover/generate' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const result = await generateSpeech(body.text, {
          lang: body.lang || 'en',
          speed: body.speed || 1.0
        });
        return send(res, 200, result);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (url.pathname === '/api/voiceover/merge' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const result = await mergeVoiceover(body.videoPath, body.audioPath, {
          mixWithOriginal: body.mixWithOriginal,
          outputFolder: body.outputFolder
        });
        return send(res, 200, result);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (url.pathname.startsWith('/api/voiceover/audio/') && req.method === 'GET') {
      const fileName = path.basename(decodeURIComponent(url.pathname.replace('/api/voiceover/audio/', '')));
      const filePath = path.join(VOICEOVER_DIR, fileName);
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        return fs.createReadStream(filePath).pipe(res);
      }
      return send(res, 404, { error: 'Audio file not found' });
    }

    // 4. Growth Booster (Farm Booster & SMM Reseller API)
    if (url.pathname === '/api/booster/smm/config' && req.method === 'GET') {
      return send(res, 200, getSmmConfig());
    }

    if (url.pathname === '/api/booster/smm/config' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const config = saveSmmConfig(body);
        return send(res, 200, { ok: true, config });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (url.pathname === '/api/booster/smm/balance' && req.method === 'GET') {
      try {
        const balance = await fetchSmmBalance();
        return send(res, 200, balance);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (url.pathname === '/api/booster/smm/services' && req.method === 'GET') {
      try {
        const services = await fetchSmmServices();
        return send(res, 200, services);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (url.pathname === '/api/booster/smm/order' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const result = await placeSmmOrder(body);
        return send(res, 200, result);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (url.pathname === '/api/booster/smm/orders' && req.method === 'GET') {
      return send(res, 200, { orders: getSmmOrders() });
    }

    if (url.pathname === '/api/booster/farm/run' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const jobId = await runFarmBoost(body);
        return send(res, 200, { ok: true, jobId });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (url.pathname === '/api/booster/farm/status' && req.method === 'GET') {
      const jobId = url.searchParams.get('id');
      const job = getFarmJob(jobId);
      if (!job) return send(res, 404, { error: 'Job not found' });
      return send(res, 200, { ok: true, job });
    }

    // 5. Bulk Facebook Page Creator
    if (url.pathname === '/api/pages/create' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        if (!Array.isArray(body.profiles) || !body.profiles.length) {
          return send(res, 400, { error: 'Please select at least one profile.' });
        }
        if (!Array.isArray(body.pageNames) || !body.pageNames.length) {
          return send(res, 400, { error: 'Please enter at least one Page Name.' });
        }
        const jobId = startPageCreationJob({
          profiles: body.profiles,
          pageNames: body.pageNames,
          category: body.category || 'Digital creator',
          bio: body.bio || '',
          delaySec: Number(body.delaySec) || 20
        });
        return send(res, 200, { ok: true, jobId });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (url.pathname === '/api/pages/create/status' && req.method === 'GET') {
      const jobId = url.searchParams.get('id');
      if (!jobId) return send(res, 400, { error: 'job id is required' });
      const job = getPageCreationJob(jobId);
      if (!job) return send(res, 404, { error: 'Job not found' });
      return send(res, 200, { ok: true, job });
    }

    if (url.pathname === '/api/pages/create/cancel' && req.method === 'POST') {
      const body = await readBody(req);
      const ok = cancelPageCreationJob(body.id);
      return send(res, 200, { ok });
    }

    if (url.pathname === '/api/upload/status' && req.method === 'GET') {
      return send(res, 200, { jobs: allJobs() });
    }

    if (url.pathname.startsWith('/api/upload/status/') && req.method === 'GET') {
      const jobId = decodeURIComponent(parts[3]);
      const status = jobStatus(jobId);
      if (!status) return send(res, 404, { error: 'job not found' });
      return send(res, 200, status);
    }

    if (url.pathname.startsWith('/api/upload/stop/') && req.method === 'POST') {
      const jobId = decodeURIComponent(parts[3]);
      return send(res, 200, { ok: cancelUpload(jobId) });
    }

    if (url.pathname === '/api/upload/history' && req.method === 'GET') {
      try {
        const historyFile = path.join(storageRoot, 'data', 'upload-history.json');
        if (fs.existsSync(historyFile)) {
          const list = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
          return send(res, 200, { history: Array.isArray(list) ? list : [] });
        }
      } catch (e) {}
      return send(res, 200, { history: [] });
    }

    if (url.pathname === '/api/upload/history/clear' && req.method === 'POST') {
      try {
        const historyFile = path.join(storageRoot, 'data', 'upload-history.json');
        fs.writeFileSync(historyFile, JSON.stringify([], null, 2));
      } catch (e) {}
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/upload/history/delete' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const targetId = body && (body.id || body.batchId);
        const historyFile = path.join(storageRoot, 'data', 'upload-history.json');
        if (fs.existsSync(historyFile)) {
          let list = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
          if (Array.isArray(list)) {
            list = list.filter(item => item.id !== targetId && String(item.createdAt) !== String(targetId));
            fs.writeFileSync(historyFile, JSON.stringify(list, null, 2));
            return send(res, 200, { ok: true, remaining: list.length });
          }
        }
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/profiles/import-cookies' && req.method === 'POST') {
      const body = await readBody(req);
      const platform = body.browserPlatform || 'Windows';
      if (!['Windows', 'Android'].includes(platform)) {
        return send(res, 400, { error: 'device type must be Windows or Android' });
      }
      const { importProfiles } = require('./profile-import');
      const controller = new AbortController();
      const cancel = () => controller.abort();
      res.once('close', cancel);
      if (res.destroyed) cancel();
      let created;
      try { created = await importProfiles(body.text, platform, controller.signal); }
      finally { res.removeListener('close', cancel); }
      return send(res, 200, { ok: true, created });
    }

    if (url.pathname === '/api/profiles/delete-many' && req.method === 'POST') {
      const body = await readBody(req);
      const names = Array.isArray(body.names) ? body.names.filter((n) => validName(n)) : [];
      if (!names.length) return send(res, 400, { error: 'no profiles selected' });
      const deleted = [];
      const skipped = [];
      for (const name of names) {
        if (body.onlyDead === true) {
          try {
            if (!isDeletableDead(name, loadProfile(name))) { skipped.push(name); continue; }
          } catch { skipped.push(name); continue; }
        }
        await stopProfile(name);
        if (body.onlyDead === true && !isDeletableDead(name, loadProfile(name))) { skipped.push(name); continue; }
        const file = path.join(PROFILES_DIR, name + '.json');
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
          deleted.push(name);
          forgetUidCheck(name);
        }
        const dataDir = path.join(storageRoot, 'data', name);
        if (fs.existsSync(dataDir)) {
          try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
        }
      }
      return send(res, 200, { ok: true, deleted, skipped });
    }

    if (url.pathname === '/api/profiles' && req.method === 'POST') {
      const body = await readBody(req);
      const platform = body.browserPlatform || 'Windows';
      if (!['Windows', 'Android'].includes(platform)) {
        return send(res, 400, { error: 'device type must be Windows or Android' });
      }
      const profile = generateRandomProfile({ platforms: [platform] });
      const defaultName = 'profile-' + Math.random().toString(36).slice(2, 6);
      if (body.name !== undefined && !validName(body.name)) return send(res, 400, { error: 'Use 1–120 letters, numbers, dots, underscores or hyphens; start with a letter, number or underscore.' });
      profile.name = body.name || defaultName;
      const names = new Set(listProfiles());
      let name = profile.name;
      let i = 2;
      while (names.has(name)) {
        name = `${profile.name}-${i++}`;
      }
      profile.name = name;
      numberNewProfile(profile, PROFILES_DIR);
      fs.writeFileSync(path.join(PROFILES_DIR, name + '.json'), JSON.stringify(profile, null, 2));
      return send(res, 200, { ok: true, profile });
    }

    if (url.pathname.startsWith('/api/profiles/')) {
      const name = decodeURIComponent(parts[2]);
      if (!validName(name)) return send(res, 400, { error: 'invalid profile name' });

      if (parts.length === 4 && parts[3] === 'check-uid' && req.method === 'POST') {
        await readBody(req);
        return send(res, 200, { name, uidCheck: await checkProfileUid(name, loadProfile(name)) });
      }

      if (url.pathname.endsWith('/start') && req.method === 'POST') {
        await readBody(req);
        const result = await startProfile(name);
        return send(res, 200, result);
      }
      if (url.pathname.endsWith('/stop') && req.method === 'POST') {
        return send(res, 200, await stopProfile(name));
      }
      if (url.pathname.endsWith('/proxy') && req.method === 'POST') {
        const body = await readBody(req);
        const profile = loadProfile(name);
        if (body.proxy && body.proxy.host) {
          const { host, scheme = 'http', port = 80 } = body.proxy;
          if (typeof host !== 'string' || !host.trim() || /[\s/@\\?#]/.test(host) || !['http', 'https', 'socks5'].includes(scheme) || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
            return send(res, 400, { error: 'Enter a valid proxy host, scheme and port (1–65535).' });
          }
          profile.proxy = {
            scheme: body.proxy.scheme || 'http',
            host: body.proxy.host.trim(),
            port: Number(body.proxy.port) || 80,
            username: body.proxy.username || undefined,
            password: body.proxy.password || undefined
          };
        } else {
          delete profile.proxy;
        }
        fs.writeFileSync(path.join(PROFILES_DIR, name + '.json'), JSON.stringify(profile, null, 2));
        if (await stopProfile(name)) { /* proxy change requires restart */ }
        return send(res, 200, { ok: true, proxy: profile.proxy || null });
      }
      if (req.method === 'DELETE') {
        await stopProfile(name);
        const file = path.join(PROFILES_DIR, name + '.json');
        if (fs.existsSync(file)) fs.unlinkSync(file);
        forgetUidCheck(name);
        const dataDir = path.join(storageRoot, 'data', name);
        if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
        return send(res, 200, { ok: true, name });
      }
      if (req.method === 'GET') {
        return send(res, 200, loadProfile(name));
      }
    }

    if (url.pathname === '/api/stop-all' && req.method === 'POST') {
      await stopAll();
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, err.status || (err.message.startsWith('profile not found:') ? 404 : 500), { error: err.message });
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(GUI_DIR, path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, ''));
  if (!file.startsWith(GUI_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(PROFILES_DIR, { recursive: true });
    const server = http.createServer((req, res) => {
      const authority = `127.0.0.1:${server.address().port}`;
      if (req.headers.host !== authority && req.headers.host !== `localhost:${server.address().port}`) return send(res, 403, { error: 'Invalid host' });
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'Cross-origin requests are not allowed' });
      let url;
      try { url = new URL(req.url, `http://${authority}`); }
      catch { return send(res, 400, { error: 'Invalid URL' }); }
      if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
      return serveStatic(req, res, url);
    });
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && Number(port) !== 0) {
        console.warn(`port ${port} busy, binding a free port instead`);
        resolve(startServer(0));
        return;
      }
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      server.on('error', (err) => console.warn('[api]', err.message));
      const actualPort = server.address().port;
      console.log(`API server running at http://127.0.0.1:${actualPort}`);
      resolve({ server, port: actualPort });
    });
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('server failed:', err.message);
    process.exit(1);
  });
}

module.exports = { startServer };
