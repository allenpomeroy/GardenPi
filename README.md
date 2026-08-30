# GardenPi

This repository contains all the hardware and software components for my garden automation system that is based on Raspberry Pi 4.  It uses the built-in GPIO ports, a I2C based PiController for additional MCP GPIO sensor ports and LEDs, ADC channels and an I2C based PowerController with 5 valve and 2 pump relays.

## Hardware

Hardware:
- Raspberry Pi 4 running Debian Bookworm Linux
- Native GPIO lines on the Raspberry Pi
  - Rain, Wind sensors
- Native I2C hardware (Bus 1) and software (Bus 3) busses
  - Si7021 Temp+Humidity sensors internal and external
- PiControllerV7.1.1 expansion PCB
  - MCP23017 for 16 additional GPIO lines accessed via I2C
  - MCP3008 Analog Digital Converter accessed via native GPIO SPI interface
    - Daylight level 3V3
    - Wind Direction 3V3
    - 3x Soil moisture 3V3
    - Water pressure 5V
    - PowerController 5V monitor
    - Auxillary 5V input
- PowerControllerV2.4.2
  - MCP23017 for control of
    - 5 24VAC relays
    - 2 12VDC pump relays
    - 60Hz 120 VAC frequency measurement
    - 3 additional GPIO input lines

## Software

# Overview

All software for this project has been completely rewritten to one monolithic project based on
- handlers to interface with hardware for command, control and queries
- comprehensive API which exposes endpoints that provide control and query access to hardware (default port 5000)
- many clients could be accessing the MCP23017's or the MCP3008 simultaneously, so there is a small number of handlers to provide exclusive access to the chips without reinitialization on each different access
- client programs communicate to the handlers via unix sockets and implement an exclusive lock to ensure only one client of each handler is communicating with the handler at a time
- handler / clients:
  - adc-handler.py / adc.py - read voltage of any of the ADC channels
  - irrigation-handler.py / irrigation.py - control valves and pumps, turn on/off, get status
  - led-handler.py / led.py - control LEDs
- api endpoints
- webui web interface (default port 8787)
- python3 virtual env in which all needed third party libraries such as the Adafruit CircuitPython
- Uses Adafruit libraries for both MCP23017 and MCP3008 chips (installed by install process)
  https://docs.circuitpython.org/projects/mcp230xx/en/latest/api.html#adafruit_mcp230xx.digital_inout.DigitalInOut
  adafruit-circuitpython-mcp230xx
- installation of software
  - extract gardenpi-x.x.x.tgz to /opt/gardenpi
  - cd /opt/gardenpi
  - sudo /opt/gardenpi/scripts/fix-perms.sh
  - sudo /opt/gardenpi/scripts/install-garden.sh
  - open browser https://raspberry.local:8787
  - create initial admin user / password
  - set any sensor, channel, relay user names and friendly names

# GardenPi Control Web UI

A professional web UI (TLS-only, port 8787) for a GardenPi-style irrigation
system: a configurable-widget **Dashboard**, an **Irrigation** tab for direct
valve/pump control, a **Schedule** tab that replaces crontab + bash-wrapper
watering scripts with an in-app scheduler, and a **Settings** tab.

It talks to the real **Garden Controller REST API** (Bearer-token auth,
relay-based irrigation control, LED status, ADC sensors, a weather endpoint)
running on the Pi, with an in-memory simulation mode for development/demo
without hardware.

Deployed at `/opt/gardenpi/webui`, configured entirely from
`/opt/gardenpi/config/garden.json` — see [Configuration](#configuration).

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [The GardenAPI integration](#the-gardenapi-integration)
- [Valves and pumps](#valves-and-pumps)
- [Status LEDs](#status-leds)
- [Sensors](#sensors)
- [Recent Activity](#recent-activity)
- [Scheduler](#scheduler-replacing-crontab)
- [Authentication and sessions](#authentication-and-sessions)
- [Guard rails, summarized](#guard-rails-summarized)
- [Error handling and logging](#error-handling-and-logging)
- [Diagnostics](#diagnostics-log_leveldebug)
- [Running as a service (systemd)](#running-as-a-service-systemd)
- [Configuration tab (editing garden.json from the UI)](#configuration-tab-editing-gardenjson-from-the-ui)
- [Versioning](#versioning)
- [Project layout](#project-layout)
- [Known limitations / things to verify on your hardware](#known-limitations--things-to-verify-on-your-hardware)

## Features

- **Dashboard** with a configurable widget grid: System Status LEDs, Valve
  Quick Status, Sensors, Scheduler & Controller Health. Widget visibility and
  (within the Sensors widget) individual sensor visibility are both toggleable
  and remembered per-browser.
- **Recent Activity** — a curated, human-readable, reverse-chronological
  activity feed (newest first) spanning 2 of the dashboard's 3 widget
  columns, with infinite scroll back through history.
- **Irrigation tab** with separate **Valves** and **Pumps** sections, live
  state, on/off control, and an optional "run for N minutes" safety limit —
  the minutes box defaults to, and is capped at, `handlers.irrigation.
  max_valve_run_time` in garden.json (so it always reflects whatever safety
  limit is currently configured, not a hardcoded guess) — plus an "Emergency
  stop" button that stops every relay at once.
- **Schedule tab** — an in-app scheduler with add/edit/delete watering
  windows, per-valve "select all" enable/disable, next-run times, and a live
  "RUNNING" badge, replacing crontab + a bash wrapper script.
- **Configuration tab** — a full editor over the `garden.json` file (not a
  separate Settings page - there is no standalone Settings tab; session
  timeout, dashboard refresh interval, valve safety limits, and everything
  else that used to live there is edited here instead, laid out to match
  the "GardenPi System / Web UI / Software" grouping used across all
  GardenPi configuration surfaces), with type-preserving edits, masked
  secrets, HW ID/User ID/Friendly Name label tables for ADC/LED/Irrigation/
  Weather, hardware pin-map tables, and automatic backups on every save.
- **Auth** — first connection prompts creation of an admin username/password;
  afterwards it's session-cookie based, with a configurable idle timeout.
- **No raw error pages** — a central error handler guarantees the browser
  never sees a raw 400/500 or a GardenAPI stack trace; it always gets a short,
  human message, while full detail goes to the logs.
- **TLS-only**, listening on port 8787.

## Quick start

This app is deployed at **`/opt/gardenpi/webui`**, with its configuration at
**`/opt/gardenpi/config/garden.json`** (see [Configuration](#configuration)
below). It is a plain Node.js/Express application — there is no Python
virtual environment or `requirements.txt` for this component (see the note
at the end of [Configuration](#configuration) if you were expecting one).

```bash
sudo mkdir -p /opt/gardenpi/config
sudo mkdir -p /opt/gardenpi/webui
sudo mkdir -p /opt/gardenpi/data/webui
sudo chown -R pi:pi /opt/gardenpi/data/webui /opt/gardenpi/webui   # or your service user
# Unpack this project's contents into /opt/gardenpi/webui, then:
cd /opt/gardenpi/webui
npm install
sudo cp garden.example.json /opt/gardenpi/config/garden.json   # only if garden.json doesn't already exist
sudo nano /opt/gardenpi/config/garden.json                     # edit the webui stanza: token, baseUrl, etc.
node scripts/seed-schedule.js                                  # optional: pre-loads an example watering schedule
npm start                                                       # listens on https://0.0.0.0:8787
```

By default the app expects a TLS certificate/key already installed at
`/etc/pki/tls/certs/node.pem` and `/etc/pki/tls/private/node.key` (set via
`config.tls_cert_file` / `config.tls_key_file` in `garden.json` — shared
system-wide, not webui-specific) — the same standard location the GardenAPI's
own production Gunicorn setup uses. If you're testing locally and don't have
those, run `./scripts/generate-cert.sh` instead and set
`config.tls_cert_file`/`config.tls_key_file` to `./certs/server.crt` /
`./certs/server.key` in `garden.json`.

**Permissions note:** `/etc/pki/tls/private/node.key` is typically root-only
readable (`0600`). Whatever OS user runs this app needs read access to it —
either run the service as `root`, or grant your app user read access, e.g.:

```bash
sudo setfacl -m u:pi:r /etc/pki/tls/private/node.key
```

Then open `https://<host>:8787` — you'll be prompted to create the admin
account on first visit. Set `gardenApi.mock` to `false` and fill in
`gardenApi.baseUrl` / `gardenApi.token` in `garden.json` once you're ready to
point at the real controller (see [Configuration](#configuration)).

No native modules are used (bcryptjs instead of bcrypt, a JSON file instead of
SQLite) specifically so `npm install` works cleanly on a Raspberry Pi without a
C build toolchain.

---

## Configuration

**`/opt/gardenpi/config/garden.json` is a file SHARED across the whole
GardenPi system** (other handlers, the API, etc.) — this web UI only
owns one stanza in it, `webui`, and treats the rest (`config`, `hardware`,
`handlers`) as **ground truth it reads but does not manage**. There is no
`.env` file and nothing is configured via environment variables (with one
narrow exception, `GARDEN_CONFIG_PATH`, described below). Everything is
loaded and cross-referenced by `server/config.js`.

Copy the shipped template and edit the `webui` stanza (the other stanzas
should already exist, managed by the rest of your GardenPi install):

```bash
sudo cp garden.example.json /opt/gardenpi/config/garden.json   # only if garden.json doesn't already exist
sudo nano /opt/gardenpi/config/garden.json
```

### The `webui` stanza (this app's own settings)

| Field | Default | Purpose |
|---|---|---|
| `webui.listen_port` | `8787` | HTTPS listen port. |
| `webui.log_level` | `info` | Falls back to `config.global_log_level` if unset. Set to `debug` temporarily to see raw GardenAPI response bodies — see [Diagnostics](#diagnostics-log_leveldebug). |
| `webui.data_dir` | `/opt/gardenpi/data/webui` | Where this app's own dynamic data lives — see below. **Never** garden.json itself. |
| `webui.log_dir` | `/opt/gardenpi/webui/logs` | Where log files are written. |
| `webui.api_base_url` | `https://raspberrypi.local:5000` | Base URL of the real Garden Controller API, as reachable from wherever webui runs. |
| `webui.api_tls_reject` | `"false"` | Set `"true"` once the controller has a trusted (non-self-signed) cert. |
| `webui.api_timeout_ms` | `"4000"` | Timeout for calls to the controller before surfacing a friendly "unreachable" message. |
| `webui.mock_api` | `"true"` | `"true"` runs against an in-memory simulated controller (no hardware needed); set `"false"` for the real API. |
| `webui.irrigation.valves[]` / `.pumps[]` | see `garden.example.json` | Friendly `name`/`location` for each relay — see below for how these map to hardware. |
| `webui.settings.*` | see `garden.example.json` | **Defaults only** for session timeout / poll interval / guard rails — see below. |

### Ground truth read from the OTHER stanzas (not webui-owned)

- **TLS cert/key** (`config.tls_cert_file` / `config.tls_key_file`) — shared
  system-wide, not a separate webui copy.
- **The GardenAPI Bearer token** (`handlers.api.token`) — webui reads
  this directly rather than keeping an independent copy that could drift out
  of sync. (It'll fall back to a `webui.api_token` field if present, but
  that's a compatibility fallback, not the intended source.)
- **Which physical relay each valve/pump actually is**
  (`handlers.irrigation.relay_map`) — `webui.irrigation.valves[].id`
  / `.pumps[].id` must be one of the labels listed there. Renaming a
  relay's label in `relay_map` (e.g. a customer relabeling the physical
  "pump1" slot to `"outsidelights"`) is picked up automatically — see
  [Valves and pumps](#valves-and-pumps) for why this matters for the pump
  safety rules specifically.
- **Status LEDs** (`handlers.leds.led_map`) — the entire LED list is
  derived from here; there is no separate `webui`-owned LED list to keep in
  sync. See [Status LEDs](#status-leds).
- **Hardware safety limits** (`handlers.irrigation.max_valve_run_time`,
  `.no_timeout_relays`) — the physical controller's own safety ceiling and
  no-timeout exemption list, enforced by `valveControl.js` regardless of what
  `webui.settings.guardrails.maxRunMinutesPerValve` says (that setting can
  only make the app-level timer *shorter* than the hardware ceiling, never
  longer). See [Guard rails](#guard-rails-summarized).

### Dynamic data lives in its own files, never in garden.json

**Nothing dynamic — user accounts, sessions, the watering schedule, or
activity history — is ever read from or written to `garden.json`.** That
file is shared system-wide configuration; embedding per-user password
hashes or fast-changing runtime state in it would be both a security problem
(every service that reads the shared file would see password hashes) and a
data-integrity one (concurrent writes from multiple services). Instead, all
of that lives under `webui.data_dir` (default `/opt/gardenpi/data/webui`),
managed exclusively by `server/db.js`:

```
/opt/gardenpi/data/webui/
  users.json       admin account(s)
  sessions.json    active session tokens
  schedule.json    the watering schedule (edited from the Schedule tab)
  events.json      the Recent Activity feed's event history
```

There is no `settings.json` - app-level settings (session timeout, dashboard
refresh interval, valve safety limits) all live in `garden.json` itself now
(edited from the Configuration tab), not a separate app-only override file.

If `garden.json` is missing or fails to parse, the app logs a clear error to
the console and **falls back to built-in defaults in mock mode** rather than
crashing, so a bad edit doesn't take the whole service down silently.

**The one environment variable:** `GARDEN_CONFIG_PATH` overrides where the
app looks for `garden.json` (default `/opt/gardenpi/config/garden.json`) —
this is a pointer to where configuration lives, not a configuration value
itself, which is why it's the one thing still set outside the file (useful
for local dev/testing without touching `/opt/gardenpi`).

**Editing garden.json from the UI:** not yet — for now this app only reads
`garden.json`. A future version will add a Settings sub-tab to edit it
in-place.

**On the `/opt/gardenpi/python3` question:** this web UI has **no Python
dependencies at all** — it's a plain Node.js/Express application, so there is
no virtual environment or `requirements.txt` needed for it. If your broader
GardenPi deployment also runs a separate Python-based service (e.g. the
API handler itself) under a venv at that path, that's a
different codebase from this one; its `requirements.txt` would depend on
that project's own dependencies (Flask, gunicorn, hardware I/O libraries,
etc.), which this project doesn't have visibility into.

---

## The GardenAPI integration

The adapter (`server/gardenApiClient.js`) implements the documented **Garden
Controller REST API v1.0**, adjusted to match the *actual* response shapes
observed from a real controller in production (a couple of details differed
from the original written spec — noted below).

| Purpose | Method | Path | Auth |
|---|---|---|---|
| Health / handler status | GET | `/api/health` | No |
| Read all ADC channels | GET | `/api/adc?channel=all` | Yes |
| Turn a relay on/off / get status | POST | `/api/irrigation` `{relay, action}` | Yes |
| Relay status (all or one) | GET | `/api/irrigation/status[?relay=X]` | Yes |
| Turn all relays off | POST | `/api/irrigation` `{relay:"all",action:"off"}` | Yes |
| LED on/off/blink | POST | `/api/leds` `{led, action}` | Yes |
| LED status (all or one) | GET | `/api/leds/status[?led=X]` | Yes |
| Latest/recent weather reading | GET | `/api/weather?last=N` | Yes |

### Response shapes confirmed against a real controller

- **Irrigation status** (bulk *and* single-relay) is a **flat map**:
  `{"mag": "off", "plants": "off", ...}` — a single-relay query returns the
  same shape, just with one key (not a `{relay, state}` object).
- **LED status** (bulk *and* single-LED) is wrapped in a `status` key:
  `{"status": {"sysred": {"effect": "static", "state": "off"}, ...}}`.
  **Blink detection reads from `effect`** (e.g.
  `"active (patternblink-led2green-3)"`), not from the momentary `state` —
  `state` genuinely toggles on/off every poll while an LED is blinking, so
  using it directly would make a blinking LED flicker in the UI instead of
  showing a steady "blinking" indicator.
- **The `/api/irrigation` POST response has no `state` field** (e.g.
  `{"action":"on","relay":"mag","safety_timeout_sec":900,"success":true}`), so
  a command's result is never assumed from the POST response alone — the
  adapter immediately reads back the relay's actual status and only reports
  success if that confirms it. If it can't get a clear confirmation, it fails
  with a specific error rather than assuming the command worked (see
  [Error handling](#error-handling-and-logging)).

### Where this maps to your controller

- **Which relay is which** — `webui.irrigation.valves[]`/`.pumps[]` give the
  friendly `name`/`location`; `handlers.irrigation.relay_map` is
  the ground truth for which customer-facing label each physical relay slot
  actually answers to (see [Valves and pumps](#valves-and-pumps)).
- **LEDs** — derived entirely from `handlers.leds.led_map` (see
  [Status LEDs](#status-leds)).
- **Connection** — `webui.api_base_url` and `handlers.api.token`.

The table of documented endpoints above is reference material, not something
read from a file — the actual calls are made directly in
`server/gardenApiClient.js`. If your controller ever changes shape, adjust
`extractRelayStates()` / `extractLedStates()` there — see
[Diagnostics](#diagnostics-log_leveldebug) for how to see the raw responses.

---

## Valves and pumps

Configured relays are split into two independent groups, shown as separate
"Valves" and "Pumps" sections on the Irrigation tab:

- **Valves** (`mag`, `plants`, `nearbed`, `farbed`, `valve5` by default) —
  mutually exclusive when `handlers.irrigation.allow_concurrent_valves` is
  `false` (the default) in garden.json: only one can be on at a time. This
  is a hardware/handler-level setting edited on the Configuration tab, not
  an app-level toggle this web UI maintains its own copy of.
- **Pumps** — not part of that mutual-exclusion rule; both can run at the
  same time as each other and alongside a valve.

### Pump rules are keyed to the physical relay's hardware_id, not the customer-facing id

`webui.irrigation.pumps[].id` is a **customer-configurable label**
(the `user_id` from the matching `handlers.irrigation.relay_map` entry,
falling back to `hardware_id` if no `user_id` is set) — a customer can
relabel which physical relay (`pump1` or `pump2`, defined by
`hardware.powercontroller.pin_map`) answers to which name. For example, a
customer might relabel the physical `pump1` relay to `"outsidelights"`
because that's what it actually controls at their site.

Because of this, the pump-specific safety rules below are resolved against
the **hardware_id** (`server/config.js` cross-references `relay_map` by
`hardware_id` to find it, exposed as each valve/pump's `hardwareId` — an
immutable, read-only field), never against the current user_id/friendly
name — so relabeling a relay doesn't silently break its safety behavior:

- **The relay with hardware_id `pump1`** has no timeout restriction and
  can run any time, for any length of time — this comes from
  `handlers.irrigation.no_timeout_relays` (ground truth), not a webui
  guess.
- **The relay with hardware_id `pump2`** may only run while an
  irrigation valve is on. This interlock *is* an app-level business rule
  (garden.json doesn't declare it) — the app blocks turning it on otherwise
  (*"Pump 2 can only run while an irrigation valve is on"*), and
  automatically turns it off if the valve it was running alongside turns out
  to be the last one running — whether that valve was stopped manually, by
  the scheduler, or by a safety timeout.

This was verified directly: with `pump1` relabeled to `"outsidelights"` in
`relay_map`, turning on `outsidelights` with no valve running still
succeeds (it's really the unrestricted `pump1` relay), while turning on
`pump2` with no valve running is still correctly blocked.

The Irrigation tab's "Emergency stop" button sends `{relay:"all",
action:"off"}`, which — per the controller's actual behavior — turns off
**every** configured relay, pumps included. It's a full stop, not just a
valve stop.

---

## Status LEDs

The full LED list is **derived entirely from `handlers.leds.led_map`** in
`garden.json` — there is no separate `webui`-owned LED list to keep in sync.
Each LED's color is inferred from its id suffix (`sysred` → red, `led2blue` →
blue, etc.) and its display group from the handler's internal group name
(`sys` → System, `led1` → Sensors, `led2` → Irrigation).

The Dashboard shows three vertical rows — **System**, **Sensors**,
**Irrigation** — each showing whichever color (red/green/blue) is currently
lit for that group, with a status label:

| Group | Red | Green | Blue |
|---|---|---|---|
| System | Error | Boot | Running |
| Sensors | Error | Initializing | Running |
| Irrigation | Error | Initializing (solid) / **Valve on** (blinking) | Running |

Pumps are intentionally **not** represented in the Irrigation LED or anywhere
else in the LED grouping: the physical `pump1` slot can free-run with no need
for an indicator, and the physical `pump2` slot only ever runs while a valve
is on, which the Irrigation LED already indicates.

---

## Sensors

The Sensors widget combines two GardenAPI sources:

- **ADC channels** (`GET /api/adc?channel=all`) — e.g. soil moisture, light,
  pressure voltages.
- **Weather** (`GET /api/weather?last=1`) — temperature, humidity, wind, rain,
  daylight, soil-moisture-sensor voltages, etc.

All floating-point readings are rounded to at most 3 decimal places for
display (long raw values like `2.697685740236551` display as `2.698`).

**Which readings are shown is configurable** — click **Configure** on the
Sensors widget to check/uncheck individual readings. New sensors are visible
by default the first time they're seen; the choice is remembered per-browser
(`localStorage`), independent of which top-level dashboard widgets are shown.

---

## Recent Activity

The Dashboard's Recent Activity panel is a curated, human-readable,
reverse-chronological feed (newest first) of the app's own meaningful
actions — valve/pump on/off, schedule changes, safety-rule enforcement
(e.g. Pump 2 auto-shutoff), scheduler deferrals — served page by page via
`GET /api/activity/current?limit=&offset=` (`server/routes/activity.js`,
backed by `db.getEventsPage()`). It's distinct from the full raw application
log: entries read like *"Magnolia turned ON (manual)"* rather than a raw
JSON log line, and there's no request-trace noise to filter, since this feed
is built from a small set of curated event types to begin with.

It sits in the same widget grid as the other dashboard tiles, spanning 2 of
the grid's 3 columns (`grid-column: span 2`) rather than a single tile's
width.

- Loads the most recent 20 events on first view, newest at the top.
- Each entry's timestamp includes the date (e.g. `Aug 24 01:38:59 PM`), not
  just the time of day, since the feed can be scrolled back across multiple
  days of history.
- **Scroll down** toward the bottom of the box to load the next older page —
  keeps loading further back through history as you scroll, like a typical
  activity/news feed (append-at-bottom; no position compensation needed since
  new content appears below what's already visible).
- **New events appear at the top** as they happen (checked on every status
  poll): if you're already looking at the very top of the feed, it stays
  pinned there so new items are visible; if you've scrolled down into
  history, your view is preserved exactly (scrollHeight/scrollTop
  compensation), rather than being pushed around by items appearing above.
- Uses the same **synthetic, always-visible scroll indicator** as elsewhere
  in the app (`updateActivityScrollbar()` in `public/js/app.js`) rather than
  relying on the browser's native scrollbar, since several platforms (macOS's
  default trackpad "overlay" scrollbar behavior, some Linux/Chrome
  configurations) hide native scrollbars until an active scroll gesture.
- Because this panel is a genuine grid item (not appended after the grid),
  and its content/scroll state must survive the other widgets' periodic
  `innerHTML` rebuild, `renderDashboard()` detaches the same DOM node before
  rebuilding the grid and reinserts it afterward — explicitly saving and
  restoring its scroll position around that, since some browsers reset an
  element's `scrollTop` on detach/reattach even when it's the same node.

**If you want the full raw request/response log instead** (e.g. for
troubleshooting GardenAPI integration issues), that's still available via
`GET /api/logs/current` — see [Diagnostics](#diagnostics-log_leveldebug) — it
just isn't what's shown in this dashboard panel.

---

## Scheduler (replacing crontab)

`server/scheduler.js` replaces the old crontab + bash-wrapper approach.
Design notes:

- A tick runs every 15 seconds and checks whether "now" falls inside any
  enabled schedule window (day-of-week + start time + duration).
- If a window should start but another valve is already running (manual or
  another schedule), the start is **deferred** (retried every tick) rather
  than force-stopping the other valve — this is logged and visible in the
  dashboard's Recent Activity feed as a "deferred" event.
- The scheduler only ever turns off a valve **it** turned on, so it never
  interferes with a valve you started by hand.
- Each valve's block on the Schedule tab has a "select all" checkbox next to
  the **Enabled** column header, to enable/disable every window for that
  valve at once.

Once you're happy with the in-app Schedule tab, remove the old crontab lines
(`crontab -e`) and the bash wrapper script they called.

---

## Authentication and sessions

- **First connection**: if no account exists yet, you're prompted to create
  one (username + password, bcrypt-hashed).
- **Afterwards**: a signed, random session token is set as an `httpOnly`,
  `secure`, `sameSite=strict` cookie. There's no separate "remember me" state —
  the cookie is the session.
- **Multiple users, no roles.** More accounts can be added from the
  Configuration tab's **Users** block (see below) — every account is
  identical in what it can do: control valves/pumps, edit the schedule, edit
  `garden.json`, and manage every other account (add/remove users, change
  anyone's password, including its own). There's no admin/viewer distinction
  and no per-account restriction. The only constraint enforced anywhere is
  that the **last remaining account can never be removed** — the app must
  always have at least one way to sign in.
- **Session timeout** (`webui.settings.session_timeout_minutes` in
  garden.json, edited on the Configuration tab): idle timeout in minutes,
  or **0 = never time out**.
- **What counts as "activity"**: any request that passes through the
  `requireAuth` middleware touches the session and resets its idle clock.
  This includes valve/schedule/settings changes, **and** the automatic status
  poll (`GET /api/status/all`) that the Dashboard and Irrigation tab call every
  few seconds on their own while open. In practice this means: as long as a
  browser tab with the app open keeps polling, the session effectively never
  times out from simple on-screen inactivity — the timeout mainly protects
  against a **closed tab, backgrounded/sleeping device, or dropped
  connection** (which stop the polling loop) rather than a person stepping
  away while the tab stays open. If you'd rather have the timeout reflect only
  explicit user actions (ignoring the background poll), that's a small,
  contained change in `server/middleware/requireAuth.js` / the status route.

---

## Guard rails, summarized

- Only one **valve** can be on at a time (toggleable in Settings) — enforced
  in one shared place (`server/valveControl.js`) used by both manual control
  and the scheduler, so it can't be bypassed from either path.
- The physical **`pump2`** slot can only run while a valve is on; the
  physical **`pump1`** slot is unrestricted — both keyed to the physical
  relay slot, not the current customer-facing label, so relabeling a relay
  doesn't change its safety behavior (see [Valves and pumps](#valves-and-pumps)).
- A manual "run for N minutes" request (or the configured app-level
  max-run-minutes setting, whichever is shorter) always sets a server-side
  safety auto-shutoff timer — **capped at the hardware's own
  `max_valve_duration_sec` ceiling regardless of what the app setting says**,
  and skipped entirely for any relay listed in
  `handlers.irrigation.no_timeout_relays`. A valve can never be left
  open by a dropped connection, a forgotten tab, or an app setting that's
  higher than the physical controller's own limit. The Irrigation tab's
  minutes input itself defaults to, and cannot exceed, the app-level **Max
  run time per valve** setting, refreshed whenever the Irrigation tab is
  opened or the setting is changed.
- After sending an on/off command, the app reads back the relay's actual
  status and only reports success if that confirms it — it will not report
  "on" if the controller silently accepted the command but the valve never
  actually changed state.

---

## Error handling and logging

- A central error handler (`server/middleware/errorHandler.js`) guarantees the
  browser never sees a raw 400/500 or a stack trace — always a short, friendly
  message (e.g. *"The Garden Controller is not responding right now"*,
  *"invalid API token"*, *"handler unavailable"*), with the full detail logged
  server-side.
- **Logging**: `winston`, rotated daily, split into `logs/app-*.log` (all
  activity — logins, valve commands, schedule changes, scheduler decisions)
  and `logs/error-*.log` (errors only).
- Expected/handled conditions (guard-rail conflicts, unreachable hardware, bad
  input) are logged at `warn`, keeping `error`-level logs meaningful for
  genuine bugs.

---

## Diagnostics (`LOG_LEVEL=debug`)

If you ever see LEDs stuck on "Unknown", or a command reporting it "couldn't
confirm" the result, set `server.logLevel` to `"debug"` in
`/opt/gardenpi/config/garden.json` and restart the service. The logs will
show the exact raw JSON returned for every irrigation/LED status and command
call:

- `Raw irrigation POST response`
- `Raw per-relay status response after command`
- `Raw bulk irrigation status response`
- `Raw bulk LED status response` / `Raw per-LED status response`

Compare those to `extractRelayStates()` / `extractLedStates()` in
`server/gardenApiClient.js` and adjust if your controller's firmware ever
returns a different shape. Set `server.logLevel` back to `"info"` once
confirmed working, to keep logs quieter.

You can get the same information directly, without the app, via (substitute
your actual token from `garden.json`'s `gardenApi.token`):

```bash
curl -k -H "Authorization: Bearer <token>" "https://<host>:5000/api/irrigation/status?relay=mag"
curl -k -H "Authorization: Bearer <token>" "https://<host>:5000/api/leds/status?led=sysblue"
curl -k -H "Authorization: Bearer <token>" "https://<host>:5000/api/leds/status"
```

---

## Running as a service (systemd)

A unit file is provided at `scripts/gardenpi-webui.service`, already set up
for the `/opt/gardenpi/webui` layout:

```bash
sudo cp scripts/gardenpi-webui.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gardenpi-webui
```

Edit the `User=` line if you're not running as `pi` (and see the TLS key
permissions note above/in the unit file's comments). Configuration is read
from `/opt/gardenpi/config/garden.json` automatically — no `EnvironmentFile`
or `.env` needed.

---

## Configuration tab (editing garden.json from the UI)

The **Configuration** tab lets you view and edit `garden.json` from the UI —
not just the `webui` stanza, but `config`/`hardware`/`handlers` too, since
those are all in the same shared file. It's the ONLY settings surface in
this app — there is no separate Settings page; session timeout, dashboard
refresh interval, valve concurrency/safety limits, and hardware/handler
naming are all edited here.

**This is an explicit allowlist, not a full generic editor.** Only the
fields listed below are shown at all; anything not mapped is excluded from
the UI entirely for now, expanded in future iterations as more fields are
decided safe/useful to expose. Hiding a field here doesn't delete it from
`garden.json`, it's simply not editable from the UI yet.

The layout below mirrors the same "GardenPi System / Web UI / Software /
Hardware" grouping used across GardenPi's configuration surfaces.

### Always visible

| Group | Fields |
|---|---|
| **GardenPi System** (`config`) | Version *(read-only)*, Last Changed *(read-only)*, Global Log Level (dropdown), TLS Certificate File, TLS Key File, plus a **Users** block (add/remove accounts, change any account's password — see below; this is the one part of the GardenPi System card that isn't backed by `garden.json`) |
| **Web UI** (`webui`) | Listener Port, Log Level (dropdown), API URL, API Access Token, Session Secret, Session Timeout (dropdown, `webui.settings.session_timeout_minutes`), Dashboard Refresh in seconds (`webui.settings.poll_interval_seconds`) |
| **Software → API** (`handlers.api`) | Listener Port, Log Level (dropdown), Auth Token |
| **Software → ADC** (`handlers.adc`) | Listener Socket, Log Level (dropdown) |
| **Software → LEDs** (`handlers.leds`) | Listener Socket, Log Level (dropdown) |
| **Software → Irrigation** (`handlers.irrigation`) | Listener Socket, Log Level (dropdown), Max Valve Run Time (`max_valve_run_time`, seconds), Allow Concurrent Valves (toggle) |
| **Software → Weather** (`handlers.weather`) | Listener Socket, Log Level (dropdown) |
| **Software → WeeWx** (`weewx`) | Main URL |

### Users (GardenPi System pane)

Also on the **GardenPi System** card, below the `config` fields above, is a
**Users** block for managing sign-in accounts. Unlike everything else on the
Configuration page, this doesn't read or write `garden.json` at all — it's
backed by its own file, `users.json` (in `webui.data_dir`, alongside
sessions/schedule/activity — see [Configuration](#configuration) above), via
a dedicated `/api/users` endpoint (`GET /`, `POST /`, `POST /:id/password`,
`DELETE /:id`), separate from `/api/config`.

- **No roles or permissions.** Every account can do everything: control the
  system, edit `garden.json`, add or remove any account (including its
  own), and change any account's password (including its own) — there's no
  concept of an admin vs. a regular user.
- **Add a user**: username (3+ characters) and a password (8+ characters,
  bcrypt-hashed the same way as the original setup flow) — no confirmation
  step server-side beyond matching the two password fields in the modal.
- **Change password**: works the same for your own account or anyone
  else's — there's no "current password" check, since there's no
  privilege distinction to protect against.
- **Remove a user**: blocked, both in the UI (the button is disabled with a
  tooltip) and by the API (`DELETE /api/users/:id` returns an error), if
  it's the **last remaining account** — the app must always have at least
  one way to sign in. Removing your own currently-signed-in account is
  otherwise allowed; the UI warns you first, then signs you out immediately
  since that session's account no longer exists. Removing any account also
  immediately invalidates that account's other active sessions (other
  signed-in browsers/tabs), not just the one that clicked Remove.

### Advanced (collapsed by default, marked DANGER)

| Group | Fields |
|---|---|
| **Web UI** | API TLS Reject (toggle), API Timeout (ms), Use Mock API (toggle) |
| **Software → ADC — Channel Labels** | One row per `handlers.adc.channel_map` entry: **HW ID** *(read-only)*, **User ID** (editable), **Friendly Name** (editable) |
| **Software → LEDs — LED Labels** | One row per `handlers.leds.led_map` entry: **HW ID**, **Group**, **Aliases** — all **read-only** (LED hardware_id and labels can never be customer-edited) |
| **Software → Irrigation — Relay Labels** | One row per `handlers.irrigation.relay_map` entry: **HW ID** *(read-only)*, **User ID** (editable), **Friendly Name** (editable) |
| **Software → Weather — Input Labels** | One row per `handlers.weather.input_map` entry: **HW ID** *(read-only)*, **User ID** (editable), **Friendly Name** (editable) - the owning table for every `source: "weather"` sensor's friendly name below |
| **Software → Weather — Sensor Labels** | One row per `handlers.weather.sensor_map` entry: **Sensor ID** *(read-only, the map key)*, **HW or User ID** (editable `source_id`), **Friendly Name** *(read-only - derived from whichever table actually owns that hardware line: ADC — Channel Labels for `source: "adc"` sensors, Weather — Input Labels above for `source: "weather"` sensors; edit it there instead)*, **Enabled** (toggle) |
| **Hardware → RaspberryPi** | GPIO Pin HW ID table: hardware_id *(read-only)* → pin number (editable), from `hardware.raspberrypi.pin_map` |
| **Hardware → PiController** | HW Version *(read-only)*, I2C Address, then three pin tables filtered from the single `hardware.picontroller.pin_map` by `type`: **GPIO Pin HW ID** (`type: "gpio"`), **MCP LED Pin HW ID** (`type: "led"`), **ADC Pin HW ID** (`type: "adc"`) — hardware_id read-only, pin number editable |
| **Hardware → PowerController** | HW Version *(read-only)*, I2C Address, **Relay HW ID** table (`hardware.powercontroller.pin_map` filtered to `type: "relay"`) — hardware_id read-only, pin number editable |
| **Hardware → Temperature Sensors** | Internal I2C Address, External I2C Address (`hardware.powercontroller.temperature_sensors`) |

Every hardware_id shown anywhere on this page — channel/relay/LED/pin
identifiers — is always read-only text, matching the rule that hardware_id
and LED labels can never be changed from the UI; only user_id, friendly
names, pin numbers, and the settings above are editable.

The very bottom of the Advanced section (below its **API** subsection) links
back to this README (`/README.md`, served directly by `server/index.js` —
`README.md` lives at the repo root, outside the `public/` folder that
`express.static` exposes, so it gets its own small route) — mainly so an
admin who's deep in the Advanced settings can jump straight to reference
docs like the `weather.csv` layout below without needing repo access.

### `weather.csv` column layout

The Advanced section's **Web UI** row (`webui.api_tls_reject`,
`webui.api_timeout_ms`, `webui.mock_api`) is the only place the Configuration
tab talks about the GardenAPI connection. It does **not** cover the separate
file the **Weather** handler writes on its own schedule — `handlers.weather.
weather_file` (default `/opt/gardenpi/data/weather.csv`) — which is consumed
directly by WeeWx and any other downstream tooling, not through the API.
Since that file's column layout isn't exposed anywhere in the UI itself
(the Configuration tab only lets you edit the *path*, not its contents),
it's documented here instead:

| # | Column | Sensor ID | Friendly name | Source |
|---|---|---|---|---|
| 1 | Timestamp | — | — | `time.strftime("%Y-%m-%d %H:%M:%S")`, local time |
| 2 | Wind Speed | `s_wind_speed` | Wind Speed | `handlers.weather.input_map` (`wind_speed`) |
| 3 | Rain | `s_rain` | Rain | `handlers.weather.input_map` (`rain`) |
| 4 | Daylight | `s_daylight` | Daylight | ADC `channel0` (`handlers.adc.channel_map`) |
| 5 | Pressure | `s_pressure` | Pressure | ADC `channel2` |
| 6 | Moisture 1 | `s_moisture1` | Mag | ADC `channel4` |
| 7 | Moisture 2 | `s_moisture2` | M2 | ADC `channel5` |
| 8 | Moisture 3 | `s_moisture3` | M3 | ADC `channel6` |
| 9 | Wind Direction | `s_wind_dir` | WindDir | ADC `channel7` |
| 10 | Internal Temp | `s_int_temp` | Int Temp | `handlers.weather.input_map` (`int_temp`) |
| 11 | Internal Humidity | `s_int_humidity` | Int Humidity | `handlers.weather.input_map` (`int_humidity`) |
| 12 | External Temp | `s_ext_temp` | Ext Temp | `handlers.weather.input_map` (`ext_temp`) |
| 13 | External Humidity | `s_ext_humidity` | Ext Humidity | `handlers.weather.input_map` (`ext_humidity`) |

Notes:

- **No header row is ever written to the file.** `weather_csv_loop()` in
  the weather handler only calls `csv.writer(...).writerow(row)` for data
  rows, on every sample cycle (`default_period`) — there's no matching
  `writerow(header)` call, and the file isn't pre-seeded with a header line
  when first created. The table above is the *implied* layout, fixed by the
  `headers_sensor_ids` list hardcoded in `weather_csv_loop()`, not by
  whatever order `handlers.weather.sensor_map` happens to be in.
- **Column order never changes based on config** — it's the same 13 columns
  in the same order every row, regardless of which sensors are enabled.
- **Disabled sensors still get a column**, just an empty one: if a sensor
  has no cached value (either disabled in `sensor_map` — e.g. `s_moisture2`/
  `s_moisture3` are disabled by default — or simply hasn't reported yet),
  its cell is written as an empty string, not `0` or omitted.
- `s_hz` (Power Hz) is **not** in this file — it's written separately to
  its own file, `handlers.weather.hz_file`, as a two-column
  (timestamp, value) CSV by `hz_csv_loop()`.
- Friendly names for the ADC-sourced columns (Daylight, Pressure, Moisture
  1–3, WindDir) are edited under **Software → ADC — Channel Labels**, not
  under Weather — see the **Software → Weather — Sensor Labels** row above.

### Field-level behaviors

- **Comments and examples are read-only.** Any key containing "comment"
  (`comment`, `comment_max_valve_run_time`, …) or "example" renders as
  plain text, never an editable input.
- **Every `log_level`-style field is a dropdown**, not free text — including
  `global_log_level` and any field ending in `log_level`. The dropdown's
  options come from `config.supported_log_levels` in the loaded file itself
  (falling back to a built-in list if that's ever missing).
- **String `"true"`/`"false"` fields render as toggles**, not text boxes
  (`webui.mock_api`, `webui.api_tls_reject`) — but still save back as that
  same lowercase string, not a real JSON boolean, matching the file's
  existing convention. Verified directly: toggling `mock_api` writes
  `"false"` (a string), not `false` (a boolean).
- **Secrets are masked** (token/secret/password) with a Show/Hide toggle.
- **Arrays are editable in place** with add/remove — used for e.g. the
  timeout-exempt relay list and the relay label assignments.
- **Type-preserving**, same as before: a numeric-looking string stays a
  string, a float stays a float, on save.

### DANGER badge

The **DANGER** badge lives on the Advanced section's toggle line itself
(`<summary><strong class="config-danger">DANGER</strong> — Show all
configuration items (advanced)</summary>`) — visible even while collapsed,
so it's seen *before* expanding, not after. The Common settings panel above
it carries a softer, factual reminder (shared file, restart required) without
the word "danger," since those fields are the ones considered safe enough to
change routinely.

### Safety on save

Since this is a file shared with hardware handlers that hard-exit on
malformed config (see `garden_config.py`'s `require()` philosophy on the
handler side):

1. A confirmation modal appears before saving.
2. `PUT /api/config/current` writes a **timestamped backup** of the
   previous file first (`garden.json.bak.<ISO-timestamp>`, never
   overwritten), writes the new content to a temp file, and **atomically
   renames it into place** — a crash mid-write can never leave a handler
   looking at a half-written, corrupt file.
3. The freshly-written file is read back and re-parsed as a final sanity
   check before the save is reported as successful.
4. **No hot-reload, anywhere.** Every GardenPi service — including this web
   UI itself — reads `garden.json` once at startup and never watches it for
   changes. Saving updates the file on disk immediately, but nothing picks
   up the new values until the affected service is restarted.

### Extending the allowlist

The mapping lives in three functions in `public/js/app.js`:
`renderCommonSettings()`, `renderAdvancedSettings()`, and
`renderRelayFriendlyFieldsSection()`. Each field is one `mappedField(path,
label, opts)` call; add a new one to promote a field into the UI. `opts.readOnly`
marks it non-editable; everything else infers its input type automatically
(log-level dropdown, boolean-string toggle, masked secret, or plain
text/number) from the field's name/current value, the same detection used
throughout the rest of the editor.

---

## Versioning

The app version lives in one place, `package.json`, and is read from there by
`server/version.js` — nothing else hardcodes it. It's surfaced in three ways:

- Every major source file (`server/**/*.js`, `public/js/app.js`,
  `public/css/style.css`, `public/index.html`, `scripts/seed-schedule.js`)
  has a `GardenPi Control vX.Y.Z` comment as its first line, so the version
  is visible directly in the source regardless of which file you're looking
  at. Bump `package.json`'s version and update these header comments together.
- A public (no-auth) `GET /api/version` endpoint, used by the UI and
  available for scripts/health checks.
- A small `vX.Y.Z` badge at the top-right of the app header, next to
  "Sign out" (`#app-version-badge` in `public/index.html`, populated by
  `loadVersionBadge()` in `public/js/app.js`).

A small **WeeWx** link also sits in the header, immediately to the right of
the API mode badge (`#weewx-link` in `public/index.html`), pointing at
`weewx.main_url` from `garden.json`. It's populated by `updateWeewxLink()`
in `public/js/app.js` (called from `loadRuntimeSettings()`) and stays
hidden if `weewx.main_url` isn't set.

## Project layout

Deployed layout:

```
/opt/gardenpi/
  config/
    garden.json           SHARED across the whole GardenPi system --
                           webui owns only the 'webui' stanza in it
  data/
    webui/                 THIS app's dynamic data ONLY (never in garden.json)
      users.json, sessions.json, schedule.json, events.json
  webui/                  this project
    server/
      index.js              HTTPS server, route mounting, TLS + port 8787
      config.js             loads garden.json; resolves valves/pumps/LEDs/safety
                             limits against the hardware/handlers stanzas
      version.js             reads the app version from package.json
      auth.js                first-run setup, login, session tokens
      db.js                  tiny JSON-file datastore -- the ONLY place dynamic
                             data (users/sessions/settings/schedule/events) lives
      gardenApiClient.js     adapter to the real (or mock) GardenAPI
      valveControl.js        shared guard-rail logic (valve mutual exclusion,
                             pump rules keyed to physical relay slot)
      scheduler.js           in-app watering scheduler (replaces cron + bash wrapper)
      logger.js              winston logging setup
      middleware/            auth guard + central friendly-error handler
      routes/                auth, valves, schedule, status, settings, logs, activity, config
    public/                the frontend (vanilla HTML/CSS/JS, no build step)
      favicon.svg, favicon.ico, apple-touch-icon.png,
      icon-192.png, icon-512.png, site.webmanifest    favicon set (the 🌿 leaf, matching the header)
    scripts/
      generate-cert.sh          self-signed TLS cert for local/dev use
      seed-schedule.js          loads an example watering schedule
      gardenpi-webui.service    systemd unit, pre-configured for this layout
    garden.example.json     shipped template showing the full shared schema
                            (config/hardware/handlers/webui stanzas)
    logs/                   created at runtime (webui.log_dir in garden.json)
```

---

## Known limitations / things to verify on your hardware

- The `leds` and `valves` arrays in `garden.json` reflect relay/LED names
  confirmed against a real controller during development, but if your
  controller's firmware/config differs, edit those arrays in `garden.json` —
  no other code needs to change.
- The bulk relay/LED status parsing has a per-item fallback if the bulk call
  ever fails or returns an unrecognized shape (see `gardenApiClient.js`); this
  was validated against real response shapes but firmware updates could change
  them again — see [Diagnostics](#diagnostics-log_leveldebug) if that happens.
- Status polling (Dashboard/Irrigation tab) is short-interval HTTP polling,
  not a push/WebSocket mechanism — "near real-time" at whatever interval is
  configured in Settings (default 3s).
