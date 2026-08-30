// GardenPi Control v1.12.0 — scripts/seed-schedule.js
// One-time helper to load a sample watering schedule
// into data/schedule.json, so the Schedule tab starts
// populated instead of empty.
// Run once with: node scripts/seed-schedule.js
// Safe to re-run: it OVERWRITES data/schedule.json, so
// back it up first if you've already made changes in
// the UI that you want to keep.

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function entry(valveId, day, start, minutes) {
  return { id: uuidv4(), valveId, dayOfWeek: DAY[day], start, durationSeconds: minutes * 60, enabled: true };
}

const schedule = [
  // Magnolia: Sun/Mon/Tue/Fri 06:00-06:05, 06:07-06:09
  ...['Sun', 'Mon', 'Tue', 'Fri'].flatMap(d => [
    entry('magnolia', d, '06:00', 5),
    entry('magnolia', d, '06:07', 2)
  ]),

  // Plants: Sat/Tue/Wed/Thu/Fri/Sun 07:00-07:02, 07:05-07:07 (2 min each)
  ...['Sat', 'Sun', 'Tue', 'Wed', 'Thu', 'Fri'].flatMap(d => [
    entry('plants', d, '07:00', 2),
    entry('plants', d, '07:05', 2)
  ]),

  // Nearbed
  entry('nearbed', 'Sat', '07:10', 2),
  entry('nearbed', 'Sat', '07:13', 2),
  entry('nearbed', 'Mon', '07:10', 1),
  entry('nearbed', 'Mon', '07:13', 1),
  entry('nearbed', 'Wed', '07:10', 2),
  entry('nearbed', 'Wed', '07:13', 2),
  entry('nearbed', 'Thu', '07:10', 1),
  entry('nearbed', 'Thu', '07:13', 1),

  // Farbed
  entry('farbed', 'Sat', '07:20', 2),
  entry('farbed', 'Sat', '07:25', 2),
  entry('farbed', 'Mon', '07:20', 1),
  entry('farbed', 'Mon', '07:25', 2),
  entry('farbed', 'Wed', '07:20', 2),
  entry('farbed', 'Wed', '07:25', 2),
  entry('farbed', 'Thu', '07:20', 1),
  entry('farbed', 'Thu', '07:25', 1)
];

const dataDir = require('../server/config').load().server.dataDir;
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'schedule.json'), JSON.stringify(schedule, null, 2));
console.log(`Wrote ${schedule.length} schedule entries to ${path.join(dataDir, 'schedule.json')}`);
