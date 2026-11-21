const fs = require('node:fs');
const path = require('node:path');

function writeJson(file, value) {
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

// Calls are synchronous so requests in the single app process cannot allocate
// the same number. Reserve numbers on disk before writing any profile changes.
function ensureProfileNumbers(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const counterFile = path.join(directory, '..', 'profile-order.json');
  const counter = fs.existsSync(counterFile) ? JSON.parse(fs.readFileSync(counterFile, 'utf8')) : { next: 1 };
  if (!Number.isSafeInteger(counter.next) || counter.next < 1) throw new Error('Invalid profile number counter');
  const profiles = fs.readdirSync(directory).filter(name => name.endsWith('.json')).flatMap(name => {
    const file = path.join(directory, name);
    try {
      const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return [];
      const stat = fs.statSync(file);
      return [{ file, profile, time: stat.birthtimeMs || stat.mtimeMs }];
    } catch { return []; }
  }).sort((a, b) => a.time - b.time || a.file.localeCompare(b.file));
  let next = counter.next;
  const seen = new Set();
  for (const { profile } of profiles) {
    if (Number.isSafeInteger(profile.serialNumber) && profile.serialNumber > 0) {
      next = Math.max(next, profile.serialNumber + 1);
    }
  }
  const changed = [];
  for (const entry of profiles) {
    const p = entry.profile;
    if (!Number.isSafeInteger(p.serialNumber) || p.serialNumber < 1 || seen.has(p.serialNumber)) {
      p.serialNumber = next++;
      changed.push(entry);
    }
    seen.add(p.serialNumber);
    if (!p.createdAt) {
      p.createdAt = new Date(entry.time).toISOString();
      if (!changed.includes(entry)) changed.push(entry);
    }
  }
  if (!Number.isSafeInteger(next)) throw new Error('Profile numbers exhausted');
  if (next !== counter.next || !fs.existsSync(counterFile)) writeJson(counterFile, { next });
  for (const { file, profile } of changed) writeJson(file, profile);
  return next;
}

function numberNewProfile(profile, directory) {
  const next = ensureProfileNumbers(directory);
  if (!Number.isSafeInteger(next + 1)) throw new Error('Profile numbers exhausted');
  writeJson(path.join(directory, '..', 'profile-order.json'), { next: next + 1 });
  profile.serialNumber = next;
  profile.createdAt = new Date().toISOString();
}

module.exports = { ensureProfileNumbers, numberNewProfile };
