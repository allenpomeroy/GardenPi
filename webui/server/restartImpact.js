// GardenPi Control v2.3.0 — server/restartImpact.js
//
// Works out which gardenpi-* services must be restarted for a garden.json
// change to take effect, and keeps a small persistent "restart needed" list
// (<data_dir>/pending-restarts.json) that the Services card shows until each
// service has actually been restarted -- by the web UI, from ssh, or by a
// reboot. A service counts as restarted once systemd reports it (re)started
// after the save that flagged it.
//
// Every service reads garden.json once, at startup; none reloads it live.
// The rules below come from which config keys each program actually reads
// (bin/*.py and webui/server/config.js). Two notable cases:
//   - Friendly names are never used by the handlers, so renaming an ADC
//     channel only needs the API (it returns them as channel_name), and
//     renaming a relay needs the API and the web UI (valve names). Weather
//     input names aren't read by any service at all: the Dashboard reads
//     them from garden.json directly (server/sensorLabels.js).
//   - weewx.* and other values the browser reads straight from garden.json
//     need no restart.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

const INIT = 'gardenpi-init.service';
const LEDS = 'gardenpi-leds.service';
const ADC = 'gardenpi-adc.service';
const IRRIGATION = 'gardenpi-irrigation.service';
const WEATHER = 'gardenpi-weather.service';
const API = 'gardenpi-api.service';
const WEBUI = 'gardenpi-webui.service';
const ORDER = [INIT, LEDS, ADC, IRRIGATION, WEATHER, API, WEBUI];
const HANDLERS = [LEDS, ADC, IRRIGATION, WEATHER];

// Values this app manages itself, or that nothing reads at runtime.
function ignored(p) {
  const last = String(p[p.length - 1] ?? '');
  if (last.startsWith('comment')) return true;
  if (p[0] === 'config' && ['config_version', 'code_version', 'last_changed', 'version'].includes(p[1])) return true;
  return false;
}

// path (array of keys/indexes) -> { services: [...units], reason: 'text' }
function rule(p) {
  const [a, b, c, , e] = p;
  const r = (services, reason) => ({ services, reason });

  if (a === 'config') {
    if (b === 'global_log_level') return r([INIT, ...HANDLERS, API, WEBUI], 'global log level');
    if (b === 'socket_timeout') return r([...HANDLERS, API], 'socket timeout');
    if (b === 'tls_cert_file' || b === 'tls_key_file') return r([API, WEBUI], 'TLS certificate');
    return r([], null); // name, application user/group, repo URL: install-time only
  }

  if (a === 'hardware') {
    if (b === 'picontroller') return r([INIT, LEDS, ADC, WEATHER], 'PiController hardware');
    if (b === 'powercontroller') return r([IRRIGATION], 'PowerController hardware');
    if (b === 'raspberrypi') return r([WEATHER], 'Raspberry Pi pins');
    return r([INIT, ...HANDLERS], 'hardware');
  }

  if (a === 'handlers') {
    if (b === 'adc') {
      if (c === 'channel_map') {
        return e === 'friendly' ? r([API], 'ADC channel names') : r([ADC, API, WEATHER], 'ADC channel IDs');
      }
      if (c === 'socket') return r([ADC, API, WEATHER], 'ADC socket');
      if (c === 'log_level') return r([ADC], 'ADC log level');
      return r([ADC], 'ADC settings');
    }
    if (b === 'irrigation') {
      if (c === 'relay_map') {
        return e === 'friendly' ? r([API, WEBUI], 'relay names') : r([IRRIGATION, API, WEBUI], 'relay IDs');
      }
      if (c === 'socket') return r([IRRIGATION, API], 'irrigation socket');
      if (c === 'valid_relay_actions') return r([API], 'valid relay actions');
      if (['max_valve_run_time', 'allow_concurrent_valves', 'no_timeout_relays'].includes(c)) return r([IRRIGATION, WEBUI], 'irrigation safety settings');
      if (c === 'log_level') return r([IRRIGATION], 'irrigation log level');
      return r([IRRIGATION], 'irrigation settings');
    }
    if (b === 'leds') {
      if (c === 'led_map') return r([LEDS, API, WEBUI], 'LED labels');
      if (c === 'socket') return r([LEDS, API, WEATHER], 'LED socket');
      if (c === 'log_level') return r([LEDS], 'LED log level');
      return r([LEDS], 'LED settings');
    }
    if (b === 'weather') {
      if (c === 'input_map') {
        return e === 'friendly' ? r([], null) : r([WEATHER], 'weather input IDs');
      }
      if (c === 'sensor_map') return r([WEATHER], 'weather sensor labels');
      if (c === 'socket') return r([WEATHER, API], 'weather socket');
      if (c === 'weather_file') return r([WEATHER, API], 'weather file');
      if (c === 'log_level') return r([WEATHER], 'weather log level');
      return r([WEATHER], 'weather settings');
    }
    if (b === 'api') {
      if (c === 'token') return r([API, WEBUI], 'API access token');
      if (c === 'log_level') return r([API], 'API log level');
      return r([API], 'API settings');
    }
    return r([...HANDLERS, API], `handlers.${b}`);
  }

  if (a === 'webui') return r([WEBUI], 'web UI settings');
  if (a === 'weewx') return r([], null); // read live by the browser
  return r([ORDER.slice(1)].flat(), `${a} settings`); // unknown top-level key: be safe
}

// Every leaf path that differs between two JSON values (added, removed or
// changed). Arrays are compared index by index; a length change reports the
// array's own path (so its rule applies to the whole list).
function changedPaths(before, after, base = [], out = []) {
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) { out.push(base); return out; }
    for (let i = 0; i < before.length; i++) changedPaths(before[i], after[i], [...base, i], out);
    return out;
  }
  if (isObj(before) && isObj(after)) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      changedPaths(before[k], after[k], [...base, k], out);
    }
    return out;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) out.push(base);
  return out;
}

// -> [{ unit, reasons: [...] }] in startup order.
function servicesAffected(before, after) {
  const byUnit = new Map();
  for (const p of changedPaths(before || {}, after || {})) {
    if (ignored(p)) continue;
    const { services, reason } = rule(p);
    for (const unit of services) {
      if (!byUnit.has(unit)) byUnit.set(unit, new Set());
      if (reason) byUnit.get(unit).add(reason);
    }
  }
  return ORDER.filter(u => byUnit.has(u)).map(unit => ({ unit, reasons: [...byUnit.get(unit)] }));
}

// ---- persistent pending list: { "<unit>": { since: ISO, reasons: [...] } }
function pendingPath() {
  return path.join(config.load().server.dataDir, 'pending-restarts.json');
}
function readPending() {
  try { return JSON.parse(fs.readFileSync(pendingPath(), 'utf8')) || {}; }
  catch { return {}; }
}
function writePending(pending) {
  try {
    const p = pendingPath();
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(pending, null, 2));
    fs.renameSync(tmp, p);
  } catch (err) {
    logger.warn('Could not write pending-restarts.json', { error: err.message });
  }
}

// Called after a successful save. Merges reasons for units already pending;
// `since` is the time of this save, so a restart must come after it.
function recordPending(affected, whenIso = new Date().toISOString()) {
  if (!affected.length) return;
  const pending = readPending();
  for (const { unit, reasons } of affected) {
    const prev = pending[unit];
    pending[unit] = { since: whenIso, reasons: [...new Set([...(prev?.reasons || []), ...reasons])] };
  }
  writePending(pending);
}

// Given current service states ({ unit, since } with since = when systemd
// last started it), drops entries that have been satisfied and returns the
// remaining pending map. Restarting gardenpi-init also restarts the four
// handlers (they Require= it), which systemd reflects in their own `since`.
function resolvePending(services) {
  const pending = readPending();
  let changed = false;
  for (const svc of services) {
    const p = pending[svc.unit];
    if (!p) continue;
    // systemd start times have 1-second resolution; compare at that
    // resolution so a restart in the same second as the save counts.
    const savedAtSec = Math.floor(new Date(p.since).getTime() / 1000) * 1000;
    if (svc.since && new Date(svc.since).getTime() >= savedAtSec) {
      delete pending[svc.unit];
      changed = true;
    }
  }
  if (changed) writePending(pending);
  return pending;
}

module.exports = {
  ORDER,
  servicesAffected,
  recordPending,
  readPending,
  resolvePending,
  _internal: { changedPaths, rule, ignored }
};
