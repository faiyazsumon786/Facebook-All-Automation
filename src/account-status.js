const ACCOUNT_STATUS_URL = 'https://www.facebook.com/account_status';
const YOUR_PAGES_URL = 'https://www.facebook.com/pages/?category=your_pages';

function isCdpError(err) {
  const msg = String(err && (err.message || err) || '');
  return /CDP timeout/.test(msg) || /CDP not connected/.test(msg) || /CDP connection closed/.test(msg) ||
    /Cannot find context/.test(msg) || /Execution context was destroyed/.test(msg) || /session closed/i.test(msg);
}

function extractYourPagesData() {
  const list = [];
  const seen = new Set();
  const scripts = [...document.querySelectorAll('script[type="application/json"]')];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i]);
      return;
    }
    const isPage = node.delegate_page_id || (node.__typename === 'Page' && node.id);
    if (isPage && (node.name || node.title)) {
      const profileId = String(node.id || node.profile_id || '');
      const pageId = String(node.delegate_page_id || node.id);
      const name = String(node.name || node.title || '');
      if (pageId && /^[0-9]+$/.test(pageId) && !seen.has(pageId)) {
        seen.add(pageId);
        list.push({
          name,
          profileId: profileId || pageId,
          pageId,
          status: 'ok',
          body: 'Page has no issues',
          icon: 'checkmark-circle'
        });
      }
    }
    for (const k of Object.keys(node)) walk(node[k]);
  };
  for (const s of scripts) {
    try { walk(JSON.parse(s.textContent || '')); } catch {}
  }
  for (const a of document.querySelectorAll('a[href*="asset_id="]')) {
    const match = /asset_id=(\d+)/.exec(a.href);
    if (match && !seen.has(match[1])) {
      const pageId = match[1];
      const name = a.innerText.trim() || ('Page ' + pageId);
      seen.add(pageId);
      list.push({
        name,
        profileId: pageId,
        pageId,
        status: 'ok',
        body: 'Page has no issues',
        icon: 'checkmark-circle'
      });
    }
  }
  return list;
}

function extractAccountStatusData() {
  const OUT = { mainProfileId: null, viewerActorId: null, routeProfileId: null, entities: [], pageIdMap: {}, pageStatusScreen: null, bizwebAssetId: null };
  const seen = new Set();
  const text = (node) => node && typeof node === 'object' && node.text != null ? String(node.text) : null;
  const entityId = (item) => {
    const test = typeof item.test_id === 'string' ? item.test_id : '';
    let m = /-(\d+)$/.exec(test);
    if (m) return m[1];
    const href = typeof item.href === 'string' ? item.href : '';
    m = /\/(\d+)\/?$/.exec(href);
    if (m) return m[1];
    const eligible = Array.isArray(item.eligible_profile_ids) ? item.eligible_profile_ids : [];
    for (const id of eligible) if (typeof id === 'string' && /^\d+$/.test(id)) return id;
    return null;
  };
  const collect = (list, kind) => {
    if (!list || typeof list !== 'object' || !Array.isArray(list.items)) return;
    for (const item of list.items) {
      if (!item || typeof item !== 'object') continue;
      const id = entityId(item);
      if (!id) continue;
      const key = kind + ':' + id;
      if (seen.has(key)) continue;
      seen.add(key);
      OUT.entities.push({
        kind,
        profileId: id,
        title: text(item.title),
        body: text(item.body),
        testId: typeof item.test_id === 'string' ? item.test_id : null,
        href: typeof item.href === 'string' ? item.href : null,
        icon: typeof item.icon === 'string' ? item.icon : null,
        typename: typeof item.__typename === 'string' ? item.__typename : null
      });
    }
  };
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 64) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) visit(node[i], depth + 1);
      return;
    }
    if (node.managed_entities && typeof node.managed_entities === 'object') collect(node.managed_entities, 'managed');
    if (node.managed_entities_other_entities && typeof node.managed_entities_other_entities === 'object') collect(node.managed_entities_other_entities, 'other');
    if (node.managed_entities_main_profile && typeof node.managed_entities_main_profile === 'object') collect(node.managed_entities_main_profile, 'main');
    if (node.main_profile_entity && typeof node.main_profile_entity === 'object' && typeof node.main_profile_entity.id === 'string' && !OUT.mainProfileId) {
      OUT.mainProfileId = node.main_profile_entity.id;
    }
    if (typeof node.delegate_page_id === 'string' && node.delegate_page_id && /^\d+$/.test(node.delegate_page_id)) {
      const candidate = (typeof node.id === 'string' && /^\d+$/.test(node.id)) ? node : (node.profile || (node.node && node.node.profile));
      if (candidate && typeof candidate.id === 'string' && /^\d+$/.test(candidate.id) && !OUT.pageIdMap[candidate.id]) {
        OUT.pageIdMap[candidate.id] = node.delegate_page_id;
      }
    }
    if (node.viewer && node.viewer.actor && typeof node.viewer.actor.id === 'string' && !OUT.viewerActorId) {
      OUT.viewerActorId = node.viewer.actor.id;
    }
    if (node.canonicalRouteName && /ProfileStatusRoute/.test(String(node.canonicalRouteName)) && !OUT.routeProfileId) {
      const pid = node.profile_id;
      if (typeof pid === 'number' || (typeof pid === 'string' && /^\d+$/.test(pid))) OUT.routeProfileId = String(pid);
    }
    if (node.cix_screen_profile_status && typeof node.cix_screen_profile_status === 'object' && !OUT.pageStatusScreen) {
      const vm = node.cix_screen_profile_status.view_model || node.cix_screen_profile_status;
      const integrity = vm && vm.integrity_status;
      const profileEntity = vm && vm.profile_entity;
      const pid = profileEntity && (typeof profileEntity.id === 'string' || typeof profileEntity.id === 'number') ? String(profileEntity.id) : null;
      OUT.pageStatusScreen = {
        header: text(vm && vm.header_title),
        title: text(integrity && integrity.title),
        body: text(integrity && integrity.body),
        icon: integrity && typeof integrity.icon === 'string' ? integrity.icon : null,
        profileId: pid
      };
    }
    if (typeof node.bizweb_home_link === 'string' && !OUT.bizwebAssetId) {
      const m = /asset_id=(\d+)/.exec(node.bizweb_home_link);
      if (m) OUT.bizwebAssetId = m[1];
    }
    if (typeof node.delegatePageID === 'string' && /^\d+$/.test(node.delegatePageID) && !OUT.bizwebAssetId) {
      OUT.bizwebAssetId = node.delegatePageID;
    }
    for (const key of Object.keys(node)) visit(node[key], depth + 1);
  };
  const scripts = [...document.querySelectorAll('script[type="application/json"]')];
  for (const script of scripts) {
    try { visit(JSON.parse(script.textContent || ''), 0); } catch (e) {}
  }
  return OUT;
}

function classifyAccountStatus(raw) {
  const mainIds = new Set();
  const pages = new Map();
  if (raw.mainProfileId) mainIds.add(raw.mainProfileId);
  for (const entity of raw.entities || []) {
    if (!entity.profileId) continue;
    if (entity.kind === 'main') { mainIds.add(entity.profileId); continue; }
    if (/^profile\s/i.test(String(entity.body || '').trim())) { mainIds.add(entity.profileId); continue; }
    pages.set(entity.profileId, entity);
  }
  for (const id of mainIds) pages.delete(id);
  const result = [];
  for (const entity of pages.values()) {
    const body = String(entity.body || '').trim();
    let status;
    if (/^page has no issues$/i.test(body)) status = 'ok';
    else if (/issues|warning|restrict|violation|error|review|disable|ban|against the rules/i.test(body)) status = 'warning';
    else status = 'unknown';
    const pageId = (raw.pageIdMap && raw.pageIdMap[entity.profileId]) || null;
    if (!pageId) status = 'unknown';
    result.push({
      name: entity.title || ('Page ' + entity.profileId),
      profileId: entity.profileId,
      pageId,
      status,
      body: entity.body,
      icon: entity.icon
    });
  }
  if (result.length === 0 && raw.pageStatusScreen) {
    const screen = raw.pageStatusScreen;
    const title = String(screen.title || '').trim();
    const body = String(screen.body || '').trim();
    const screenProfileId = screen.profileId || raw.routeProfileId || null;
    const actorMatch = !screenProfileId || !raw.viewerActorId || screenProfileId === raw.viewerActorId;
    const pageId = actorMatch ? (raw.bizwebAssetId || null) : null;
    let status;
    if (/^page has no issues$/i.test(body)) status = 'ok';
    else if (/issues|warning|restrict|violation|error|review|disable|ban|against the rules/i.test(body)) status = 'warning';
    else status = 'unknown';
    if (!pageId) status = 'unknown';
    if (title || body) {
      result.push({
        name: title || ('Page ' + screenProfileId),
        profileId: screenProfileId,
        pageId,
        status,
        body: screen.body,
        icon: screen.icon
      });
    }
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return {
    pages: result,
    mainProfileId: raw.mainProfileId,
    warningCount: result.filter((p) => p.status === 'warning').length,
    healthyCount: result.filter((p) => p.status === 'ok').length,
    unknownCount: result.filter((p) => p.status === 'unknown').length
  };
}

async function scanAccountStatus(page, job, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let statusResult = null;

  // 1. Visit Account Status to check warnings or policy restrictions
  try {
    await page.goto(ACCOUNT_STATUS_URL, { waitUntil: 'domcontentloaded', timeout: Math.min(30000, timeoutMs) });
    let lastRaw = null;
    let foundAt = 0;
    const statusDeadline = Math.min(deadline, Date.now() + 15000);
    while (Date.now() < statusDeadline) {
      let raw;
      try {
        raw = await page.evaluate(extractAccountStatusData, 10000);
      } catch (err) {
        if (!isCdpError(err)) throw err;
        await page.waitForTimeout(1000);
        continue;
      }
      lastRaw = raw;
      const hasData = !!raw.mainProfileId || (Array.isArray(raw.entities) && raw.entities.length > 0) || !!raw.pageStatusScreen;
      if (hasData && !foundAt) foundAt = Date.now();
      if (hasData && Date.now() - foundAt > 2000) {
        statusResult = classifyAccountStatus(raw);
        break;
      }
      await page.waitForTimeout(1000);
    }
    if (!statusResult && lastRaw) statusResult = classifyAccountStatus(lastRaw);
  } catch (e) {}

  // 2. Visit Your Pages to ensure ALL managed pages owned by this profile are discovered
  let yourPages = [];
  try {
    await page.goto(YOUR_PAGES_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(2000);
    yourPages = await page.evaluate(extractYourPagesData, 15000).catch(() => []);
  } catch (e) {}

  // Merge pages from both sources
  const pagesMap = new Map();
  for (const p of yourPages) {
    if (p.pageId) pagesMap.set(p.pageId, p);
  }
  if (statusResult && Array.isArray(statusResult.pages)) {
    for (const p of statusResult.pages) {
      if (p.pageId) {
        const existing = pagesMap.get(p.pageId);
        if (existing) {
          if (p.status === 'warning') existing.status = 'warning';
          if (p.body) existing.body = p.body;
        } else {
          pagesMap.set(p.pageId, p);
        }
      }
    }
  }

  const allPages = Array.from(pagesMap.values());
  allPages.sort((a, b) => a.name.localeCompare(b.name));

  if (!allPages.length && (!statusResult || statusResult.scanFailed)) {
    return {
      pages: [],
      mainProfileId: null,
      warningCount: 0,
      healthyCount: 0,
      unknownCount: 0,
      scanFailed: true,
      error: 'Could not load managed Pages. Check the Facebook login and try again.'
    };
  }

  return {
    pages: allPages,
    mainProfileId: statusResult?.mainProfileId || null,
    warningCount: allPages.filter((p) => p.status === 'warning').length,
    healthyCount: allPages.filter((p) => p.status === 'ok').length,
    unknownCount: allPages.filter((p) => p.status === 'unknown').length,
    scanFailed: false
  };
}

module.exports = { scanAccountStatus, classifyAccountStatus, extractAccountStatusData, extractYourPagesData, ACCOUNT_STATUS_URL, YOUR_PAGES_URL };
