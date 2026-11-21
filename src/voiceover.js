const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { storageRoot } = require('./storage');

let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
} catch {
  ffmpegPath = null;
}

const VOICEOVER_DIR = path.join(storageRoot, 'voiceovers');
const VOICED_REELS_DIR = path.join(storageRoot, 'voiced_reels');

function ensureDirs() {
  if (!fs.existsSync(VOICEOVER_DIR)) fs.mkdirSync(VOICEOVER_DIR, { recursive: true });
  if (!fs.existsSync(VOICED_REELS_DIR)) fs.mkdirSync(VOICED_REELS_DIR, { recursive: true });
}

function fetchAudioChunk(text, lang = 'en') {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(text.trim());
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encoded}`;
    
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`TTS service returned HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });

    req.on('error', reject);
    req.setTimeout(12000, () => {
      req.destroy();
      reject(new Error('TTS request timed out'));
    });
  });
}

function splitTextIntoChunks(text, maxLen = 175) {
  const sentences = text.replace(/\r?\n+/g, ' ').split(/([।!?.,;]+)/);
  const chunks = [];
  let current = '';

  for (let i = 0; i < sentences.length; i++) {
    const part = sentences[i];
    if ((current + part).length <= maxLen) {
      current += part;
    } else {
      if (current.trim()) chunks.push(current.trim());
      current = part;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.slice(0, maxLen)];
}

/**
 * Generates an MP3 voiceover from text
 */
async function generateSpeech(text, { lang = 'en', speed = 1.0 } = {}) {
  ensureDirs();
  const cleanText = (text || '').trim();
  if (!cleanText) throw new Error('No text provided for voiceover generation.');

  const chunks = splitTextIntoChunks(cleanText);
  const audioBuffers = [];

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const buf = await fetchAudioChunk(chunk, lang);
    audioBuffers.push(buf);
  }

  const rawBuffer = Buffer.concat(audioBuffers);
  const fileId = crypto.randomUUID().slice(0, 10);
  const tempPath = path.join(VOICEOVER_DIR, `temp_${fileId}.mp3`);
  const finalPath = path.join(VOICEOVER_DIR, `voice_${Date.now()}_${fileId}.mp3`);

  fs.writeFileSync(tempPath, rawBuffer);

  // If speed is adjusted or we want clean header, run through ffmpeg
  if (ffmpegPath) {
    try {
      const sp = Math.max(0.7, Math.min(1.5, parseFloat(speed) || 1.0));
      const args = ['-i', tempPath];
      if (sp !== 1.0) {
        args.push('-filter:a', `atempo=${sp}`);
      }
      args.push('-c:a', 'libmp3lame', '-b:a', '128k', finalPath, '-y');
      await execFileAsync(ffmpegPath, args, { stdio: 'pipe' });
      try { fs.unlinkSync(tempPath); } catch {}
    } catch {
      // Fallback
      fs.renameSync(tempPath, finalPath);
    }
  } else {
    fs.renameSync(tempPath, finalPath);
  }

  // Get duration
  let duration = 0;
  if (ffmpegPath) {
    try {
      const { stderr } = await execFileAsync(ffmpegPath, ['-i', finalPath], { stdio: 'pipe' }).catch(err => err);
      const match = (stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
      if (match) {
        duration = Math.round((parseFloat(match[1]) * 3600) + (parseFloat(match[2]) * 60) + parseFloat(match[3]));
      }
    } catch {}
  }

  return {
    ok: true,
    audioPath: finalPath,
    filename: path.basename(finalPath),
    duration,
    lang
  };
}

/**
 * Merges a voiceover audio track into a video file
 */
async function mergeVoiceover(videoPath, audioPath, options = {}) {
  if (!ffmpegPath) throw new Error('FFmpeg is required to merge audio with video.');
  if (!fs.existsSync(videoPath)) throw new Error('Video file does not exist: ' + videoPath);
  if (!fs.existsSync(audioPath)) throw new Error('Voiceover audio file does not exist: ' + audioPath);

  ensureDirs();
  const outDir = options.outputFolder && fs.existsSync(options.outputFolder) ? options.outputFolder : VOICED_REELS_DIR;
  const baseName = path.basename(videoPath, path.extname(videoPath)).replace(/[^\w.-]+/g, '_');
  const ext = path.extname(videoPath) || '.mp4';
  const outPath = path.join(outDir, `${baseName}_voiced_${Date.now().toString(36).slice(-4)}${ext}`);

  const mixOriginal = Boolean(options.mixWithOriginal);

  if (mixOriginal) {
    // Duck original audio to 20% and mix with 100% voiceover
    await execFileAsync(ffmpegPath, [
      '-i', videoPath,
      '-i', audioPath,
      '-filter_complex', '[0:a]volume=0.22[a0];[1:a]volume=1.0[a1];[a0][a1]amix=inputs=2:duration=first[aout]',
      '-map', '0:v',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '128k',
      outPath,
      '-y'
    ], { stdio: 'pipe' });
  } else {
    // Replace original audio with voiceover
    await execFileAsync(ffmpegPath, [
      '-i', videoPath,
      '-i', audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-shortest',
      outPath,
      '-y'
    ], { stdio: 'pipe' });
  }

  return {
    ok: true,
    mergedPath: outPath,
    filename: path.basename(outPath)
  };
}

module.exports = {
  generateSpeech,
  mergeVoiceover,
  VOICEOVER_DIR,
  VOICED_REELS_DIR
};
