const { classifyFacebookUrl } = require('./reel-links');
const PROFILE_FETCH_CONCURRENCY = 5;
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function facebookUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port ||
      !/^(?:[a-z0-9-]+\.)*(?:facebook\.com|fb\.watch|fbwat\.ch)$/.test(u.hostname)) {
    throw new Error('Use a Facebook video or Reel HTTPS link.');
  }
  u.hash = '';
  return u.href;
}

function mediaUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port ||
      !/(?:^|\.)(?:fbcdn\.net|facebook\.com)$/.test(u.hostname)) throw new Error('Provider returned an unsupported video host.');
  return u.href;
}

function chooseQuality(links, quality) {
  const selected = links[quality];
  if (!selected) throw new Error(`${quality === 'hd' ? 'HD' : 'Normal'} quality is unavailable. Choose another quality and retry.`);
  return mediaUrl(selected);
}

class DownloadQueue {
  constructor({ resolve, collect, folder, fetchMedia = fetch, validateMedia = mediaUrl }) {
    this.resolve = resolve;
    this.collect = collect;
    this.sources = [];
    this.preparing = false;
    this.seen = new Set();
    this.folder = folder;
    this.fetchMedia = fetchMedia;
    this.validateMedia = validateMedia;
    this.tasks = [];
    this.parallel = 2;
    this.active = 0;
    this.controllers = new Map();
    this.work = new Set();
  }
  status() {
    return { folder: this.folder, parallel: this.parallel, preparing: this.preparing, sources: this.sources.map(s => ({ ...s })), active: this.preparing || this.tasks.some(t => !['completed', 'failed', 'cancelled'].includes(t.state)), tasks: this.tasks.map(t => ({ ...t })) };
  }
  start({ urls, quality = 'hd', parallel = 2 }) {
    if (this.status().active) throw new Error('Finish or cancel the current queue first.');
    if (!['hd', 'sd'].includes(quality) || !Number.isInteger(parallel) || parallel < 1 || parallel > 10) throw new Error('Choose HD or Normal and 1–10 simultaneous downloads.');
    if (!Array.isArray(urls) || !urls.length || urls.length > 100) throw new Error('Paste between 1 and 100 video or profile links.');
    const inputs = new Map();
    urls.forEach((url, i) => {
      let source;
      try { source = classifyFacebookUrl(url); } catch { throw new Error(`Link ${i + 1} is not a supported Facebook video or profile HTTPS URL.`); }
      inputs.set(source.url, source);
    });
    fs.mkdirSync(this.folder, { recursive: true });
    this.parallel = parallel;
    this.tasks = []; this.sources = []; this.seen.clear();
    for (const source of inputs.values()) {
      if (source.type === 'video') this.addTask(source.url, quality);
      else this.sources.push({ ...source, state: 'queued', count: 0, message: '' });
    }
    if (this.sources.length) {
      this.preparing = true;
      this.discoveryController = new AbortController();
      this.preparation = this.prepare(quality, this.discoveryController.signal).finally(() => {
        this.preparing = false;
        this.pump();
      });
    } else this.pump();
    return this.status();
  }
  addTask(url, quality) {
    const canonical = classifyFacebookUrl(url);
    if (canonical.type !== 'video') throw new Error('Discovery returned an invalid Reel link.');
    if (this.seen.has(canonical.url)) return;
    this.seen.add(canonical.url);
    this.tasks.push({ id: randomUUID(), number: this.tasks.length + 1, url: canonical.url, quality, state: 'queued', received: 0, total: null, progress: null, file: '', error: '' });
  }
  async prepare(quality, signal) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(PROFILE_FETCH_CONCURRENCY, this.sources.length) }, async () => {
      while (next < this.sources.length) {
        const source = this.sources[next++];
        if (signal.aborted) { source.state = 'cancelled'; continue; }
        source.state = 'extracting';
        try {
          if (!this.collect) throw new Error('Profile discovery is available in the desktop app.');
          const result = await this.collect(source, signal, update => Object.assign(source, update));
          signal.throwIfAborted();
          for (const url of result.urls) this.addTask(url, quality);
          source.count = result.urls.length;
          source.state = result.complete ? 'completed' : 'partial';
          source.message = result.message || (result.urls.length ? 'Reel links collected' : 'No Reels found on this profile');
        } catch (error) {
          source.state = signal.aborted ? 'cancelled' : 'failed';
          source.message = signal.aborted ? '' : error.message;
        }
      }
    }));
  }
  pump() {
    if (this.preparing) return;
    while (this.active < this.parallel) {
      const task = this.tasks.find(t => t.state === 'queued');
      if (!task) break;
      task.state = 'resolving';
      this.active++;
      const controller = new AbortController();
      this.controllers.set(task.id, controller);
      const work = this.run(task, controller.signal).finally(() => {
        this.active--;
        this.controllers.delete(task.id);
        this.work.delete(work);
        this.pump();
      });
      this.work.add(work);
    }
  }
  async run(task, signal) {
    let partial;
    try {
      const url = await this.resolve(task.url, task.quality, signal, state => { task.state = state; });
      signal.throwIfAborted();
      task.state = 'downloading';
      let current = this.validateMedia(url), response;
      const transferSignal = AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]);
      for (let redirects = 0; redirects <= 5; redirects++) {
        response = await this.fetchMedia(current, { redirect: 'manual', signal: transferSignal });
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 5) throw new Error('Invalid video redirect.');
        current = this.validateMedia(new URL(location, current).href);
      }
      if (!response.ok || !response.body) throw new Error(`Video server returned HTTP ${response.status}. Retry to fetch a fresh link.`);
      const type = response.headers.get('content-type') || '';
      if (!/^(video\/|application\/octet-stream)/i.test(type)) {
        await response.body.cancel();
        throw new Error('The server returned a page instead of a video.');
      }
      const total = Number(response.headers.get('content-length'));
      task.total = Number.isSafeInteger(total) && total > 0 ? total : null;
      const filename = `facebook-${Date.now()}-${task.id.slice(0, 8)}-${task.quality}.mp4`;
      const destination = path.join(this.folder, filename);
      partial = destination + '.part';
      const meter = new Transform({ transform(chunk, encoding, callback) {
        task.received += chunk.length;
        task.progress = task.total ? Math.min(99, Math.floor(task.received / task.total * 100)) : null;
        callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(partial, { flags: 'wx' }), { signal: transferSignal });
      signal.throwIfAborted();
      if (!task.received || (task.total && task.received !== task.total)) throw new Error('Incomplete video received. Retry the download.');
      await fs.promises.rename(partial, destination);
      task.file = destination;
      task.progress = 100;
      task.state = 'completed';
    } catch (error) {
      task.state = signal.aborted ? 'cancelled' : 'failed';
      task.error = signal.aborted ? '' : error.message;
    } finally {
      if (partial) await fs.promises.rm(partial, { force: true }).catch(() => {});
    }
  }
  cancel(id) {
    if (!id) this.discoveryController?.abort();
    for (const t of this.tasks) {
      if (id && t.id !== id) continue;
      if (t.state === 'queued') t.state = 'cancelled';
      this.controllers.get(t.id)?.abort();
    }
    return this.status();
  }
  async close() { this.cancel(); await this.preparation; await Promise.allSettled([...this.work]); }
}

module.exports = { DownloadQueue, facebookUrl, mediaUrl, chooseQuality };
