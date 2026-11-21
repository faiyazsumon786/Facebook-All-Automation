const fs = require('fs');
const path = require('path');
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

const TEMP_DIR = path.join(storageRoot, 'temp_uniquified');

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

/**
 * Checks if a video file has an audio stream using ffmpeg probe output
 */
async function hasAudioStream(filePath) {
  if (!ffmpegPath) return false;
  try {
    const { stderr } = await execFileAsync(ffmpegPath, ['-i', filePath], { stdio: 'pipe' }).catch(err => err);
    return /Stream #.*: Audio:/i.test(stderr || '');
  } catch {
    return false;
  }
}

/**
 * Modifies video digital signature (MD5, SHA-256), frame hashes, and audio frequencies.
 * Bypasses Facebook's duplicate content / reused content detection algorithms.
 * 
 * @param {string} inputPath Path to original video
 * @param {object} options Options (e.g. profileName, customTag)
 * @returns {Promise<string>} Path to unique video file (or original if ffmpeg unavailable)
 */
async function uniquifyVideo(inputPath, options = {}) {
  if (!ffmpegPath || !fs.existsSync(inputPath)) {
    return inputPath;
  }

  ensureTempDir();
  const ext = path.extname(inputPath) || '.mp4';
  const uniqueId = crypto.randomUUID().slice(0, 12);
  const outPath = path.join(TEMP_DIR, `uniq_${Date.now()}_${uniqueId}${ext}`);

  try {
    const hasAudio = await hasAudioStream(inputPath);

    // Micro-adjustments: completely invisible to human eyes, but radically alters neural net hashes
    const cropW = Math.random() > 0.5 ? 4 : 2;
    const cropH = Math.random() > 0.5 ? 4 : 2;
    const contrast = (1.006 + Math.random() * 0.008).toFixed(4);
    const brightness = (0.003 + Math.random() * 0.004).toFixed(4);
    const saturation = (1.006 + Math.random() * 0.008).toFixed(4);
    const tempo = (1.0015 + Math.random() * 0.002).toFixed(4);

    const vFilters = [
      `crop=in_w-${cropW}:in_h-${cropH}`,
      `scale=in_w:in_h:flags=lanczos`,
      `eq=contrast=${contrast}:brightness=${brightness}:saturation=${saturation}`,
      `setpts=PTS/${tempo}`
    ].join(',');

    const args = [
      '-i', inputPath,
      '-vf', vFilters
    ];

    if (hasAudio) {
      args.push('-af', `atempo=${tempo}`);
      args.push('-c:a', 'aac', '-b:a', '128k');
    } else {
      args.push('-an');
    }

    // Video encoding settings
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '21',
      '-map_metadata', '-1', // Strip camera/device/fingerprint metadata
      '-metadata', 'title=Reel',
      '-metadata', `comment=Luminous_${crypto.randomBytes(8).toString('hex')}`,
      '-metadata', `creation_time=${new Date().toISOString()}`,
      outPath,
      '-y'
    );

    await execFileAsync(ffmpegPath, args, { stdio: 'pipe' });

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
      return outPath;
    }
    return inputPath;
  } catch (err) {
    // If anything fails during processing, fallback safely to the original video
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
    return inputPath;
  }
}

/**
 * Clean up temporary uniquified video files
 */
function cleanupFiles(filePaths) {
  if (!Array.isArray(filePaths)) return;
  for (const fp of filePaths) {
    if (!fp || typeof fp !== 'string') continue;
    if (fp.startsWith(TEMP_DIR) && fs.existsSync(fp)) {
      try {
        fs.unlinkSync(fp);
      } catch {}
    }
  }
}

/**
 * Clear any old leftover temporary files on system boot
 */
function cleanupOldTempFiles() {
  if (!fs.existsSync(TEMP_DIR)) return;
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
    for (const f of files) {
      const full = path.join(TEMP_DIR, f);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < twoHoursAgo) {
          fs.unlinkSync(full);
        }
      } catch {}
    }
  } catch {}
}

// Clean old temp files on load
cleanupOldTempFiles();

module.exports = {
  uniquifyVideo,
  cleanupFiles,
  cleanupOldTempFiles,
  hasFfmpeg: Boolean(ffmpegPath)
};
