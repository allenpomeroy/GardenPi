// GardenPi Control v2.0.0 — public/js/app.js
(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // Small API helper: every call returns { ok, message?, ...data }.
  // Network failures and non-2xx responses are both turned into a friendly
  // toast instead of a raw browser/HTTP error ever reaching the screen.
  // ---------------------------------------------------------------------
  async function api(path, options = {}) {
    try {
      const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        ...options
      });
      let data;
      try { data = await res.json(); }
      catch { data = { ok: false, message: 'The server sent an unexpected response.' }; }

      if (res.status === 401) {
        showToast('Your session has ended. Please sign in again.', 'error');
        showLogin();
        return { ok: false, message: 'Session expired' };
      }
      return data;
    } catch (err) {
      showToast('Unable to reach the server. Check your connection and try again.', 'error');
      return { ok: false, message: 'Network error' };
    }
  }

  function showToast(message, kind = 'info') {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = `toast ${kind}`;
    el.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.add('hidden'), 4000);
  }

  // ---------------------------------------------------------------------
  // Theme (light / dark / system), preference stored per-browser like the
  // dashboard widget/sensor prefs below. A tiny inline script in
  // index.html's <head> applies the saved choice before first paint (to
  // avoid a flash of the wrong theme); this is the single source of truth
  // for resolving it afterwards and for reacting to live OS-theme changes
  // and to the selector in the topbar.
  // ---------------------------------------------------------------------
  const THEME_KEY = 'gp_theme';
  const THEME_MEDIA = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function getThemePref() {
    try { return localStorage.getItem(THEME_KEY) || 'system'; }
    catch { return 'system'; }
  }
  function resolveTheme(pref) {
    if (pref === 'system') return THEME_MEDIA && THEME_MEDIA.matches ? 'dark' : 'light';
    return pref;
  }
  function applyTheme(pref) {
    const resolved = resolveTheme(pref);
    if (resolved === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    const select = document.getElementById('theme-select');
    if (select) select.value = pref;
  }
  function setThemePref(pref) {
    try { localStorage.setItem(THEME_KEY, pref); } catch { /* privacy mode, etc. */ }
    applyTheme(pref);
  }
  function initTheme() {
    applyTheme(getThemePref());
    document.getElementById('theme-select').addEventListener('change', (e) => {
      setThemePref(e.target.value);
    });
    // If the user picked "System", keep following the OS setting live.
    if (THEME_MEDIA && THEME_MEDIA.addEventListener) {
      THEME_MEDIA.addEventListener('change', () => {
        if (getThemePref() === 'system') applyTheme('system');
      });
    }
  }
  initTheme();

  // ---------------------------------------------------------------------
  // Boot / auth flow
  // ---------------------------------------------------------------------
  const screenSetup = document.getElementById('screen-setup');
  const screenLogin = document.getElementById('screen-login');
  const appEl = document.getElementById('app');

  function showOnly(el) {
    [screenSetup, screenLogin, appEl].forEach(s => s.classList.add('hidden'));
    el.classList.remove('hidden');
  }
  function showLogin() { showOnly(screenLogin); }
  function showSetup() { showOnly(screenSetup); }
  async function showApp() { showOnly(appEl); await loadRuntimeSettings(); startPolling(); }

  async function loadVersionBadge() {
    const result = await api('/api/version');
    const badge = document.getElementById('app-version-badge');
    // Shows garden.json's config.version (the shared GardenPi config/system
    // version), not this webui package's own version, so the badge tracks
    // whatever config revision the Pi is actually running.
    if (badge && result.ok) badge.textContent = result.configVersion ? `v${result.configVersion}` : '';
  }

  async function boot() {
    loadVersionBadge();
    const setupStatus = await api('/api/auth/setup-status');
    if (setupStatus.ok && !setupStatus.setupComplete) { showSetup(); return; }
    const me = await api('/api/auth/me');
    if (me.ok && me.authenticated) {
      document.getElementById('whoami').textContent = me.username;
      showApp();
    } else {
      showLogin();
    }
  }

  document.getElementById('form-setup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('setup-username').value.trim();
    const password = document.getElementById('setup-password').value;
    const password2 = document.getElementById('setup-password2').value;
    const errEl = document.getElementById('setup-error');
    errEl.textContent = '';
    if (password !== password2) { errEl.textContent = 'Passwords do not match.'; return; }
    const result = await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ username, password }) });
    if (!result.ok) { errEl.textContent = result.message || 'Could not create account.'; return; }
    document.getElementById('whoami').textContent = result.username;
    showApp();
  });

  document.getElementById('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');
    errEl.textContent = '';
    const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    if (!result.ok) { errEl.textContent = result.message || 'Sign-in failed.'; return; }
    document.getElementById('whoami').textContent = result.username;
    showApp();
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    stopPolling();
    showLogin();
  });

  // ---------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'schedule') loadSchedule();
      if (btn.dataset.tab === 'config') {
        document.getElementById('config-save-status').textContent = '';
        loadConfigTab();
      }
      if (btn.dataset.tab === 'irrigation') {
        // Refresh from garden.json so the "run for N minutes" input's
        // default/cap reflects the latest Max Valve Run Time, then
        // re-render immediately.
        loadRuntimeSettings().then(() => { if (lastStatus) renderValveCards(lastStatus); });
      }
    });
  });

  // ---------------------------------------------------------------------
  // Dashboard widgets (configurable, preference stored client-side)
  // ---------------------------------------------------------------------
  const WIDGET_DEFS = [
    { key: 'leds', label: 'System Status LEDs' },
    { key: 'valves', label: 'Valve Quick Status' },
    { key: 'sensors', label: 'Sensors' },
    { key: 'schedule', label: 'Scheduler & Controller Health' },
    { key: 'activity', label: 'Recent Activity' }
  ];
  const WIDGET_PREF_KEY = 'gp_dashboard_widgets';

  function getWidgetPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(WIDGET_PREF_KEY));
      if (saved) return saved;
    } catch { /* fall through to defaults */ }
    return Object.fromEntries(WIDGET_DEFS.map(w => [w.key, true]));
  }
  function saveWidgetPrefs(prefs) { localStorage.setItem(WIDGET_PREF_KEY, JSON.stringify(prefs)); }

  let widgetPrefs = getWidgetPrefs();

  function renderCustomizePanel() {
    const panel = document.getElementById('customize-panel');
    panel.innerHTML = WIDGET_DEFS.map(w => `
      <label><input type="checkbox" data-widget="${w.key}" ${widgetPrefs[w.key] ? 'checked' : ''}/> ${w.label}</label>
    `).join('');
    panel.querySelectorAll('input').forEach(cb => {
      cb.addEventListener('change', () => {
        widgetPrefs[cb.dataset.widget] = cb.checked;
        saveWidgetPrefs(widgetPrefs);
        renderDashboard(lastStatus);
      });
    });
  }
  document.getElementById('btn-customize').addEventListener('click', () => {
    document.getElementById('customize-panel').classList.toggle('hidden');
  });
  renderCustomizePanel();

  const LED_GROUP_META = {
    system:     { label: 'System' },
    sensors:    { label: 'Sensors' },
    irrigation: { label: 'Irrigation' }
  };

  // Label rules, per the spec: each group's active color maps to a status word;
  // Irrigation's green has two meanings depending on whether it's blinking.
  function ledStatusLabel(group, color, blinking) {
    if (!color) return 'Unknown';
    if (color === 'red') return 'Error';
    if (color === 'blue') return 'Running';
    // color === 'green'
    if (group === 'system') return 'Boot';
    if (group === 'sensors') return 'Initializing';
    if (group === 'irrigation') return blinking ? 'Valve on' : 'Initializing';
    return 'Unknown';
  }

  function renderLedWidget(ledList) {
    const groups = ['system', 'sensors', 'irrigation'];
    const rows = groups.map(group => {
      const members = (ledList || []).filter(l => l.group === group);
      // Prefer whichever LED in the group is actually lit (on or blinking).
      const active = members.find(l => l.state === 'on' || l.state === 'blink') || null;
      const blinking = active?.state === 'blink';
      const color = active?.color || null;
      const label = ledStatusLabel(group, color, blinking);
      const circleClass = color ? `${color}${blinking ? ' blink' : ''}` : '';
      return `
        <div class="led-row-v">
          <span class="led-circle ${circleClass}"></span>
          <div class="led-text">
            <span class="led-group-name">${LED_GROUP_META[group].label}</span>
            <span class="led-status-label">${label}</span>
          </div>
        </div>`;
    }).join('');
    return `<div class="widget"><h3>System Status LEDs</h3><div class="led-vertical">${rows}</div></div>`;
  }

  // ---------------------------------------------------------------------
  // Sensors widget: which individual sensor readings are shown is configurable
  // per-browser (localStorage), same idea as the top-level widget toggles but
  // scoped to items *within* the Sensors widget.
  // ---------------------------------------------------------------------
  const SENSOR_PREF_KEY = 'gp_sensor_prefs';
  function getSensorPrefs() {
    try { return JSON.parse(localStorage.getItem(SENSOR_PREF_KEY)) || {}; }
    catch { return {}; }
  }
  function saveSensorPrefs(prefs) { localStorage.setItem(SENSOR_PREF_KEY, JSON.stringify(prefs)); }
  let sensorPrefs = getSensorPrefs();
  let sensorConfigOpen = false;
  const knownSensorItems = new Map(); // key -> label, accumulates as sensors are seen

  const WEATHER_FIELD_DEFS = [
    ['ext_temp_f', 'Outside Temp', '°F'],
    ['ext_humidity', 'Outside Humidity', '%'],
    ['windspeed_mph', 'Wind Speed', 'mph'],
    ['wind_dir_deg', 'Wind Direction', '°'],
    ['rain_inches', 'Rain', 'in'],
    ['daylight_lux', 'Daylight', 'lux'],
    ['pressure_v', 'Pressure', 'V'],
    ['int_temp_f', 'Inside Temp', '°F'],
    ['int_humidity', 'Inside Humidity', '%'],
    ['moisture1_v', 'Soil Moisture 1', 'V'],
    ['moisture2_v', 'Soil Moisture 2', 'V'],
    ['moisture3_v', 'Soil Moisture 3', 'V']
  ];

  function collectSensorItems(sensors) {
    const items = [];
    if (!sensors) return items;
    Object.values(sensors.adc?.channels || {}).forEach(c => {
      const key = `adc:${c.channel_name || 'unknown'}`;
      items.push({ key, label: friendlyChannelName(c.channel_name), display: `${fmt3(c.value)} V` });
    });
    const w = sensors.weather;
    if (w) {
      WEATHER_FIELD_DEFS.forEach(([field, label, unit]) => {
        if (w[field] !== undefined && w[field] !== null) {
          items.push({ key: `weather:${field}`, label, display: `${fmt3(w[field])} ${unit}` });
        }
      });
    }
    return items;
  }

  function renderSensorsWidget(sensors) {
    const items = collectSensorItems(sensors);
    items.forEach(it => knownSensorItems.set(it.key, it.label));

    const visible = items.filter(it => sensorPrefs[it.key] !== false);
    const rows = visible.map(it => `
      <div class="mini-stat"><span>${it.label}</span><span class="val">${it.display}</span></div>
    `).join('') || '<p class="hint">No sensors selected to display.</p>';

    const errNote = sensors?.adc?.errors ? `<p class="valve-note">Some sensor channels could not be read.</p>` : '';

    const configOptions = Array.from(knownSensorItems.entries()).map(([key, label]) => `
      <label><input type="checkbox" data-sensor-toggle="${key}" ${sensorPrefs[key] !== false ? 'checked' : ''}/> ${label}</label>
    `).join('') || '<span class="hint">No sensors detected yet.</span>';

    return `<div class="widget">
      <div class="widget-header-row">
        <h3>Sensors</h3>
        <button class="btn-link-subtle" id="btn-sensor-configure" type="button">Configure</button>
      </div>
      <div id="sensor-configure-panel" class="customize-panel ${sensorConfigOpen ? '' : 'hidden'}">${configOptions}</div>
      ${rows}${errNote}
    </div>`;
  }

  function wireSensorWidgetControls() {
    const btn = document.getElementById('btn-sensor-configure');
    if (btn) {
      btn.addEventListener('click', () => {
        sensorConfigOpen = !sensorConfigOpen;
        renderDashboard(lastStatus);
      });
    }
    document.querySelectorAll('[data-sensor-toggle]').forEach(cb => {
      cb.addEventListener('change', () => {
        sensorPrefs[cb.dataset.sensorToggle] = cb.checked;
        saveSensorPrefs(sensorPrefs);
        renderDashboard(lastStatus);
      });
    });
  }

  function renderDashboard(status) {
    if (!status) return;
    const grid = document.getElementById('widget-grid');

    // The Recent Activity panel lives inside this same grid (so it can span 2
    // columns like a normal widget), but its content/scroll state must never
    // be wiped by the innerHTML rebuild below -- detach the actual DOM node
    // first and reinsert the SAME node afterward, instead of regenerating it
    // from an HTML string like the other widgets. Browsers can reset an
    // element's scrollTop when it's detached and reinserted even though it's
    // the same node, so explicitly save/restore the scroll position too.
    const activityPanel = document.getElementById('activity-panel');
    let savedActivityScrollTop = null;
    if (activityPanel) {
      const innerBox = activityPanel.querySelector('#activity-log-box');
      if (innerBox) savedActivityScrollTop = innerBox.scrollTop;
      if (activityPanel.parentNode) activityPanel.parentNode.removeChild(activityPanel);
    }

    const parts = [];

    if (widgetPrefs.leds) {
      parts.push(renderLedWidget(status.leds));
    }

    if (widgetPrefs.valves) {
      parts.push(`<div class="widget"><h3>Valve Quick Status</h3>${
        (status.valves || []).map(v => `
          <div class="mini-stat"><span>${v.name}</span><span class="val" style="color:${v.state === 'on' ? '#2f6d4f' : '#5c6b64'}">${v.state.toUpperCase()}</span></div>
        `).join('')
      }</div>`);
    }

    if (widgetPrefs.sensors) {
      parts.push(renderSensorsWidget(status.sensors));
    }

    if (widgetPrefs.schedule) {
      const running = status.schedulerActive;
      const sys = status.system || {};
      const handlers = sys.handlers || {};
      const handlerRow = (label, ok) => `<div class="mini-stat"><span>${label} handler</span><span class="val" style="color:${ok ? '#2f6d4f' : '#c0392b'}">${ok ? 'up' : 'down'}</span></div>`;
      parts.push(`<div class="widget"><h3>Scheduler &amp; Controller Health</h3>
        <div class="mini-stat"><span>Scheduler</span><span class="val">${running ? 'Running a valve now' : 'Idle'}</span></div>
        <div class="mini-stat"><span>API connection</span><span class="val">${status.apiMode === 'mock' ? 'Simulated' : 'Live'}</span></div>
        <div class="mini-stat"><span>Controller status</span><span class="val" style="color:${sys.status === 'ok' ? '#2f6d4f' : '#c0392b'}">${sys.status || 'unknown'}</span></div>
        ${handlerRow('ADC', handlers.adc)}
        ${handlerRow('Irrigation', handlers.irrigation)}
        ${handlerRow('LED', handlers.leds)}
        ${handlerRow('Weather', handlers.weather)}
      </div>`);
    }

    grid.innerHTML = parts.join('');
    grid.appendChild(activityPanel); // reattach the same, untouched node -- always last in the grid
    if (savedActivityScrollTop !== null) {
      const innerBox = activityPanel.querySelector('#activity-log-box');
      if (innerBox) innerBox.scrollTop = savedActivityScrollTop;
      updateActivityScrollbar();
    }
    wireSensorWidgetControls();
    document.getElementById('api-mode-badge').textContent = status.apiMode === 'mock' ? 'Simulated API' : 'Live API';

    if (widgetPrefs.activity) {
      activityPanel.classList.remove('hidden');
      if (!activityState.initialized) loadActivityInitial();
    } else {
      activityPanel.classList.add('hidden');
    }
  }

  function friendlyChannelName(name) {
    if (!name) return 'Sensor';
    return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  // Rounds a numeric sensor reading to at most 3 decimal places (no trailing
  // zero-padding) so long floating-point voltages/readings stay readable.
  function fmt3(n) {
    if (typeof n !== 'number' || !isFinite(n)) return n ?? '—';
    return Math.round(n * 1000) / 1000;
  }

  // ---------------------------------------------------------------------
  // Irrigation tab
  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // Recent Activity: a curated, human-readable, reverse-chronological feed
  // (newest first) backed by GET /api/activity/current -- distinct from the
  // full raw application log. Supports scrolling further back through
  // history (scroll down = older, like a typical activity/news feed) via
  // the same synthetic always-visible scrollbar used elsewhere, and quietly
  // prepends new events at the top as they happen.
  // ---------------------------------------------------------------------
  const activityState = { events: [], hasMore: false, loading: false, initialized: false };

  // Draws a synthetic, always-visible scroll indicator for the log box.
  // Needed because native scrollbars are unreliable here: several platforms
  // (macOS's default trackpad "overlay" scrollbars, some Linux/Chrome setups)
  // hide the real scrollbar until an active scroll gesture, regardless of
  // overflow-y:scroll or ::-webkit-scrollbar CSS.
  function updateActivityScrollbar() {
    const box = document.getElementById('activity-log-box');
    const thumb = document.getElementById('activity-scrollbar-thumb');
    if (!box || !thumb) return;
    const { scrollTop, scrollHeight, clientHeight } = box;
    if (scrollHeight <= clientHeight + 1) { thumb.style.display = 'none'; return; }
    thumb.style.display = 'block';
    const thumbHeightPct = Math.max((clientHeight / scrollHeight) * 100, 8);
    const maxTopPct = 100 - thumbHeightPct;
    const topPct = (scrollTop / (scrollHeight - clientHeight)) * maxTopPct;
    thumb.style.height = thumbHeightPct + '%';
    thumb.style.top = topPct + '%';
  }

  function describeEvent(e) {
    switch (e.type) {
      case 'valve_on': return `${e.valveName} turned ON (${e.source})`;
      case 'valve_off': return `${e.valveName} turned OFF (${e.source})`;
      case 'valve_off_all': return `All valves and pumps turned OFF (${e.source})`;
      case 'schedule_deferred': return `Deferred: ${e.message}`;
      case 'schedule_updated': return e.message;
      default: return e.message || e.type;
    }
  }

  function formatEventTimestamp(ts) {
    const dt = new Date(ts);
    const dateStr = dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const timeStr = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `${dateStr} ${timeStr}`;
  }

  function makeActivityRowEl(e) {
    const div = document.createElement('div');
    div.className = 'event-row';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = formatEventTimestamp(e.ts);
    div.appendChild(t);
    div.appendChild(document.createTextNode(describeEvent(e)));
    return div;
  }

  function appendActivityRows(box, events) {
    const frag = document.createDocumentFragment();
    events.forEach(e => frag.appendChild(makeActivityRowEl(e)));
    box.appendChild(frag);
    updateActivityScrollbar();
  }

  function prependActivityRows(box, events) {
    // `events` is already newest-first among itself; appending in that order
    // into a fragment then inserting the whole fragment before the current
    // first child preserves overall newest-at-top ordering.
    const frag = document.createDocumentFragment();
    events.forEach(e => frag.appendChild(makeActivityRowEl(e)));
    box.insertBefore(frag, box.firstChild);
    updateActivityScrollbar();
  }

  async function loadActivityInitial() {
    const box = document.getElementById('activity-log-box');
    if (!box || activityState.loading) return;
    activityState.loading = true;
    const result = await api('/api/activity/current?limit=20&offset=0');
    activityState.loading = false;
    if (!result.ok) { box.innerHTML = '<p class="hint">Could not load recent activity.</p>'; return; }

    activityState.events = result.events;
    activityState.hasMore = result.hasMore;
    activityState.initialized = true;

    box.innerHTML = '';
    if (!activityState.events.length) {
      box.innerHTML = '<p class="hint">No recent activity yet.</p>';
      return;
    }
    appendActivityRows(box, activityState.events);
    box.scrollTop = 0; // newest is at the top
  }

  // Infinite-scroll further back through history: scrolling down toward the
  // bottom loads and appends the next (older) page below what's shown.
  async function loadActivityOlder() {
    if (activityState.loading || !activityState.hasMore) return;
    const box = document.getElementById('activity-log-box');
    if (!box) return;
    activityState.loading = true;
    const result = await api(`/api/activity/current?limit=20&offset=${activityState.events.length}`);
    activityState.loading = false;
    if (!result.ok || !result.events.length) return;

    activityState.events = activityState.events.concat(result.events);
    activityState.hasMore = result.hasMore;
    appendActivityRows(box, result.events);
  }

  // Called on every status poll: quietly picks up any newer events and
  // prepends them at the top. If the person is already looking at the very
  // top (the newest item), scroll stays pinned to the top so new items are
  // visible; if they've scrolled down into history, their view is preserved
  // exactly (measuring scrollHeight before/after and compensating scrollTop),
  // rather than being yanked around by content appearing above them.
  async function refreshActivityIncremental() {
    if (!activityState.initialized || activityState.loading) return;
    const box = document.getElementById('activity-log-box');
    if (!box) return;
    const wasAtTop = box.scrollTop < 10;

    const result = await api('/api/activity/current?limit=30&offset=0');
    if (!result.ok) return;

    const currentNewestTs = activityState.events[0]?.ts;
    let newOnes;
    if (!currentNewestTs) {
      newOnes = result.events;
    } else {
      const idx = result.events.findIndex(e => e.ts === currentNewestTs);
      if (idx === -1) { await loadActivityInitial(); return; } // too many to diff cleanly -- resync
      newOnes = result.events.slice(0, idx);
    }
    if (!newOnes.length) return;

    const oldScrollHeight = box.scrollHeight;
    const oldScrollTop = box.scrollTop;
    activityState.events = newOnes.concat(activityState.events);
    prependActivityRows(box, newOnes);

    if (wasAtTop) box.scrollTop = 0;
    else box.scrollTop = box.scrollHeight - oldScrollHeight + oldScrollTop;
  }

  function wireActivityScroll() {
    const box = document.getElementById('activity-log-box');
    if (!box || box.dataset.wired) return;
    box.dataset.wired = '1';
    box.addEventListener('scroll', () => {
      updateActivityScrollbar();
      if (box.scrollHeight - box.scrollTop - box.clientHeight < 40) loadActivityOlder();
    });
    window.addEventListener('resize', updateActivityScrollbar);
  }
  wireActivityScroll();

  function renderValveCards(status) {
    const all = status.valves || [];
    const valveItems = all.filter(v => v.type !== 'pump');
    const pumpItems = all.filter(v => v.type === 'pump');
    // Guard rail only applies among irrigation valves; pumps run independently
    // of that rule (they have their own rule below).
    const activeValve = valveItems.find(v => v.state === 'on');
    const anyValveOn = !!activeValve;

    renderCardGroup('valve-cards', valveItems, (v) => {
      if (activeValve && activeValve.id !== v.id) {
        return `Blocked: ${activeValve.name} is currently running.`;
      }
      return null;
    });

    renderCardGroup('pump-cards', pumpItems, (v) => {
      // Pump 2 can only run while an irrigation valve is on (enforced by the
      // app, since the irrigation handler does not enforce this itself). Pump 1
      // has no restriction and can run any time, for any length of time.
      if (v.id === 'pump2' && v.state !== 'on' && !anyValveOn) {
        return 'Blocked: Pump 2 requires an irrigation valve to be running.';
      }
      return null;
    });
  }

  function renderCardGroup(containerId, items, getBlockReason) {
    const container = document.getElementById(containerId);
    if (!items.length) { container.innerHTML = '<p class="hint">None configured.</p>'; return; }

    // The status poll re-renders this whole block every few seconds. Capture
    // whatever's currently typed into each "run for N minutes" box first, so
    // re-rendering doesn't wipe out a value the person just entered (this was
    // resetting the field whenever a poll landed while someone was mid-click).
    const preservedMinutes = {};
    items.forEach(v => {
      const el = document.getElementById(`run-${v.id}`);
      if (el && el.value) preservedMinutes[v.id] = el.value;
    });

    // The minutes box defaults to, and is capped at, handlers.irrigation.
    // max_valve_run_time from garden.json (edited on the Configuration
    // page) -- so it always reflects the currently configured limit.
    const currentMaxRunMinutes = maxRunMinutes;

    container.innerHTML = items.map(v => {
      const isOn = v.state === 'on';
      const blockReason = isOn ? null : getBlockReason(v);
      const minutesValue = preservedMinutes[v.id] || currentMaxRunMinutes;
      return `
      <div class="valve-card">
        <div class="valve-card-head">
          <div><div class="name">${v.name}</div><div class="loc">${v.location || ''}</div></div>
          <span class="state-pill ${v.state}">${v.state.toUpperCase()}</span>
        </div>
        <div class="valve-actions">
          ${isOn
            ? `<button class="btn-danger btn-small" data-off="${v.id}">Turn Off</button>`
            : `<input type="number" min="1" max="${currentMaxRunMinutes}" placeholder="min" id="run-${v.id}" value="${minutesValue}" ${blockReason ? 'disabled' : ''}/>
               <button class="btn-primary btn-small" data-on="${v.id}" ${blockReason ? `disabled title="${blockReason}"` : ''}>Turn On</button>`
          }
        </div>
        ${blockReason ? `<p class="valve-note">${blockReason}</p>` : ''}
      </div>`;
    }).join('');

    container.querySelectorAll('[data-on]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.on;
        const minutesInput = document.getElementById(`run-${id}`);
        const runForMinutes = minutesInput && minutesInput.value ? Number(minutesInput.value) : undefined;
        const result = await api(`/api/valves/${id}/on`, { method: 'POST', body: JSON.stringify({ runForMinutes }) });
        if (!result.ok) showToast(result.message, 'error'); else showToast('Turned on.', 'success');
        refreshStatus();
      });
    });
    container.querySelectorAll('[data-off]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const result = await api(`/api/valves/${btn.dataset.off}/off`, { method: 'POST' });
        if (!result.ok) showToast(result.message, 'error'); else showToast('Turned off.', 'success');
        refreshStatus();
      });
    });
  }

  document.getElementById('btn-off-all').addEventListener('click', async () => {
    if (!confirm('Turn off ALL valves and pumps? This stops everything immediately.')) return;
    const result = await api('/api/valves/off-all', { method: 'POST' });
    if (!result.ok) showToast(result.message, 'error'); else showToast('All valves and pumps turned off.', 'success');
    refreshStatus();
  });

  // ---------------------------------------------------------------------
  // Polling for near-real-time status
  // ---------------------------------------------------------------------
  let pollTimer = null;
  let lastStatus = null;
  let pollIntervalSeconds = 3;
  // Sourced from garden.json (handlers.irrigation.max_valve_run_time),
  // used to size/cap the Irrigation tab's "run for N minutes" input. There
  // is no separate Settings page/app-level cap anymore -- this value is
  // the single source of truth, edited on the Configuration page.
  let maxRunMinutes = 30;

  async function refreshStatus() {
    const status = await api('/api/status/all');
    if (!status.ok) return;
    lastStatus = status;
    renderDashboard(status);
    renderValveCards(status);
    if (widgetPrefs.activity) refreshActivityIncremental();
  }

  function startPolling() {
    stopPolling();
    refreshStatus();
    pollTimer = setInterval(refreshStatus, pollIntervalSeconds * 1000);
  }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  // Reads the two garden.json values the dashboard/irrigation tab need
  // before a Configuration-tab visit would otherwise load them: how often
  // to poll for status, and the valve safety run-time cap. Both live under
  // webui.settings / handlers.irrigation in garden.json -- see
  // server/config.js and the Configuration page's "Web UI" / "Irrigation"
  // sections, which are the only place either is edited.
  async function loadRuntimeSettings() {
    const result = await api('/api/config/current');
    if (!result.ok || !result.config) return;
    const webuiSettings = result.config.webui?.settings || {};
    const pollSeconds = Number(webuiSettings.poll_interval_seconds);
    if (Number.isFinite(pollSeconds) && pollSeconds > 0) pollIntervalSeconds = pollSeconds;

    const maxRunSeconds = Number(result.config.handlers?.irrigation?.max_valve_run_time);
    if (Number.isFinite(maxRunSeconds) && maxRunSeconds > 0) {
      maxRunMinutes = Math.max(1, Math.round(maxRunSeconds / 60));
    }

    updateWeewxLink(result.config.weewx?.main_url);
  }

  // Small "WeeWx" link in the topbar, right of the API mode badge -- points
  // straight at the external WeeWx dashboard (garden.json's weewx.main_url).
  // Hidden entirely if that field isn't set.
  function updateWeewxLink(url) {
    const link = document.getElementById('weewx-link');
    if (!link) return;
    if (url) {
      link.href = url;
      link.classList.remove('hidden');
    } else {
      link.href = '#';
      link.classList.add('hidden');
    }
  }

  // ---------------------------------------------------------------------
  // Schedule tab
  // ---------------------------------------------------------------------
  let valvesCache = [];

  async function loadSchedule() {
    const [valvesResult, scheduleResult] = await Promise.all([api('/api/valves'), api('/api/schedule')]);
    if (valvesResult.ok) valvesCache = valvesResult.valves;
    if (!scheduleResult.ok) return;

    const byValve = {};
    for (const v of valvesCache) byValve[v.id] = { name: v.name, entries: [] };
    for (const e of scheduleResult.schedule) {
      if (!byValve[e.valveId]) byValve[e.valveId] = { name: e.valveName, entries: [] };
      byValve[e.valveId].entries.push(e);
    }

    const container = document.getElementById('schedule-by-valve');
    container.innerHTML = Object.entries(byValve).map(([valveId, group]) => {
      const allEnabled = group.entries.length > 0 && group.entries.every(e => e.enabled !== false);
      return `
      <div class="valve-schedule-block">
        <h3>${group.name}</h3>
        <table class="schedule-table">
          <thead><tr>
            <th>Day</th><th>Start</th><th>Duration</th>
            <th><label class="th-checkbox"><input type="checkbox" data-select-all="${valveId}" ${allEnabled ? 'checked' : ''} ${group.entries.length === 0 ? 'disabled' : ''}/> Enabled</label></th>
            <th>Next run</th><th></th>
          </tr></thead>
          <tbody>
            ${group.entries.length ? group.entries.sort((a,b)=>a.dayOfWeek-b.dayOfWeek || a.start.localeCompare(b.start)).map(e => `
              <tr>
                <td>${e.dayName}</td>
                <td>${e.start}</td>
                <td>${Math.round(e.durationSeconds/60)} min</td>
                <td><input type="checkbox" data-toggle="${e.id}" ${e.enabled ? 'checked' : ''}/></td>
                <td>${e.currentlyRunning ? '<span class="running-badge">RUNNING</span>' : (e.nextRun ? new Date(e.nextRun).toLocaleString([], {weekday:'short', hour:'2-digit', minute:'2-digit'}) : '—')}</td>
                <td class="row-actions">
                  <button class="btn-secondary btn-small" data-edit="${e.id}">Edit</button>
                  <button class="btn-danger btn-small" data-delete="${e.id}">Delete</button>
                </td>
              </tr>
            `).join('') : `<tr><td colspan="6" class="hint">No watering windows yet.</td></tr>`}
          </tbody>
        </table>
      </div>`;
    }).join('');

    container.querySelectorAll('[data-select-all]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const valveId = cb.dataset.selectAll;
        const entries = byValve[valveId]?.entries || [];
        const checked = cb.checked;
        const results = await Promise.all(entries.map(e =>
          api(`/api/schedule/${e.id}`, { method: 'PUT', body: JSON.stringify({ enabled: checked }) })
        ));
        const failed = results.find(r => !r.ok);
        if (failed) showToast(failed.message, 'error');
        loadSchedule();
      });
    });

    container.querySelectorAll('[data-toggle]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const result = await api(`/api/schedule/${cb.dataset.toggle}`, { method: 'PUT', body: JSON.stringify({ enabled: cb.checked }) });
        if (!result.ok) { showToast(result.message, 'error'); cb.checked = !cb.checked; }
        else loadSchedule();
      });
    });
    container.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this watering window?')) return;
        const result = await api(`/api/schedule/${btn.dataset.delete}`, { method: 'DELETE' });
        if (!result.ok) showToast(result.message, 'error');
        loadSchedule();
      });
    });
    container.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => {
        const all = Object.values(byValve).flatMap(g => g.entries);
        const entry = all.find(e => e.id === btn.dataset.edit);
        openWindowModal(entry);
      });
    });
  }

  // Modal (add/edit watering window)
  const modal = document.getElementById('modal-window');
  function openWindowModal(entry) {
    document.getElementById('modal-title').textContent = entry ? 'Edit watering window' : 'Add watering window';
    document.getElementById('window-id').value = entry ? entry.id : '';
    const valveSelect = document.getElementById('window-valve');
    valveSelect.innerHTML = valvesCache.map(v => `<option value="${v.id}">${v.name}</option>`).join('');
    if (entry) valveSelect.value = entry.valveId;
    document.getElementById('window-day').value = entry ? entry.dayOfWeek : 0;
    document.getElementById('window-start').value = entry ? entry.start : '06:00';
    document.getElementById('window-duration').value = entry ? Math.round(entry.durationSeconds / 60) : 5;
    document.getElementById('window-enabled').checked = entry ? entry.enabled !== false : true;
    document.getElementById('window-error').textContent = '';
    modal.classList.remove('hidden');
  }
  document.getElementById('btn-add-window').addEventListener('click', () => openWindowModal(null));
  document.getElementById('btn-cancel-window').addEventListener('click', () => modal.classList.add('hidden'));

  document.getElementById('form-window').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('window-id').value;
    const payload = {
      valveId: document.getElementById('window-valve').value,
      dayOfWeek: Number(document.getElementById('window-day').value),
      start: document.getElementById('window-start').value,
      durationSeconds: Number(document.getElementById('window-duration').value) * 60,
      enabled: document.getElementById('window-enabled').checked
    };
    const result = id
      ? await api(`/api/schedule/${id}`, { method: 'PUT', body: JSON.stringify(payload) })
      : await api('/api/schedule', { method: 'POST', body: JSON.stringify(payload) });

    if (!result.ok) { document.getElementById('window-error').textContent = result.message || 'Could not save.'; return; }
    modal.classList.add('hidden');
    showToast('Schedule saved.', 'success');
    loadSchedule();
  });

  // ---------------------------------------------------------------------
  // Configuration tab: a generic (schema-agnostic) editor over the FULL
  // garden.json file -- not just this app's own "webui" stanza, but also
  // the config/hardware/handlers stanzas shared with the other GardenPi
  // services. "Generic" here means the renderer walks whatever object/
  // array/primitive shape the file actually has, rather than hardcoding
  // knowledge of every field -- so it keeps working as the handler side
  // adds/changes fields without needing a matching webui code change.
  //
  // Editing rules:
  //   - Leaf values keep their original JSON type on save (a string like
  //     "8787" stays a string, not silently promoted to a number) --
  //     enforced by reading the CURRENT value's typeof at save time to
  //     decide how to coerce the new input text back.
  //   - Keys whose name contains "comment" are shown as read-only italic
  //     text, never an editable input, matching how garden.json itself
  //     uses e.g. "comment_max_valve_duration_sec" purely as documentation.
  //   - Keys whose name contains token/secret/password render as a masked
  //     password field with a Show/Hide toggle, so a secret isn't shown in
  //     plaintext by default but can still be reviewed/edited.
  //   - Arrays of primitives get an editable row per item (add/remove);
  //     arrays of objects get a repeatable card per item (add/remove),
  //     recursively rendering each object's own fields the same way.
  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // Configuration tab: an EXPLICIT allowlist editor over garden.json.
  //
  // Unlike a fully generic "show everything" tree, only fields listed below
  // (in COMMON or ADVANCED) are shown at all -- anything not mapped here is
  // excluded from the UI entirely for now, to be added in future iterations
  // as it's decided which additional fields are safe/useful to expose.
  //
  // A field can still use the generic recursive renderer under the hood
  // (renderConfigValue / renderConfigObjectFields) once its path is chosen
  // -- "explicit allowlist" governs WHICH paths appear, not how each one
  // is drawn.
  // ---------------------------------------------------------------------
  let configWorkingCopy = null;

  // User accounts (users.json via server/db.js) are separate from
  // garden.json -- they're rendered inside the GardenPi System card but
  // don't flow through configWorkingCopy / data-config-path / PUT
  // /api/config/current at all. loadUsers() below is the only writer of
  // this cache; renderCommonSettings() only ever reads it.
  let usersCache = [];

  function humanizeConfigKey(key) {
    return key
      .replace(/_/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, c => c.toUpperCase());
  }
  function isCommentConfigKey(key) { return /comment/i.test(key); }
  function isExampleConfigKey(key) { return /example/i.test(key); }
  function isSensitiveConfigKey(key) { return /token|secret|passwd|password/i.test(key); }
  // Matches "log_level" and any legacy "logLevel"-style key alike.
  function isLogLevelKey(key) { return /log_?level$/i.test(key); }

  function escapeHtmlAttr(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function getDeepConfig(obj, path) {
    return path.reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
  }
  function setDeepConfig(obj, path, value) {
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
    cur[path[path.length - 1]] = value;
  }

  // The options list for every log-level selector comes from garden.json's
  // own config.supported_log_levels -- "defined in the config stanza",
  // per spec -- with a sane fallback if that's ever missing.
  function getLogLevelOptions() {
    const opts = getDeepConfig(configWorkingCopy, ['config', 'supported_log_levels']);
    return Array.isArray(opts) && opts.length ? opts : ['critical', 'error', 'warning', 'info', 'debug'];
  }
  function renderLogLevelSelect(pathArr, currentValue) {
    const pathAttr = escapeHtmlAttr(JSON.stringify(pathArr));
    const options = getLogLevelOptions().map(o => `
      <option value="${escapeHtmlAttr(o)}" ${String(o).toLowerCase() === String(currentValue).toLowerCase() ? 'selected' : ''}>${escapeHtmlAttr(o)}</option>
    `).join('');
    return `<select data-config-path="${pathAttr}">${options}</select>`;
  }

  function renderReadOnlyField(label, value) {
    return `<div class="config-field"><label>${escapeHtmlAttr(label)}</label><p class="config-readonly-value">${escapeHtmlAttr(value ?? '—')}</p></div>`;
  }

  // Fixed set of session-timeout choices (minutes; 0 = never), matching
  // what the old standalone Settings page used to offer, now edited
  // directly on webui.settings.session_timeout_minutes here instead.
  const SESSION_TIMEOUT_OPTIONS = [15, 30, 60, 120, 480, 0];
  function renderSessionTimeoutSelect(pathArr, currentValue) {
    const pathAttr = escapeHtmlAttr(JSON.stringify(pathArr));
    const options = SESSION_TIMEOUT_OPTIONS.map(mins => {
      const label = mins === 0 ? 'Never time out' : (mins >= 60 ? `${mins / 60} hour${mins > 60 ? 's' : ''}` : `${mins} minutes`);
      return `<option value="${mins}" ${Number(currentValue) === mins ? 'selected' : ''}>${label}</option>`;
    }).join('');
    return `<select data-config-path="${pathAttr}">${options}</select>`;
  }

  // ---- Generic HW-ID label tables (ADC channel_map / Irrigation relay_map
  // / LED led_map / Weather sensor_map) -- hardware_id (or, for sensor_map,
  // the sensor_id key itself) is always shown read-only; other columns are
  // editable text/checkbox inputs wired through the same generic
  // data-config-path mechanism as every other field on this page. ----
  function tableInputCell(pathArr, value, type) {
    const pathAttr = escapeHtmlAttr(JSON.stringify(pathArr));
    if (type === 'checkbox') {
      return `<input type="checkbox" data-config-path="${pathAttr}" ${value ? 'checked' : ''} />`;
    }
    return `<input type="text" data-config-path="${pathAttr}" value="${escapeHtmlAttr(value ?? '')}" />`;
  }
  function tableReadOnlyCell(value) {
    return `<span class="config-readonly-value">${escapeHtmlAttr(value ?? '')}</span>`;
  }
  function renderLabelTable(headers, rows) {
    const thead = `<tr>${headers.map(h => `<th>${escapeHtmlAttr(h)}</th>`).join('')}</tr>`;
    const tbody = rows.map(cells => `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<table class="config-map-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
  }

  // ADC channel_map / Irrigation relay_map: HW ID (read-only) | User ID
  // (editable) | Friendly Name (editable).
  function renderIdMapTable(basePath) {
    const arr = getDeepConfig(configWorkingCopy, basePath) || [];
    const rows = arr.map((entry, i) => [
      tableReadOnlyCell(entry.hardware_id),
      tableInputCell([...basePath, i, 'user_id'], entry.user_id),
      tableInputCell([...basePath, i, 'friendly'], entry.friendly)
    ]);
    return renderLabelTable(['HW ID', 'User ID', 'Friendly Name'], rows);
  }

  // LED led_map: HW ID | Group | Aliases -- ALL read-only. hardware_id and
  // led labels (group/aliases) can never be customer-edited.
  function renderLedMapTable(basePath) {
    const arr = getDeepConfig(configWorkingCopy, basePath) || [];
    const rows = arr.map(entry => [
      tableReadOnlyCell(entry.hardware_id),
      tableReadOnlyCell(entry.group),
      tableReadOnlyCell((entry.aliases || []).join(', '))
    ]);
    return renderLabelTable(['HW ID', 'Group', 'Aliases'], rows);
  }

  // Finds the index of an entry within a channel_map/relay_map/input_map
  // array whose hardware_id OR user_id matches `token` - used to resolve a
  // sensor_map entry's source_id to the map entry that actually owns its
  // friendly name, without guessing which id form was used.
  function findEntryIndexByIdToken(mapArray, token) {
    return (mapArray || []).findIndex(e => e && (e.hardware_id === token || e.user_id === token));
  }

  // Weather sensor_map: Sensor ID (read-only, the dict key) | HW or User ID
  // (editable source_id) | Friendly Name (read-only here) | Enabled (editable).
  //
  // Friendly Name is NOT stored on the sensor_map entry itself and is NOT
  // editable from this table - it's only ever editable on the entry that
  // actually owns that hardware line: handlers.adc.channel_map (Advanced >
  // Software > ADC - Channel Labels, for source "adc" sensors) or
  // handlers.weather.input_map (Advanced > Software > Weather - Input
  // Labels, for source "weather" sensors). Editing the same field from two
  // different tables was confusing - since both point at the identical
  // JSON path, whichever box you typed in last silently won over the
  // other with no visual indication - so only the owning table's box is
  // ever an editable input; every other view of that value is read-only.
  function renderSensorMapTable(basePath) {
    const obj = getDeepConfig(configWorkingCopy, basePath) || {};
    const adcChannelMap = getDeepConfig(configWorkingCopy, ['handlers', 'adc', 'channel_map']) || [];
    const inputMap = getDeepConfig(configWorkingCopy, ['handlers', 'weather', 'input_map']) || [];

    const rows = Object.keys(obj).map(sensorId => {
      const entry = obj[sensorId] || {};
      const ownerArray = entry.source === 'adc' ? adcChannelMap
        : entry.source === 'weather' ? inputMap
        : [];
      const ownerIdx = findEntryIndexByIdToken(ownerArray, entry.source_id);
      const friendlyValue = ownerIdx >= 0 ? ownerArray[ownerIdx].friendly : '—';

      return [
        tableReadOnlyCell(sensorId),
        tableInputCell([...basePath, sensorId, 'source_id'], entry.source_id),
        tableReadOnlyCell(friendlyValue),
        tableInputCell([...basePath, sensorId, 'enabled'], entry.enabled, 'checkbox')
      ];
    });
    return renderLabelTable(['Sensor ID', 'HW or User ID', 'Friendly Name', 'Enabled'], rows);
  }

  // ---- Hardware pin_map tables (RaspberryPi/PiController/PowerController)
  // -- hardware_id is always read-only; only the physical pin number is
  // editable, filtered to entries of the requested `type` within that
  // source's single pin_map array. ----
  function renderPinMapTable(basePath, type, idLabel) {
    const arr = getDeepConfig(configWorkingCopy, basePath) || [];
    const rows = [];
    arr.forEach((entry, i) => {
      if (entry.type !== type) return;
      rows.push([
        tableReadOnlyCell(entry.hardware_id),
        tableInputCell([...basePath, i, 'pin'], entry.pin)
      ]);
    });
    return renderLabelTable([idLabel, 'Pin'], rows);
  }

  // Renders just the <input> for a primitive value (no label/wrapper),
  // choosing the input type from the value's current JS type/content so the
  // generic change-handler below can coerce edits back to the same
  // representation. A string that's exactly "true"/"false" (e.g.
  // webui.mock_api, webui.api_tls_reject) renders as a toggle but is written
  // back as that same lowercase string, not a real JSON boolean -- matching
  // whatever convention that field already used in the file.
  function renderConfigPrimitiveInput(pathArr, value, sensitive) {
    const pathAttr = escapeHtmlAttr(JSON.stringify(pathArr));
    if (typeof value === 'boolean') {
      return `<input type="checkbox" data-config-path="${pathAttr}" ${value ? 'checked' : ''} />`;
    }
    if (typeof value === 'string' && /^(true|false)$/i.test(value)) {
      const checked = value.toLowerCase() === 'true';
      return `<input type="checkbox" data-config-path="${pathAttr}" data-config-boolstring="1" ${checked ? 'checked' : ''} />`;
    }
    if (typeof value === 'number') {
      return `<input type="number" step="any" data-config-path="${pathAttr}" value="${value}" />`;
    }
    const inputType = sensitive ? 'password' : 'text';
    const revealBtn = sensitive ? `<button type="button" class="config-reveal-btn" data-config-reveal>Show</button>` : '';
    return `<input type="${inputType}" data-config-path="${pathAttr}" value="${escapeHtmlAttr(value ?? '')}" />${revealBtn}`;
  }

  // `skipSet`, when given, is a Set of JSON.stringify(path) strings to omit
  // entirely -- used by the "all other X items" catch-all groups (ADC, LEDs,
  // Weather) to hide one or two fields called out separately (e.g. ADC's
  // channel list, deferred to a future iteration) while still showing
  // everything else in that handler's stanza generically.
  function renderConfigObjectFields(pathArr, obj, skipSet) {
    return Object.keys(obj).map(k => {
      const childPath = [...pathArr, k];
      if (skipSet && skipSet.has(JSON.stringify(childPath))) return '';
      return renderConfigValue(childPath, obj[k], humanizeConfigKey(k), skipSet);
    }).join('');
  }

  function renderConfigValue(pathArr, value, keyLabel, skipSet) {
    const key = pathArr[pathArr.length - 1];
    const pathAttr = escapeHtmlAttr(JSON.stringify(pathArr));

    if (typeof value === 'string' && (isCommentConfigKey(key) || isExampleConfigKey(key))) {
      return `<p class="config-comment">${escapeHtmlAttr(keyLabel)}: ${escapeHtmlAttr(value)}</p>`;
    }

    if (value === null || typeof value !== 'object') {
      if (isLogLevelKey(key)) {
        return `<div class="config-field"><label>${escapeHtmlAttr(keyLabel)}</label>${renderLogLevelSelect(pathArr, value)}</div>`;
      }
      const sensitive = typeof value === 'string' && isSensitiveConfigKey(key);
      return `<div class="config-field"><label>${escapeHtmlAttr(keyLabel)}</label>${renderConfigPrimitiveInput(pathArr, value, sensitive)}</div>`;
    }

    if (Array.isArray(value)) {
      const allPrimitive = value.every(v => v === null || typeof v !== 'object');
      if (allPrimitive) {
        const rows = value.map((item, i) => `
          <div class="config-array-row">
            ${renderConfigPrimitiveInput([...pathArr, i], item, false)}
            <button type="button" class="config-btn-remove" data-config-array-remove="${pathAttr}" data-index="${i}">✕</button>
          </div>`).join('');
        return `<div class="config-field" style="align-items:flex-start;">
          <label>${escapeHtmlAttr(keyLabel)}</label>
          <div class="config-array-of-primitives">
            ${rows}
            <button type="button" class="config-btn-add" data-config-array-add="${pathAttr}">+ Add item</button>
          </div>
        </div>`;
      }
      const cards = value.map((item, i) => `
        <div class="config-array-item-card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div class="config-node-title">${escapeHtmlAttr(keyLabel)} #${i + 1}</div>
            <button type="button" class="config-btn-remove" data-config-array-remove="${pathAttr}" data-index="${i}">Remove</button>
          </div>
          ${renderConfigObjectFields([...pathArr, i], item, skipSet)}
        </div>`).join('');
      return `<div>
        <div class="config-node-title">${escapeHtmlAttr(keyLabel)}</div>
        ${cards}
        <button type="button" class="config-btn-add" data-config-array-add-object="${pathAttr}">+ Add ${escapeHtmlAttr(keyLabel)}</button>
      </div>`;
    }

    // Plain object -- if every child was skipped, don't render an empty
    // section header for it either.
    const innerFields = renderConfigObjectFields(pathArr, value, skipSet);
    if (!innerFields.trim()) return '';
    return `<div class="config-node">
      <div class="config-node-title">${escapeHtmlAttr(keyLabel)}</div>
      ${innerFields}
    </div>`;
  }

  // Renders one explicitly-allowlisted field at `pathArr`. Returns '' if the
  // path doesn't exist in this particular garden.json (schema drift is
  // handled gracefully, same as elsewhere in this editor) rather than
  // showing an error for a field that simply isn't present.
  function mappedField(pathArr, label, opts = {}) {
    const value = getDeepConfig(configWorkingCopy, pathArr);
    if (value === undefined) return '';
    if (opts.readOnly) return renderReadOnlyField(label, value);
    return renderConfigValue(pathArr, value, label);
  }

  // ---- Users (Configuration > GardenPi System > Users) ----
  // No roles/permissions: every account can add/remove any other account
  // and set anyone's password, including its own. Rendered from usersCache,
  // which loadUsers() keeps in sync with users.json via GET /api/users.
  function renderUsersCard() {
    const whoami = document.getElementById('whoami').textContent;
    const onlyOneUser = usersCache.length <= 1;

    const rows = usersCache.map(u => {
      const isSelf = u.username === whoami;
      const created = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—';
      const removeAttrs = onlyOneUser
        ? 'disabled title="Cannot remove the last user"'
        : '';
      return `<tr>
        <td>${escapeHtmlAttr(u.username)}${isSelf ? ' <span class="hint">(you)</span>' : ''}</td>
        <td>${escapeHtmlAttr(created)}</td>
        <td>
          <div class="row-actions">
            <button type="button" class="btn-secondary btn-small" data-user-password="${escapeHtmlAttr(u.id)}">Change password</button>
            <button type="button" class="btn-danger btn-small" data-user-remove="${escapeHtmlAttr(u.id)}" data-username="${escapeHtmlAttr(u.username)}" ${removeAttrs}>Remove</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    return `<div id="config-users-node">
      <p class="hint">No roles or permissions here — every user can sign in, control the
        system, and manage every account below, including adding, removing, and changing
        anyone's password.</p>
      <table class="config-map-table">
        <thead><tr><th>Username</th><th>Created</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3" class="hint">Loading users…</td></tr>'}</tbody>
      </table>
      <button type="button" class="config-btn-add" id="btn-add-user">+ Add user</button>
    </div>`;
  }

  function renderCommonSettings() {
    const container = document.getElementById('config-common');
    if (!configWorkingCopy) return;

    // ---- GardenPi System ----
    const gardenSystem = [
      mappedField(['config', 'version'], 'Version', { readOnly: true }),
      mappedField(['config', 'last_changed'], 'Last Changed', { readOnly: true }),
      `<div class="config-field"><label>Global Log Level</label>${renderLogLevelSelect(['config', 'global_log_level'], getDeepConfig(configWorkingCopy, ['config', 'global_log_level']))}</div>`,
      mappedField(['config', 'tls_cert_file'], 'TLS Certificate File'),
      mappedField(['config', 'tls_key_file'], 'TLS Key File')
    ].join('');

    // ---- Web UI ----
    const webuiLogLevel = getDeepConfig(configWorkingCopy, ['webui', 'log_level']);
    const sessionTimeout = getDeepConfig(configWorkingCopy, ['webui', 'settings', 'session_timeout_minutes']);
    const webui = [
      mappedField(['webui', 'listen_port'], 'Listener Port'),
      `<div class="config-field"><label>Log Level</label>${renderLogLevelSelect(['webui', 'log_level'], webuiLogLevel)}</div>`,
      mappedField(['webui', 'api_base_url'], 'API URL'),
      mappedField(['webui', 'api_token'], 'API Access Token'),
      mappedField(['webui', 'session_secret'], 'Session Secret'),
      `<div class="config-field"><label>Session Timeout</label>${renderSessionTimeoutSelect(['webui', 'settings', 'session_timeout_minutes'], sessionTimeout)}</div>`,
      mappedField(['webui', 'settings', 'poll_interval_seconds'], 'Dashboard Refresh (seconds)')
    ].join('');

    // ---- Software (per-handler listener/log level + Irrigation's safety
    // settings - naming/label tables live under Advanced Settings) ----
    const apiLogLevel = getDeepConfig(configWorkingCopy, ['handlers', 'api', 'log_level']);
    const adcLogLevel = getDeepConfig(configWorkingCopy, ['handlers', 'adc', 'log_level']);
    const ledsLogLevel = getDeepConfig(configWorkingCopy, ['handlers', 'leds', 'log_level']);
    const irrigationLogLevel = getDeepConfig(configWorkingCopy, ['handlers', 'irrigation', 'log_level']);
    const weatherLogLevel = getDeepConfig(configWorkingCopy, ['handlers', 'weather', 'log_level']);

    const softwareApi = [
      mappedField(['handlers', 'api', 'listen_port'], 'Listener Port'),
      `<div class="config-field"><label>Log Level</label>${renderLogLevelSelect(['handlers', 'api', 'log_level'], apiLogLevel)}</div>`,
      mappedField(['handlers', 'api', 'token'], 'Auth Token')
    ].join('');
    const softwareAdc = [
      mappedField(['handlers', 'adc', 'socket'], 'Listener Socket'),
      `<div class="config-field"><label>Log Level</label>${renderLogLevelSelect(['handlers', 'adc', 'log_level'], adcLogLevel)}</div>`
    ].join('');
    const softwareLeds = [
      mappedField(['handlers', 'leds', 'socket'], 'Listener Socket'),
      `<div class="config-field"><label>Log Level</label>${renderLogLevelSelect(['handlers', 'leds', 'log_level'], ledsLogLevel)}</div>`
    ].join('');
    const softwareIrrigation = [
      mappedField(['handlers', 'irrigation', 'socket'], 'Listener Socket'),
      `<div class="config-field"><label>Log Level</label>${renderLogLevelSelect(['handlers', 'irrigation', 'log_level'], irrigationLogLevel)}</div>`,
      mappedField(['handlers', 'irrigation', 'max_valve_run_time'], 'Max Valve Run Time'),
      mappedField(['handlers', 'irrigation', 'allow_concurrent_valves'], 'Allow Concurrent Valves')
    ].join('');
    const softwareWeather = [
      mappedField(['handlers', 'weather', 'socket'], 'Listener Socket'),
      `<div class="config-field"><label>Log Level</label>${renderLogLevelSelect(['handlers', 'weather', 'log_level'], weatherLogLevel)}</div>`
    ].join('');
    const softwareWeewx = [
      mappedField(['weewx', 'main_url'], 'Main URL')
    ].join('');

    container.innerHTML = `
      <div class="config-card-grid">
        <div class="config-area-card"><h3>GardenPi System</h3>${gardenSystem}</div>
        <div class="config-area-card"><h3>Web UI</h3>${webui}</div>
        <div class="config-area-card"><h3>API</h3>${softwareApi}</div>
      </div>
      <div class="config-area-card config-users-card">
        <h3>Users</h3>
        ${renderUsersCard()}
      </div>
      <div class="config-area-card config-software-card">
        <h3>Software</h3>
        <div class="config-node"><div class="config-node-title">ADC</div>${softwareAdc}</div>
        <div class="config-node"><div class="config-node-title">LEDs</div>${softwareLeds}</div>
        <div class="config-node"><div class="config-node-title">Irrigation</div>${softwareIrrigation}</div>
        <div class="config-node"><div class="config-node-title">Weather</div>${softwareWeather}</div>
        <div class="config-node"><div class="config-node-title">WeeWx</div>${softwareWeewx}</div>
      </div>`;
  }

  // ---- API reference (Advanced > API) - static swagger-style
  // documentation of every endpoint api.py exposes, with copy-pasteable
  // curl examples built from the currently configured API URL/token. This
  // reads configWorkingCopy purely for those two values; nothing here is
  // editable and nothing writes back through data-config-path. ----
  function renderApiEndpointCard(ep) {
    const authBadge = ep.auth
      ? '<span class="api-auth-badge required">Auth required</span>'
      : '<span class="api-auth-badge none">No auth</span>';

    const paramsTable = ep.params ? `<h4>${ep.paramsTitle || 'Query Parameters'}</h4>
      <table><thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead><tbody>
        ${ep.params.map(p => `<tr><td><code>${escapeHtmlAttr(p.name)}</code></td><td>${escapeHtmlAttr(p.type)}</td><td>${escapeHtmlAttr(p.desc)}</td></tr>`).join('')}
      </tbody></table>` : '';

    const bodyBlock = ep.body ? `<h4>Request Body</h4><pre>${escapeHtmlAttr(ep.body)}</pre>` : '';
    const responseBlock = ep.response ? `<h4>Example Response</h4><pre>${escapeHtmlAttr(ep.response)}</pre>` : '';
    const curlBlock = `<h4>curl Example</h4><pre>${escapeHtmlAttr(ep.curl)}</pre>`;

    return `<div class="api-endpoint">
      <div class="api-endpoint-head">
        <span class="api-method ${ep.method.toLowerCase()}">${escapeHtmlAttr(ep.method)}</span>
        <span class="api-path">${escapeHtmlAttr(ep.path)}</span>
        ${authBadge}
      </div>
      <p class="api-endpoint-desc">${ep.description}</p>
      ${paramsTable}${bodyBlock}${responseBlock}${curlBlock}
    </div>`;
  }

  function renderApiReferenceSection() {
    const baseUrl = (getDeepConfig(configWorkingCopy, ['webui', 'api_base_url']) || 'https://<host>:5000').replace(/\/$/, '');
    // A placeholder, never the real configured secret - this page is
    // documentation, not a place to echo handlers.api.token back out.
    const authHeader = `-H "Authorization: Bearer $TOKEN"`;
    const tokenSetup = `TOKEN="<handlers.api.token from garden.json>"`;

    const endpoints = [
      {
        method: 'GET', path: '/api/health', auth: false,
        description: 'Health check. Reports whether the API can see each hardware handler\'s Unix socket on disk - not a live round-trip to each one.',
        response: JSON.stringify({ status: 'ok', service: 'api', version: '2.0', handlers: { adc: true, irrigation: true, leds: true, weather: true } }, null, 2),
        curl: `curl -sk ${baseUrl}/api/health`
      },
      {
        method: 'GET', path: '/api/adc', auth: true,
        description: 'Read one ADC channel\'s voltage, or every channel at once. Accepts either a channel\'s hardware_id (e.g. <code>channel3</code>) or its user_id (e.g. <code>moisture1</code>).',
        params: [
          { name: 'channel', type: 'string', desc: 'hardware_id, user_id, or "all" (required)' }
        ],
        response: JSON.stringify({ channel: 'moisture1', channel_name: 'Magnolia Moisture', value: 1.842, success: true }, null, 2),
        curl: `${tokenSetup}\ncurl -sk ${authHeader} \\\n  "${baseUrl}/api/adc?channel=moisture1"\n\n# every channel at once\ncurl -sk ${authHeader} "${baseUrl}/api/adc?channel=all"`
      },
      {
        method: 'POST', path: '/api/irrigation', auth: true,
        description: 'Turn a relay on/off, or ask for its status. Accepts either a relay\'s hardware_id (e.g. <code>valve1</code>) or its user_id (e.g. <code>farbed</code>); <code>relay: "all"</code> is accepted for <code>action: "off"</code> (stop everything) or <code>action: "status"</code>.',
        body: JSON.stringify({ relay: 'farbed', action: 'on' }, null, 2),
        response: JSON.stringify({ relay: 'farbed', action: 'on', success: true, safety_timeout_sec: 960 }, null, 2),
        curl: `${tokenSetup}\ncurl -sk -X POST ${authHeader} \\\n  -H "Content-Type: application/json" \\\n  -d '{"relay": "farbed", "action": "on"}' \\\n  ${baseUrl}/api/irrigation\n\n# emergency stop everything\ncurl -sk -X POST ${authHeader} \\\n  -H "Content-Type: application/json" \\\n  -d '{"relay": "all", "action": "off"}' \\\n  ${baseUrl}/api/irrigation`
      },
      {
        method: 'GET', path: '/api/irrigation/status', auth: true,
        description: 'Get relay status - one relay, or every relay at once (the default).',
        params: [
          { name: 'relay', type: 'string', desc: 'hardware_id, user_id, or "all" (default: all)' }
        ],
        response: JSON.stringify({ farbed: 'on', nearbed: 'off', mag: 'off', plants: 'off', valve5: 'off', outsidelights: 'off', pump2: 'off' }, null, 2),
        curl: `${tokenSetup}\ncurl -sk ${authHeader} "${baseUrl}/api/irrigation/status"\n\n# single relay\ncurl -sk ${authHeader} "${baseUrl}/api/irrigation/status?relay=farbed"`
      },
      {
        method: 'POST', path: '/api/leds', auth: true,
        description: 'Control an LED, group, or alias. hardware_id and LED labels are read-only - there\'s no user_id for LEDs.',
        params: [
          { name: 'led', type: 'string', desc: 'hardware_id, group, or alias (required)' },
          { name: 'action', type: 'string', desc: '"on", "off", "fastblink", "flash-&lt;colors&gt;", or "patternblink" (required)' },
          { name: 'duration', type: 'string', desc: 'e.g. "10s" - only used with a "flash-…" action (optional, default "5s")' },
          { name: 'count', type: 'number', desc: 'blinks per cycle - only used with "patternblink" (optional, default 1)' }
        ],
        paramsTitle: 'Request Body',
        body: JSON.stringify({ led: 'led2red', action: 'patternblink', count: 3 }, null, 2),
        response: JSON.stringify({ led: 'led2red', action: 'patternblink', output: 'led2red pattern blinking 3 times per cycle', success: true }, null, 2),
        curl: `${tokenSetup}\ncurl -sk -X POST ${authHeader} \\\n  -H "Content-Type: application/json" \\\n  -d '{"led": "sysblue", "action": "on"}' \\\n  ${baseUrl}/api/leds`
      },
      {
        method: 'GET', path: '/api/leds/status', auth: true,
        description: 'Get LED status - one LED/group/alias, or every LED at once (the default).',
        params: [
          { name: 'led', type: 'string', desc: 'hardware_id, group, or alias (optional - omit for all)' }
        ],
        response: JSON.stringify({ sysred: { state: 'off', effect: 'static' }, sysgreen: { state: 'on', effect: 'static' } }, null, 2),
        curl: `${tokenSetup}\ncurl -sk ${authHeader} "${baseUrl}/api/leds/status"`
      },
      {
        method: 'GET', path: '/api/weather', auth: true,
        description: 'Latest weather reading (live from the weather handler\'s socket when reachable), or a range of recent readings from its CSV file.',
        params: [
          { name: 'last', type: 'number', desc: 'number of readings to return, from the CSV file (optional, default 1 = live reading, max 1000)' }
        ],
        response: JSON.stringify({ reading: { s_int_temp: 71.4, s_rain: 0.0, s_wind_speed: 2.1 }, success: true }, null, 2),
        curl: `${tokenSetup}\ncurl -sk ${authHeader} "${baseUrl}/api/weather"\n\n# last 10 readings from the CSV\ncurl -sk ${authHeader} "${baseUrl}/api/weather?last=10"`
      }
    ];

    return `<p class="hint">
      Every endpoint below except <code>/api/health</code> requires
      <code>Authorization: Bearer &lt;token&gt;</code>, where the token is
      <code>handlers.api.token</code> above. If that field is left empty,
      the API runs open-access (no token required) - not recommended
      outside local development.
    </p>${endpoints.map(renderApiEndpointCard).join('')}`;
  }

  function renderAdvancedSettings() {
    const container = document.getElementById('config-tree');
    if (!configWorkingCopy) return;

    // ---- Web UI ----
    const webuiAdvanced = [
      mappedField(['webui', 'api_tls_reject'], 'API TLS Reject'),
      mappedField(['webui', 'api_timeout_ms'], 'API Timeout (ms)'),
      mappedField(['webui', 'mock_api'], 'Use Mock API')
    ].join('');

    // ---- Software: HW ID / User ID / Friendly Name (or Group/Aliases,
    // or Sensor Labels) tables - hardware_id (and, for LEDs, the whole
    // led_map) are always read-only; other columns are editable here. ----
    const adcLabels = renderIdMapTable(['handlers', 'adc', 'channel_map']);
    const ledLabels = renderLedMapTable(['handlers', 'leds', 'led_map']);
    const irrigationLabels = renderIdMapTable(['handlers', 'irrigation', 'relay_map']);
    // input_map is the owning table for every "source: weather" sensor's
    // friendly name (ground_temp1/2, wind_speed, hz, rain, int/ext temp &
    // humidity) - shown here, right alongside Sensor Labels, since that's
    // the only place those names are actually editable.
    const weatherInputLabels = renderIdMapTable(['handlers', 'weather', 'input_map']);
    const weatherLabels = renderSensorMapTable(['handlers', 'weather', 'sensor_map']);

    // ---- Hardware: pin_map tables, plus HW version / I2C address fields.
    // hardware_id is always read-only; only the pin number is editable. ----
    const rpiGpio = renderPinMapTable(['hardware', 'raspberrypi', 'pin_map'], 'gpio', 'GPIO Pin HW ID');

    const picHwVersion = mappedField(['hardware', 'picontroller', 'hw_version'], 'HW Version', { readOnly: true });
    const picI2c = mappedField(['hardware', 'picontroller', 'i2c_addr'], 'I2C Address');
    const picGpio = renderPinMapTable(['hardware', 'picontroller', 'pin_map'], 'gpio', 'GPIO Pin HW ID');
    const picLed = renderPinMapTable(['hardware', 'picontroller', 'pin_map'], 'led', 'MCP LED Pin HW ID');
    const picAdc = renderPinMapTable(['hardware', 'picontroller', 'pin_map'], 'adc', 'ADC Pin HW ID');

    const pcHwVersion = mappedField(['hardware', 'powercontroller', 'hw_version'], 'HW Version', { readOnly: true });
    const pcI2c = mappedField(['hardware', 'powercontroller', 'i2c_addr'], 'I2C Address');
    const pcRelay = renderPinMapTable(['hardware', 'powercontroller', 'pin_map'], 'relay', 'Relay HW ID');

    const tempSensors = [
      mappedField(['hardware', 'powercontroller', 'temperature_sensors', 'internal_i2caddr'], 'Internal I2C Address'),
      mappedField(['hardware', 'powercontroller', 'temperature_sensors', 'external_i2caddr'], 'External I2C Address')
    ].join('');

    container.innerHTML = `
      <details class="config-section" open>
        <summary>Web UI</summary>
        ${webuiAdvanced}
      </details>
      <details class="config-section" open>
        <summary>Software</summary>
        <div class="config-node"><div class="config-node-title">ADC — Channel Labels</div>${adcLabels}</div>
        <div class="config-node"><div class="config-node-title">LEDs — LED Labels</div>${ledLabels}</div>
        <div class="config-node"><div class="config-node-title">Irrigation — Relay Labels</div>${irrigationLabels}</div>
        <div class="config-node"><div class="config-node-title">Weather — Input Labels</div>${weatherInputLabels}</div>
        <div class="config-node"><div class="config-node-title">Weather — Sensor Labels</div>${weatherLabels}<p class="hint">Friendly Name is read-only here - it's editable only on the entry that actually owns that hardware line, above (ADC — Channel Labels for "adc"-sourced sensors, Weather — Input Labels for "weather"-sourced sensors).</p></div>
      </details>
      <details class="config-section">
        <summary>Hardware</summary>
        <div class="config-node">
          <div class="config-node-title">RaspberryPi</div>
          ${rpiGpio}
        </div>
        <div class="config-node">
          <div class="config-node-title">PiController</div>
          ${picHwVersion}${picI2c}
          <p class="hint">GPIO Pin HW ID</p>${picGpio}
          <p class="hint">MCP LED Pin HW ID</p>${picLed}
          <p class="hint">ADC Pin HW ID</p>${picAdc}
        </div>
        <div class="config-node">
          <div class="config-node-title">PowerController</div>
          ${pcHwVersion}${pcI2c}
          <p class="hint">Relay HW ID</p>${pcRelay}
        </div>
        <div class="config-node">
          <div class="config-node-title">Temperature Sensors</div>
          ${tempSensors}
        </div>
      </details>
      <details class="config-section">
        <summary>API</summary>
        ${renderApiReferenceSection()}
      </details>
      <p class="hint config-readme-link">
        Full documentation — including the <code>weather.csv</code> column
        layout — lives in <a href="/README.md" target="_blank" rel="noopener">README.md</a>.
      </p>`;
  }

  // Re-renders both panels from the current configWorkingCopy and re-wires
  // events once across both -- used after any structural change (an array
  // add/remove) wherever it happened, so both stay consistent.
  function refreshConfigEditor() {
    renderCommonSettings();
    renderAdvancedSettings();
    wireConfigTreeEvents();
    wireUsersEvents();
  }

  // Fetches the current user list from users.json (via GET /api/users),
  // updates the cache, and re-renders -- called on initial tab load and
  // after any add/remove/password-change action succeeds.
  async function loadUsers() {
    const result = await api('/api/users');
    if (result.ok) usersCache = result.users;
    renderCommonSettings();
    wireUsersEvents();
  }

  function openAddUserModal() {
    document.getElementById('add-user-error').textContent = '';
    document.getElementById('form-add-user').reset();
    document.getElementById('modal-add-user').classList.remove('hidden');
  }

  function openUserPasswordModal(userId) {
    const user = usersCache.find(u => u.id === userId);
    document.getElementById('user-password-title').textContent =
      user ? `Change password — ${user.username}` : 'Change password';
    document.getElementById('user-password-id').value = userId;
    document.getElementById('user-password-error').textContent = '';
    document.getElementById('form-user-password').reset();
    document.getElementById('modal-user-password').classList.remove('hidden');
  }

  // Wires the Users block's own buttons (Add user / Change password /
  // Remove). Scoped to #config-editor-root, same as wireConfigTreeEvents,
  // so it's safe to call every time that container's innerHTML is rebuilt.
  function wireUsersEvents() {
    const container = document.getElementById('config-editor-root');
    if (!container) return;

    const addBtn = container.querySelector('#btn-add-user');
    if (addBtn) addBtn.addEventListener('click', openAddUserModal);

    container.querySelectorAll('[data-user-password]').forEach(btn => {
      btn.addEventListener('click', () => openUserPasswordModal(btn.dataset.userPassword));
    });

    container.querySelectorAll('[data-user-remove]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const userId = btn.dataset.userRemove;
        const username = btn.dataset.username;
        const isSelf = username === document.getElementById('whoami').textContent;
        const question = isSelf
          ? `Remove your own account "${username}"? You'll be signed out immediately and won't be able to sign back in with it.`
          : `Remove user "${username}"? This cannot be undone.`;
        if (!confirm(question)) return;

        const result = await api(`/api/users/${userId}`, { method: 'DELETE' });
        if (!result.ok) { showToast(result.message, 'error'); return; }

        if (isSelf) {
          // The account behind this session no longer exists -- there's
          // nothing left to refresh, just drop back to the login screen.
          showToast(result.message, 'success');
          await api('/api/auth/logout', { method: 'POST' });
          stopPolling();
          showLogin();
          return;
        }
        showToast(result.message, 'success');
        await loadUsers();
      });
    });
  }

  document.getElementById('btn-cancel-add-user').addEventListener('click', () => {
    document.getElementById('modal-add-user').classList.add('hidden');
  });
  document.getElementById('form-add-user').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('new-user-username').value.trim();
    const password = document.getElementById('new-user-password').value;
    const password2 = document.getElementById('new-user-password2').value;
    const errEl = document.getElementById('add-user-error');
    errEl.textContent = '';
    if (password !== password2) { errEl.textContent = 'Passwords do not match.'; return; }
    const result = await api('/api/users', { method: 'POST', body: JSON.stringify({ username, password }) });
    if (!result.ok) { errEl.textContent = result.message || 'Could not add user.'; return; }
    document.getElementById('modal-add-user').classList.add('hidden');
    showToast(`User "${result.user.username}" added.`, 'success');
    await loadUsers();
  });

  document.getElementById('btn-cancel-user-password').addEventListener('click', () => {
    document.getElementById('modal-user-password').classList.add('hidden');
  });
  document.getElementById('form-user-password').addEventListener('submit', async (e) => {
    e.preventDefault();
    const userId = document.getElementById('user-password-id').value;
    const password = document.getElementById('user-password-new').value;
    const password2 = document.getElementById('user-password-new2').value;
    const errEl = document.getElementById('user-password-error');
    errEl.textContent = '';
    if (password !== password2) { errEl.textContent = 'Passwords do not match.'; return; }
    const result = await api(`/api/users/${userId}/password`, { method: 'POST', body: JSON.stringify({ password }) });
    if (!result.ok) { errEl.textContent = result.message || 'Could not update password.'; return; }
    document.getElementById('modal-user-password').classList.add('hidden');
    showToast('Password updated.', 'success');
  });

  function wireConfigTreeEvents() {
    const container = document.getElementById('config-editor-root');

    container.querySelectorAll('input[data-config-path]').forEach(input => {
      const evt = input.type === 'checkbox' ? 'change' : 'input';
      input.addEventListener(evt, () => {
        const path = JSON.parse(input.dataset.configPath);
        let newVal;
        if (input.type === 'checkbox') {
          newVal = input.dataset.configBoolstring ? (input.checked ? 'true' : 'false') : input.checked;
        } else if (input.type === 'number') {
          const original = getDeepConfig(configWorkingCopy, path);
          const isFloat = typeof original === 'number' && !Number.isInteger(original);
          newVal = input.value === '' ? 0 : (isFloat ? parseFloat(input.value) : parseInt(input.value, 10));
        } else {
          newVal = input.value; // text/password: always stays a string, even if it looks numeric
        }
        setDeepConfig(configWorkingCopy, path, newVal);
      });
    });

    container.querySelectorAll('select[data-config-path]').forEach(select => {
      select.addEventListener('change', () => {
        const path = JSON.parse(select.dataset.configPath);
        setDeepConfig(configWorkingCopy, path, select.value);
      });
    });

    container.querySelectorAll('[data-config-reveal]').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = btn.previousElementSibling;
        if (input && input.tagName === 'INPUT') {
          input.type = input.type === 'password' ? 'text' : 'password';
          btn.textContent = input.type === 'password' ? 'Show' : 'Hide';
        }
      });
    });

    container.querySelectorAll('[data-config-array-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        const path = JSON.parse(btn.dataset.configArrayRemove);
        const index = Number(btn.dataset.index);
        const arr = getDeepConfig(configWorkingCopy, path);
        if (Array.isArray(arr)) arr.splice(index, 1);
        refreshConfigEditor();
      });
    });

    container.querySelectorAll('[data-config-array-add]').forEach(btn => {
      btn.addEventListener('click', () => {
        const path = JSON.parse(btn.dataset.configArrayAdd);
        const arr = getDeepConfig(configWorkingCopy, path);
        if (Array.isArray(arr)) arr.push('');
        refreshConfigEditor();
      });
    });

    container.querySelectorAll('[data-config-array-add-object]').forEach(btn => {
      btn.addEventListener('click', () => {
        const path = JSON.parse(btn.dataset.configArrayAddObject);
        const arr = getDeepConfig(configWorkingCopy, path);
        if (Array.isArray(arr)) {
          const template = arr.length ? arr[0] : {};
          const blank = {};
          Object.keys(template).forEach(k => {
            const v = template[k];
            blank[k] = typeof v === 'number' ? 0 : typeof v === 'boolean' ? false
              : Array.isArray(v) ? [] : (v && typeof v === 'object') ? {} : '';
          });
          arr.push(blank);
        }
        refreshConfigEditor();
      });
    });
  }

  async function loadConfigTab() {
    const commonContainer = document.getElementById('config-common');
    commonContainer.innerHTML = '<p class="hint">Loading configuration…</p>';
    // Fetch garden.json and the user list together -- users live in
    // users.json (server/db.js), not garden.json, but both render into
    // this tab, so there's no reason to serialize the two requests.
    const [result, usersResult] = await Promise.all([
      api('/api/config/current'),
      api('/api/users')
    ]);
    if (!result.ok) {
      commonContainer.innerHTML = `<p class="hint">${result.message}</p>`;
      document.getElementById('config-tree').innerHTML = '';
      return;
    }
    configWorkingCopy = JSON.parse(JSON.stringify(result.config)); // working copy; edits don't touch the loaded original
    if (usersResult.ok) usersCache = usersResult.users;
    document.getElementById('config-file-path').textContent = result.path;
    const filePath2 = document.getElementById('config-file-path-2');
    if (filePath2) filePath2.textContent = result.path;
    document.getElementById('config-confirm-path').textContent = result.path;
    refreshConfigEditor();
  }

  document.getElementById('btn-save-config').addEventListener('click', () => {
    document.getElementById('modal-config-confirm').classList.remove('hidden');
  });
  document.getElementById('btn-cancel-config-save').addEventListener('click', () => {
    document.getElementById('modal-config-confirm').classList.add('hidden');
  });
  document.getElementById('btn-confirm-config-save').addEventListener('click', async () => {
    document.getElementById('modal-config-confirm').classList.add('hidden');
    const statusEl = document.getElementById('config-save-status');
    statusEl.style.color = '';
    statusEl.textContent = 'Saving…';
    const result = await api('/api/config/current', { method: 'PUT', body: JSON.stringify(configWorkingCopy) });
    if (!result.ok) {
      statusEl.style.color = '#c0392b';
      statusEl.textContent = result.message;
      showToast(result.message, 'error');
      return;
    }
    showToast('garden.json saved.', 'success');
    await loadConfigTab(); // reload fresh from disk so the form reflects exactly what's now stored
    // Set the success message AFTER the reload, since loadConfigTab() re-renders
    // the tab but does not touch config-save-status itself.
    statusEl.style.color = '#2f6d4f';
    statusEl.textContent = result.message;
  });

  boot();
})();
