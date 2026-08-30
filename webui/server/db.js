// GardenPi Control v2.0.0 — server/db.js
// Minimal JSON-file datastore. Avoids native-module build dependencies (important on
// a Raspberry Pi) while still persisting users, sessions, and the watering
// schedule across restarts. Not intended for high write concurrency, which
// this app doesn't need.
//
// IMPORTANT: this is the ONLY place dynamic/runtime data (users, sessions,
// the watering schedule, activity events) is read or written. None of it
// ever lives in garden.json -- that file is configuration only (see
// server/config.js, and the Configuration page, which is now the ONLY
// place app settings like session timeout/poll interval/guardrails are
// edited - there is no separate Settings page or settings.json anymore),
// and garden.json may be shared with/read by other GardenPi services, so
// it must never contain per-user secrets (password hashes!) or
// fast-changing runtime state.
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const config = require('./config').load();

const DATA_DIR = config.server.dataDir;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
  users: path.join(DATA_DIR, 'users.json'),
  sessions: path.join(DATA_DIR, 'sessions.json'),
  schedule: path.join(DATA_DIR, 'schedule.json'),
  events: path.join(DATA_DIR, 'events.json')
};

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    logger.error('Failed to read datastore file, using fallback', { file, error: err.message });
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.error('Failed to write datastore file', { file, error: err.message });
  }
}

// ---- Users ----
function getUsers() { return readJson(FILES.users, []); }
function saveUsers(users) { writeJson(FILES.users, users); }
function hasAnyUser() { return getUsers().length > 0; }

// ---- Sessions ----
function getSessions() { return readJson(FILES.sessions, {}); }
function saveSessions(sessions) { writeJson(FILES.sessions, sessions); }

// ---- Schedule ----
// Each entry: { id, valveId, dayOfWeek (0=Sun..6=Sat), start "HH:MM", durationSeconds, enabled }
function getSchedule() { return readJson(FILES.schedule, []); }
function saveSchedule(entries) { writeJson(FILES.schedule, entries); }

// ---- Recent activity events (curated, human-readable feed shown on the
// dashboard -- newest first. Distinct from the full raw application log.) ----
const MAX_EVENTS = 500; // generous ring buffer so there's real history to scroll through
function addEvent(evt) {
  const events = readJson(FILES.events, []);
  events.unshift(Object.assign({ ts: new Date().toISOString() }, evt));
  writeJson(FILES.events, events.slice(0, MAX_EVENTS));
}
function getEvents(limit = 50) {
  return readJson(FILES.events, []).slice(0, limit);
}
// Paged access for the dashboard's scrollable activity feed: events are
// already stored newest-first, so offset 0 is the most recent page.
function getEventsPage(limit = 20, offset = 0) {
  const all = readJson(FILES.events, []);
  return { events: all.slice(offset, offset + limit), total: all.length };
}

module.exports = {
  getUsers, saveUsers, hasAnyUser,
  getSessions, saveSessions,
  getSchedule, saveSchedule,
  addEvent, getEvents, getEventsPage
};
