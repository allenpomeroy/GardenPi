// GardenPi Control v2.1.0 — server/routes/system.js
//
// Backs the Services card on the Configuration page:
//   GET  /api/system/services                   status of every gardenpi-* unit
//   POST /api/system/services/restart-all       restart every long-running unit
//   POST /api/system/services/:unit/restart     restart one unit
//   POST /api/system/reboot                     reboot the Pi
//   POST /api/system/shutdown                   power off the Pi via scripts/pijuice-safe-shutdown.py
//
// All mounted behind requireAuth (server/index.js). See server/systemControl.js
// for the sudo model. There is intentionally no "stop" endpoint.
const express = require('express');
const router = express.Router();
const db = require('../db');
const logger = require('../logger');
const systemControl = require('../systemControl');
const valveControl = require('../valveControl');

function who(req) { return req.session?.username || 'unknown'; }

router.get('/services', async (req, res, next) => {
  try {
    res.json(await systemControl.listServices());
  } catch (err) { next(err); }
});

// Must be declared before '/services/:unit/restart' so "restart-all" isn't
// taken for a unit name.
router.post('/services/restart-all', async (req, res, next) => {
  try {
    await systemControl.scheduleRestartAll();
    db.addEvent({ type: 'service_restart_all', source: who(req), message: `All GardenPi services restarted (${who(req)})` });
    res.json({
      ok: true,
      selfRestarting: true,
      message: 'Restarting all GardenPi services. This page will reconnect when the web UI is back (usually 10-30 seconds).'
    });
  } catch (err) { next(err); }
});

router.post('/services/:unit/restart', async (req, res, next) => {
  try {
    const svc = systemControl.findService(req.params.unit);
    if (!svc) return res.json({ ok: false, message: `"${req.params.unit}" is not a GardenPi service.` });

    if (svc.unit === systemControl.SELF_UNIT) {
      await systemControl.scheduleSelfRestart();
      db.addEvent({ type: 'service_restart', unit: svc.unit, source: who(req), message: `${svc.unit} restarted (${who(req)})` });
      return res.json({
        ok: true,
        selfRestarting: true,
        message: 'Restarting the web UI. This page will reconnect in a few seconds.'
      });
    }

    await systemControl.restartService(svc.unit);
    db.addEvent({ type: 'service_restart', unit: svc.unit, source: who(req), message: `${svc.unit} restarted (${who(req)})` });
    res.json({ ok: true, message: `${svc.unit} restarted.` });
  } catch (err) { next(err); }
});

// Before the Pi goes down, stop every valve/pump through the API so nothing
// is left running on relays that the irrigation handler is about to stop
// supervising. Best effort, time-boxed: an unreachable API must not block
// a reboot the person explicitly asked for.
async function stopAllRelaysBestEffort(reason) {
  try {
    await Promise.race([
      valveControl.turnOffAll(reason),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 5000))
    ]);
    return true;
  } catch (err) {
    logger.warn('Could not stop all relays before power action; continuing anyway', { reason, error: err.message });
    return false;
  }
}

function powerRoute(action, verb) {
  return async (req, res, next) => {
    try {
      // Checks sudo permission first -- don't stop the irrigation for a
      // reboot that sudo is going to refuse anyway.
      await systemControl.checkPowerAllowed(action);
      const relaysStopped = await stopAllRelaysBestEffort(`system ${verb}`);
      systemControl.schedulePower(action);
      db.addEvent({ type: `system_${action}`, source: who(req), message: `System ${verb} requested (${who(req)})` });
      logger.warn(`System ${verb} requested via web UI`, { username: who(req), relaysStopped });
      res.json({
        ok: true,
        relaysStopped,
        message: action === 'reboot'
          ? 'Rebooting. This page will reconnect when the Pi is back up (usually 1-2 minutes).'
          : 'Shutting down. The PiJuice will cut power about 60 seconds after the Pi halts, and will turn it back on when external power is present and the battery is charging (5% or more).'
      });
    } catch (err) { next(err); }
  };
}

router.post('/reboot', powerRoute('reboot', 'reboot'));
router.post('/shutdown', powerRoute('poweroff', 'shutdown'));

module.exports = router;
