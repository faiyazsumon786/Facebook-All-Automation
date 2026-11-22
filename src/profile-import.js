const fs = require('node:fs');
const path = require('node:path');
const { storageRoot } = require('./storage');
const { parseImportRecords } = require('./cookies');
const { generateRandomProfile } = require('./random');
const { listProfiles } = require('./index');
const { numberNewProfile } = require('./profile-numbers');
const { saveFacebookPassword } = require('./facebook-password');
const { checkProfileSession } = require('./session-checker');

function child(root, name) {
  const result = path.resolve(root, name);
  if (path.dirname(result) !== path.resolve(root)) throw new Error('Invalid import destination');
  return result;
}

async function importProfiles(text, platform, signal, folder = 'General') {
  const records = parseImportRecords(text);
  const profilesDir = path.join(storageRoot, 'profiles');
  const dataDir = path.join(storageRoot, 'data');
  let stage;
  const filesCreated = [], directoriesCreated = [], prepared = [];
  try {
    for (const record of records) {
      signal?.throwIfAborted();
      const profile = generateRandomProfile({ platforms: [platform] });
      profile.folder = (typeof folder === 'string' && folder.trim()) ? folder.trim() : 'General';
      profile.uid = record.uid;
      if (record.phone) profile.phone = record.phone;
      if (record.password) profile.password = record.password;
      if (record.twoFactor) profile.twoFactorSecret = record.twoFactor;
      profile.importCookie = record.cookies;

      let directory;
      if (record.password !== null) {
        if (!stage) {
          fs.mkdirSync(dataDir, { recursive: true });
          stage = fs.mkdtempSync(path.join(dataDir, '.password-import-'));
        }
        directory = child(stage, String(prepared.length));
        fs.mkdirSync(directory);
        profile.localPasswordStoreOnly = true;
        const passToSave = record.password;
        try { await saveFacebookPassword(profile, directory, record.uid || record.phone, passToSave, signal); }
        catch { /* continue if Chrome password manager fails, profile.password is still preserved */ }
      }
      prepared.push({ profile, directory, uid: record.uid });
    }
    signal?.throwIfAborted();
    // Commit synchronously after all stores succeeded. Concurrent requests see
    // the final names and existing profile/serial-number allocations.
    const names = new Set(listProfiles());
    const created = [];
    for (const { profile, directory, uid } of prepared) {
      const base = uid ? `fb-${uid}` : 'profile';
      let name = base, suffix = 2;
      while (names.has(name) || fs.existsSync(child(dataDir, name))) name = `${base}-${suffix++}`;
      names.add(name);
      profile.name = name;
      numberNewProfile(profile, profilesDir);
      if (directory) {
        const target = child(dataDir, name);
        fs.renameSync(directory, target);
        directoriesCreated.push(target);
      }
      const file = child(profilesDir, name + '.json');
      const fd = fs.openSync(file, 'wx');
      filesCreated.push(file);
      try { fs.writeFileSync(fd, JSON.stringify(profile, null, 2)); } finally { fs.closeSync(fd); }
      created.push({ name, account: uid, platform, passwordSaved: !!directory });
    }
    // Automatically verify Facebook sessions in the background
    if (created.length > 0) {
      setTimeout(async () => {
        for (const item of created) {
          try { await checkProfileSession(item.name); } catch {}
        }
      }, 500);
    }
    return created;
  } catch (error) {
    for (const file of filesCreated) fs.rmSync(file, { force: true });
    for (const directory of directoriesCreated) fs.rmSync(child(dataDir, path.basename(directory)), { recursive: true, force: true });
    throw error;
  } finally {
    if (stage) fs.rmSync(child(dataDir, path.basename(stage)), { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}
module.exports = { importProfiles };
