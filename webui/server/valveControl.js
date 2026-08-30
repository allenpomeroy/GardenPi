// GardenPi Control v2.0.0 — server/valveControl.js
// Shared valve-control logic used by both the manual API routes and the
// scheduler, so the concurrency guard rail is enforced in exactly one place.
const gardenApi = require('./gardenApiClient');
const db = require('./db');
const logger = require('./logger');
const config = require('./config').load();
const valvesConfig = config.valves;
const {
  maxRunSeconds: HARDWARE_MAX_RUN_SECONDS,
  allowConcurrentValves: ALLOW_CONCURRENT_VALVES,
  noTimeoutHardwareIds: NO_TIMEOUT_HARDWARE_IDS
} = config.irrigationPolicy;

const manualAutoOffTimers = new Map(); // valveId -> Timeout, for "run for N minutes" requests

function entryFor(id) {
  return valvesConfig.find(v => v.id === id) || {};
}
function typeOf(id) {
  return entryFor(id).type || 'valve';
}
// The physical relay hardware_id (e.g. "pump1", "pump2", "valve3") a given
// webui id currently maps to, resolved against the irrigation handler's own
// relay_map (see server/config.js) -- NOT the customer-facing id/name,
// which can be relabeled. Hardware-level rules (below) key off this instead
// of the id, so they keep applying to the correct physical relay even after
// a relabel (e.g. renaming the "pump1" relay's user_id to "outsidelights").
function hardwareIdOf(id) {
  return entryFor(id).hardwareId || null;
}

function conflictError(activeValveName) {
  return Object.assign(
    new Error(`${activeValveName} is currently running. Turn it off before starting another valve.`),
    { code: 'VALVE_CONFLICT' }
  );
}

// Only irrigation valves are mutually exclusive -- pumps can run alongside a
// valve, matching how the physical controller is wired.
async function getActiveValve(excludeId = null) {
  const statuses = await gardenApi.listValveStatus();
  return statuses.find(v => v.state === 'on' && v.id !== excludeId && typeOf(v.id) === 'valve') || null;
}

async function anyValveOn() {
  const statuses = await gardenApi.listValveStatus();
  return statuses.some(v => v.state === 'on' && typeOf(v.id) === 'valve');
}

// The physical "pump2" relay may only run while an irrigation valve is on --
// the irrigation handler does not enforce this itself, so it's enforced
// here. The "pump1" relay has no such restriction and can run any time, for
// any length of time (see the no-timeout check below too). This is an
// application-level business rule, not something garden.json declares, so
// it's keyed directly to the "pump2" hardware_id.
function requiresValveRunning(id) {
  return hardwareIdOf(id) === 'pump2';
}

function pump2RequiresValveError() {
  return Object.assign(
    new Error('Pump 2 can only run while an irrigation valve is on.'),
    { code: 'VALVE_CONFLICT' }
  );
}

// Finds whichever configured id currently occupies a given hardware_id
// (e.g. "pump2"), so the auto-off-when-last-valve-stops logic below works
// even if that relay has been relabeled to a different user_id/friendly name.
function idForHardwareId(hardwareId) {
  const entry = valvesConfig.find(v => v.hardwareId === hardwareId);
  return entry ? entry.id : null;
}

async function turnOn(valveId, valveName, { runForMinutes, source = 'manual' } = {}) {
  // handlers.irrigation.allow_concurrent_valves is the ground-truth switch
  // for this rule -- this app does not maintain a separate opinion about it.
  if (typeOf(valveId) === 'valve' && !ALLOW_CONCURRENT_VALVES) {
    const active = await getActiveValve(valveId);
    if (active) throw conflictError(active.name || active.id);
  }

  if (requiresValveRunning(valveId) && !(await anyValveOn())) {
    throw pump2RequiresValveError();
  }

  await gardenApi.setValve(valveId, true);
  db.addEvent({ type: 'valve_on', valveId, valveName, source });
  logger.info('Valve turned on', { valveId, valveName, source, runForMinutes });

  clearAutoOff(valveId);

  // The irrigation handler's own no-timeout list (e.g. the "pump1" relay)
  // is the hard ground truth for "never auto-shutoff this relay" -- checked
  // by hardware_id, not by id, so it survives relabeling.
  const hardwareId = hardwareIdOf(valveId);
  if (hardwareId && NO_TIMEOUT_HARDWARE_IDS.includes(hardwareId)) {
    return { valveId, state: 'on' };
  }

  // Always cap the run at handlers.irrigation.max_valve_run_time - there is
  // no separate app-level cap layered on top of it (the Settings page that
  // used to hold one is gone; this garden.json value is the single source
  // of truth, edited on the Configuration page).
  const hardwareMaxMinutes = HARDWARE_MAX_RUN_SECONDS / 60;
  const effectiveMinutes = Math.min(runForMinutes || hardwareMaxMinutes, hardwareMaxMinutes);
  if (effectiveMinutes && effectiveMinutes > 0) {
    const ms = effectiveMinutes * 60 * 1000;
    const timer = setTimeout(() => {
      turnOff(valveId, valveName, { source: 'auto-safety-timeout' }).catch(err =>
        logger.error('Auto safety shutoff failed', { valveId, error: err.message })
      );
    }, ms);
    manualAutoOffTimers.set(valveId, timer);
  }

  return { valveId, state: 'on' };
}

async function turnOff(valveId, valveName, { source = 'manual' } = {}) {
  await gardenApi.setValve(valveId, false);
  clearAutoOff(valveId);
  db.addEvent({ type: 'valve_off', valveId, valveName, source });
  logger.info('Valve turned off', { valveId, valveName, source });

  // Enforce the pump2 dependency the other direction too: if this was an
  // irrigation valve and it was the last one running, and whatever id
  // currently occupies the "pump2" hardware_id is on, stop it as well --
  // the irrigation handler won't do this automatically.
  if (typeOf(valveId) === 'valve') {
    try {
      const pump2Id = idForHardwareId('pump2');
      if (pump2Id) {
        const statuses = await gardenApi.listValveStatus();
        const stillHasValveOn = statuses.some(v => v.state === 'on' && typeOf(v.id) === 'valve');
        const pump2Status = statuses.find(v => v.id === pump2Id);
        if (!stillHasValveOn && pump2Status?.state === 'on') {
          const pump2Name = entryFor(pump2Id).name || pump2Id;
          await gardenApi.setValve(pump2Id, false);
          clearAutoOff(pump2Id);
          db.addEvent({ type: 'valve_off', valveId: pump2Id, valveName: pump2Name, source: 'auto-safety (no valve running)' });
          logger.info(`${pump2Name} automatically turned off (no irrigation valve is running)`);
        }
      }
    } catch (err) {
      logger.error('Failed to enforce pump2 dependency rule after valve turned off', { error: err.message });
    }
  }

  return { valveId, state: 'off' };
}

function clearAutoOff(valveId) {
  const t = manualAutoOffTimers.get(valveId);
  if (t) {
    clearTimeout(t);
    manualAutoOffTimers.delete(valveId);
  }
}

// Safety-net control: stop every configured relay at once, matching the API's
// `{ relay: "all", action: "off" }` behavior. This sends "off" to every
// configured relay -- which includes both pump slots, not just irrigation
// valves -- so this is a full irrigation+pump e-stop.
async function turnOffAll(source = 'manual') {
  const result = await gardenApi.turnOffAllValves();
  for (const v of valvesConfig) clearAutoOff(v.id);
  db.addEvent({ type: 'valve_off_all', source });
  logger.info('All relays (valves and pumps) turned off', { source });
  return result;
}

module.exports = { turnOn, turnOff, turnOffAll, getActiveValve };
