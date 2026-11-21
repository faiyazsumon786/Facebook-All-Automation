(() => {
  let slicedPartsCache = [];

  function formatDuration(sec) {
    if (!sec || isNaN(sec)) return '0s';
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    if (m === 0) return `${s}s`;
    return `${m}m ${s}s`;
  }

  function renderSlicedParts(parts) {
    const list = $('slicer-parts-list');
    const countLabel = $('slicer-parts-count');
    const btnSend = $('btn-send-to-uploader');
    if (!list) return;

    slicedPartsCache = Array.isArray(parts) ? parts : [];
    if (countLabel) countLabel.textContent = slicedPartsCache.length;

    if (!slicedPartsCache.length) {
      list.innerHTML = `
        <div class="h-empty">
          <p>No video sliced yet. Select a long video above and click "Split Video into Reels".</p>
        </div>
      `;
      if (btnSend) btnSend.classList.add('hidden');
      return;
    }

    if (btnSend) btnSend.classList.remove('hidden');

    list.innerHTML = slicedPartsCache.map(p => {
      return `
        <div class="camp-card" style="margin-bottom:10px;padding:12px 16px;">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="h-badge h-badge-pill" style="background:rgba(59,130,246,0.18);color:#93c5fd;font-weight:600;">Part ${p.part}</span>
              <strong style="font-size:13.5px;color:var(--ink);">${escapeHtml(p.filename)}</strong>
            </div>
            <div style="display:flex;align-items:center;gap:12px;">
              <span class="muted" style="font-size:12px;">Duration: <strong>${formatDuration(p.duration)}</strong></span>
              <button class="btn-ghost btn-copy-path" data-path="${escapeHtml(p.path)}" style="font-size:11.5px;">Copy Path</button>
            </div>
          </div>
          <div class="muted" style="font-size:11px;margin-top:6px;word-break:break-all;">
            ${escapeHtml(p.path)}
          </div>
        </div>
      `;
    }).join('');

    list.querySelectorAll('.btn-copy-path').forEach(btn => {
      btn.onclick = () => {
        const path = btn.dataset.path;
        navigator.clipboard.writeText(path).then(() => toast('Path copied to clipboard!'));
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

  async function checkVideoDuration(filePath) {
    const info = $('slicer-file-info');
    if (!info || !filePath) return;
    info.textContent = 'Probing video duration…';
    try {
      const res = await api.post('/video/duration', { filePath });
      if (res.duration > 0) {
        info.innerHTML = `✅ Total Duration: <strong style="color:var(--accent);">${formatDuration(res.duration)}</strong> (Ready to slice into Reels)`;
      } else {
        info.textContent = 'Could not determine duration, but slicing can still be attempted.';
      }
    } catch {
      info.textContent = 'Supported formats: .mp4, .mov, .mkv, .avi, .webm';
    }
  }

  function init() {
    $('btn-browse-slicer-file')?.addEventListener('click', async () => {
      if (window.fsApp?.pickVideo) {
        const files = await window.fsApp.pickVideo();
        if (files && files.length) {
          $('slicer-file').value = files[0];
          await checkVideoDuration(files[0]);
        }
      } else {
        toast('Video picker not available in browser mode. Enter file path manually.', true);
      }
    });

    $('slicer-file')?.addEventListener('change', (e) => {
      const path = e.target.value.trim();
      if (path) checkVideoDuration(path);
    });

    $('btn-browse-slicer-folder')?.addEventListener('click', async () => {
      if (window.fsApp?.pickFolder) {
        const folder = await window.fsApp.pickFolder();
        if (folder) $('slicer-out-folder').value = folder;
      }
    });

    $('btn-slicer-clear')?.addEventListener('click', () => {
      $('slicer-file').value = '';
      $('slicer-file-info').textContent = 'Supported formats: .mp4, .mov, .mkv, .avi, .webm';
      $('slicer-progress-box').classList.add('hidden');
      renderSlicedParts([]);
    });

    $('btn-send-to-uploader')?.addEventListener('click', () => {
      if (!slicedPartsCache.length) return;
      const paths = slicedPartsCache.map(p => p.path).join('\n');
      const uVideo = $('u-video');
      if (uVideo) {
        uVideo.value = paths;
        try { localStorage.setItem('reels-u-video', paths); } catch {}
        window.updateVideoCount?.();
      }
      toast(`Loaded ${slicedPartsCache.length} sliced Reel parts into uploader!`);
      showPage('upload');
    });

    $('btn-start-slice')?.addEventListener('click', async () => {
      const filePath = $('slicer-file')?.value?.trim();
      if (!filePath) {
        toast('Please choose or enter a video file path', true);
        $('slicer-file')?.focus();
        return;
      }

      const chunkDuration = parseInt($('slicer-chunk-duration')?.value, 10) || 60;
      const outputFolder = $('slicer-out-folder')?.value?.trim() || undefined;

      const progressBox = $('slicer-progress-box');
      const progressText = $('slicer-progress-text');
      const btnSlice = $('btn-start-slice');

      if (progressBox) progressBox.classList.remove('hidden');
      if (progressText) progressText.textContent = `✂️ Slicing video into ${chunkDuration}-second Reels... Please wait...`;
      if (btnSlice) {
        btnSlice.disabled = true;
        btnSlice.textContent = 'Processing…';
      }

      try {
        const result = await api.post('/video/split', {
          filePath,
          chunkDuration,
          outputFolder
        });

        toast(`Success! Generated ${result.partsCount} Reels chunks.`);
        renderSlicedParts(result.parts);
      } catch (err) {
        toast('Video slicing failed: ' + err.message, true);
      } finally {
        if (progressBox) progressBox.classList.add('hidden');
        if (btnSlice) {
          btnSlice.disabled = false;
          btnSlice.textContent = '✂️ Split Video into Reels';
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
