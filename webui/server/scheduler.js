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

function nameFor(valveId) {
  return (valves.find(v => v.id === valveId) || {}).name || valveId;
}

function toMinutesOfDay(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
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
  const schedule = db.getSchedule().filter(e => e.enabled !== false);

  for (const entry of schedule) {
    const active = isWithinWindow(entry, now);
    const alreadyRunning = runningByScheduler.has(entry.id);

    if (active && !alreadyRunning) {
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

function status() {
  const schedule = db.getSchedule();
  return schedule.map(e => ({
    ...e,
    currentlyRunning: runningByScheduler.has(e.id),
    nextRun: computeNextRun(e)
  }));
}

module.exports = { start, stop, status };
