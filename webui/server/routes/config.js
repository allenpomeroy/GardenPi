// GardenPi Control v2.3.0 — server/routes/config.js
//
// v2.3.0 2026/09/24
// - each save works out which services the change affects
//   (server/restartImpact.js), returns them as `restartNeeded`, and records
//   them in the persistent pending-restart list shown on the Services card.
//
// v2.2.0 2026/09/23
// - config.version is renamed config.config_version (same auto-bump
//   behavior), and config.code_version is added: a version for the code
//   base, set by hand (e.g. by patching the installed garden.json), never
//   by this app.
// - migration: a file that still has config.version is shown by GET as if
//   it were config_version, and the next save writes it back renamed, in
//   the same position in the file. No manual edit needed.
// - config.code_version is always taken from the file ON DISK when saving,
//   never from the browser. The Configuration page only displays it, so a
//   browser tab opened before a hand edit would otherwise send the old
//   value back and silently undo that edit.
// v2.1.0 2026/09/23
// - fixed: config.last_changed and config.version were never updated on
//   save. Every save that actually changes something now stamps
//   config.last_changed (local time with UTC offset, same format as the
//   shipped file) and bumps the patch component of config.version
//   (3.0.6 -> 3.0.7). Both are computed from the file ON DISK, never from
//   what the browser sent, so two admins saving back-to-back can't both
//   produce the same version number.
// - a save with no real changes is now a no-op (no rewrite, no backup
//   file, no version bump).
//
// Read/write access to the FULL garden.json file -- not just the "webui"
// stanza this app owns, but also the config/hardware/handlers stanzas that
// are ground truth for the other GardenPi services (see server/config.js).
// This is what the Configuration tab reads from and saves to.
//
// IMPORTANT: garden.json is read once at startup by every GardenPi service
// (this one included -- see the caching in server/config.js) and none of
// them watch the file for changes. Saving here updates the file on disk
// immediately, but nothing picks up the new values until the affected
// service is restarted. The frontend is expected to make this clear to the
// person saving; this route does not attempt any kind of hot-reload.
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { CONFIG_PATH } = require('../config');
const restartImpact = require('../restartImpact');

// ---- config.config_version / config.last_changed stamping ----

// ISO 8601 in the Pi's local time with its UTC offset, e.g.
// 2026-09-23T14:05:09-05:00 -- matches the format already used in
// garden.json rather than a UTC "Z" timestamp.
function localIsoWithOffset(d = new Date()) {
  const pad = n => String(Math.abs(Math.trunc(n))).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(offsetMin / 60)}:${pad(offsetMin % 60)}`;
}

// "3.0.6" -> "3.0.7". Anything that isn't MAJOR.MINOR.PATCH (optionally
// with a suffix, e.g. "3.0.6-dev") is returned unchanged -- better to
// leave a hand-set version alone than to guess at a format.
function bumpPatchVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(String(version ?? '').trim());
  if (!m) return null;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}${m[4]}`;
}

// Renames a legacy config.version key to config_version IN PLACE (same
// position among the config keys, so the file doesn't get reshuffled).
// Returns the object passed in. If both keys exist, config_version wins and
// the legacy key is dropped.
function migrateVersionKey(cfg) {
  const c = cfg && cfg.config;
  if (!c || typeof c !== 'object' || Array.isArray(c) || !('version' in c)) return cfg;
  const rebuilt = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === 'version') {
      if (!('config_version' in c)) rebuilt.config_version = v;
    } else {
      rebuilt[k] = v;
    }
  }
  cfg.config = rebuilt;
  return cfg;
}

// Deep copy with the fields this route manages itself removed, so "did
// anything change?" ignores them: config_version/last_changed are stamped
// here, and code_version is always taken from disk (see header).
function withoutStampFields(cfg) {
  const copy = migrateVersionKey(JSON.parse(JSON.stringify(cfg || {})));
  if (copy.config && typeof copy.config === 'object') {
    delete copy.config.config_version;
    delete copy.config.code_version;
    delete copy.config.last_changed;
  }
  return copy;
}

// Always read the file fresh from disk (bypassing server/config.js's
// once-at-startup cache) so the editor shows what's actually on disk right
// now, including any changes made outside this app (e.g. by hand, or by
// another admin) since this process started.
router.get('/current', (req, res) => {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = migrateVersionKey(JSON.parse(raw));
    res.json({ ok: true, config: parsed, path: CONFIG_PATH });
  } catch (err) {
    logger.error('Failed to read garden.json for the Configuration tab', { path: CONFIG_PATH, error: err.message });
    res.json({ ok: false, message: `Could not read ${CONFIG_PATH}: ${err.message}` });
  }
});

// Overwrites garden.json with the given object. Safety measures, since this
// file is shared with hardware handlers that hard-exit on malformed config:
//   1. A timestamped backup of the previous file is written first (never
//      overwritten, so every save leaves a recovery point).
//   2. The new content is written to a temp file and then renamed into
//      place, so a crash mid-write can never leave a half-written,
//      corrupt garden.json for a handler to trip over.
//   3. The freshly-written file is read back and re-parsed as a final
//      sanity check before responding success.
router.put('/current', (req, res) => {
  const newConfig = req.body;

  if (!newConfig || typeof newConfig !== 'object' || Array.isArray(newConfig)) {
    return res.json({ ok: false, message: 'Expected a JSON object for the configuration.' });
  }

  const dir = path.dirname(CONFIG_PATH);
  const tmpPath = `${CONFIG_PATH}.tmp-${process.pid}`;
  const backupPath = `${CONFIG_PATH}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;

  try {
    // Read what's on disk now: it's both the change-detection baseline
    // and the source of the version number being bumped.
    let onDisk = null;
    let rawDisk = null; // as parsed, before migrateVersionKey()
    if (fs.existsSync(CONFIG_PATH)) {
      try {
        rawDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        onDisk = migrateVersionKey(JSON.parse(JSON.stringify(rawDisk)));
      } catch { onDisk = null; rawDisk = null; } // unreadable/corrupt -- treat as changed and overwrite
    }

    migrateVersionKey(newConfig);

    // A file on disk that still uses the legacy "version" key counts as a
    // change, so the first save after upgrading writes the rename.
    const diskNeedsMigration = !!(rawDisk && rawDisk.config && 'version' in rawDisk.config);

    if (onDisk && !diskNeedsMigration &&
        JSON.stringify(withoutStampFields(onDisk)) === JSON.stringify(withoutStampFields(newConfig))) {
      return res.json({
        ok: true,
        unchanged: true,
        message: 'No changes to save.',
        config_version: onDisk.config?.config_version ?? null,
        code_version: onDisk.config?.code_version ?? null,
        last_changed: onDisk.config?.last_changed ?? null
      });
    }

    if (!newConfig.config || typeof newConfig.config !== 'object' || Array.isArray(newConfig.config)) {
      newConfig.config = {};
    }

    // code_version: disk wins. Absent on disk -> absent in the saved file.
    if (onDisk && onDisk.config && 'code_version' in onDisk.config) {
      newConfig.config.code_version = onDisk.config.code_version;
    } else if (onDisk) {
      delete newConfig.config.code_version;
    }

    const previousVersion = onDisk?.config?.config_version ?? newConfig.config.config_version;
    const nextVersion = bumpPatchVersion(previousVersion);
    if (nextVersion) {
      newConfig.config.config_version = nextVersion;
    } else {
      if (previousVersion !== undefined) newConfig.config.config_version = previousVersion;
      logger.warn('config.config_version is not MAJOR.MINOR.PATCH; left unchanged on save', { config_version: previousVersion });
    }
    newConfig.config.last_changed = localIsoWithOffset();

    // Which services need a restart to pick this change up. Compared
    // against the migrated on-disk copy; version/timestamp fields and
    // comments are ignored by restartImpact itself.
    const restartNeeded = restartImpact.servicesAffected(onDisk || {}, newConfig);

    if (fs.existsSync(CONFIG_PATH)) {
      fs.copyFileSync(CONFIG_PATH, backupPath);
    }

    const serialized = JSON.stringify(newConfig, null, 2) + '\n';
    fs.writeFileSync(tmpPath, serialized, 'utf8');

    // Sanity check: read back and re-parse what was just written before
    // committing it into place, so a serialization bug never gets as far
    // as overwriting the real file.
    JSON.parse(fs.readFileSync(tmpPath, 'utf8'));

    fs.renameSync(tmpPath, CONFIG_PATH);

    logger.info('garden.json updated via the Configuration tab', {
      path: CONFIG_PATH,
      backup: fs.existsSync(backupPath) ? backupPath : null,
      topLevelKeys: Object.keys(newConfig),
      configVersion: newConfig.config.config_version,
      codeVersion: newConfig.config.code_version,
      lastChanged: newConfig.config.last_changed,
      migratedVersionKey: diskNeedsMigration
    });

    restartImpact.recordPending(restartNeeded);
    const units = restartNeeded.map(r => r.unit.replace(/\.service$/, ''));
    res.json({
      ok: true,
      restartNeeded,
      message: `Saved as config version ${newConfig.config.config_version}. ` + (units.length
        ? `Takes effect after restarting: ${units.join(', ')}.`
        : 'No service restart is needed.'),
      backup: fs.existsSync(backupPath) ? backupPath : null,
      config_version: newConfig.config.config_version,
      code_version: newConfig.config.code_version ?? null,
      last_changed: newConfig.config.last_changed
    });
  } catch (err) {
    logger.error('Failed to write garden.json from the Configuration tab', { path: CONFIG_PATH, error: err.message });
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* best effort cleanup */ }
    res.json({ ok: false, message: `Could not save configuration: ${err.message}` });
  }
});

module.exports = router;
// Exported for tests.
module.exports._internal = { localIsoWithOffset, bumpPatchVersion, withoutStampFields, migrateVersionKey };
