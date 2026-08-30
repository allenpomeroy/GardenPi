// GardenPi Control v2.0.0 — server/gardenApiClient.js
// Adapter between this web app and the real Garden Controller REST API,
// matching the README you provided: Bearer-token auth, relay-based irrigation
// control (POST /api/irrigation {relay, action}), LED control the same way,
// an ADC endpoint for sensor voltages, a separate weather-station endpoint,
// and a no-auth /api/health for handler status. Every id sent to or read
// from the API is a user_id when one is defined, else a hardware_id -- see
// server/config.js, which resolves that once so this module never has to.
//
// Set gardenApi.mock=true in garden.json to run against a realistic in-memory
// simulation instead of the physical controller -- handy for developing/demoing
// the UI without hardware.
const axios = require('axios');
const https = require('https');
const logger = require('./logger');
const config = require('./config').load();
const valves = config.valves;
const leds = config.leds;

const BASE_URL = config.gardenApi.baseUrl;
const TIMEOUT_MS = config.gardenApi.timeoutMs;
const MOCK = !!config.gardenApi.mock;
const TOKEN = config.gardenApi.token || '';
// The controller's own dev/production TLS cert is frequently self-signed (the
// README's own examples use `curl -k`). Default to accepting it, but let an
// operator require a valid chain once they've installed a real certificate.
const REJECT_UNAUTHORIZED = !!config.gardenApi.tlsRejectUnauthorized;

const client = axios.create({
  baseURL: BASE_URL,
  timeout: TIMEOUT_MS,
  headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
  httpsAgent: new https.Agent({ rejectUnauthorized: REJECT_UNAUTHORIZED })
});

const VALVE_TYPES = { valve: valves.filter(v => v.type === 'valve'), pump: valves.filter(v => v.type === 'pump') };

// ---------------------------------------------------------------------------
// Mock simulation (used when MOCK_API=true, or automatically as a fallback if
// the real controller cannot be reached, so the UI stays useful during outages)
// ---------------------------------------------------------------------------
const mockState = {
  valves: Object.fromEntries(valves.map(v => [v.id, { state: 'off', since: new Date().toISOString() }])),
  // LEDs: track a real on/off/blink token per physical LED (not just boolean), since
  // e.g. the irrigation group's green LED means different things solid vs blinking.
  leds: Object.fromEntries(leds.map(l => [l.id, (l.color === 'blue') ? 'on' : 'off'])),
  weather: {
    timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
    windspeed_mph: 3.2, rain_inches: 0.0, daylight_lux: 12543.0, pressure_v: 2.91,
    moisture1_v: 1.84, moisture2_v: 2.13, moisture3_v: 1.97, wind_dir_deg: 180.0,
    int_temp_c: 24.1, int_temp_f: 75.4, int_humidity: 48.2,
    ext_temp_c: 31.7, ext_temp_f: 89.1, ext_humidity: 51.6
  }
};

function mockDelay() { return new Promise(res => setTimeout(res, 40 + Math.random() * 60)); }

async function mockListValveStatus() {
  await mockDelay();
  return valves.map(v => ({ id: v.id, name: v.name, type: v.type, ...mockState.valves[v.id] }));
}
// Recompute the Irrigation LED group whenever a valve's state changes: solid blue
// when idle/ready, blinking green while a valve is actually running.
function mockRecomputeIrrigationLed() {
  const anyValveOn = valves.some(v => v.type === 'valve' && mockState.valves[v.id]?.state === 'on');
  mockState.leds.led2blue = anyValveOn ? 'off' : 'on';
  mockState.leds.led2green = anyValveOn ? 'blink' : 'off';
  mockState.leds.led2red = 'off';
}
async function mockSetValve(id, on) {
  await mockDelay();
  mockState.valves[id] = { state: on ? 'on' : 'off', since: new Date().toISOString() };
  mockRecomputeIrrigationLed();
  return { id, ...mockState.valves[id] };
}
async function mockTurnOffAll() {
  await mockDelay();
  for (const v of valves) mockState.valves[v.id] = { state: 'off', since: new Date().toISOString() };
  mockRecomputeIrrigationLed();
  return { results: Object.fromEntries(valves.map(v => [v.id, { relay: v.id, state: 'off' }])), success: true };
}
async function mockLeds() {
  await mockDelay();
  return leds.map(l => ({ id: l.id, group: l.group, color: l.color, state: mockState.leds[l.id] || 'off' }));
}
async function mockSensors() {
  await mockDelay();
  return {
    adc: {
      channels: {
        '0': { channel_name: 'soil_moisture', value: 2.4 + Math.random() * 0.4 },
        '1': { channel_name: 'light', value: 1.6 + Math.random() * 0.6 },
        '2': { channel_name: 'pressure', value: 3.2 + Math.random() * 0.2 }
      },
      errors: null
    },
    weather: mockState.weather
  };
}
async function mockSystemStatus() {
  await mockDelay();
  return { status: 'ok', service: 'garden-api', version: '1.0', handlers: { adc: true, irrigation: true, leds: true, weather: true } };
}

// ---------------------------------------------------------------------------
// Friendly-error translation for the real API's documented status codes
// ---------------------------------------------------------------------------
function translateError(err, context) {
  const status = err.response?.status;
  const body = err.response?.data;
  let message;

  if (!status) {
    message = 'The Garden Controller is not responding right now. Please check the device and network.';
  } else if (status === 401) {
    message = 'The Garden Controller rejected our request: no API token was sent. Check GARDENAPI_TOKEN.';
  } else if (status === 403) {
    message = 'The Garden Controller rejected our API token as invalid. Check GARDENAPI_TOKEN.';
  } else if (status === 503) {
    message = 'A Garden Controller service is temporarily unavailable (its handler may be restarting).';
  } else if (status === 500) {
    message = 'The Garden Controller reported an internal error handling that request.';
  } else if (status === 404) {
    message = 'That information is not available from the Garden Controller yet.';
  } else if (status === 400) {
    message = body?.error || 'The Garden Controller rejected that request as invalid.';
  } else {
    message = 'The Garden Controller returned an unexpected response.';
  }

  logger.error(`GardenAPI call failed: ${context}`, { status, body, error: err.message });
  return Object.assign(new Error(message), { code: 'GARDENAPI_UNREACHABLE', cause: `${context}: HTTP ${status || 'n/a'} ${JSON.stringify(body || err.message)}` });
}

async function safeCall(context, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.code === 'GARDENAPI_UNREACHABLE') throw err; // already a specific, friendly error -- pass through as-is
    if (MOCK) throw new Error('Simulated GardenAPI error'); // shouldn't normally hit in mock mode
    throw translateError(err, context);
  }
}

// ---------------------------------------------------------------------------
// Real API calls
// ---------------------------------------------------------------------------
function relayLookup(internalId) {
  const cfg = valves.find(v => v.id === internalId);
  if (!cfg) throw new Error(`Unknown valve/pump id: ${internalId}`);
  return cfg.id;
}

async function realListValveStatus() {
  // Prefer one bulk call; if the shape doesn't look like relay results, fall back
  // to querying each relay individually (the README documents the single-relay
  // response shape explicitly: { relay, state }, but not the bulk "status all" shape).
  try {
    const res = await client.get('/api/irrigation/status');
    logger.debug('Raw bulk irrigation status response', { data: res.data });
    const byRelay = extractRelayStates(res.data);
    if (Object.keys(byRelay).length > 0) {
      return valves.map(v => ({
        id: v.id, name: v.name, type: v.type,
        state: byRelay[v.id] || 'unknown',
        since: null
      }));
    }
    logger.warn('Bulk irrigation status response did not match any known shape, falling back to per-relay status');
  } catch (err) {
    logger.warn('Bulk irrigation status call failed, falling back to per-relay status', { error: err.message });
  }

  const results = await Promise.all(valves.map(async v => {
    try {
      const res = await client.get('/api/irrigation/status', { params: { relay: v.id } });
      logger.debug('Raw per-relay status response', { relay: v.id, data: res.data });
      const state = extractRelayStates(res.data)[v.id] || 'unknown';
      return { id: v.id, name: v.name, type: v.type, state, since: null };
    } catch (err) {
      logger.error('Per-relay status call failed', { relay: v.id, error: err.message });
      return { id: v.id, name: v.name, type: v.type, state: 'unknown', since: null };
    }
  }));
  return results;
}

// Best-effort parse of whatever shape a bulk relay-status response takes.
// Handles a `{ results: { relayName: { state } } }` wrapper (matching the
// documented "turn all off" response) as well as a flatter `{ relayName: state }`.
function extractRelayStates(data) {
  const out = {};
  if (!data) return out;
  const relayNames = valves.map(v => v.id);
  const source = data.results || data;
  for (const name of relayNames) {
    const entry = source?.[name];
    if (entry == null) continue;
    const state = extractStateToken(entry);
    if (state) out[name] = state;
  }
  return out;
}

// Pulls an "on"/"off" (or blink-style) token out of a variety of plausible
// response shapes, since the API docs don't pin down every field name used by
// every handler response. Checks, in order: a bare string; `.state`; `.status`;
// `.output` (text like "ON"/"OFF"); a boolean `.on`. Returns null (not a
// default) when nothing matches, so callers can tell "confirmed off" apart
// from "couldn't tell" -- these must never be treated the same way.
function extractStateToken(entry) {
  if (entry == null) return null;
  let raw = null;
  if (typeof entry === 'string') raw = entry;
  else if (typeof entry.state === 'string') raw = entry.state;
  else if (typeof entry.status === 'string') raw = entry.status;
  else if (typeof entry.output === 'string') raw = entry.output;
  else if (typeof entry.on === 'boolean') raw = entry.on ? 'on' : 'off';
  if (raw == null) return null;
  const lower = raw.toLowerCase();
  if (lower.includes('blink')) return 'blink';
  if (lower.includes('on')) return 'on';
  if (lower.includes('off')) return 'off';
  return null;
}

async function realSetValve(internalId, on) {
  const relay = relayLookup(internalId);
  const res = await client.post('/api/irrigation', { relay, action: on ? 'on' : 'off' });
  logger.debug('Raw irrigation POST response', { relay, action: on ? 'on' : 'off', data: res.data });

  // The handler can return HTTP 200 with `success: false` (e.g. hardware rejected
  // the command) -- axios won't treat that as an error, so check explicitly.
  if (res.data && res.data.success === false) {
    throw Object.assign(
      new Error(res.data.error || `The Garden Controller rejected the request for ${internalId}.`),
      { code: 'GARDENAPI_UNREACHABLE' }
    );
  }

  // The POST response shape for /api/irrigation isn't fully specified in the
  // API docs, so don't just assume the command took effect -- read back the
  // relay's own status right after and use THAT as the source of truth.
  let confirmedState = null;
  try {
    const statusRes = await client.get('/api/irrigation/status', { params: { relay } });
    logger.debug('Raw per-relay status response after command', { relay, data: statusRes.data });
    // The real controller returns the SAME flat map shape for a single-relay
    // query as it does for the bulk query (e.g. `{ "mag": "off" }`), not a
    // `{ relay, state }` object -- so parse it with the same relay-map
    // extractor and pull out this one relay, rather than treating the whole
    // response as a single entry.
    confirmedState = extractRelayStates(statusRes.data)[relay] || null;
  } catch (err) {
    logger.warn('Could not verify valve state after sending command', { relay, error: err.message });
  }

  const expected = on ? 'on' : 'off';

  // Critical: if we couldn't determine a state at all, do NOT assume success.
  // A false "it worked" with a status indicator that never updates is worse
  // than a clear error -- fail loud instead, and point at debug logging so the
  // actual response shape can be seen and the parser above adjusted if needed.
  if (confirmedState === null) {
    throw Object.assign(
      new Error(`Sent the ${expected} command for ${internalId}, but couldn't read back a clear state from the controller to confirm it took effect. Set LOG_LEVEL=debug and check the logs for the raw response, then verify manually.`),
      { code: 'GARDENAPI_UNREACHABLE' }
    );
  }
  if (confirmedState !== expected) {
    throw Object.assign(
      new Error(`The Garden Controller accepted the command, but ${internalId} still reports "${confirmedState}". Check the controller/hardware.`),
      { code: 'GARDENAPI_UNREACHABLE' }
    );
  }

  return { id: internalId, state: confirmedState, since: new Date().toISOString() };
}

async function realTurnOffAll() {
  const res = await client.post('/api/irrigation', { relay: 'all', action: 'off' });
  logger.debug('Raw "turn off all" response', { data: res.data });
  return res.data;
}

async function realGetLeds() {
  try {
    const res = await client.get('/api/leds/status');
    logger.debug('Raw bulk LED status response', { data: res.data });
    const parsed = extractLedStates(res.data);
    if (Object.keys(parsed).length > 0) {
      return leds.map(l => ({ id: l.id, group: l.group, color: l.color, state: parsed[l.id] || 'unknown' }));
    }
    logger.warn('Bulk LED status response did not match any known shape, falling back to per-LED status');
  } catch (err) {
    logger.warn('Bulk LED status call failed, falling back to per-LED status', { error: err.message });
  }

  const results = await Promise.all(leds.map(async l => {
    try {
      const res = await client.get('/api/leds/status', { params: { led: l.id } });
      logger.debug('Raw per-LED status response', { led: l.id, data: res.data });
      // Single-LED queries use the same { status: { <id>: {effect, state} } }
      // wrapper as the bulk call, so reuse the same map-extractor here too.
      const state = extractLedStates(res.data)[l.id] || 'unknown';
      return { id: l.id, group: l.group, color: l.color, state };
    } catch (err) {
      logger.error('Per-LED status call failed', { led: l.id, error: err.message });
      return { id: l.id, group: l.group, color: l.color, state: 'unknown' };
    }
  }));
  return results;
}

// The real controller wraps LED status in a `status` object keyed by LED id,
// each with an `effect` (e.g. "static", "active (patternblink-led2green-3)")
// and an instantaneous `state` ("on"/"off"). Blink detection MUST come from
// `effect`, not the momentary `state` -- a blinking LED's `state` toggles
// on/off every poll, so treating that as the source of truth would make a
// blinking LED flicker between "on" and "off" in the UI instead of showing
// a steady "blinking" indicator.
function extractLedStates(data) {
  const out = {};
  if (!data) return out;
  const source = data.status || data.results || data;
  for (const l of leds) {
    const entry = source?.[l.id];
    const state = normalizeLedEntry(entry);
    if (state) out[l.id] = state;
  }
  return out;
}

function normalizeLedEntry(entry) {
  if (entry == null) return null;
  if (typeof entry === 'string') {
    const lower = entry.toLowerCase();
    if (lower.includes('blink')) return 'blink';
    if (lower.includes('on')) return 'on';
    if (lower.includes('off')) return 'off';
    return null;
  }
  const effect = typeof entry.effect === 'string' ? entry.effect.toLowerCase() : '';
  const state = typeof entry.state === 'string' ? entry.state.toLowerCase() : '';
  if (effect.includes('blink')) return 'blink';
  if (state === 'on') return 'on';
  if (state === 'off') return 'off';
  return null;
}

async function realGetSensors() {
  const [adcResult, weatherResult] = await Promise.allSettled([
    client.get('/api/adc', { params: { channel: 'all' } }),
    client.get('/api/weather', { params: { last: 1 } })
  ]);

  const adc = adcResult.status === 'fulfilled'
    ? { channels: adcResult.value.data.channels || {}, errors: adcResult.value.data.errors || null }
    : { channels: {}, errors: [{ error: 'ADC data unavailable' }] };

  if (adcResult.status === 'rejected') {
    logger.warn('ADC read failed', { error: adcResult.reason?.message });
  }

  const weather = weatherResult.status === 'fulfilled'
    ? (weatherResult.value.data.reading || null)
    : null;

  if (weatherResult.status === 'rejected') {
    logger.warn('Weather read failed', { error: weatherResult.reason?.message });
  }

  return { adc, weather };
}

async function realGetSystemStatus() {
  const res = await client.get('/api/health');
  return res.data;
}

const gardenApi = {
  mode: MOCK ? 'mock' : 'live',

  async listValveStatus() {
    if (MOCK) return mockListValveStatus();
    return safeCall('listValveStatus', realListValveStatus);
  },

  async setValve(id, on) {
    if (MOCK) return mockSetValve(id, on);
    return safeCall(`setValve(${id},${on})`, () => realSetValve(id, on));
  },

  async turnOffAllValves() {
    if (MOCK) return mockTurnOffAll();
    return safeCall('turnOffAllValves', realTurnOffAll);
  },

  async getLeds() {
    if (MOCK) return mockLeds();
    return safeCall('getLeds', realGetLeds);
  },

  async getSensors() {
    if (MOCK) return mockSensors();
    // Sensor reads are best-effort by design (see realGetSensors) so a single
    // flaky channel never blanks the whole dashboard -- don't wrap in safeCall.
    return realGetSensors();
  },

  async getSystemStatus() {
    if (MOCK) return mockSystemStatus();
    return safeCall('getSystemStatus', realGetSystemStatus).catch(() => ({ status: 'degraded', handlers: {} }));
  }
};

module.exports = gardenApi;
