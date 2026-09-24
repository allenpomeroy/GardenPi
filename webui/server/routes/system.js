// GardenPi Control v2.1.0 — server/routes/system.js
//
// Backs the Services card on the Configuration page:
//   GET  /api/system/services                   status of every gardenpi-* unit
//   POST /api/system/services/restart-all       restart every long-running unit
//   POST /api/system/services/restart-needed    restart only units flagged by config saves
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
const restartImpact = require('../restartImpact');

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

// Restarts just the services flagged "restart needed" by config saves, in
// startup order, the web UI last (after the response). If gardenpi-init is
// among them, the four handlers are skipped: systemd restarts them along
// with init because they Require= it.
router.post('/services/restart-needed', async (req, res, next) => {
  try {
    const listing = await systemControl.listServices(); // also clears satisfied entries
    if (!listing.ok) return res.json({ ok: false, message: listing.message });
    let units = listing.services.filter(s => s.restartNeeded && s.installed).map(s => s.unit);
    if (!units.length) return res.json({ ok: true, restarted: [], message: 'No services need a restart.' });

    if (units.includes('gardenpi-init.service')) {
      units = units.filter(u => !['gardenpi-leds.service', 'gardenpi-adc.service',
        'gardenpi-irrigation.service', 'gardenpi-weather.service'].includes(u));
    }
    const includeSelf = units.includes(systemControl.SELF_UNIT);
    const others = restartImpact.ORDER.filter(u => units.includes(u) && u !== systemControl.SELF_UNIT);

    const restarted = [];
    for (const unit of others) {
      try {
        await systemControl.restartService(unit);
        restarted.push(unit);
        db.addEvent({ type: 'service_restart', unit, source: who(req), message: `${unit} restarted (${who(req)})` });
      } catch (err) {
        return res.json({
          ok: false,
          restarted,
          message: `${err.message}${restarted.length ? ` (already restarted: ${restarted.join(', ')})` : ''}`
        });
      }
    }

    if (includeSelf) {
      await systemControl.scheduleSelfRestart();
      db.addEvent({ type: 'service_restart', unit: systemControl.SELF_UNIT, source: who(req), message: `${systemControl.SELF_UNIT} restarted (${who(req)})` });
    }
    const names = [...restarted, ...(includeSelf ? [systemControl.SELF_UNIT] : [])].map(u => u.replace(/\.service$/, ''));
    res.json({
      ok: true,
      restarted,
      selfRestarting: includeSelf,
      message: `Restarted ${names.join(', ')}.${includeSelf ? ' This page will reconnect in a few seconds.' : ''}`
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
