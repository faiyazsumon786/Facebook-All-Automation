const fs = require('fs');
const path = require('path');
const { storageRoot } = require('./storage');
const { listProfiles, loadProfile, saveProfile } = require('./index');
const { ensureProfileNumbers } = require('./profile-numbers');

const DATA_DIR = path.join(storageRoot, 'data');
const CAMPAIGNS_FILE = path.join(DATA_DIR, 'campaigns.json');
const HISTORY_FILE = path.join(DATA_DIR, 'upload-history.json');
const NUMBERS_FILE = path.join(storageRoot, 'profile-numbers.json');

/**
 * Creates a complete JSON export of all profiles, campaigns, and settings
 */
function createFullBackup() {
  const profileList = listProfiles();
  const profiles = [];

  for (const name of profileList) {
    try {
      const p = loadProfile(name);
      if (p) profiles.push(p);
    } catch {}
  }

  let campaigns = [];
  try {
    if (fs.existsSync(CAMPAIGNS_FILE)) {
      campaigns = JSON.parse(fs.readFileSync(CAMPAIGNS_FILE, 'utf8'));
    }
  } catch {}

  let history = [];
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch {}

  let numbers = {};
  try {
    if (fs.existsSync(NUMBERS_FILE)) {
      numbers = JSON.parse(fs.readFileSync(NUMBERS_FILE, 'utf8'));
    }
  } catch {}

  return {
    app: 'Luminous Tech',
    version: '1.5.19',
    exportedAt: Date.now(),
    dateStr: new Date().toISOString(),
    profileCount: profiles.length,
    campaignCount: campaigns.length,
    profiles,
    campaigns,
    history: history.slice(-50),
    numbers
  };
}

/**
 * Restores profiles, campaigns, and settings from a backup object
 */
function restoreFullBackup(backupData) {
  if (!backupData || typeof backupData !== 'object') {
    throw new Error('Invalid backup file format.');
  }

  const profiles = Array.isArray(backupData.profiles) ? backupData.profiles : [];
  let restoredProfiles = 0;

  for (const p of profiles) {
    if (!p.name) continue;
    try {
      saveProfile(p.name, p);
      restoredProfiles++;
    } catch {}
  }

  // Restore profile numbers
  if (backupData.numbers && typeof backupData.numbers === 'object') {
    try {
      fs.writeFileSync(NUMBERS_FILE, JSON.stringify(backupData.numbers, null, 2));
    } catch {}
  }
  ensureProfileNumbers();

  // Restore campaigns (merge with existing)
  let restoredCampaigns = 0;
  if (Array.isArray(backupData.campaigns) && backupData.campaigns.length) {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      let existing = [];
      try {
        if (fs.existsSync(CAMPAIGNS_FILE)) {
          existing = JSON.parse(fs.readFileSync(CAMPAIGNS_FILE, 'utf8'));
        }
      } catch {}

      const map = new Map();
      for (const c of existing) map.set(c.id, c);
      for (const c of backupData.campaigns) {
        if (c.id) {
          map.set(c.id, c);
          restoredCampaigns++;
        }
      }
      fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify([...map.values()], null, 2));
    } catch {}
  }

  // Restore history
  if (Array.isArray(backupData.history) && backupData.history.length) {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      let existing = [];
      try {
        if (fs.existsSync(HISTORY_FILE)) {
          existing = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        }
      } catch {}

      const map = new Map();
      for (const h of existing) map.set(h.id, h);
      for (const h of backupData.history) if (h.id) map.set(h.id, h);
      fs.writeFileSync(HISTORY_FILE, JSON.stringify([...map.values()].slice(-50), null, 2));
    } catch {}
  }

  return {
    ok: true,
    restoredProfiles,
    restoredCampaigns
  };
}

module.exports = {
  createFullBackup,
  restoreFullBackup
};
