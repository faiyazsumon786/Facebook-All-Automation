(() => {
  const $ = id => document.getElementById(id);
  const escapeHtml = str => String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  let historyData = [];
  let currentSearch = '';
  let currentFilter = 'all';

  function formatTime(timestamp) {
    if (!timestamp) return 'Unknown time';
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return 'Unknown time';
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function getBatchSummary(batch) {
    const totalProfiles = (batch.tasks || []).length;
    let totalPages = 0;
    let publishedPages = 0;
    let failedPages = 0;
    let skippedPages = 0;

    for (const task of (batch.tasks || [])) {
      const pages = task.pages || [];
      totalPages += pages.length;
      for (const page of pages) {
        if (page.state === 'published' || page.state === 'accepted' || (page.status === 'ok' && !page.error && task.state === 'accepted')) {
          publishedPages++;
        } else if (page.state === 'failed' || page.error) {
          failedPages++;
        } else if (page.state === 'skipped') {
          skippedPages++;
        } else if (task.state === 'accepted' || task.state === 'ready') {
          if (page.status === 'ok') publishedPages++;
          else failedPages++;
        }
      }
    }

    let status = 'all_published';
    if (totalPages === 0) {
      status = (batch.state === 'needs_review' || (batch.tasks || []).some(t => t.error)) ? 'issues' : 'partial';
    } else if (publishedPages === totalPages) {
      status = 'all_published';
    } else if (publishedPages > 0) {
      status = 'partial';
    } else {
      status = 'issues';
    }

    return { totalProfiles, totalPages, publishedPages, failedPages, skippedPages, status };
  }

  function updateMetrics(list) {
    const totalBatches = list.length;
    let totalProfiles = 0;
    let totalVideos = 0;
    let totalPagesPublished = 0;

    for (const batch of list) {
      const vCount = (batch.videoPaths || []).length;
      const tasks = batch.tasks || [];
      totalProfiles += tasks.length;
      for (const task of tasks) {
        for (const page of (task.pages || [])) {
          if (page.state === 'published' || page.state === 'accepted' || (page.status === 'ok' && !page.error && task.state === 'accepted')) {
            totalPagesPublished++;
            totalVideos += vCount;
          }
        }
      }
    }

    if ($('h-total-batches')) $('h-total-batches').textContent = totalBatches;
    if ($('h-total-profiles')) $('h-total-profiles').textContent = totalProfiles;
    if ($('h-total-videos')) $('h-total-videos').textContent = totalVideos;
    if ($('h-total-pages')) $('h-total-pages').textContent = totalPagesPublished;
  }

  function filterList() {
    return historyData.filter(batch => {
      const summary = getBatchSummary(batch);
      if (currentFilter !== 'all' && summary.status !== currentFilter) return false;

      if (!currentSearch) return true;
      const q = currentSearch.toLowerCase();
      if ((batch.id || '').toLowerCase().includes(q)) return true;
      if (formatTime(batch.createdAt).toLowerCase().includes(q)) return true;

      for (const task of (batch.tasks || [])) {
        if ((task.name || '').toLowerCase().includes(q)) return true;
        for (const page of (task.pages || [])) {
          if ((page.name || '').toLowerCase().includes(q)) return true;
          if ((page.pageId || '').toLowerCase().includes(q)) return true;
        }
      }
      return false;
    });
  }

  function renderHistory() {
    const listEl = $('history-list');
    const feedbackEl = $('history-feedback');
    if (!listEl) return;
    const filtered = filterList();

    if (!historyData.length) {
      if (feedbackEl) feedbackEl.textContent = '';
      listEl.innerHTML = `
        <div class="h-empty">
          <svg class="icon" style="width:48px;height:48px;margin-bottom:12px;opacity:0.4"><use href="#icon-history"/></svg>
          <h3 style="margin:0 0 6px;">No upload history yet</h3>
          <p class="muted" style="margin:0;">Completed upload sessions will automatically appear here with full account, profile, and page details.</p>
        </div>
      `;
      return;
    }

    if (!filtered.length) {
      if (feedbackEl) feedbackEl.textContent = 'No matching upload records found for this filter/search.';
      listEl.innerHTML = '';
      return;
    }

    if (feedbackEl) feedbackEl.textContent = `Showing ${filtered.length} of ${historyData.length} upload session(s)`;

    listEl.innerHTML = filtered.map((batch, index) => {
      const summary = getBatchSummary(batch);
      const timeStr = formatTime(batch.createdAt);
      const videoCount = (batch.videoPaths || []).length;
      const videoNames = (batch.videoPaths || []).map(p => p.split(/[\\/]/).pop());
      const batchIdentifier = batch.id || String(batch.createdAt);

      let badgeHtml = '';
      if (summary.status === 'all_published') {
        badgeHtml = `<span class="h-badge h-badge-success">✓ All Pages Published (${summary.publishedPages}/${summary.totalPages})</span>`;
      } else if (summary.status === 'partial') {
        badgeHtml = `<span class="h-badge h-badge-warning">⚠ Partial (${summary.publishedPages}/${summary.totalPages} Published)</span>`;
      } else {
        badgeHtml = `<span class="h-badge h-badge-danger">✕ Issues / Failed (${summary.publishedPages}/${summary.totalPages})</span>`;
      }

      const tasksHtml = (batch.tasks || []).map(task => {
        const pages = task.pages || [];
        const pagesCount = pages.length;

        const pagesRows = pages.map(p => {
          const isSuccess = p.state === 'published' || p.state === 'accepted' || (p.status === 'ok' && !p.error && task.state === 'accepted');
          const isFailed = p.state === 'failed' || p.error;
          const statusClass = isSuccess ? 'h-badge-success' : (isFailed ? 'h-badge-danger' : 'h-badge-warning');
          const statusText = isSuccess ? '✓ Published (Accepted)' : (isFailed ? '✕ Failed' : (p.state || 'Pending'));
          const errDetail = p.error ? `<div class="h-error-text">${escapeHtml(p.error)}</div>` : '';

          return `
            <tr>
              <td><strong>${escapeHtml(p.name || 'Unnamed Page')}</strong></td>
              <td><code>${escapeHtml(p.pageId || '-')}</code></td>
              <td><span class="h-badge ${statusClass}">${statusText}</span>${errDetail}</td>
              <td style="text-align:right;">
                <button type="button" class="btn-ghost btn-h-reply" data-profile="${escapeHtml(task.name)}" data-pageid="${escapeHtml(p.pageId || '')}" title="Auto-reply and like viewer comments on this page" style="font-size:11px;padding:3px 7px;">
                  💬 Auto-Reply
                </button>
              </td>
            </tr>
          `;
        }).join('') || '<tr><td colspan="4" class="muted" style="text-align:center;">No managed pages detected in this account</td></tr>';

        const taskErrorHtml = task.error ? `<div class="h-task-error"><strong>Error:</strong> ${escapeHtml(task.error)}</div>` : '';
        const logsHtml = (task.log && task.log.length) ? `
          <button type="button" class="h-log-toggle">Show execution log (${task.log.length} events)</button>
          <div class="h-log-box hidden">${task.log.map(l => escapeHtml(l)).join('\n')}</div>
        ` : '';

        return `
          <div class="h-profile-card">
            <div class="h-profile-title">
              <span>
                <svg class="icon" style="width:16px;height:16px;color:var(--accent);"><use href="#icon-profiles"/></svg>
                Profile: <strong>${escapeHtml(task.name)}</strong>
              </span>
              <div style="display:flex;align-items:center;gap:8px;">
                <span class="h-badge h-badge-pill">📑 ${pagesCount} Managed Page${pagesCount === 1 ? '' : 's'} in Account</span>
                <button type="button" class="h-btn-action h-btn-profile-retry" data-batch-id="${escapeHtml(batchIdentifier)}" data-profile-name="${escapeHtml(task.name)}" title="Retry upload for this profile">
                  <svg class="icon" aria-hidden="true"><use href="#icon-retry"/></svg> Retry Profile
                </button>
              </div>
            </div>
            ${taskErrorHtml}
            <table class="h-pages-table">
              <thead>
                <tr>
                  <th>Page Name</th>
                  <th>Page ID / Asset</th>
                  <th>Publish Result</th>
                  <th style="text-align:right;">Engagement</th>
                </tr>
              </thead>
              <tbody>
                ${pagesRows}
              </tbody>
            </table>
            ${logsHtml}
          </div>
        `;
      }).join('');

      return `
        <article class="h-batch-item" id="batch-${escapeHtml(batchIdentifier)}">
          <div class="h-batch-head">
            <div class="h-batch-meta h-toggle-trigger">
              <span class="h-batch-time">📅 ${escapeHtml(timeStr)}</span>
              <span class="h-badge h-badge-pill">🎬 ${videoCount} Reel${videoCount === 1 ? '' : 's'}</span>
              <span class="h-badge h-badge-pill">👤 ${summary.totalProfiles} Profile${summary.totalProfiles === 1 ? '' : 's'}</span>
              <span class="h-badge h-badge-pill">📑 ${summary.totalPages} Total Page${summary.totalPages === 1 ? '' : 's'}</span>
            </div>
            <div class="h-batch-actions">
              ${badgeHtml}
              <button type="button" class="h-btn-action h-btn-retry" data-batch-id="${escapeHtml(batchIdentifier)}" title="Retry this upload session with the same videos and profiles">
                <svg class="icon" aria-hidden="true"><use href="#icon-retry"/></svg> Retry Again
              </button>
              <button type="button" class="h-btn-action h-btn-delete" data-batch-id="${escapeHtml(batchIdentifier)}" title="Delete this session from history">
                <svg class="icon" aria-hidden="true"><use href="#icon-trash"/></svg> Delete
              </button>
              <span class="h-chevron h-toggle-trigger" title="Toggle session details">▼</span>
            </div>
          </div>
          <div class="h-batch-body">
            <div class="h-video-preview">
              <strong>Uploaded Video(s):</strong> ${escapeHtml(videoNames.join(', ') || 'No video names recorded')}
              ${batch.description ? `<br><strong style="margin-top:4px;display:inline-block;">Caption:</strong> <span class="muted">${escapeHtml(batch.description.slice(0, 160))}${batch.description.length > 160 ? '…' : ''}</span>` : ''}
            </div>
            <div class="h-profiles-list">
              ${tasksHtml}
            </div>
          </div>
        </article>
      `;
    }).join('');
  }

  async function loadHistory() {
    const feedback = $('history-feedback');
    if (feedback) feedback.textContent = 'Loading upload history…';
    try {
      const res = await fetch('/api/upload/history');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      historyData = Array.isArray(data) ? data : (data.history || []);
      updateMetrics(historyData);
      renderHistory();
    } catch (e) {
      console.error('Failed to load upload history:', e);
      if (feedback) feedback.textContent = 'Failed to load upload history: ' + e.message;
    }
  }

  async function clearHistory() {
    if (!confirm('Are you sure you want to clear all upload history logs? This cannot be undone.')) return;
    try {
      const res = await fetch('/api/upload/history/clear', { method: 'POST' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      historyData = [];
      updateMetrics([]);
      renderHistory();
      if (window.toast) window.toast('Upload history cleared');
    } catch (e) {
      alert('Failed to clear upload history: ' + e.message);
    }
  }

  function init() {
    const searchInput = $('history-search');
    if (searchInput) {
      searchInput.oninput = () => {
        currentSearch = searchInput.value.trim();
        renderHistory();
      };
    }

    const filterSelect = $('history-filter');
    if (filterSelect) {
      filterSelect.onchange = () => {
        currentFilter = filterSelect.value;
        renderHistory();
      };
    }

    const refreshBtn = $('btn-refresh-history');
    if (refreshBtn) refreshBtn.onclick = () => loadHistory();

    const clearBtn = $('btn-clear-history');
    if (clearBtn) clearBtn.onclick = () => clearHistory();

    const listEl = $('history-list');
    if (listEl) {
      listEl.addEventListener('click', async (e) => {
        // Toggle Log Box
        const logToggle = e.target.closest('.h-log-toggle');
        if (logToggle) {
          e.stopPropagation();
          const box = logToggle.nextElementSibling;
          if (box) box.classList.toggle('hidden');
          return;
        }

        // Auto-reply to comments
        const replyBtn = e.target.closest('.btn-h-reply');
        if (replyBtn) {
          e.stopPropagation();
          const pName = replyBtn.dataset.profile;
          const pageId = replyBtn.dataset.pageid;
          if (window.openCommentReply) {
            window.openCommentReply(pName, pageId);
          }
          return;
        }

        // Retry Entire Batch
        const retryBtn = e.target.closest('.h-btn-retry');
        if (retryBtn) {
          e.stopPropagation();
          const batchId = retryBtn.dataset.batchId;
          const batch = historyData.find(b => String(b.id || b.createdAt) === String(batchId));
          if (!batch) return;
          const profileNames = (batch.tasks || []).map(t => t.name);
          if (window.retryUploadBatch) {
            window.retryUploadBatch({
              videoPaths: batch.videoPaths || [],
              title: batch.title || '',
              description: batch.description || '',
              profileNames,
              parallel: batch.parallel || 1
            });
          }
          return;
        }

        // Retry Specific Profile
        const profileRetryBtn = e.target.closest('.h-btn-profile-retry');
        if (profileRetryBtn) {
          e.stopPropagation();
          const batchId = profileRetryBtn.dataset.batchId;
          const profileName = profileRetryBtn.dataset.profileName;
          const batch = historyData.find(b => String(b.id || b.createdAt) === String(batchId));
          if (!batch) return;
          if (window.retryUploadBatch) {
            window.retryUploadBatch({
              videoPaths: batch.videoPaths || [],
              title: batch.title || '',
              description: batch.description || '',
              profileNames: [profileName],
              parallel: 1
            });
          }
          return;
        }

        // Delete Single Batch
        const deleteBtn = e.target.closest('.h-btn-delete');
        if (deleteBtn) {
          e.stopPropagation();
          const batchId = deleteBtn.dataset.batchId;
          if (!confirm('Are you sure you want to delete this upload history record?')) return;
          try {
            const res = await fetch('/api/upload/history/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: batchId })
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            historyData = historyData.filter(b => String(b.id || b.createdAt) !== String(batchId));
            updateMetrics(historyData);
            renderHistory();
            if (window.toast) window.toast('Upload history record deleted');
          } catch (err) {
            alert('Failed to delete history record: ' + err.message);
          }
          return;
        }

        // Toggle Expand/Collapse on header click
        const trigger = e.target.closest('.h-toggle-trigger');
        if (trigger) {
          const item = trigger.closest('.h-batch-item');
          if (item) {
            const body = item.querySelector('.h-batch-body');
            if (body) body.classList.toggle('hidden');
          }
        }
      });
    }
  }

  window.loadHistory = loadHistory;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
