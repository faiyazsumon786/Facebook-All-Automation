(() => {
  let currentAudioPath = null;
  let currentAudioFile = null;

  function init() {
    const btnGenerate = $('btn-generate-voice');
    const player = $('voice-audio-player');
    const previewBox = $('voice-preview-box');
    const btnMerge = $('btn-merge-voice');
    const btnBrowse = $('btn-browse-voice-video');
    const videoInput = $('voice-video-file');

    function checkMergeReady() {
      if (btnMerge) {
        const hasVideo = !!videoInput?.value?.trim();
        const hasAudio = !!currentAudioPath;
        btnMerge.disabled = !(hasVideo && hasAudio);
      }
    }

    btnGenerate?.addEventListener('click', async () => {
      const text = $('voice-text')?.value?.trim();
      if (!text) {
        toast('Please enter a voiceover script or text', true);
        $('voice-text')?.focus();
        return;
      }

      const lang = $('voice-lang')?.value || 'en';
      const speed = parseFloat($('voice-speed')?.value) || 1.0;

      btnGenerate.disabled = true;
      btnGenerate.textContent = 'Generating Voiceover…';

      try {
        const res = await api.post('/voiceover/generate', { text, lang, speed });
        currentAudioPath = res.audioPath;
        currentAudioFile = res.filename;

        if (player) {
          player.src = `${API_BASE}/api/voiceover/audio/${encodeURIComponent(res.filename)}`;
          player.load();
          player.play().catch(() => {});
        }

        if (previewBox) previewBox.classList.remove('hidden');
        toast(`Voiceover generated (${res.duration || 0}s). Audio preview loaded!`);
        checkMergeReady();
      } catch (err) {
        toast('Failed to generate voiceover: ' + err.message, true);
      } finally {
        btnGenerate.disabled = false;
        btnGenerate.textContent = '🔊 Generate Voiceover Audio';
      }
    });

    btnBrowse?.addEventListener('click', async () => {
      if (window.fsApp?.pickVideo) {
        const files = await window.fsApp.pickVideo();
        if (files && files.length) {
          if (videoInput) videoInput.value = files[0];
          checkMergeReady();
        }
      } else {
        toast('Video picker not available in browser mode. Enter video path manually.', true);
      }
    });

    videoInput?.addEventListener('input', checkMergeReady);

    btnMerge?.addEventListener('click', async () => {
      const videoPath = videoInput?.value?.trim();
      if (!videoPath) {
        toast('Please select or enter a video file path', true);
        return;
      }
      if (!currentAudioPath) {
        toast('Please generate audio voiceover first', true);
        return;
      }

      const mixWithOriginal = $('voice-blend-mix')?.checked || false;

      btnMerge.disabled = true;
      btnMerge.textContent = 'Merging Video & Audio…';

      try {
        const res = await api.post('/voiceover/merge', {
          videoPath,
          audioPath: currentAudioPath,
          mixWithOriginal
        });

        toast('Voiceover merged with video successfully!');
        
        // Put merged video into uploader
        const uVideo = $('u-video');
        if (uVideo) {
          uVideo.value = res.mergedPath;
          try { localStorage.setItem('reels-u-video', res.mergedPath); } catch {}
          window.updateVideoCount?.();
        }

        // Switch to upload page
        showPage('upload');
      } catch (err) {
        toast('Audio merge failed: ' + err.message, true);
      } finally {
        btnMerge.disabled = false;
        btnMerge.textContent = '🎙️ Merge Voiceover & Send to Reels Upload';
      }
    });

    $('btn-voice-clear')?.addEventListener('click', () => {
      if ($('voice-text')) $('voice-text').value = '';
      if (videoInput) videoInput.value = '';
      if (player) {
        player.pause();
        player.src = '';
      }
      if (previewBox) previewBox.classList.add('hidden');
      currentAudioPath = null;
      currentAudioFile = null;
      checkMergeReady();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
