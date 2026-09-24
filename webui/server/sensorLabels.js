// GardenPi Control v2.3.0 — server/sensorLabels.js
//
// Dashboard sensor labels, resolved from garden.json AS IT IS ON DISK NOW
// (re-read whenever the file's mtime changes), not from anything cached at
// startup. A rename on the Configuration page therefore shows up on the
// Dashboard on the next status poll, without restarting any service.
//
//   adc:     keyed by the channel's display id (what the API uses as the
//            key in /api/adc?channel=all: user_id if set, else hardware_id)
//            AND by hardware_id, each -> { hardwareId, name }.
//   weather: keyed by the field name /api/weather returns (moisture1_v,
//            ext_temp_f, ...) -> { sensorId, name }, following
//            sensor_map -> source/source_id -> the owning table's friendly
//            name (ADC Channel Labels for source "adc", Weather Input
//            Labels for source "weather") -- the same rule the
//            Configuration page's Sensor Labels table uses.
//
// hardwareId / sensorId are what the Dashboard keys its show/hide choices
// on, so those survive renames too.
const fs = require('fs');
const { CONFIG_PATH } = require('./config');

// Same table as KNOWN_FIELD_RENAMES in bin/api.py (sensor_map id -> the field
// name /api/weather returns). Sensors not listed pass through the API under
// their own sensor_map id, so that's the fallback here too.
const WEATHER_FIELD_BY_SENSOR = {
  s_wind_speed: 'windspeed_mph',
  s_rain: 'rain_inches',
  s_daylight: 'daylight_lux',
  s_pressure: 'pressure_v',
  s_moisture1: 'moisture1_v',
  s_moisture2: 'moisture2_v',
  s_moisture3: 'moisture3_v',
  s_wind_dir: 'wind_dir_deg',
  s_int_temp: 'int_temp_f',
  s_int_humidity: 'int_humidity',
  s_ext_temp: 'ext_temp_f',
  s_ext_humidity: 'ext_humidity'
};

let cache = { mtimeMs: -1, size: -1, labels: { adc: {}, weather: {} } };

// A source_id may name either the owning entry's user_id or its hardware_id.
function findOwner(list, token) {
  if (!Array.isArray(list) || !token) return null;
  return list.find(e => e && e.user_id === token) || list.find(e => e && e.hardware_id === token) || null;
}

function build(cfg) {
  const handlers = cfg?.handlers || {};
  const channelMap = Array.isArray(handlers.adc?.channel_map) ? handlers.adc.channel_map : [];
  const inputMap = Array.isArray(handlers.weather?.input_map) ? handlers.weather.input_map : [];
  const sensorMap = (handlers.weather?.sensor_map && typeof handlers.weather.sensor_map === 'object') ? handlers.weather.sensor_map : {};

  const adc = {};
  for (const e of channelMap) {
    if (!e || !e.hardware_id) continue;
    const label = { hardwareId: e.hardware_id, name: e.friendly || e.user_id || e.hardware_id };
    adc[e.hardware_id] = label;
    if (e.user_id) adc[e.user_id] = label;
  }

  const weather = {};
  for (const [sensorId, entry] of Object.entries(sensorMap)) {
    if (!entry || typeof entry !== 'object') continue;
    const owner = entry.source === 'adc' ? findOwner(channelMap, entry.source_id)
      : entry.source === 'weather' ? findOwner(inputMap, entry.source_id)
      : null;
    const field = WEATHER_FIELD_BY_SENSOR[sensorId] || sensorId;
    weather[field] = { sensorId, name: owner?.friendly || null };
  }
  return { adc, weather };
}

// Never throws: on any read/parse problem the last good labels are kept
// (the Dashboard then falls back to its built-in names for anything missing).
function getSensorLabels() {
  try {
    const st = fs.statSync(CONFIG_PATH);
    if (st.mtimeMs !== cache.mtimeMs || st.size !== cache.size) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cache = { mtimeMs: st.mtimeMs, size: st.size, labels: build(cfg) };
    }
  } catch { /* keep the previous labels */ }
  return cache.labels;
}

module.exports = { getSensorLabels, WEATHER_FIELD_BY_SENSOR, _internal: { build, findOwner } };
