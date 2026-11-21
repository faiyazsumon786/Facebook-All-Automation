// Parse only the profile's Reels connection, not arbitrary video IDs in HTML.
function classifyFacebookUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !/^(?:[a-z0-9-]+\.)*(facebook\.com|fb\.watch|fbwat\.ch)$/.test(u.hostname)) throw new Error('Use a Facebook HTTPS URL.');
  u.hash = '';
  const reel = u.pathname.match(/^\/reels?\/(\d+)\/?$/);
  if (reel) return { type: 'video', url: `https://www.facebook.com/reel/${reel[1]}` };
  if (/(?:^|\.)fb(?:\.watch|wat\.ch)$/.test(u.hostname) || /^\/(?:watch|video\.php|share\/(?:r|v))(?:\/|$)/.test(u.pathname) || /\/videos\//.test(u.pathname)) return { type: 'video', url: u.href };
  let id;
  if (u.pathname === '/profile.php') {
    id = u.searchParams.get('id');
    if (!/^\d+$/.test(id || '')) throw new Error('Profile URL requires a numeric id.');
  } else {
    id = u.pathname.match(/^\/people\/[^/]+\/(\d+)(?:\/reels)?\/?$/)?.[1] || u.pathname.match(/^\/(\d+)\/?$/)?.[1];
  }
  if (id) return { type: 'profile', id, url: `https://www.facebook.com/profile.php?id=${id}&sk=reels_tab` };
  const vanity = u.pathname.match(/^\/([A-Za-z0-9._-]+)(?:\/reels)?\/?$/)?.[1];
  if (vanity && !['reel','reels','watch','groups','share','login','login.php','photo.php','photos','gaming','marketplace','stories','story.php'].includes(vanity.toLowerCase())) {
    return { type: 'profile', url: `https://www.facebook.com/${vanity}/reels/` };
  }
  throw new Error('Paste a Reel/video URL or a Facebook profile URL.');
}

function readObject(text, start) {
  let depth = 0, quoted = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { if (--depth === 0) return JSON.parse(text.slice(start, i + 1)); }
  }
  return null;
}

function extractReelConnection(text, ownerId) {
  const urls = new Set();
  let found = false, hasNext = null, cursor = null;
  const re = /"aggregated_fb_shorts"\s*:\s*(?=\{)/g;
  for (const match of text.matchAll(re)) {
    let connection;
    try { connection = readObject(text, match.index + match[0].length); } catch { continue; }
    if (!connection || !Array.isArray(connection.edges)) continue;
    found = true;
    for (const edge of connection.edges) {
      const node = edge.profile_reel_node?.node;
      const video = node?.short_form_video_context?.video;
      if (/^\d+$/.test(video?.id || '') && (!ownerId || video.owner?.id === ownerId)) urls.add(`https://www.facebook.com/reel/${video.id}`);
    }
    if (typeof connection.page_info?.has_next_page === 'boolean') {
      hasNext = connection.page_info.has_next_page;
      cursor = connection.page_info.end_cursor || null;
    }
  }
  return { found, urls: [...urls], hasNext, cursor };
}
module.exports = { classifyFacebookUrl, extractReelConnection };
