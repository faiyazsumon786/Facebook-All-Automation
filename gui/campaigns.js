(() => {
  let campaignsCache = [];

  function formatTimeDiff(ms) {
    if (ms <= 0) return 'Due now';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `in ${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `in ${hours}h ${remMins}m`;
  }

  function formatInterval(hours) {
    if (hours < 1) return `Every ${Math.round(hours * 60)} minutes`;
    if (hours === 1) return 'Every 1 hour';
    return `Every ${hours} hours`;
  }

  async function loadCampaigns() {
    const feedback = $('campaigns-feedback');
    const list = $('campaigns-list');
    if (!feedback || !list) return;

    feedback.classList.remove('hidden');
    feedback.textContent = 'Loading campaigns…';

    try {
      const data = await api.get('/campaigns');
      campaignsCache = Array.isArray(data) ? data : (data.campaigns || []);
      feedback.classList.add('hidden');
      updateMetrics();
      renderCampaigns();
      populateTargetProfiles();
    } catch (err) {
      feedback.classList.remove('hidden');
      feedback.textContent = 'Failed to load campaigns: ' + err.message;
    }
  }

  function updateMetrics() {
    const total = campaignsCache.length;
    const active = campaignsCache.filter(c => c.active && c.status !== 'completed').length;
    let posted = 0;
    let remaining = 0;

    for (const c of campaignsCache) {
      posted += (c.postedCount || 0);
      remaining += (c.remainingCount || 0);
    }

    if ($('camp-total-count')) $('camp-total-count').textContent = total;
    if ($('camp-active-count')) $('camp-active-count').textContent = active;
    if ($('camp-posted-count')) $('camp-posted-count').textContent = posted;
    if ($('camp-remaining-count')) $('camp-remaining-count').textContent = remaining;
  }

  function renderCampaigns() {
    const list = $('campaigns-list');
    if (!list) return;

    const query = ($('campaign-search')?.value || '').toLowerCase().trim();
    const filter = $('campaign-filter')?.value || 'all';

    const filtered = campaignsCache.filter(c => {
      if (filter === 'active' && (!c.active || c.status === 'completed')) return false;
      if (filter === 'paused' && (c.active || c.status === 'completed')) return false;
      if (filter === 'completed' && c.status !== 'completed') return false;

      if (!query) return true;
      const name = (c.name || '').toLowerCase();
      const folder = (c.folder || '').toLowerCase();
      return name.includes(query) || folder.includes(query);
    });

    if (!filtered.length) {
      list.innerHTML = `
        <div class="h-empty">
          <p>No campaigns found.</p>
          <button id="btn-empty-new-camp" class="btn-primary" style="margin-top:10px;">+ Create First Auto-Pilot Campaign</button>
        </div>
      `;
      const btn = $('btn-empty-new-camp');
      if (btn) btn.onclick = openNewCampaign;
      return;
    }

    list.innerHTML = filtered.map(c => {
      const statusClass = c.status || (c.active ? 'active' : 'paused');
      const statusLabel = c.status === 'completed' ? 'Completed' : (c.active ? 'Active' : 'Paused');
      const nextRunStr = c.active && c.nextRunAt
        ? (c.nextRunAt > Date.now() ? formatTimeDiff(c.nextRunAt - Date.now()) : 'Overdue / Running')
        : 'Paused';

      const targetStr = Array.isArray(c.profiles) && c.profiles.length
        ? `${c.profiles.length} profiles`
        : 'All profiles';

      return `
        <article class="camp-card" data-id="${c.id}">
          <header class="camp-head">
            <div class="camp-title-row">
              <strong class="camp-name">${escapeHtml(c.name || 'Auto-Pilot Campaign')}</strong>
              <span class="camp-badge ${statusClass}">${statusLabel}</span>
              ${c.antiCopyright !== false ? '<span class="camp-badge shield">🛡️ Anti-Copyright</span>' : ''}
              ${c.humanize !== false ? '<span class="camp-badge mask">🎭 Humanizer</span>' : ''}
            </div>
            <div class="camp-actions">
              <button class="btn-secondary btn-camp-run" data-id="${c.id}" title="Trigger upload now">▶ Run Now</button>
              <button class="btn-ghost btn-camp-toggle" data-id="${c.id}" data-active="${c.active ? 'false' : 'true'}">
                ${c.active ? '⏸ Pause' : '▶ Resume'}
              </button>
              <button class="btn-ghost btn-camp-edit" data-id="${c.id}">Edit</button>
              <button class="btn-danger btn-camp-del" data-id="${c.id}">Delete</button>
            </div>
          </header>

          <div class="camp-grid">
            <div class="camp-field">
              <span class="camp-field-label">Watch Folder</span>
              <span class="camp-field-val" title="${escapeHtml(c.folder || 'None')}">${escapeHtml(c.folder || 'None')}</span>
            </div>
            <div class="camp-field">
              <span class="camp-field-label">Videos Queue</span>
              <span class="camp-field-val">
                <strong>${c.remainingCount || 0}</strong> left / ${c.totalVideos || 0} total
                <small class="muted">(${c.postedCount || 0} posted)</small>
              </span>
            </div>
            <div class="camp-field">
              <span class="camp-field-label">Schedule</span>
              <span class="camp-field-val">${formatInterval(c.intervalHours || 2)}</span>
            </div>
            <div class="camp-field">
              <span class="camp-field-label">Next Scheduled Run</span>
              <span class="camp-field-val" style="color:var(--accent); font-weight:600;">${nextRunStr}</span>
            </div>
            <div class="camp-field">
              <span class="camp-field-label">Target Profiles</span>
              <span class="camp-field-val">${targetStr}</span>
            </div>
            <div class="camp-field">
              <span class="camp-field-label">Batch Size / Limit</span>
              <span class="camp-field-val">${c.videosPerRun || 1} video(s) · ${c.parallel || 1} parallel</span>
            </div>
          </div>

          ${c.firstComment ? `
            <div class="camp-comment-box">
              <strong style="color:var(--accent);">💬 First Comment / Pin:</strong>
              <span>${escapeHtml(c.firstComment)}</span>
            </div>
          ` : ''}

          ${c.title || c.description ? `
            <div style="font-size:12px;color:var(--muted);display:flex;gap:16px;flex-wrap:wrap;">
              ${c.title ? `<div><strong>Title:</strong> ${escapeHtml(c.title)}</div>` : ''}
              ${c.description ? `<div><strong>Desc:</strong> ${escapeHtml(c.description)}</div>` : ''}
            </div>
          ` : ''}
        </article>
      `;
    }).join('');

    // Attach card event listeners
    list.querySelectorAll('.btn-camp-run').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.id;
        btn.disabled = true;
        btn.textContent = 'Starting…';
        try {
          const res = await api.post('/campaigns/run', { id });
          toast(`Campaign triggered: Job #${res.jobId || 'started'}`);
          await loadCampaigns();
          showPage('dashboard');
        } catch (e) {
          toast('Failed to run campaign: ' + e.message, true);
          btn.disabled = false;
          btn.textContent = '▶ Run Now';
        }
      };
    });

    list.querySelectorAll('.btn-camp-toggle').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.id;
        const active = btn.dataset.active === 'true';
        btn.disabled = true;
        try {
          await api.post('/campaigns/toggle', { id, active });
          toast(active ? 'Campaign activated' : 'Campaign paused');
          await loadCampaigns();
        } catch (e) {
          toast('Failed: ' + e.message, true);
        } finally {
          btn.disabled = false;
        }
      };
    });

    list.querySelectorAll('.btn-camp-edit').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        const camp = campaignsCache.find(c => c.id === id);
        if (camp) openEditCampaign(camp);
      };
    });

    list.querySelectorAll('.btn-camp-del').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.id;
        if (!confirm('Are you sure you want to delete this Auto-Pilot Campaign?')) return;
        btn.disabled = true;
        try {
          await api.post('/campaigns/delete', { id });
          toast('Campaign deleted');
          await loadCampaigns();
        } catch (e) {
          toast('Failed to delete campaign: ' + e.message, true);
        }
      };
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function openNewCampaign() {
    $('c-camp-id').value = '';
    $('campaign-modal-title').textContent = 'New Auto-Pilot Campaign';
    $('c-camp-name').value = '';
    $('c-camp-folder').value = '';
    $('c-camp-folder-info').textContent = 'Select a local folder with .mp4 or .mov video files.';
    $('c-camp-title').value = '';
    $('c-camp-desc').value = '';
    $('c-camp-comment').value = '';
    $('c-camp-interval').value = '2';
    $('c-camp-videos-per-run').value = '1';
    $('c-camp-parallel').value = '1';
    $('c-camp-active').checked = true;
    $('c-camp-loop').checked = false;
    if ($('c-camp-anti-copyright')) $('c-camp-anti-copyright').checked = true;
    if ($('c-camp-humanize')) $('c-camp-humanize').checked = true;
    populateTargetProfiles('all');
    showPage('campaignModal');
  }

  function openEditCampaign(c) {
    $('c-camp-id').value = c.id;
    $('campaign-modal-title').textContent = 'Edit Auto-Pilot Campaign';
    $('c-camp-name').value = c.name || '';
    $('c-camp-folder').value = c.folder || '';
    $('c-camp-folder-info').textContent = `${c.remainingCount || 0} unposted videos remaining (${c.totalVideos || 0} total).`;
    $('c-camp-title').value = c.title || '';
    $('c-camp-desc').value = c.description || '';
    $('c-camp-comment').value = c.firstComment || '';
    $('c-camp-interval').value = String(c.intervalHours || 2);
    $('c-camp-videos-per-run').value = String(c.videosPerRun || 1);
    $('c-camp-parallel').value = String(c.parallel || 1);
    $('c-camp-active').checked = c.active !== false;
    $('c-camp-loop').checked = Boolean(c.loopFolder);
    if ($('c-camp-anti-copyright')) $('c-camp-anti-copyright').checked = c.antiCopyright !== false;
    if ($('c-camp-humanize')) $('c-camp-humanize').checked = c.humanize !== false;
    populateTargetProfiles(c.profiles);
    showPage('campaignModal');
  }

  function populateTargetProfiles(selectedProfiles) {
    const sel = $('c-camp-target');
    if (!sel) return;
    const profiles = (state && state.profiles) ? state.profiles : [];
    
    let html = `<option value="all">All Connected Profiles (${profiles.length})</option>`;
    for (const p of profiles) {
      const isSel = Array.isArray(selectedProfiles) && selectedProfiles.includes(p.name);
      html += `<option value="${p.name}" ${isSel ? 'selected' : ''}>${escapeHtml(p.name)} (${p.uid || 'No UID'})</option>`;
    }
    sel.innerHTML = html;

    if (selectedProfiles === 'all' || !selectedProfiles) {
      sel.value = 'all';
    }
  }

  async function saveCampaign() {
    const name = $('c-camp-name').value.trim();
    const folder = $('c-camp-folder').value.trim();

    if (!folder) {
      toast('Please choose or enter a video folder', true);
      $('c-camp-folder').focus();
      return;
    }

    const id = $('c-camp-id').value || undefined;
    const title = $('c-camp-title').value.trim();
    const description = $('c-camp-desc').value.trim();
    const firstComment = $('c-camp-comment').value.trim();
    const intervalHours = parseFloat($('c-camp-interval').value) || 2;
    const videosPerRun = parseInt($('c-camp-videos-per-run').value, 10) || 1;
    const parallel = parseInt($('c-camp-parallel').value, 10) || 1;
    const active = $('c-camp-active').checked;
    const loopFolder = $('c-camp-loop').checked;
    const antiCopyright = $('c-camp-anti-copyright') ? $('c-camp-anti-copyright').checked : true;
    const humanize = $('c-camp-humanize') ? $('c-camp-humanize').checked : true;

    const targetVal = $('c-camp-target').value;
    const profiles = targetVal === 'all' ? 'all' : [targetVal];

    const btnSave = $('c-camp-save');
    btnSave.disabled = true;
    btnSave.textContent = 'Saving…';

    try {
      await api.post('/campaigns', {
        id,
        name: name || 'Auto-Pilot Campaign',
        folder,
        title,
        description,
        firstComment,
        intervalHours,
        videosPerRun,
        parallel,
        profiles,
        active,
        loopFolder,
        antiCopyright,
        humanize
      });

      toast('Campaign saved successfully!');
      showPage('campaigns');
      await loadCampaigns();
    } catch (e) {
      toast('Failed to save campaign: ' + e.message, true);
    } finally {
      btnSave.disabled = false;
      btnSave.textContent = 'Save Campaign';
    }
  }

  // Initialize event bindings
  function init() {
    $('btn-refresh-campaigns')?.addEventListener('click', loadCampaigns);
    $('btn-new-campaign')?.addEventListener('click', openNewCampaign);
    $('c-camp-cancel')?.addEventListener('click', () => showPage('campaigns'));
    $('c-camp-save')?.addEventListener('click', saveCampaign);

    $('campaign-search')?.addEventListener('input', renderCampaigns);
    $('campaign-filter')?.addEventListener('change', renderCampaigns);

    $('btn-browse-folder')?.addEventListener('click', async () => {
      if (window.fsApp?.pickFolder) {
        const folder = await window.fsApp.pickFolder();
        if (folder) {
          $('c-camp-folder').value = folder;
          try {
            const scan = await api.post('/campaigns/scan-folder', { folder });
            $('c-camp-folder-info').textContent = `Found ${scan.count || 0} video(s) in this folder.`;
          } catch {
            $('c-camp-folder-info').textContent = 'Folder selected.';
          }
        }
      } else {
        toast('Folder picker not supported in browser mode. Enter folder path manually.', true);
      }
    });

    $('c-camp-folder')?.addEventListener('change', async (e) => {
      const folder = e.target.value.trim();
      if (!folder) return;
      try {
        const scan = await api.post('/campaigns/scan-folder', { folder });
        $('c-camp-folder-info').textContent = `Found ${scan.count || 0} video(s) in this folder.`;
      } catch {
        $('c-camp-folder-info').textContent = 'Folder path updated.';
      }
    });
  }

  window.loadCampaigns = loadCampaigns;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
