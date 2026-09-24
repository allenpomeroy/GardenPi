// GardenPi Control v2.3.0 — server/routes/status.js
//
// v2.3.0 2026/09/24
// - added `sensorLabels` (server/sensorLabels.js): the Dashboard's sensor
//   names, read fresh from garden.json, so renames show up without a
//   restart and the Weather section uses the configured friendly names.
// v2.1.0 2026/09/23
// - added `host.uptimeSeconds` / `host.bootTime` for the topbar uptime badge.
//   Taken from this process's host (os.uptime(), i.e. /proc/uptime), which
//   is the Pi itself -- the web UI always runs on the controller.
const os = require('os');
const express = require('express');
const router = express.Router();
const gardenApi = require('../gardenApiClient');
const db = require('../db');
const scheduler = require('../scheduler');
const valvesConfig = require('../config').load().valves;
const { getSensorLabels } = require('../sensorLabels');

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
      host: {
        uptimeSeconds: Math.floor(os.uptime()),
        bootTime: new Date(Date.now() - os.uptime() * 1000).toISOString()
      },
      system,
      valves,
      leds,
      sensors,
      sensorLabels: getSensorLabels(),
      events: db.getEvents(20),
      schedulerActive: scheduler.status().some(e => e.currentlyRunning)
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
