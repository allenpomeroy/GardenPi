// GardenPi Control v2.0.0 — server/routes/valves.js
const express = require('express');
const router = express.Router();
const gardenApi = require('../gardenApiClient');
const valveControl = require('../valveControl');
const valvesConfig = require('../config').load().valves;

router.get('/', async (req, res, next) => {
  try {
    const statuses = await gardenApi.listValveStatus();
    const byId = Object.fromEntries(statuses.map(s => [s.id, s]));
    const merged = valvesConfig.map(v => ({
      id: v.id,
      name: v.name,
      location: v.location,
      type: v.type,
      state: byId[v.id]?.state || 'unknown',
      since: byId[v.id]?.since || null
    }));
    res.json({ ok: true, valves: merged });
  } catch (err) {
    next(err);
  }
});

// Safety-net "stop all irrigation" -- maps to the Garden Controller's
// { relay: "all", action: "off" } behavior. Does not affect pumps.
router.post('/off-all', async (req, res, next) => {
  try {
    await valveControl.turnOffAll('manual');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/on', async (req, res, next) => {
  try {
    const cfg = valvesConfig.find(v => v.id === req.params.id);
    if (!cfg) return res.json({ ok: false, message: 'Unknown valve.' });
    const runForMinutes = Number(req.body?.runForMinutes) || undefined;
    const result = await valveControl.turnOn(cfg.id, cfg.name, { runForMinutes, source: 'manual' });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/off', async (req, res, next) => {
  try {
    const cfg = valvesConfig.find(v => v.id === req.params.id);
    if (!cfg) return res.json({ ok: false, message: 'Unknown valve.' });
    const result = await valveControl.turnOff(cfg.id, cfg.name, { source: 'manual' });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
