// GardenPi Control v2.0.0 — server/routes/logs.js
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const config = require('../config').load();

const LOG_DIR = config.server.logDir;

// The "current" log file is whichever app-*.log was written to most recently
// -- more robust than computing today's date ourselves (handles timezone
// differences and the moment right around midnight rollover).
function findCurrentLogFile() {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => /^app-.*\.log$/.test(f))
      .map(f => ({ f, mtime: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length ? files[0].f : null;
  } catch (err) {
    logger.error('Could not list log directory', { error: err.message });
    return null;
  }
}

// Serves a page of lines from the current application log, tailed from the
// end. `offset` counts back from the most recent line (0 = newest lines);
// `limit` is how many lines to return. Used by the dashboard's scrollable
// Recent Activity panel both for the initial view and for "load older" as
// the person scrolls up.
//
// The generic per-request "HTTP request" trace line (logged for every single
// /api/* call, including the frequent status/valve/schedule polling the
// dashboard itself does every few seconds) is filtered out here. It's pure
// noise for this purpose: every action worth seeing already has its own
// descriptive line elsewhere (e.g. "Valve turned on", "Schedule entry
// created", "User logged in", "Request could not be completed" for errors),
// so dropping the HTTP trace line loses no unique information while removing
// the vast majority of the volume.
const NOISE_LINE_RE = /\]\s+HTTP request\b/;

router.get('/current', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const file = findCurrentLogFile();
  if (!file) {
    return res.json({ ok: true, lines: [], total: 0, hasMore: false, file: null });
  }

  try {
    const raw = fs.readFileSync(path.join(LOG_DIR, file), 'utf8');
    const allLines = raw.split('\n').filter((line, i, arr) => !(i === arr.length - 1 && line === ''));
    const lines = allLines.filter(line => !NOISE_LINE_RE.test(line));
    const total = lines.length;
    const end = Math.max(total - offset, 0);
    const start = Math.max(end - limit, 0);
    res.json({ ok: true, lines: lines.slice(start, end), total, hasMore: start > 0, file });
  } catch (err) {
    logger.error('Failed to read current log file', { file, error: err.message });
    res.json({ ok: false, message: 'Could not read the current log file.' });
  }
});

module.exports = router;
