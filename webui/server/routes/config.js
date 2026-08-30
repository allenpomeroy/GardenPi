// GardenPi Control v2.0.0 — server/routes/config.js
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

// Always read the file fresh from disk (bypassing server/config.js's
// once-at-startup cache) so the editor shows what's actually on disk right
// now, including any changes made outside this app (e.g. by hand, or by
// another admin) since this process started.
router.get('/current', (req, res) => {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
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
      topLevelKeys: Object.keys(newConfig)
    });

    res.json({
      ok: true,
      message: 'Saved. Restart the affected service(s) -- including this web UI -- for the changes to take effect.',
      backup: fs.existsSync(backupPath) ? backupPath : null
    });
  } catch (err) {
    logger.error('Failed to write garden.json from the Configuration tab', { path: CONFIG_PATH, error: err.message });
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* best effort cleanup */ }
    res.json({ ok: false, message: `Could not save configuration: ${err.message}` });
  }
});

module.exports = router;
