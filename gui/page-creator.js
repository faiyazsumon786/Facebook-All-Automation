(() => {
  let isInitialized = false;
  let activeJobId = null;
  let pollTimer = null;
  let cachedProfiles = [];
  let filterText = '';

  function $(id) {
    return document.getElementById(id);
  }

  function initPageCreator() {
    renderProfilesList();
    if (isInitialized) return;
    isInitialized = true;

    // Category selection change
    $('pc-category-select')?.addEventListener('change', (e) => {
      const isCustom = e.target.value === 'custom';
      const customInput = $('pc-category-custom');
      if (customInput) {
        customInput.classList.toggle('hidden', !isCustom);
        if (isCustom) customInput.focus();
      }
    });

    // Profile Search
    $('pc-profile-search')?.addEventListener('input', (e) => {
      filterText = (e.target.value || '').trim().toLowerCase();
      renderFilteredProfiles();
    });

    // Profile Select All / Deselect All / Logged-in only
    $('pc-select-all')?.addEventListener('click', () => {
      document.querySelectorAll('.pc-profile-cb').forEach(cb => cb.checked = true);
      updateSelectedCount();
    });

    $('pc-clear-all')?.addEventListener('click', () => {
      document.querySelectorAll('.pc-profile-cb').forEach(cb => cb.checked = false);
      updateSelectedCount();
    });

    $('pc-select-alive')?.addEventListener('click', () => {
      document.querySelectorAll('.pc-profile-cb').forEach(cb => {
        const isLogged = cb.dataset.logged === 'true';
        cb.checked = isLogged;
      });
      updateSelectedCount();
    });

    // Mode change description helper
    $('pc-execution-mode')?.addEventListener('change', (e) => {
      const descEl = $('pc-mode-desc');
      if (!descEl) return;
      const mode = e.target.value;
      if (mode === 'failover') {
        descEl.textContent = 'প্রথমে ১ম প্রোফাইলে ট্রাই করবে। ফেসবুক লিমিট বা ব্লক দিলে স্বয়ংক্রিয়ভাবে পরবর্তী প্রোফাইলে ট্রাই করবে।';
      } else if (mode === 'round_robin') {
        descEl.textContent = 'সিলেক্ট করা প্রোফাইলগুলোর মধ্যে ঘুরিয়ে ফিরিয়ে প্রতি প্রোফাইলে ১টি করে পেজ তৈরি করবে।';
      } else if (mode === 'single_first') {
        descEl.textContent = 'শুধুমাত্র প্রথম সিলেক্টেড প্রোফাইলে সবগুলো পেজ বানানোর চেষ্টা করবে।';
      }
    });

    // Start Batch Creation
    $('btn-start-page-creator')?.addEventListener('click', startPageCreation);

    // Cancel Batch Creation
    $('btn-cancel-page-creator')?.addEventListener('click', cancelPageCreation);
  }

  async function renderProfilesList() {
    const listEl = $('pc-profile-list');
    if (!listEl) return;

    let profiles = window.state?.profiles;
    if (!profiles || !profiles.length) {
      try {
        const res = await (window.api ? window.api.get('/profiles') : fetch('/api/profiles').then(r => r.json()));
        if (res && Array.isArray(res.list)) {
          profiles = res.list;
          if (window.state) window.state.profiles = profiles;
        }
      } catch (err) {
        console.warn('Could not fetch profiles for Page Creator:', err);
      }
    }

    cachedProfiles = Array.isArray(profiles) ? profiles : [];
    renderFilteredProfiles();
  }

  function renderFilteredProfiles() {
    const listEl = $('pc-profile-list');
    if (!listEl) return;

    const filtered = cachedProfiles.filter(p => {
      if (!filterText) return true;
      const n = (p.name || '').toLowerCase();
      const u = String(p.uid || '').toLowerCase();
      return n.includes(filterText) || u.includes(filterText);
    });

    if (!filtered.length) {
      listEl.innerHTML = `<p class="muted" style="padding:10px;text-align:center;font-size:12px;">${cachedProfiles.length === 0 ? 'No profiles found. Create or import profiles first.' : 'No profiles matching search.'}</p>`;
      updateSelectedCount();
      return;
    }

    listEl.innerHTML = filtered.map(p => {
      const isAlive = p.uidCheck?.state === 'alive';
      const isRunning = p.running;
      const isLogged = p.composerLogin?.state === 'logged_in';
      const isGood = isLogged || isAlive || isRunning;

      let badge = '<span class="pill" style="font-size:10px;background:rgba(100,116,139,0.2);color:#94a3b8;">ready</span>';
      if (isRunning) {
        badge = '<span class="pill running" style="font-size:10px;">running</span>';
      } else if (isLogged) {
        badge = '<span class="pill" style="font-size:10px;background:rgba(34,197,94,0.15);color:#4ade80;">logged in</span>';
      } else if (isAlive) {
        badge = '<span class="pill" style="font-size:10px;background:rgba(34,197,94,0.15);color:#4ade80;">alive</span>';
      } else if (p.composerLogin?.state === 'logged_out') {
        badge = '<span class="pill" style="font-size:10px;background:rgba(239,68,68,0.15);color:#f87171;">logged out</span>';
      }

      return `
        <label class="pc-profile-item" style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--line);cursor:pointer;">
          <div style="display:flex;align-items:center;gap:10px;overflow:hidden;">
            <input type="checkbox" class="modern-check pc-profile-cb" value="${p.name}" data-logged="${isGood}" ${isGood ? 'checked' : ''} onchange="window.updatePageCreatorCount?.()">
            <div style="display:flex;flex-direction:column;line-height:1.2;">
              <span style="font-weight:600;font-size:13px;color:var(--fg);">${p.name}</span>
              <span class="muted" style="font-size:11px;">UID: ${p.uid || 'N/A'}</span>
            </div>
          </div>
          <div>
            ${badge}
          </div>
        </label>
      `;
    }).join('');

    updateSelectedCount();
  }

  function updateSelectedCount() {
    const checked = document.querySelectorAll('.pc-profile-cb:checked').length;
    const total = document.querySelectorAll('.pc-profile-cb').length;
    const counter = $('pc-selected-count');
    if (counter) counter.textContent = `${checked} of ${total} selected`;
  }
  window.updatePageCreatorCount = updateSelectedCount;

  function appendLog(msg) {
    const logBox = $('pc-live-logs');
    if (!logBox) return;
    const entry = document.createElement('div');
    entry.textContent = msg;
    entry.style.marginBottom = '3px';
    if (msg.includes('Successfully created') || msg.includes('confirmed') || msg.includes('Batch completed')) {
      entry.style.color = '#4ade80';
    } else if (msg.includes('Failed') || msg.includes('Fatal') || msg.includes('error') || msg.includes('Rate-Limit')) {
      entry.style.color = '#f87171';
    } else if (msg.includes('Waiting') || msg.includes('Switching') || msg.includes('Retrying') || msg.includes('failover')) {
      entry.style.color = '#fbbf24';
    }
    logBox.appendChild(entry);
    logBox.scrollTop = logBox.scrollHeight;
  }

  async function startPageCreation() {
    const rawNames = $('pc-page-names')?.value || '';
    const pageNames = rawNames.split('\n').map(s => s.trim()).filter(Boolean);

    if (!pageNames.length) {
      if (window.toast) window.toast('Please enter at least one Page Name.', true);
      $('pc-page-names')?.focus();
      return;
    }

    const selectedProfiles = Array.from(document.querySelectorAll('.pc-profile-cb:checked')).map(cb => cb.value);
    if (!selectedProfiles.length) {
      if (window.toast) window.toast('Please select at least one Facebook profile.', true);
      return;
    }

    const catSelect = $('pc-category-select')?.value || 'Digital creator';
    const category = catSelect === 'custom' ? ($('pc-category-custom')?.value.trim() || 'Digital creator') : catSelect;
    const bio = $('pc-bio')?.value.trim() || '';
    const delaySec = Number($('pc-delay')?.value) || 20;

    const mode = $('pc-execution-mode')?.value || 'failover';
    const maxPerProfile = Number($('pc-max-per-profile')?.value) || 1;
    const autoRetryNext = $('pc-auto-retry-next')?.checked !== false;

    // UI state loading
    $('btn-start-page-creator').disabled = true;
    $('btn-start-page-creator').textContent = 'Creating Pages...';
    $('btn-cancel-page-creator')?.classList.remove('hidden');
    $('pc-live-logs').innerHTML = '';
    appendLog(`[System] Initializing page creation for ${pageNames.length} pages across ${selectedProfiles.length} profiles...`);
    appendLog(`[Strategy] Mode: ${mode} · Max/Profile: ${maxPerProfile} · Auto-Failover: ${autoRetryNext ? 'Enabled' : 'Disabled'}`);

    try {
      const payload = {
        profiles: selectedProfiles,
        pageNames,
        category,
        bio,
        delaySec,
        mode,
        maxPerProfile,
        autoRetryNext
      };

      const res = window.api ? await window.api.post('/pages/create', payload) : await fetch('/api/pages/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(r => r.json());

      if (!res.ok || !res.jobId) {
        throw new Error(res.error || 'Failed to start page creation job.');
      }

      activeJobId = res.jobId;
      if (window.toast) window.toast('Page creation job started!');
      startPolling(activeJobId);
    } catch (err) {
      $('btn-start-page-creator').disabled = false;
      $('btn-start-page-creator').textContent = '⚡ Start Creating Pages';
      $('btn-cancel-page-creator')?.classList.add('hidden');
      if (window.toast) window.toast(err.message, true);
      appendLog(`[Error] ${err.message}`);
    }
  }

  function startPolling(jobId) {
    if (pollTimer) clearInterval(pollTimer);

    pollTimer = setInterval(async () => {
      try {
        const res = window.api ? await window.api.get(`/pages/create/status?id=${encodeURIComponent(jobId)}`) : await fetch(`/api/pages/create/status?id=${encodeURIComponent(jobId)}`).then(r => r.json());
        if (!res.ok || !res.job) return;

        const job = res.job;
        const progressEl = $('pc-progress-fill');
        const progressText = $('pc-progress-text');

        if (progressEl && job.total > 0) {
          const pct = Math.min(100, Math.round((job.current / job.total) * 100));
          progressEl.style.width = `${pct}%`;
        }
        if (progressText) {
          progressText.textContent = `${job.current} / ${job.total} processed (${job.createdPages.length} created, ${job.failedPages.length} failed)`;
        }

        // Render logs
        const logBox = $('pc-live-logs');
        if (logBox && Array.isArray(job.logs)) {
          logBox.innerHTML = '';
          job.logs.forEach(msg => appendLog(msg));
        }

        // Render success table
        renderCreatedPagesTable(job.createdPages);

        if (['completed', 'cancelled', 'failed'].includes(job.state)) {
          clearInterval(pollTimer);
          pollTimer = null;
          activeJobId = null;
          $('btn-start-page-creator').disabled = false;
          $('btn-start-page-creator').textContent = '⚡ Start Creating Pages';
          $('btn-cancel-page-creator')?.classList.add('hidden');
          if (window.toast) window.toast(`Job finished: ${job.createdPages.length} pages created!`);

          // Refresh profile data in app
          if (window.refreshProfiles) window.refreshProfiles();
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 2500);
  }

  function renderCreatedPagesTable(pages) {
    const container = $('pc-results-list');
    if (!container) return;

    if (!pages || !pages.length) {
      container.innerHTML = '<p class="muted" style="text-align:center;padding:16px;">No pages created yet.</p>';
      return;
    }

    container.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="border-bottom:1px solid var(--line);text-align:left;color:var(--muted);">
            <th style="padding:8px;">Page Name</th>
            <th style="padding:8px;">Category</th>
            <th style="padding:8px;">Profile</th>
            <th style="padding:8px;">Page ID</th>
            <th style="padding:8px;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${pages.map(p => `
            <tr style="border-bottom:1px solid var(--line);">
              <td style="padding:8px;font-weight:600;color:var(--fg);">${p.pageName}</td>
              <td style="padding:8px;color:var(--muted);">${p.category}</td>
              <td style="padding:8px;">${p.profileName}</td>
              <td style="padding:8px;font-family:monospace;color:var(--accent);">${p.pageId}</td>
              <td style="padding:8px;"><span class="pill" style="background:rgba(34,197,94,0.15);color:#4ade80;">Success</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  async function cancelPageCreation() {
    if (!activeJobId) return;
    try {
      if (window.api) {
        await window.api.post('/pages/create/cancel', { id: activeJobId });
      } else {
        await fetch('/api/pages/create/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: activeJobId })
        });
      }
      if (window.toast) window.toast('Cancel request sent.');
      appendLog('[System] Cancelling job...');
    } catch (err) {
      if (window.toast) window.toast('Could not cancel: ' + err.message, true);
    }
  }

  window.initPageCreator = initPageCreator;
  window.renderPageCreatorProfiles = renderProfilesList;
})();
