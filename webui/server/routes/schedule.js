// GardenPi Control v2.0.0 — server/routes/schedule.js
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const logger = require('../logger');
const scheduler = require('../scheduler');
const valvesConfig = require('../config').load().valves;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validate(entry) {
  if (!valvesConfig.some(v => v.id === entry.valveId)) return 'Unknown valve.';
  if (typeof entry.dayOfWeek !== 'number' || entry.dayOfWeek < 0 || entry.dayOfWeek > 6) return 'Day of week must be 0 (Sun) through 6 (Sat).';
  if (!TIME_RE.test(entry.start)) return 'Start time must be in HH:MM (24-hour) format.';
  if (!Number.isFinite(entry.durationSeconds) || entry.durationSeconds < 30 || entry.durationSeconds > 3600) {
    return 'Duration must be between 30 seconds and 60 minutes.';
  }
  return null;
}

router.get('/', (req, res) => {
  const entries = scheduler.status().map(e => ({
    ...e,
    dayName: DAY_NAMES[e.dayOfWeek],
    valveName: (valvesConfig.find(v => v.id === e.valveId) || {}).name || e.valveId
  }));
  res.json({ ok: true, schedule: entries, days: DAY_NAMES });
});

router.post('/', (req, res, next) => {
  try {
    const body = req.body || {};
    const entry = {
      id: uuidv4(),
      valveId: body.valveId,
      dayOfWeek: Number(body.dayOfWeek),
      start: body.start,
      durationSeconds: Number(body.durationSeconds),
      enabled: body.enabled !== false
    };
    const problem = validate(entry);
    if (problem) return res.json({ ok: false, message: problem });

    const all = db.getSchedule();
    all.push(entry);
    db.saveSchedule(all);
    logger.info('Schedule entry created', entry);
    db.addEvent({ type: 'schedule_updated', message: `Added watering window for ${entry.valveId}` });
    res.json({ ok: true, entry });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', (req, res, next) => {
  try {
    const all = db.getSchedule();
    const idx = all.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.json({ ok: false, message: 'Schedule entry not found.' });

    const merged = { ...all[idx], ...req.body, id: all[idx].id };
    merged.dayOfWeek = Number(merged.dayOfWeek);
    merged.durationSeconds = Number(merged.durationSeconds);
    const problem = validate(merged);
    if (problem) return res.json({ ok: false, message: problem });

    all[idx] = merged;
    db.saveSchedule(all);
    logger.info('Schedule entry updated', merged);
    db.addEvent({ type: 'schedule_updated', message: `Updated watering window for ${merged.valveId}` });
    res.json({ ok: true, entry: merged });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    const all = db.getSchedule();
    const idx = all.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.json({ ok: false, message: 'Schedule entry not found.' });
    const [removed] = all.splice(idx, 1);
    db.saveSchedule(all);
    logger.info('Schedule entry deleted', removed);
    db.addEvent({ type: 'schedule_updated', message: `Removed watering window for ${removed.valveId}` });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
