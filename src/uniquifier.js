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
 * Modifies video digital signature (MD5, SHA-256), strips device metadata, and alters container hash.
 * Bypasses Facebook's duplicate content / reused content detection algorithms instantly without CPU lag.
 * 
 * @param {string} inputPath Path to original video
 * @param {object} options Options (e.g. profileName, customTag)
 * @returns {Promise<string>} Path to unique video file (or original if failed)
 */
async function uniquifyVideo(inputPath, options = {}) {
  if (!fs.existsSync(inputPath)) {
    return inputPath;
  }

  ensureTempDir();
  const ext = path.extname(inputPath) || '.mp4';
  const uniqueId = crypto.randomUUID().slice(0, 12);
  const outPath = path.join(TEMP_DIR, `uniq_${Date.now()}_${uniqueId}${ext}`);

  try {
    if (ffmpegPath) {
      // Ultra-fast stream copy: strips device metadata and injects unique cryptographic salt in < 0.1s
      const randomTag = `Luminous_${crypto.randomBytes(8).toString('hex')}`;
      const randomDate = new Date(Date.now() - Math.floor(Math.random() * 86400000)).toISOString();

      const args = [
        '-nostdin',
        '-y',
        '-i', inputPath,
        '-c', 'copy',
        '-map_metadata', '-1', // Strip camera/device/fingerprint metadata
        '-metadata', 'title=Reel',
        '-metadata', `comment=${randomTag}`,
        '-metadata', `creation_time=${randomDate}`,
        outPath
      ];

      await execFileAsync(ffmpegPath, args, { stdio: 'pipe', timeout: 15000 });

      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
        // Append a minor 16-byte random salt to guarantee 100% unique MD5 & bitstream hash
        try {
          fs.appendFileSync(outPath, crypto.randomBytes(16));
        } catch {}
        return outPath;
      }
    }

    // Direct binary salting fallback (instant, no ffmpeg required)
    fs.copyFileSync(inputPath, outPath);
    fs.appendFileSync(outPath, crypto.randomBytes(32));
    return outPath;
  } catch (err) {
    // If anything fails, fallback safely to original video
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch {}
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
