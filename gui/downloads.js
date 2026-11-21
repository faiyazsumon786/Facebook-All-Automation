(() => {
  const client = window.fsApp?.downloads;
  let snapshot = { tasks: [], active: false }, polling = false;
  const rows = new Map(), sourceRows = new Map();
  const terminal = ['completed', 'failed', 'cancelled'];
  const labels = { queued: 'Queued', waiting: 'Waiting for provider', resolving: 'Fetching video link', verification: 'Complete provider verification', downloading: 'Downloading', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };
  const bytes = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
  const error = e => { $('download-error').textContent = e?.message || ''; };
  function step(value) {
    const n = Math.max(1, Math.min(10, Math.round(Number(value) || 2)));
    $('download-parallel').value = n;
    $('download-less').disabled = snapshot.active || n === 1;
    $('download-more').disabled = snapshot.active || n === 10;
  }
  function render(data) {
    snapshot = data;
    if (data.folder) $('download-folder-path').textContent = data.folder;
    for (const name of ['start', 'folder', 'quality', 'parallel', 'urls']) $('download-' + name).disabled = data.active;
    $('download-cancel').disabled = !data.active;
    step($('download-parallel').value);
    const completed = data.tasks.filter(t => t.state === 'completed').length;
    const failed = data.tasks.filter(t => t.state === 'failed').length;
    const cancelled = data.tasks.filter(t => t.state === 'cancelled').length;
    $('download-summary').textContent = data.tasks.length ? `${completed}/${data.tasks.length} completed${failed ? ` · ${failed} failed` : ''}${cancelled ? ` · ${cancelled} cancelled` : ''}` : 'No downloads yet';
    renderSources(data);
    const queue = $('download-queue');
    if (!data.tasks.length) {
      rows.clear();
      queue.replaceChildren();
      const empty = document.createElement('div'); empty.className = 'download-empty';
      empty.textContent = data.preparing ? 'Collecting profile Reels before starting downloads…' : 'No video links in this queue.';
      queue.append(empty); return;
    }
    queue.querySelector('.download-empty')?.remove();
    const ids = new Set(data.tasks.map(t => t.id));
    for (const [id, row] of rows) if (!ids.has(id)) { row.remove(); rows.delete(id); }
    for (const task of data.tasks) {
      let row = rows.get(task.id);
      if (!row) {
        row = document.createElement('article');
        row.className = 'download-row';
        row.innerHTML = '<div class="download-row-top"><span class="download-number"></span><div class="download-description"><strong></strong><p></p></div><span class="download-quality"></span><button class="btn-ghost download-action"></button></div><div class="download-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><span></span></div><div class="download-row-bottom"><span></span><span></span></div><p class="download-task-error"></p>';
        queue.append(row); rows.set(task.id, row);
      }
      row.dataset.state = task.state;
      row.querySelector('.download-number').textContent = String(task.number).padStart(2, '0');
      row.querySelector('strong').textContent = task.file ? task.file.split(/[\\/]/).pop() : `Facebook video ${task.number}`;
      row.querySelector('.download-description p').textContent = task.url;
      row.querySelector('.download-quality').textContent = task.quality === 'hd' ? 'HD' : 'Normal';
      const bar = row.querySelector('.download-track');
      bar.setAttribute('aria-label', `Video ${task.number}: ${labels[task.state]}`);
      const percent = Number.isFinite(task.progress) ? task.progress : null;
      if (percent !== null) bar.setAttribute('aria-valuenow', percent); else bar.removeAttribute('aria-valuenow');
      bar.classList.toggle('indeterminate', percent === null && !terminal.includes(task.state) && task.state !== 'queued');
      bar.firstElementChild.style.width = `${percent || 0}%`;
      row.querySelector('.download-row-bottom span').textContent = labels[task.state] || task.state;
      row.querySelector('.download-row-bottom span:last-child').textContent = task.received ? `${bytes(task.received)}${task.total ? ` / ${bytes(task.total)}` : ''}${percent !== null ? ` · ${percent}%` : ''}` : '';
      row.querySelector('.download-task-error').textContent = task.error;
      const action = row.querySelector('.download-action');
      action.textContent = task.state === 'completed' ? 'Show file' : task.state === 'verification' ? 'Verify' : terminal.includes(task.state) ? 'Retry' : 'Cancel';
      action.disabled = terminal.includes(task.state) && task.state !== 'completed' && data.active;
      action.onclick = async () => {
        try {
          error();
          if (task.state === 'completed') await client.open(task.id);
          else if (task.state === 'verification') await client.verify();
          else if (terminal.includes(task.state)) { $('download-urls').value = task.url; $('download-quality').value = task.quality; $('download-urls').focus(); }
          else render(await client.cancel(task.id));
        } catch (e) { error(e); }
      };
    }
  }
  function renderSources(data) {
    const sources = data.sources || [];
    $('download-discovery').classList.toggle('hidden', !sources.length);
    $('download-discovery-title').textContent = data.preparing ? 'Collecting Reel links' : 'Profile Reel results';
    $('download-discovery-summary').textContent = `${data.tasks.length} unique video links · ${data.preparing ? 'Collecting' : 'Collection finished'}`;
    const links = data.tasks.map(t => t.url).join('\n');
    if ($('download-collected-links').value !== links) $('download-collected-links').value = links;
    const container = $('download-sources');
    const keys = new Set(sources.map(s => s.url));
    for (const [key,row] of sourceRows) if (!keys.has(key)) { row.remove(); sourceRows.delete(key); }
    for (const source of sources) {
      let row = sourceRows.get(source.url);
      if (!row) {
        row = document.createElement('article'); row.className = 'download-source';
        row.innerHTML = '<div class="download-row-top"><div class="download-description"><strong></strong><p></p></div><span class="download-quality"></span><button class="btn-secondary">Open Facebook</button></div><p class="muted"></p><div class="download-track indeterminate"><span></span></div>';
        row.querySelector('button').onclick = () => client.verify(source.url).catch(error);
        container.append(row); sourceRows.set(source.url,row);
      }
      row.querySelector('strong').textContent = source.id ? `Profile ${source.id}` : source.url;
      row.querySelector('.download-description p').textContent = source.url;
      row.querySelector('.download-quality').textContent = ({queued:'Queued',extracting:'Collecting',verification:'Needs attention',completed:'Collected',partial:'Partial list',failed:'Failed',cancelled:'Cancelled'})[source.state] || source.state;
      row.querySelector('button').classList.toggle('hidden',source.state !== 'verification');
      row.querySelector('p.muted').textContent = `${source.count} Reels found${source.message ? ' · ' + source.message : ''}`;
      row.querySelector('.download-track').classList.toggle('hidden',!['extracting','verification'].includes(source.state));
    }
  }
  async function refresh() {
    if (!client || polling) return;
    polling = true;
    try { render(await client.status()); } catch (e) { error(e); }
    finally { polling = false; }
  }
  $('btn-downloads').onclick = () => {
    showPage('downloads');
    if (!client) { error(new Error('Open the desktop app to download videos.')); $('download-start').disabled = true; }
    else refresh();
  };
  $('download-less').onclick = () => step(Number($('download-parallel').value) - 1);
  $('download-more').onclick = () => step(Number($('download-parallel').value) + 1);
  $('download-parallel').onchange = () => step($('download-parallel').value);
  $('download-start').onclick = async () => {
    if (!client) return;
    error(); $('download-start').disabled = true;
    try {
      render(await client.start({ urls: $('download-urls').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean), quality: $('download-quality').value, parallel: Number($('download-parallel').value) }));
    } catch (e) { error(e); $('download-start').disabled = false; }
  };
  $('download-folder').onclick = async () => { try { if (client) render(await client.folder()); } catch (e) { error(e); } };
  $('download-open').onclick = async () => { try { await client?.open(); } catch (e) { error(e); } };
  $('download-cancel').onclick = async () => { try { if (client) render(await client.cancel()); } catch (e) { error(e); } };
  setInterval(() => { if (page === 'downloads') refresh(); }, 700);
  step(2);
})();
