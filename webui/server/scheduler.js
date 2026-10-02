// GardenPi Control v2.0.0 — server/scheduler.js
// In-app watering scheduler. Replaces the old crontab + bash-wrapper approach with
// entries stored in data/schedule.json, editable from the Schedule tab in the UI.
//
// Design notes:
//  - A tick runs every 15 seconds and checks whether "now" falls inside any enabled
//    schedule window (day-of-week + start time + duration).
//  - If a window should be active but another valve is running (manual or another
//    schedule), the start is DEFERRED (retried every tick) rather than force-stopping
//    the other valve -- this avoids surprising a person mid-task. A deferred/missed
//    run is logged so it's visible on the dashboard activity feed.
//  - The scheduler only ever turns off a valve that IT turned on, so it never
//    interferes with a manual run you started by hand.
//  - "Skip next": an entry with skipNext=true carries skipRunAt, the ISO start
//    time of the one occurrence to skip (set by routes/schedule.js when the box
//    is ticked). When that window arrives the valve is NOT started, skipNext is
//    reset to false (so the box unticks itself) and a "skipped" event is logged.
//    skipRunAt is kept until the window ends so the scheduler doesn't start the
//    valve on the next tick, then removed. If the Pi was off or the entry was
//    disabled during the skipped window, the stale flag is cleared afterwards
//    rather than silently skipping the following week too.
//  - Rain delay (data/rain-delay.json): while active, no window whose start
//    time falls before the delay's end is started, and any window the
//    scheduler is running when the delay is set is stopped. Each suppressed
//    window is logged once. Manual runs are never touched. A window that began
//    during the delay is not started part-way through when the delay ends.
const db = require('./db');
const logger = require('./logger');
const valveControl = require('./valveControl');
const valves = require('./config').load().valves;

const TICK_MS = 15 * 1000;
let timer = null;

// entryId -> { valveId, endsAtMs }  (windows currently running, started by the scheduler)
const runningByScheduler = new Map();
// entryId -> true, so we only log a "deferred" event once per blocked attempt, not every tick
const deferredWarned = new Set();
// "entryId|occurrenceISO" of windows already skipped, so re-ticking Skip next
// during a skipped window (which retargets skipRunAt to next week) can't let the
// current window start part-way through.
const skippedWindows = new Set();
// "entryId|occurrenceISO" of windows already logged as rain-delayed.
const rainLogged = new Set();

function rainDelayUntilMs() {
  const d = db.getRainDelay();
  const ms = d && d.until ? new Date(d.until).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
}
function rainDelayActive(now = new Date()) { return now.getTime() < rainDelayUntilMs(); }

function nameFor(valveId) {
  return (valves.find(v => v.id === valveId) || {}).name || valveId;
}

function toMinutesOfDay(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Start time (Date) of the entry's occurrence on the same day as `now`.
function occurrenceStart(entry, now) {
  const [h, m] = entry.start.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d;
}

function windowEndMs(entry, startIso) {
  return new Date(startIso).getTime() + Math.ceil(entry.durationSeconds / 60) * 60 * 1000;
}

// Persist a change to one entry. Re-reads the file so concurrent UI edits made
// since this tick started aren't lost (all of this is synchronous, so nothing
// can interleave between the read and the write).
function patchEntry(id, changes) {
  const all = db.getSchedule();
  const idx = all.findIndex(e => e.id === id);
  if (idx === -1) return;
  const updated = { ...all[idx], ...changes };
  for (const [k, v] of Object.entries(changes)) if (v === undefined) delete updated[k];
  all[idx] = updated;
  db.saveSchedule(all);
}

// Handle the skip-next flag for one entry. Returns true if this tick must not
// start the valve for this entry.
function applySkip(entry, now, active) {
  const occKey = `${entry.id}|${occurrenceStart(entry, now).toISOString()}`;
  if (active && skippedWindows.has(occKey)) return true;
  if (!active) {
    for (const k of skippedWindows) if (k.startsWith(entry.id + '|')) skippedWindows.delete(k);
  }
  if (!entry.skipRunAt) {
    if (entry.skipNext) {
      // Flag set without a target occurrence (e.g. hand-edited schedule.json):
      // target the next occurrence that hasn't started yet.
      patchEntry(entry.id, { skipRunAt: computeNextRun(entry, now) });
    }
    return false;
  }
  const skipStartMs = new Date(entry.skipRunAt).getTime();
  if (now.getTime() < skipStartMs) return false;           // not reached yet

  const isThisOccurrence = active && occurrenceStart(entry, now).toISOString() === entry.skipRunAt;
  if (isThisOccurrence && entry.enabled !== false) {
    skippedWindows.add(occKey);
    if (entry.skipNext) {
      patchEntry(entry.id, { skipNext: false });
      logger.info('Scheduled watering skipped (Skip next)', { entryId: entry.id, valveId: entry.valveId, start: entry.skipRunAt });
      db.addEvent({ type: 'schedule_skipped', valveId: entry.valveId, valveName: nameFor(entry.valveId),
        message: `Skipped ${nameFor(entry.valveId)} watering at ${entry.start}` });
    }
    return true;
  }
  if (now.getTime() >= windowEndMs(entry, entry.skipRunAt)) {
    // The skipped window is over (or was missed entirely): tidy up.
    patchEntry(entry.id, { skipNext: false, skipRunAt: undefined });
  }
  return false;
}

function isWithinWindow(entry, now) {
  if (entry.dayOfWeek !== now.getDay()) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const startMin = toMinutesOfDay(entry.start);
  const endMin = startMin + Math.ceil(entry.durationSeconds / 60);
  return nowMin >= startMin && nowMin < endMin;
}

async function tick() {
  const now = new Date();
  const schedule = db.getSchedule();
  const rainUntil = rainDelayUntilMs();
  const rainNow = now.getTime() < rainUntil;

  for (const entry of schedule) {
    const active = isWithinWindow(entry, now);
    const alreadyRunning = runningByScheduler.has(entry.id);
    const occKey = `${entry.id}|${occurrenceStart(entry, now).toISOString()}`;
    if (!active) rainLogged.delete(occKey);

    // Rain delay set while the scheduler is running this window: stop it.
    if (alreadyRunning && rainNow) {
      const info = runningByScheduler.get(entry.id);
      try {
        await valveControl.turnOff(info.valveId, nameFor(info.valveId), { source: 'rain-delay' });
      } catch (err) {
        logger.error('Rain delay stop failed', { entryId: entry.id, error: err.message });
      } finally {
        runningByScheduler.delete(entry.id);
        deferredWarned.delete(entry.id);
        rainLogged.add(occKey);
      }
      continue;
    }

    // Skip housekeeping runs for disabled entries too, so stale flags clear.
    const skipped = !alreadyRunning && applySkip(entry, now, active);
    if (entry.enabled === false && !alreadyRunning) continue;

    // A window whose start time falls inside the rain delay doesn't run.
    const rainBlocked = active && !alreadyRunning && !skipped
      && occurrenceStart(entry, now).getTime() < rainUntil;
    if (rainBlocked) {
      if (!rainLogged.has(occKey)) {
        rainLogged.add(occKey);
        logger.info('Scheduled watering suppressed by rain delay', { entryId: entry.id, valveId: entry.valveId });
        db.addEvent({ type: 'schedule_rain_delayed', valveId: entry.valveId, valveName: nameFor(entry.valveId),
          message: `Rain delay: skipped ${nameFor(entry.valveId)} watering at ${entry.start}` });
      }
      continue;
    }

    if (active && !alreadyRunning && !skipped) {
      try {
        await valveControl.turnOn(entry.valveId, nameFor(entry.valveId), { source: 'schedule' });
        const startMin = toMinutesOfDay(entry.start);
        const endsAtMs = new Date(now).setHours(0, startMin + Math.ceil(entry.durationSeconds / 60), 0, 0);
        runningByScheduler.set(entry.id, { valveId: entry.valveId, endsAtMs });
        deferredWarned.delete(entry.id);
      } catch (err) {
        if (err.code === 'VALVE_CONFLICT' && !deferredWarned.has(entry.id)) {
          logger.warn('Scheduled watering deferred due to another active valve', {
            entryId: entry.id, valveId: entry.valveId, reason: err.message
          });
          db.addEvent({ type: 'schedule_deferred', valveId: entry.valveId, valveName: nameFor(entry.valveId), message: err.message });
          deferredWarned.add(entry.id);
        } else if (err.code !== 'VALVE_CONFLICT') {
          logger.error('Scheduled valve start failed', { entryId: entry.id, error: err.message });
        }
      }
    } else if (!active && alreadyRunning) {
      const info = runningByScheduler.get(entry.id);
      try {
        await valveControl.turnOff(info.valveId, nameFor(info.valveId), { source: 'schedule' });
      } catch (err) {
        logger.error('Scheduled valve stop failed', { entryId: entry.id, error: err.message });
      } finally {
        runningByScheduler.delete(entry.id);
        deferredWarned.delete(entry.id);
      }
    }
  }
}

function start() {
  if (timer) return;
  logger.info('Scheduler started', { tickSeconds: TICK_MS / 1000 });
  timer = setInterval(() => {
    tick().catch(err => logger.error('Scheduler tick failed', { error: err.message }));
  }, TICK_MS);
  tick().catch(err => logger.error('Scheduler initial tick failed', { error: err.message }));
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

// For the UI: what's the scheduler currently running, and what's the next window per valve?
function computeNextRun(entry, from = new Date()) {
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const d = new Date(from);
    d.setDate(d.getDate() + dayOffset);
    if (d.getDay() !== entry.dayOfWeek) continue;
    const [h, m] = entry.start.split(':').map(Number);
    d.setHours(h, m, 0, 0);
    if (d > from || dayOffset > 0) return d.toISOString();
  }
  return null;
}

// First occurrence at/after `from` that will actually run: not the skipped
// one and not starting inside the rain delay.
function effectiveNextRun(e, from, rainUntilMs) {
  let t = from;
  for (let i = 0; i < 60; i++) {
    const iso = computeNextRun(e, t);
    if (!iso) return null;
    const ms = new Date(iso).getTime();
    const isSkipped = e.skipNext && e.skipRunAt === iso;
    if (!isSkipped && ms >= rainUntilMs) return iso;
    t = new Date(ms + 60 * 1000);
  }
  return null;
}

function status() {
  const now = new Date();
  const schedule = db.getSchedule();
  const rainUntil = rainDelayUntilMs();
  return schedule.map(e => {
    const occKey = `${e.id}|${occurrenceStart(e, now).toISOString()}`;
    const nextRun = computeNextRun(e);
    const effective = effectiveNextRun(e, now, rainUntil);
    const skipping = (isWithinWindow(e, now) && skippedWindows.has(`${e.id}|${occurrenceStart(e, now).toISOString()}`))
      || !!(e.skipRunAt && now.getTime() >= new Date(e.skipRunAt).getTime()
        && now.getTime() < windowEndMs(e, e.skipRunAt));
    return {
      ...e,
      currentlyRunning: runningByScheduler.has(e.id),
      currentlySkipped: skipping && !runningByScheduler.has(e.id),
      currentlyRainDelayed: e.enabled !== false && !runningByScheduler.has(e.id) && isWithinWindow(e, now)
        && (rainLogged.has(occKey) || occurrenceStart(e, now).getTime() < rainUntil),
      nextRun,
      // The run that will actually happen next, if the next scheduled one
      // is cancelled by Skip next and/or the rain delay.
      effectiveNextRun: effective !== nextRun ? effective : null,
      nextRunReason: effective === nextRun ? null
        : (nextRun && new Date(nextRun).getTime() < rainUntil ? 'rain' : 'skip')
    };
  });
}

function rainDelay() {
  const d = db.getRainDelay();
  if (!d || !rainDelayActive()) return { active: false };
  return { active: true, until: d.until, setAt: d.setAt, setBy: d.setBy };
}

module.exports = { start, stop, status, computeNextRun, rainDelay, rainDelayActive };
