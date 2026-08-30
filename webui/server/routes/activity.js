// GardenPi Control v2.0.0 — server/routes/activity.js
const express = require('express');
const router = express.Router();
const db = require('../db');

// Paged, human-readable activity feed (reverse chronological: index 0 is the
// newest), backed by the small curated event list db.addEvent() maintains --
// distinct from the full raw application log served by /api/logs. This is
// what the Dashboard's Recent Activity panel scrolls through.
router.get('/current', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const { events, total } = db.getEventsPage(limit, offset);
  res.json({ ok: true, events, total, hasMore: offset + events.length < total });
});

module.exports = router;
