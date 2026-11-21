(() => {
  let isInitialized = false;
  let activeFarmJobId = null;
  let farmPollTimer = null;
  let smmServicesCache = [];

  function initBooster() {
    renderFarmProfiles();
    loadSmmConfig();
    loadSmmOrders();
    if (isInitialized) return;
    isInitialized = true;

    // Tab Navigation
    const tabFarm = $('tab-farm-boost');
    const tabSmm = $('tab-smm-boost');
    const contentFarm = $('booster-farm-content');
    const contentSmm = $('booster-smm-content');

    tabFarm?.addEventListener('click', () => {
      tabFarm.classList.add('active');
      tabSmm?.classList.remove('active');
      contentFarm?.classList.remove('hidden');
      contentSmm?.classList.add('hidden');
      renderFarmProfiles();
    });

    tabSmm?.addEventListener('click', () => {
      tabSmm.classList.add('active');
      tabFarm?.classList.remove('active');
      contentSmm?.classList.remove('hidden');
      contentFarm?.classList.add('hidden');
      loadSmmConfig();
      loadSmmOrders();
    });

    // Action type change (toggle reaction dropdown)
    $('farm-action-type')?.addEventListener('change', (e) => {
      const container = $('farm-reaction-container');
      if (container) {
        container.classList.toggle('hidden', e.target.value !== 'react_reel');
      }
    });

    // Profile select all / deselect all
    $('farm-select-all')?.addEventListener('click', () => {
      const checkboxes = document.querySelectorAll('.farm-profile-cb');
      checkboxes.forEach(cb => cb.checked = true);
      updateFarmSelectedCount();
    });

    $('farm-deselect-all')?.addEventListener('click', () => {
      const checkboxes = document.querySelectorAll('.farm-profile-cb');
      checkboxes.forEach(cb => cb.checked = false);
      updateFarmSelectedCount();
    });

    // Start Farm Boost
    $('btn-start-farm-boost')?.addEventListener('click', startFarmBoost);

    // SMM Controls
    $('btn-save-smm-config')?.addEventListener('click', saveSmmConfig);
    $('btn-refresh-smm-balance')?.addEventListener('click', fetchSmmBalance);
    $('btn-load-smm-services')?.addEventListener('click', fetchSmmServices);
    $('btn-submit-smm-order')?.addEventListener('click', submitSmmOrder);
    $('btn-refresh-smm-orders')?.addEventListener('click', loadSmmOrders);

    $('smm-service-select')?.addEventListener('change', onServiceSelectChange);
    $('smm-order-quantity')?.addEventListener('input', calculateEstimatedCost);
    $('smm-manual-service-id')?.addEventListener('input', () => {
      calculateEstimatedCost();
    });
  }

  // -------------------------------------------------------------
  // FARM BOOSTER FUNCTIONS
  // -------------------------------------------------------------

  function renderFarmProfiles() {
    const listEl = $('farm-profile-list');
    if (!listEl) return;
    const profiles = state?.profiles || [];

    if (!profiles.length) {
      listEl.innerHTML = '<p class="muted" style="font-size:12px;margin:8px 0;text-align:center;">No profiles available. Create or import profiles first.</p>';
      updateFarmSelectedCount();
      return;
    }

    listEl.innerHTML = profiles.map(p => {
      const isAlive = p.uidCheck?.state === 'alive';
      const uidBadge = p.uid ? `<span style="font-size:11px;color:${isAlive ? 'var(--green)' : 'var(--muted)'};">(${p.uid})</span>` : '';
      return `
        <label style="display:flex;align-items:center;gap:8px;padding:4px 6px;cursor:pointer;border-radius:4px;user-select:none;">
          <input type="checkbox" class="modern-check farm-profile-cb" value="${escapeHtml(p.name)}" checked>
          <span style="font-size:13px;font-weight:500;">${escapeHtml(p.name)}</span>
          ${uidBadge}
        </label>
      `;
    }).join('');

    listEl.querySelectorAll('.farm-profile-cb').forEach(cb => {
      cb.addEventListener('change', updateFarmSelectedCount);
    });

    updateFarmSelectedCount();
  }

  function updateFarmSelectedCount() {
    const checked = document.querySelectorAll('.farm-profile-cb:checked');
    const badge = $('farm-selected-count');
    if (badge) {
      badge.textContent = `${checked.length} selected`;
      badge.className = checked.length ? 'h-badge h-badge-success' : 'h-badge h-badge-pill';
    }
  }

  async function startFarmBoost() {
    const targetUrl = $('farm-target-url')?.value?.trim();
    if (!targetUrl) {
      toast('Please enter the target Facebook URL to boost', true);
      $('farm-target-url')?.focus();
      return;
    }

    const selectedProfiles = Array.from(document.querySelectorAll('.farm-profile-cb:checked')).map(cb => cb.value);
    if (!selectedProfiles.length) {
      toast('Please select at least one participating profile', true);
      return;
    }

    const action = $('farm-action-type')?.value || 'follow_page';
    const reaction = $('farm-reaction-type')?.value || 'like';
    const delaySec = parseInt($('farm-delay-sec')?.value, 10) || 4;

    const btn = $('btn-start-farm-boost');
    btn.disabled = true;
    btn.textContent = '🚀 Farm Boost in Progress…';

    const logBox = $('farm-live-logs');
    if (logBox) logBox.innerHTML = `[${new Date().toLocaleTimeString()}] Starting boost job on ${selectedProfiles.length} profiles...<br>`;

    $('farm-stat-success').textContent = '0';
    $('farm-stat-failed').textContent = '0';

    try {
      const res = await api.post('/booster/farm/run', {
        targetUrl,
        action,
        profiles: selectedProfiles,
        reaction,
        delaySec
      });

      activeFarmJobId = res.jobId;
      toast(`Farm boost job launched on ${selectedProfiles.length} profiles!`);
      pollFarmStatus();
    } catch (err) {
      toast('Failed to start farm boost: ' + err.message, true);
      btn.disabled = false;
      btn.textContent = '🚀 Start Farm Boost Now';
    }
  }

  async function pollFarmStatus() {
    if (!activeFarmJobId) return;
    clearTimeout(farmPollTimer);

    try {
      const res = await api.get('/booster/farm/status?id=' + encodeURIComponent(activeFarmJobId));
      const job = res?.job;
      if (!job) return;

      if ($('farm-stat-success')) $('farm-stat-success').textContent = job.successCount || 0;
      if ($('farm-stat-failed')) $('farm-stat-failed').textContent = job.failCount || 0;

      const logBox = $('farm-live-logs');
      if (logBox && job.logs) {
        logBox.innerHTML = job.logs.map(escapeHtml).join('<br>');
        logBox.scrollTop = logBox.scrollHeight;
      }

      if (job.status === 'running') {
        farmPollTimer = setTimeout(pollFarmStatus, 2000);
      } else {
        const btn = $('btn-start-farm-boost');
        if (btn) {
          btn.disabled = false;
          btn.textContent = '🚀 Start Farm Boost Now';
        }
        toast(`Farm Boost ${job.status === 'completed' ? 'Finished' : 'Stopped'}! Succeeded: ${job.successCount}, Failed: ${job.failCount}`);
      }
    } catch {
      farmPollTimer = setTimeout(pollFarmStatus, 3000);
    }
  }

  // -------------------------------------------------------------
  // SMM RESELLER PANEL FUNCTIONS
  // -------------------------------------------------------------

  async function loadSmmConfig() {
    try {
      const res = await api.get('/booster/smm/config');
      if (res && $('smm-api-url') && $('smm-api-key')) {
        if (!$('smm-api-url').value) $('smm-api-url').value = res.apiUrl || '';
        if (!$('smm-api-key').value) $('smm-api-key').value = res.apiKey || '';
        if (res.apiUrl && res.apiKey) {
          fetchSmmBalance();
        }
      }
    } catch {}
  }

  async function saveSmmConfig() {
    const apiUrl = $('smm-api-url')?.value?.trim();
    const apiKey = $('smm-api-key')?.value?.trim();

    if (!apiUrl || !apiKey) {
      toast('Please enter both SMM API URL and API Key', true);
      return;
    }

    const btn = $('btn-save-smm-config');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
      await api.post('/booster/smm/config', { apiUrl, apiKey });
      toast('SMM Panel API settings saved!');
      await fetchSmmBalance();
    } catch (err) {
      toast('Failed to save SMM config: ' + err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '💾 Save & Connect';
    }
  }

  async function fetchSmmBalance() {
    const amountEl = $('smm-balance-amount');
    if (amountEl) amountEl.textContent = 'Checking…';

    try {
      const res = await api.get('/booster/smm/balance');
      if (res.error) {
        if (amountEl) amountEl.textContent = 'Error: ' + res.error;
        toast('SMM API Error: ' + res.error, true);
      } else if (res.balance !== undefined) {
        const curr = res.currency || '$';
        if (amountEl) amountEl.textContent = `${res.balance} ${curr}`;
        toast(`Live SMM Balance: ${res.balance} ${curr}`);
      } else {
        if (amountEl) amountEl.textContent = 'Connected';
      }
    } catch (err) {
      if (amountEl) amountEl.textContent = 'Connection failed';
      toast('Failed to fetch balance: ' + err.message, true);
    }
  }

  async function fetchSmmServices() {
    const btn = $('btn-load-smm-services');
    btn.disabled = true;
    btn.textContent = '⏳ Loading Services from API…';

    const sel = $('smm-service-select');

    try {
      const list = await api.get('/booster/smm/services');
      if (!Array.isArray(list)) {
        throw new Error(list.error || 'Invalid service list returned by provider');
      }

      smmServicesCache = list;

      // Filter Facebook services first, then others
      const fbServices = list.filter(s => {
        const hay = ((s.category || '') + ' ' + (s.name || '')).toLowerCase();
        return hay.includes('facebook') || hay.includes('fb') || hay.includes('reel');
      });

      const displayList = fbServices.length ? fbServices : list;

      sel.innerHTML = `<option value="">-- Choose from ${displayList.length} services --</option>` +
        displayList.map(s => {
          const cat = s.category ? `[${s.category}] ` : '';
          const rate = s.rate ? ` ($${s.rate}/1k)` : '';
          return `<option value="${s.service}" data-rate="${s.rate || 0}" data-min="${s.min || 10}" data-max="${s.max || 100000}">${escapeHtml(cat + s.service + ' - ' + s.name + rate)}</option>`;
        }).join('');

      toast(`Loaded ${displayList.length} services from SMM Panel!`);
    } catch (err) {
      toast('Failed to fetch SMM services: ' + err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '🔄 Fetch All Services from API';
    }
  }

  function onServiceSelectChange() {
    const sel = $('smm-service-select');
    const opt = sel?.options[sel.selectedIndex];
    if (!opt || !opt.value) return;

    if ($('smm-manual-service-id')) $('smm-manual-service-id').value = opt.value;
    calculateEstimatedCost();
  }

  function calculateEstimatedCost() {
    const sel = $('smm-service-select');
    const opt = sel?.options[sel.selectedIndex];
    const rate = parseFloat(opt?.dataset?.rate || 0);
    const qty = parseInt($('smm-order-quantity')?.value, 10) || 0;

    const costEl = $('smm-order-cost');
    if (!costEl) return;

    if (rate > 0 && qty > 0) {
      const total = ((rate / 1000) * qty).toFixed(4);
      costEl.textContent = `$${total} USD`;
    } else {
      costEl.textContent = '—';
    }
  }

  async function submitSmmOrder() {
    const service = $('smm-manual-service-id')?.value?.trim();
    const link = $('smm-order-link')?.value?.trim();
    const quantity = parseInt($('smm-order-quantity')?.value, 10);

    if (!service) {
      toast('Please enter or select a Service ID', true);
      $('smm-manual-service-id')?.focus();
      return;
    }
    if (!link) {
      toast('Please enter the target link (Page, Profile, or Reel URL)', true);
      $('smm-order-link')?.focus();
      return;
    }
    if (!quantity || quantity < 1) {
      toast('Please enter a valid order quantity', true);
      $('smm-order-quantity')?.focus();
      return;
    }

    const btn = $('btn-submit-smm-order');
    btn.disabled = true;
    btn.textContent = 'Submitting Order…';

    try {
      const res = await api.post('/booster/smm/order', { service, link, quantity });
      if (res.error) {
        throw new Error(res.error);
      }
      if (res.order) {
        toast(`Order #${res.order} placed successfully!`);
        $('smm-order-link').value = '';
        fetchSmmBalance();
        loadSmmOrders();
      } else {
        toast('Order submitted: ' + JSON.stringify(res));
      }
    } catch (err) {
      toast('Failed to place SMM order: ' + err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '⚡ Submit SMM Order';
    }
  }

  async function loadSmmOrders() {
    const listEl = $('smm-orders-list');
    if (!listEl) return;

    try {
      const res = await api.get('/booster/smm/orders');
      const orders = res?.orders || [];

      if (!orders.length) {
        listEl.innerHTML = '<p class="muted" style="text-align:center;padding:20px;">No recent SMM orders yet.</p>';
        return;
      }

      listEl.innerHTML = orders.map(o => `
        <div class="smm-order-item">
          <div class="smm-order-header">
            <strong>Order #${escapeHtml(o.orderId || '—')}</strong>
            <span class="smm-order-badge">${escapeHtml(o.status || 'Pending')}</span>
          </div>
          <div style="color:var(--muted);font-size:11.5px;margin-bottom:4px;">
            Service ID: <strong>${escapeHtml(o.service || '—')}</strong> · Qty: <strong>${escapeHtml(o.quantity || '—')}</strong>
          </div>
          <div style="word-break:break-all;color:var(--accent);font-size:11.5px;margin-bottom:4px;">
            ${escapeHtml(o.link || '—')}
          </div>
          <div style="font-size:10.5px;color:var(--muted);">
            ${new Date(o.createdAt).toLocaleString()}
          </div>
        </div>
      `).join('');
    } catch {}
  }

  window.initBooster = initBooster;
})();
