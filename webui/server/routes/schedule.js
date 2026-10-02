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

// Keep skipRunAt (the ISO start of the one occurrence to skip) consistent with
// skipNext. `prev` is the stored entry before this change (null on create).
//  - ticking Skip next targets the next occurrence that hasn't started yet, so
//    ticking it while that window is already running skips NEXT week's run;
//  - unticking it cancels the pending skip (only on a real true->false change,
//    so the scheduler's own auto-reset during a skipped window is preserved);
//  - editing the day or start time of a skipped entry retargets the skip.
function reconcileSkip(entry, prev) {
  entry.skipNext = entry.skipNext === true;
  const wasSkip = !!(prev && prev.skipNext);
  const timingChanged = prev && (prev.dayOfWeek !== entry.dayOfWeek || prev.start !== entry.start);
  if (entry.skipNext && (!wasSkip || timingChanged || !entry.skipRunAt)) {
    entry.skipRunAt = scheduler.computeNextRun(entry);
  } else if (!entry.skipNext && (wasSkip || timingChanged)) {
    delete entry.skipRunAt;
  }
}

router.get('/', (req, res) => {
  const entries = scheduler.status().map(e => ({
    ...e,
    dayName: DAY_NAMES[e.dayOfWeek],
    valveName: (valvesConfig.find(v => v.id === e.valveId) || {}).name || e.valveId
  }));
  res.json({ ok: true, schedule: entries, days: DAY_NAMES, rainDelay: scheduler.rainDelay() });
});

// ---- Rain delay: pause all scheduled watering until a point in time ----
const MAX_RAIN_DELAY_DAYS = 30;

router.get('/rain-delay', (req, res) => {
  res.json({ ok: true, rainDelay: scheduler.rainDelay() });
});

// Body: { days: 1..30 } (that many 24-hour periods from now), or
//       { until: ISO } (e.g. midnight at the end of a chosen date).
router.put('/rain-delay', (req, res, next) => {
  try {
    const body = req.body || {};
    const now = Date.now();
    let untilMs;
    if (body.days !== undefined) {
      const days = Number(body.days);
      if (!Number.isFinite(days) || days <= 0 || days > MAX_RAIN_DELAY_DAYS) {
        return res.json({ ok: false, message: `Rain delay must be between 1 and ${MAX_RAIN_DELAY_DAYS} days.` });
      }
      untilMs = now + days * 24 * 60 * 60 * 1000;
    } else if (body.until !== undefined) {
      untilMs = new Date(body.until).getTime();
      if (!Number.isFinite(untilMs) || untilMs <= now) {
        return res.json({ ok: false, message: 'Rain delay end must be in the future.' });
      }
      if (untilMs > now + (MAX_RAIN_DELAY_DAYS + 1) * 24 * 60 * 60 * 1000) {
        return res.json({ ok: false, message: `Rain delay can be at most ${MAX_RAIN_DELAY_DAYS} days.` });
      }
    } else {
      return res.json({ ok: false, message: 'Give the rain delay as a number of days or an end date.' });
    }
    const delay = { until: new Date(untilMs).toISOString(), setAt: new Date(now).toISOString(), setBy: req.session?.username || 'unknown' };
    db.saveRainDelay(delay);
    logger.info('Rain delay set', delay);
    db.addEvent({ type: 'rain_delay_set', until: delay.until, source: delay.setBy });
    res.json({ ok: true, rainDelay: scheduler.rainDelay() });
  } catch (err) {
    next(err);
  }
});

router.delete('/rain-delay', (req, res, next) => {
  try {
    const wasActive = scheduler.rainDelayActive();
    db.saveRainDelay(null);
    if (wasActive) {
      logger.info('Rain delay cancelled', { by: req.session?.username });
      db.addEvent({ type: 'rain_delay_cleared', source: req.session?.username || 'unknown' });
    }
    res.json({ ok: true, rainDelay: scheduler.rainDelay() });
  } catch (err) {
    next(err);
  }
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
      enabled: body.enabled !== false,
      skipNext: body.skipNext === true
    };
    const problem = validate(entry);
    if (problem) return res.json({ ok: false, message: problem });
    reconcileSkip(entry, null);

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

    // skipRunAt is server-managed; never accept it from the client.
    const { skipRunAt, ...body } = req.body || {};
    const merged = { ...all[idx], ...body, id: all[idx].id };
    merged.dayOfWeek = Number(merged.dayOfWeek);
    merged.durationSeconds = Number(merged.durationSeconds);
    const problem = validate(merged);
    if (problem) return res.json({ ok: false, message: problem });
    reconcileSkip(merged, all[idx]);

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
