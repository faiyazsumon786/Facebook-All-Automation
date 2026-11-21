const fs = require('fs');
const path = require('path');
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

const DEFAULT_SLICER_DIR = path.join(storageRoot, 'sliced_reels');

function ensureSlicerDir(targetDir) {
  const dir = targetDir || DEFAULT_SLICER_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Extracts total video duration in seconds using ffmpeg probe
 */
async function getVideoDuration(filePath) {
  if (!ffmpegPath || !fs.existsSync(filePath)) return 0;
  try {
    const { stderr } = await execFileAsync(ffmpegPath, ['-i', filePath], { stdio: 'pipe' }).catch(err => err);
    const match = (stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
    if (!match) return 0;
    const hours = parseFloat(match[1]) || 0;
    const mins = parseFloat(match[2]) || 0;
    const secs = parseFloat(match[3]) || 0;
    return (hours * 3600) + (mins * 60) + secs;
  } catch {
    return 0;
  }
}

/**
 * Splits a long video into shorter Reels chunks (e.g. 30s or 60s)
 * 
 * @param {string} inputPath Path to original long video
 * @param {object} options Options: chunkDuration (secs), outputFolder
 * @returns {Promise<object>} Result containing list of generated Reel parts
 */
async function splitVideo(inputPath, options = {}) {
  if (!ffmpegPath) throw new Error('FFmpeg is not installed or available.');
  if (!fs.existsSync(inputPath)) throw new Error('Video file does not exist: ' + inputPath);

  const chunkDuration = Math.max(5, Math.min(600, parseInt(options.chunkDuration, 10) || 60));
  const outDir = ensureSlicerDir(options.outputFolder);

  const totalDuration = await getVideoDuration(inputPath);
  if (totalDuration <= 0) {
    throw new Error('Could not determine video duration. Ensure file is a valid video.');
  }

  const baseName = path.basename(inputPath, path.extname(inputPath)).replace(/[^\w.-]+/g, '_');
  const ext = path.extname(inputPath) || '.mp4';
  const totalChunks = Math.ceil(totalDuration / chunkDuration);
  const parts = [];

  for (let i = 0; i < totalChunks; i++) {
    const startSec = i * chunkDuration;
    const remaining = totalDuration - startSec;
    if (remaining < 3) continue; // Skip micro tail remnant under 3 seconds

    const duration = Math.min(chunkDuration, remaining);
    const partNum = String(i + 1).padStart(2, '0');
    const outFileName = `${baseName}_part_${partNum}${ext}`;
    const outPath = path.join(outDir, outFileName);

    try {
      // Fast stream copy split
      await execFileAsync(ffmpegPath, [
        '-ss', String(startSec),
        '-i', inputPath,
        '-t', String(duration),
        '-c', 'copy',
        outPath,
        '-y'
      ], { stdio: 'pipe' });
    } catch {
      // Fallback with fast re-encode if stream copy fails on keyframe alignment
      await execFileAsync(ffmpegPath, [
        '-ss', String(startSec),
        '-i', inputPath,
        '-t', String(duration),
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-c:a', 'aac',
        outPath,
        '-y'
      ], { stdio: 'pipe' });
    }

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
      parts.push({
        part: i + 1,
        title: `${baseName} (Part ${i + 1})`,
        filename: outFileName,
        path: outPath,
        startSec,
        duration: Math.round(duration)
      });
    }
  }

  return {
    ok: true,
    originalFile: inputPath,
    totalDuration: Math.round(totalDuration),
    chunkDuration,
    partsCount: parts.length,
    outputFolder: outDir,
    parts
  };
}

module.exports = {
  getVideoDuration,
  splitVideo,
  DEFAULT_SLICER_DIR
};
