// GardenPi Control v2.0.0 — server/config.js
// Loads application configuration from a single SHARED file, by default
// /opt/gardenpi/config/garden.json. This file is not owned exclusively by
// this web UI -- it also holds `config`/`hardware`/`handlers` stanzas used
// by other GardenPi services (the ADC/LED/irrigation/weather handlers, the
// API itself, weewx, etc). This module:
//
//   1. Reads webui's OWN settings from the `webui` stanza (listen port,
//      API connection, valve/pump display metadata, default settings).
//   2. Treats the `config`, `hardware`, and `handlers` stanzas as GROUND
//      TRUTH for anything hardware- or handler-defined -- TLS cert/key
//      paths, the customer-configurable relay/channel labels the
//      irrigation/adc handlers actually accept, the relay safety limits,
//      and the LED list -- rather than letting the webui stanza duplicate
//      (and potentially drift from) those values.
//   3. Never reads or writes dynamic/runtime data (users, sessions, the
//      watering schedule, the activity log) from/to this file. That data
//      lives in its own persistent files under a data directory (see
//      server/db.js) -- garden.json is configuration only.
//
// This app talks to the physical controller EXCLUSIVELY through the API
// (see gardenApiClient.js) -- it never opens a handler socket or touches
// hardware directly.
//
// GARDEN_CONFIG_PATH overrides the file location -- a pointer to where
// configuration lives, not a configuration value itself, which is why it's
// the one thing still set outside garden.json (handy for local dev/testing).
const fs = require('fs');

const CONFIG_PATH = process.env.GARDEN_CONFIG_PATH || '/opt/gardenpi/config/garden.json';

// Raw defaults matching garden.json's real shape, used for any field the
// file omits, and as the full fallback (mock mode) if the file is missing
// or fails to parse -- the app stays usable rather than refusing to start.
const RAW_DEFAULTS = {
  config: {
    tls_cert_file: '/etc/pki/tls/certs/node.pem',
    tls_key_file: '/etc/pki/tls/private/node.key',
    global_log_level: 'info'
  },
  handlers: {
    irrigation: {
      max_valve_run_time: 1800,
      allow_concurrent_valves: false,
      no_timeout_relays: [],
      relay_map: [
        { hardware_id: 'valve1', user_id: 'farbed', friendly: 'Far Bed' },
        { hardware_id: 'valve2', user_id: 'nearbed', friendly: 'Near Bed' },
        { hardware_id: 'valve3', user_id: 'mag', friendly: 'Magnolia' },
        { hardware_id: 'valve4', user_id: 'plants', friendly: 'Plants' },
        { hardware_id: 'valve5', user_id: 'valve5', friendly: 'Valve 5' },
        { hardware_id: 'pump1', user_id: 'pump1', friendly: 'Pump 1' },
        { hardware_id: 'pump2', user_id: 'pump2', friendly: 'Pump 2' }
      ]
    },
    leds: {
      led_map: [
        { hardware_id: 'sysred', group: 'sys' }, { hardware_id: 'sysgreen', group: 'sys' }, { hardware_id: 'sysblue', group: 'sys' },
        { hardware_id: 'led1red', group: 'led1' }, { hardware_id: 'led1green', group: 'led1' }, { hardware_id: 'led1blue', group: 'led1' },
        { hardware_id: 'led2red', group: 'led2' }, { hardware_id: 'led2green', group: 'led2' }, { hardware_id: 'led2blue', group: 'led2' }
      ]
    },
    api: { token: '' }
  },
  webui: {
    listen_port: '8787',
    log_level: 'info',
    api_base_url: 'https://raspberrypi.local:5000',
    api_tls_reject: 'false',
    api_timeout_ms: '4000',
    mock_api: 'true',
    data_dir: '/opt/gardenpi/data/webui',
    log_dir: '/opt/gardenpi/webui/logs',
    irrigation: {
      valves: [
        { hardware_id: 'valve3', location: 'Front bed', type: 'valve' },
        { hardware_id: 'valve4', location: 'Patio pots', type: 'valve' },
        { hardware_id: 'valve2', location: 'Near bed', type: 'valve' },
        { hardware_id: 'valve1', location: 'Far bed', type: 'valve' },
        { hardware_id: 'valve5', location: 'Unassigned', type: 'valve' }
      ],
      pumps: [
        { hardware_id: 'pump1', location: 'Well/tank', type: 'pump' },
        { hardware_id: 'pump2', location: 'Well/tank', type: 'pump' }
      ]
    },
    settings: {
      session_timeout_minutes: 30,
      poll_interval_seconds: 3
    }
  }
};

// Maps the LED handler's internal group names to this app's display groups.
const LED_GROUP_DISPLAY = { sys: 'system', led1: 'sensors', led2: 'irrigation' };

function isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const key of Object.keys(override)) {
    out[key] = isPlainObject(base[key]) ? deepMerge(base[key], override[key]) : override[key];
  }
  return out;
}
function truthy(v, fallback) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  return String(v).toLowerCase() === 'true';
}
function numeric(v, fallback) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

// Looks up a handlers.irrigation.relay_map entry by hardware_id -- the
// only immutable identifier -- and returns its display id (user_id if
// defined, else hardware_id) plus friendly name. This is what lets
// hardware-level rules (the no-timeout pump, the safety-cap run time)
// keep applying to the correct physical relay even after a customer
// renames it (relabeling a relay only ever changes user_id/friendly,
// never hardware_id).
function relayMapEntry(relayMap, hardwareId) {
  return (relayMap || []).find(r => r.hardware_id === hardwareId) || null;
}
function displayId(entry, hardwareId) {
  return (entry && entry.user_id) ? entry.user_id : hardwareId;
}

function deriveLeds(handlers) {
  const ledMap = handlers?.leds?.led_map || [];
  return ledMap.map(def => {
    const id = def.hardware_id;
    const color = id.endsWith('red') ? 'red' : id.endsWith('green') ? 'green' : id.endsWith('blue') ? 'blue' : 'unknown';
    const group = LED_GROUP_DISPLAY[def.group] || def.group || 'system';
    // LEDs have no user_id (hardware_id and led labels are read-only) --
    // the hardware_id itself is always what's shown and sent to the API.
    return { id, hardwareId: id, group, color };
  });
}

function deriveValves(webui, handlers) {
  const relayMap = handlers?.irrigation?.relay_map || [];
  const valves = webui?.irrigation?.valves || [];
  const pumps = webui?.irrigation?.pumps || [];
  return [...valves, ...pumps].map(v => {
    const entry = relayMapEntry(relayMap, v.hardware_id);
    const id = displayId(entry, v.hardware_id); // user_id if defined, else hardware_id
    return {
      id, // the identifier used in all API calls and as this app's own key
      hardwareId: v.hardware_id, // immutable, read-only
      name: entry?.friendly || id,
      location: v.location,
      type: v.type
    };
  });
}

let cached = null;

function load() {
  if (cached) return cached;

  let fileConfig = {};
  let loadedFrom = null;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    fileConfig = JSON.parse(raw);
    loadedFrom = CONFIG_PATH;
  } catch (err) {
    // Logged via console, not the winston logger: logger.js reads its log
    // directory from this module, so it can't be relied on yet at this point.
    console.error(
      `[config] Could not read/parse ${CONFIG_PATH} (${err.code || err.message}). ` +
      'Falling back to built-in defaults (mock mode). Copy garden.example.json to ' +
      `${CONFIG_PATH} and edit it to configure GardenPi Control.`
    );
  }

  const raw = deepMerge(RAW_DEFAULTS, fileConfig);
  const webui = raw.webui;
  const handlers = raw.handlers;

  cached = {
    raw, // full merged garden.json, in case anything needs a field not surfaced below

    server: {
      // TLS cert/key are SYSTEM-wide ground truth (config.*), not webui-owned.
      tlsCertPath: raw.config.tls_cert_file,
      tlsKeyPath: raw.config.tls_key_file,
      port: numeric(webui.listen_port, 8787),
      // Dynamic data (users/sessions/schedule/events) lives under this
      // directory, in its own files -- never inline in garden.json.
      dataDir: webui.data_dir,
      logDir: webui.log_dir,
      // Prefer webui's own log level; fall back to the system-wide default.
      logLevel: webui.log_level || raw.config.global_log_level || 'info'
    },

    gardenApi: {
      baseUrl: webui.api_base_url,
      // Ground truth is the API handler's own token; webui doesn't keep
      // an independent copy that could drift out of sync.
      token: handlers.api.token || webui.api_token || '',
      tlsRejectUnauthorized: truthy(webui.api_tls_reject, false),
      timeoutMs: numeric(webui.api_timeout_ms, 4000),
      mock: truthy(webui.mock_api, true)
    },

    // Session timeout / dashboard poll interval - edited on the
    // Configuration page (webui.settings in garden.json), not a separate
    // app-level Settings page/persisted file.
    settings: {
      sessionTimeoutMinutes: numeric(webui.settings?.session_timeout_minutes, 30),
      pollIntervalSeconds: numeric(webui.settings?.poll_interval_seconds, 3)
    },

    // `id` (user_id if defined, else hardware_id) is what's used in every
    // API call and as this app's own key; `hardwareId` is read-only
    // context for display. Location/type are webui-only display metadata.
    valves: deriveValves(webui, handlers),

    // LEDs are derived entirely from the LED handler's own led_map -- both
    // the map and hardware_id are read-only, so there's no id/user_id
    // split here.
    leds: deriveLeds(handlers),

    // Handler-level irrigation policy, used by valveControl.js: a relay
    // whose hardwareId is in noTimeoutHardwareIds never gets an auto-shutoff
    // timer (matches the irrigation handler's own no_timeout_relays); every
    // other relay's timer is capped at maxRunSeconds regardless of what a
    // (possibly misconfigured) app-level setting says. allowConcurrentValves
    // mirrors handlers.irrigation.allow_concurrent_valves exactly (this app
    // does not maintain its own separate copy of that rule).
    irrigationPolicy: {
      maxRunSeconds: numeric(handlers.irrigation.max_valve_run_time, 1800),
      allowConcurrentValves: truthy(handlers.irrigation.allow_concurrent_valves, false),
      noTimeoutHardwareIds: handlers.irrigation.no_timeout_relays || []
    },

    _meta: { configPath: CONFIG_PATH, loadedFromFile: loadedFrom !== null },

    // garden.json's own `config.version` -- the version of the shared
    // GardenPi config/system as a whole, distinct from this webui
    // package's own version (server/version.js). Surfaced separately so
    // the UI can show whichever one it prefers (see /api/version).
    configVersion: raw.config?.version || null
  };

  return cached;
}

module.exports = { load, CONFIG_PATH };
