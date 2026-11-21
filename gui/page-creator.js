(() => {
  let isInitialized = false;
  let activeJobId = null;
  let pollTimer = null;

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

    // Profile Select All / Deselect All
    $('pc-select-all')?.addEventListener('click', () => {
      document.querySelectorAll('.pc-profile-cb').forEach(cb => cb.checked = true);
      updateSelectedCount();
    });

    $('pc-clear-all')?.addEventListener('click', () => {
      document.querySelectorAll('.pc-profile-cb').forEach(cb => cb.checked = false);
      updateSelectedCount();
    });

    // Start Batch Creation
    $('btn-start-page-creator')?.addEventListener('click', startPageCreation);

    // Cancel Batch Creation
    $('btn-cancel-page-creator')?.addEventListener('click', cancelPageCreation);
  }

  function renderProfilesList() {
    const listEl = $('pc-profile-list');
    if (!listEl) return;

    const profiles = window.state?.profiles || [];
    if (!profiles.length) {
      listEl.innerHTML = '<p class="muted" style="padding:10px;">No profiles available. Create or import profiles first.</p>';
      return;
    }

    listEl.innerHTML = profiles.map(p => {
      const isAlive = p.uidCheck?.state === 'alive';
      const isRunning = p.running;
      return `
        <label class="pc-profile-item" style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--line);cursor:pointer;">
          <div style="display:flex;align-items:center;gap:10px;">
            <input type="checkbox" class="modern-check pc-profile-cb" value="${p.name}" ${isRunning || isAlive ? 'checked' : ''} onchange="window.updatePageCreatorCount?.()">
            <span style="font-weight:500;">${p.name}</span>
            <span class="muted" style="font-size:12px;">UID: ${p.uid || 'N/A'}</span>
          </div>
          <div>
            ${isRunning ? '<span class="pill running" style="font-size:11px;">running</span>' : '<span class="pill stopped" style="font-size:11px;">stopped</span>'}
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
    if (msg.includes('Successfully created') || msg.includes('confirmed')) {
      entry.style.color = '#4ade80';
    } else if (msg.includes('Failed') || msg.includes('Fatal') || msg.includes('error')) {
      entry.style.color = '#f87171';
    } else if (msg.includes('Waiting')) {
      entry.style.color = '#fbbf24';
    }
    logBox.appendChild(entry);
    logBox.scrollTop = logBox.scrollHeight;
  }

  async function startPageCreation() {
    const rawNames = $('pc-page-names')?.value || '';
    const pageNames = rawNames.split('\n').map(s => s.trim()).filter(Boolean);

    if (!pageNames.length) {
      window.toast?.('Please enter at least one Page Name.', true);
      $('pc-page-names')?.focus();
      return;
    }

    const selectedProfiles = Array.from(document.querySelectorAll('.pc-profile-cb:checked')).map(cb => cb.value);
    if (!selectedProfiles.length) {
      window.toast?.('Please select at least one Facebook profile.', true);
      return;
    }

    const catSelect = $('pc-category-select')?.value || 'Digital creator';
    const category = catSelect === 'custom' ? ($('pc-category-custom')?.value.trim() || 'Digital creator') : catSelect;
    const bio = $('pc-bio')?.value.trim() || '';
    const delaySec = Number($('pc-delay')?.value) || 20;

    // UI state loading
    $('btn-start-page-creator').disabled = true;
    $('btn-start-page-creator').textContent = 'Creating Pages...';
    $('btn-cancel-page-creator')?.classList.remove('hidden');
    $('pc-live-logs').innerHTML = '';
    appendLog(`[System] Initializing page creation job for ${pageNames.length} pages...`);

    try {
      const res = await window.api.post('/pages/create', {
        profiles: selectedProfiles,
        pageNames,
        category,
        bio,
        delaySec
      });

      if (!res.ok || !res.jobId) {
        throw new Error(res.error || 'Failed to start page creation job.');
      }

      activeJobId = res.jobId;
      window.toast?.('Page creation job started!');
      startPolling(activeJobId);
    } catch (err) {
      $('btn-start-page-creator').disabled = false;
      $('btn-start-page-creator').textContent = '⚡ Start Creating Pages';
      $('btn-cancel-page-creator')?.classList.add('hidden');
      window.toast?.(err.message, true);
      appendLog(`[Error] ${err.message}`);
    }
  }

  function startPolling(jobId) {
    if (pollTimer) clearInterval(pollTimer);

    pollTimer = setInterval(async () => {
      try {
        const res = await window.api.get(`/pages/create/status?id=${encodeURIComponent(jobId)}`);
        if (!res.ok || !res.job) return;

        const job = res.job;
        const progressEl = $('pc-progress-fill');
        const progressText = $('pc-progress-text');

        if (progressEl && job.total > 0) {
          const pct = Math.round((job.current / job.total) * 100);
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
          window.toast?.(`Job finished: ${job.createdPages.length} pages created!`);

          // Refresh profile data in app
          if (window.loadProfiles) window.loadProfiles();
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
      await window.api.post('/pages/create/cancel', { id: activeJobId });
      window.toast?.('Cancel request sent.');
      appendLog('[System] Cancelling job...');
    } catch (err) {
      window.toast?.('Could not cancel: ' + err.message, true);
    }
  }

  window.initPageCreator = initPageCreator;
})();
