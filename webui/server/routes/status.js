// GardenPi Control v2.0.0 — server/routes/status.js
const express = require('express');
const router = express.Router();
const gardenApi = require('../gardenApiClient');
const db = require('../db');
const scheduler = require('../scheduler');
const valvesConfig = require('../config').load().valves;

// One aggregated, near-real-time snapshot for the dashboard/irrigation tab to poll.
router.get('/all', async (req, res, next) => {
  try {
    const [valveStatuses, leds, sensors, system] = await Promise.all([
      gardenApi.listValveStatus().catch(() => []),
      gardenApi.getLeds().catch(() => []),
      gardenApi.getSensors().catch(() => null),
      gardenApi.getSystemStatus().catch(() => ({ online: false }))
    ]);

    const byId = Object.fromEntries(valveStatuses.map(s => [s.id, s]));
    const valves = valvesConfig.map(v => ({
      id: v.id, name: v.name, location: v.location, type: v.type,
      state: byId[v.id]?.state || 'unknown',
      since: byId[v.id]?.since || null
    }));

    res.json({
      ok: true,
      apiMode: gardenApi.mode,
      system,
      valves,
      leds,
      sensors,
      events: db.getEvents(20),
      schedulerActive: scheduler.status().some(e => e.currentlyRunning)
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
