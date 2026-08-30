#!/opt/gardenpi/python3/bin/python3
#
# api.py
#
# Unified REST API for the Garden Controller system with a single Flask app
#
# v2.1 2026/08/29
# - normalize weather sensors
# v2.0 2026/08/27
# - terminology/schema: handlers.adc.channels, handlers.irrigation.
#   relay_name_map, and handlers.leds.leds are replaced everywhere by the
#   shared {hardware_id, user_id, friendly} map shape (channel_map,
#   relay_map, led_map). This API now:
#     * accepts EITHER a hardware_id or a user_id in any query/command
#       (?channel=, {"relay": ...}, {"led": ...}, ?relay=, ?led=) and
#       resolves it locally before forwarding to the owning handler;
#     * always returns the user_id in responses when one is defined for a
#       given hardware_id, falling back to the hardware_id only when no
#       user_id exists - never a mix of the two within one response.
#   Each low-level handler (adc/irrigation/leds) also understands both
#   forms natively now, so this API mostly just validates against its own
#   cached copy of the map and passes the resolved hardware_id straight
#   through on the wire.
# - /api/weather now queries the weather handler's own socket
#   (handlers.weather.socket) for a live reading first, falling back to
#   the last line(s) of handlers.weather.weather_file if the handler is
#   unreachable - previously this endpoint only ever read the CSV file.
# - uses sockets to reach every other handler (adc/irrigation/leds/
#   weather) for concurrency control and exclusive hardware access -
#   unchanged in spirit from v1.x, now including weather.
#
# v1.7 2026/08/26
# - simplify socket naming
# - renamed garden-api.py to api.py
# v1.6 2026/08/25
# - no hardcoded config except the config *file path* itself
#   (DEFAULT_CONFIG_FILE). All other values (socket timeout, TLS
#   cert/key paths, listen port, log levels, handler socket paths, ADC
#   channels, relay names, valid actions, weather CSV path) must be
#   present in garden.json; a missing required value raises
#   garden_config.ConfigError naming the exact dotted path that needs to
#   be added, and the app factory fails to start rather than silently
#   substituting a guessed default. (handlers.api.token remains the
#   one deliberate exception: empty/absent means "open access" by design,
#   not a masked fallback for a real secret.)
#
# v1.4 2026/08/25
# - eliminated duplicate request logging between the app and gunicorn:
#     * garden-api.py's own _log() now skips plain 200 responses entirely,
#       since gunicorn's access log (see below) already records those with
#       more detail than the app's own line had (client IP, bytes sent,
#       user-agent). Non-200 responses (4xx/5xx/207) are still logged here,
#       now with a `detail` message explaining *why* - e.g. the actual
#       handler connection error - which gunicorn's access log can't provide.
#     * paired with a new garden_gunicorn_logger.py (GardenGunicornLogger)
#       and gunicorn.conf.py: gunicorn's access log now varies its own
#       level by status code (info/warning/error) instead of always
#       logging at INFO, is routed through the same garden_logger
#       formatter/timestamp as the app, and its format string is trimmed
#       to just the fields the app doesn't already cover (client IP, bytes
#       sent, user-agent) - method/path/status is dropped from it since
#       the app's own line already has that.
# - all logging now goes through the centralized garden_logger.init_logging()
#   helper instead of ad-hoc print()-based request/warning logging
# v1.1 2026/05/20
# - did /opt/gardenpi/python3/bin/pip install sdnotify for gunicorn to
#   notify systemd watchdog
# v1.0 2026/04/11
# - unified API gateway (single port, single TLS config)
# - direct Unix socket communication (no subprocess fork)
# - timing-safe token comparison (hmac.compare_digest)
# - endpoints: /api/adc, /api/irrigation, /api/leds, /api/weather, /api/health
# - designed to run behind gunicorn for production
#
# Installation:
#   python3 -m venv /opt/gardenpi/python3
#   source /opt/gardenpi/python3/bin/activate
#   pip install flask gunicorn
#
# Running (production with gunicorn, using garden.json defaults and the
# bundled logging config - see gunicorn.conf.py for the access-log/level
# unification that avoids duplicate log lines):
#   gunicorn -c gunicorn.conf.py --bind 0.0.0.0:5000 \
#            --workers 4 \
#            --certfile /etc/pki/tls/certs/node.pem \
#            --keyfile /etc/pki/tls/private/node.key \
#            --timeout 30 \
#            'api:create_app()'
#
# Running with an explicit config path and/or log level override (gunicorn
# supports passing arguments to an app-factory function in the module URI):
#   gunicorn --bind 0.0.0.0:5000 --workers 4 \
#            --certfile /etc/pki/tls/certs/node.pem \
#            --keyfile /etc/pki/tls/private/node.key \
#            'api:create_app(config_path="/opt/gardenpi/config/garden.json", log_level="debug")'
#
# Running standalone (dev mode):
#   ./api.py --config /opt/gardenpi/config/garden.json --loglevel debug
#
# Systemd service: gardenpi-api.service
#
# Copyright 2025-2026 Allen Pomeroy - MIT license

import os
import sys
import json
import hmac
import socket
import csv
import io
import logging
import argparse
from functools import wraps
from flask import Flask, request, jsonify

from garden_logger import init_logging, resolve_effective_level, LEVEL_ALIASES
from garden_config import (
    ConfigError, require, require_nonempty,
    build_id_map, resolve_id, display_id,
)

# --------------------------
# Constants
# --------------------------

VERSION = "2.0"

# The only hardcoded default kept: where to find garden.json. Every other
# value below must be present in the config file - see garden_config.py.
DEFAULT_CONFIG_FILE = "/opt/gardenpi/config/garden.json"

log = logging.getLogger(__name__)


# --------------------------
# Configuration loading
# --------------------------

def load_config(config_path):
    with open(config_path, "r") as f:
        cfg = json.load(f)

    global_cfg = cfg.get("config", {})
    handlers_cfg = cfg.get("handlers", {})
    api_cfg = handlers_cfg.get("api", {})
    adc_cfg = handlers_cfg.get("adc", {})
    irrigation_cfg = handlers_cfg.get("irrigation", {})
    leds_cfg = handlers_cfg.get("leds", {})
    weather_cfg = handlers_cfg.get("weather", {})

    socket_timeout = require(global_cfg, "socket_timeout", "config.socket_timeout")
    cert_file = require(global_cfg, "tls_cert_file", "config.tls_cert_file")
    key_file = require(global_cfg, "tls_key_file", "config.tls_key_file")

    listen_port = int(require(api_cfg, "listen_port", "handlers.api.listen_port"))
    api_log_level = require(api_cfg, "log_level", "handlers.api.log_level")
    global_log_level = require(global_cfg, "global_log_level", "config.global_log_level")
    # Empty/absent token intentionally means "open access" (dev mode) -
    # not a hardcoded fallback standing in for a real secret - so this one
    # key stays optional.
    config_api_token = api_cfg.get("token", "")

    adc_socket = require(adc_cfg, "socket", "handlers.adc.socket")
    channel_map_cfg = require_nonempty(adc_cfg, "channel_map", "handlers.adc.channel_map")
    adc_id_map = build_id_map(channel_map_cfg, "handlers.adc.channel_map")

    irrigation_socket = require(irrigation_cfg, "socket", "handlers.irrigation.socket")
    relay_map_cfg = require_nonempty(irrigation_cfg, "relay_map", "handlers.irrigation.relay_map")
    irrigation_id_map = build_id_map(relay_map_cfg, "handlers.irrigation.relay_map")
    valid_actions = require_nonempty(
        irrigation_cfg, "valid_relay_actions", "handlers.irrigation.valid_relay_actions"
    )

    leds_socket = require(leds_cfg, "socket", "handlers.leds.socket")
    led_map_cfg = require_nonempty(leds_cfg, "led_map", "handlers.leds.led_map")
    led_id_map = build_id_map(led_map_cfg, "handlers.leds.led_map")

    weather_socket = require(weather_cfg, "socket", "handlers.weather.socket")
    weather_csv = require(weather_cfg, "weather_file", "handlers.weather.weather_file")

    return {
        "socket_timeout": socket_timeout,
        "cert_file": cert_file,
        "key_file": key_file,
        "listen_port": listen_port,
        "api_log_level": api_log_level,
        "global_log_level": global_log_level,
        "config_api_token": config_api_token,
        "adc_socket": adc_socket,
        "adc_id_map": adc_id_map,
        "irrigation_socket": irrigation_socket,
        "irrigation_id_map": irrigation_id_map,
        "valid_actions": valid_actions,
        "leds_socket": leds_socket,
        "led_id_map": led_id_map,
        "weather_socket": weather_socket,
        "weather_csv": weather_csv,
    }


# --------------------------
# Socket communication helper
# --------------------------

def handler_command(socket_path, command, timeout):
    """
    Send a command to a Unix socket handler and return the response.
    Raises ConnectionError on failure.
    """
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout)
            sock.connect(socket_path)
            sock.sendall(command.encode('utf-8'))
            # Read until EOF or newline
            response = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response += chunk
                if b"\n" in chunk:
                    break
            return response.decode('utf-8').strip()
    except FileNotFoundError:
        raise ConnectionError(f"Handler socket not found: {socket_path}")
    except ConnectionRefusedError:
        raise ConnectionError(f"Handler not running: {socket_path}")
    except socket.timeout:
        raise ConnectionError(f"Handler timeout: {socket_path}")
    except Exception as e:
        raise ConnectionError(f"Handler error: {str(e)}")


# --------------------------
# Application factory
# --------------------------

def create_app(config_path=None, log_level=None, token=None):
    """
    Flask application factory.

    All configuration comes from garden.json plus these optional explicit
    overrides (no environment variables are read):

      config_path - path to garden.json (default: DEFAULT_CONFIG_FILE)
      log_level   - overrides both handlers.api.log_level and
                    config.global_log_level outright (e.g. "debug")
      token       - overrides handlers.api.token outright

    Examples:
      create_app()
      create_app(config_path="/opt/gardenpi/config/garden.json", log_level="debug")

    gunicorn can pass these directly in the module URI, e.g.:
      'api:create_app(config_path="/opt/gardenpi/config/garden.json")'
    """
    app = Flask(__name__)

    config_path = config_path or DEFAULT_CONFIG_FILE
    cfg = load_config(config_path)

    if log_level:
        try:
            level = LEVEL_ALIASES[log_level.strip().lower()]
        except KeyError:
            valid = ", ".join(sorted(LEVEL_ALIASES.keys()))
            level = resolve_effective_level(cfg["api_log_level"], cfg["global_log_level"])
            init_logging(level=level)
            log.error(f"Unknown log_level override '{log_level}'; valid options: {valid}. "
                      f"Falling back to config-derived level.")
        else:
            init_logging(level=level)
    else:
        level = resolve_effective_level(cfg["api_log_level"], cfg["global_log_level"])
        init_logging(level=level)

    socket_timeout = cfg["socket_timeout"]
    adc_socket = cfg["adc_socket"]
    adc_id_map = cfg["adc_id_map"]
    irrigation_socket = cfg["irrigation_socket"]
    irrigation_id_map = cfg["irrigation_id_map"]
    leds_socket = cfg["leds_socket"]
    led_id_map = cfg["led_id_map"]
    weather_socket = cfg["weather_socket"]
    weather_csv = cfg["weather_csv"]
    valid_actions = cfg["valid_actions"]

    # Token: an explicit argument (e.g. from a CLI flag) wins outright;
    # otherwise falls back to handlers.api.token in config.
    api_token = token or cfg["config_api_token"]
    if not api_token:
        log.warning("No API token set (handlers.api.token in config is empty "
                    "and no token override was given)! API is unprotected!")

    # Stash for the standalone dev server entrypoint below, so it doesn't
    # need to reload/reparse the config file itself.
    app.config['GARDEN_CFG'] = cfg
    app.config['GARDEN_API_TOKEN'] = api_token

    # ---- Auth decorator ----

    def require_token(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            if not api_token:
                # No token configured = open access (dev mode)
                return f(*args, **kwargs)

            supplied = request.headers.get('Authorization', '')
            if supplied.startswith('Bearer '):
                supplied = supplied[7:]

            if not supplied:
                _log(request, 401)
                return jsonify({'error': 'No authorization token provided'}), 401

            if not hmac.compare_digest(supplied, api_token):
                _log(request, 403)
                return jsonify({'error': 'Invalid authorization token'}), 403

            return f(*args, **kwargs)
        return decorated

    def _log(req, status, detail=None):
        # Plain success responses (200) are already fully captured by
        # gunicorn's own access log - via GardenGunicornLogger and
        # gunicorn.conf.py - which additionally records client IP, bytes
        # sent, and user-agent. Logging them again here would just be a
        # second, less detailed copy of the same line, so skip those.
        #
        # Everything else (4xx, 5xx, and 207 partial success) gets logged
        # here because the app knows *why* the request didn't fully
        # succeed - the reason passed via `detail` - which gunicorn's
        # access log has no way to capture.
        if status == 200:
            return
        message = f"[{req.method}] {req.url} - {status}"
        if detail:
            message += f": {detail}"
        if status >= 500:
            log.error(message)
        else:
            log.warning(message)

    # ---- id resolution helpers (hardware_id or user_id in, user_id-or-
    # hardware_id-for-display out) ----

    def resolve_or_none(id_map, token_str):
        return resolve_id(id_map, token_str)

    def relabel_keys(id_map, obj):
        """Given a dict keyed by hardware_id (as returned by a handler's
        own JSON response), return an equivalent dict keyed by whichever
        identifier should be shown (user_id if defined, else
        hardware_id)."""
        if not isinstance(obj, dict):
            return obj
        return {
            display_id(id_map, k) if k in id_map["by_hardware_id"] else k: v
            for k, v in obj.items()
        }

    # ===============================
    # Health endpoint (no auth)
    # ===============================

    @app.route('/api/health', methods=['GET'])
    def health():
        """Health check - reports handler reachability"""
        handlers = {}
        for name, sock_path in [
            ('adc', adc_socket),
            ('irrigation', irrigation_socket),
            ('leds', leds_socket),
            ('weather', weather_socket),
        ]:
            handlers[name] = os.path.exists(sock_path)

        all_ok = all(handlers.values())
        _log(request, 200)
        return jsonify({
            'status': 'ok' if all_ok else 'degraded',
            'service': 'api',
            'version': VERSION,
            'handlers': handlers
        }), 200

    # ===============================
    # ADC endpoints
    # ===============================

    @app.route('/api/adc', methods=['GET'])
    @require_token
    def read_adc():
        """
        Read ADC value from a channel, by hardware_id or user_id.
        GET /api/adc?channel=channel3
        GET /api/adc?channel=moisture1
        GET /api/adc?channel=all
        """
        channel = request.args.get('channel')
        valid_display_ids = [display_id(adc_id_map, hw) for hw in adc_id_map["order"]]

        if not channel:
            _log(request, 400, detail="missing required query parameter: channel")
            return jsonify({
                'error': 'Missing required query parameter: channel',
                'valid_channels': valid_display_ids
            }), 400

        if channel == 'all':
            results = {}
            errors = []
            for hardware_id in adc_id_map["order"]:
                label = display_id(adc_id_map, hardware_id)
                try:
                    response = handler_command(adc_socket, hardware_id, timeout=socket_timeout)
                    if response.startswith("ERROR"):
                        errors.append({'channel': label, 'error': response})
                    else:
                        entry = adc_id_map["by_hardware_id"][hardware_id]
                        results[label] = {
                            'channel_name': entry.get('friendly', label),
                            'value': float(response)
                        }
                except ConnectionError as e:
                    errors.append({'channel': label, 'error': str(e)})

            status = 200 if not errors else 207
            _log(request, status,
                 detail=f"{len(errors)} of {len(adc_id_map['order'])} channel(s) failed" if errors else None)
            return jsonify({
                'channels': results,
                'errors': errors if errors else None,
                'success': len(errors) == 0
            }), status

        hardware_id = resolve_or_none(adc_id_map, channel)
        if hardware_id is None:
            _log(request, 400, detail=f"invalid channel '{channel}'")
            return jsonify({
                'error': f'Invalid channel: {channel}',
                'valid_channels': valid_display_ids
            }), 400

        try:
            response = handler_command(adc_socket, hardware_id, timeout=socket_timeout)
            if response.startswith("ERROR"):
                _log(request, 500, detail=response)
                return jsonify({
                    'error': response,
                    'channel': display_id(adc_id_map, hardware_id)
                }), 500

            value = float(response)
            entry = adc_id_map["by_hardware_id"][hardware_id]
            _log(request, 200)
            return jsonify({
                'channel': display_id(adc_id_map, hardware_id),
                'channel_name': entry.get('friendly', display_id(adc_id_map, hardware_id)),
                'value': value,
                'success': True
            }), 200

        except ConnectionError as e:
            _log(request, 503, detail=str(e))
            return jsonify({'error': str(e)}), 503
        except ValueError:
            _log(request, 500, detail=f"handler returned non-numeric output: {response!r}")
            return jsonify({
                'error': 'Handler returned non-numeric output',
                'raw': response
            }), 500

    # ===============================
    # Irrigation endpoints
    # ===============================

    @app.route('/api/irrigation', methods=['POST'])
    @require_token
    def control_irrigation():
        """
        Control irrigation relays, by hardware_id or user_id.
        POST /api/irrigation  {"relay": "farbed", "action": "on"}
        POST /api/irrigation  {"relay": "valve1", "action": "on"}
        """
        data = request.get_json(silent=True)

        if not data:
            _log(request, 400, detail="no JSON data provided")
            return jsonify({'error': 'No JSON data provided'}), 400

        relay = (data.get('relay') or '').lower()
        action = (data.get('action') or '').lower()
        valid_display_ids = [display_id(irrigation_id_map, hw) for hw in irrigation_id_map["order"]]

        if not relay or not action:
            _log(request, 400, detail="missing relay or action field")
            return jsonify({'error': 'Missing required fields: relay and action'}), 400

        hardware_id = None if relay == 'all' else resolve_or_none(irrigation_id_map, relay)
        if relay != 'all' and hardware_id is None:
            _log(request, 400, detail=f"invalid relay '{relay}'")
            return jsonify({
                'error': f'Invalid relay: {relay}',
                'valid_relays': valid_display_ids + ['all']
            }), 400

        if action not in valid_actions:
            _log(request, 400, detail=f"invalid action '{action}'")
            return jsonify({
                'error': f'Invalid action: {action}',
                'valid_actions': valid_actions
            }), 400

        try:
            # Handle 'all off'
            if relay == 'all' and action == 'off':
                results = {}
                for hw_id in irrigation_id_map["order"]:
                    label = display_id(irrigation_id_map, hw_id)
                    resp = handler_command(irrigation_socket, f"{hw_id} off", timeout=socket_timeout)
                    try:
                        results[label] = json.loads(resp)
                    except json.JSONDecodeError:
                        results[label] = {"output": resp}
                _log(request, 200)
                return jsonify({'results': results, 'success': True}), 200

            # Handle 'all status' or single relay status
            if action == 'status':
                command = "status all" if relay == 'all' else f"status {hardware_id}"
            else:
                if relay == 'all':
                    _log(request, 400, detail=f"relay 'all' does not support action '{action}'")
                    return jsonify({
                        'error': "Relay 'all' only supports 'off' or 'status'"
                    }), 400
                command = f"{hardware_id} {action}"

            response = handler_command(irrigation_socket, command, timeout=socket_timeout)

            try:
                result = json.loads(response)
                _log(request, 200)
                return jsonify(result), 200
            except json.JSONDecodeError:
                _log(request, 200)
                return jsonify({
                    'output': response,
                    'relay': relay if relay == 'all' else display_id(irrigation_id_map, hardware_id),
                    'action': action,
                    'success': True
                }), 200

        except ConnectionError as e:
            _log(request, 503, detail=str(e))
            return jsonify({'error': str(e)}), 503

    @app.route('/api/irrigation/status', methods=['GET'])
    @require_token
    def irrigation_status():
        """
        GET /api/irrigation/status              - all relays
        GET /api/irrigation/status?relay=farbed  - single relay (user_id or hardware_id)
        """
        relay = (request.args.get('relay') or 'all').lower()

        try:
            if relay == 'all':
                response = handler_command(irrigation_socket, "status all", timeout=socket_timeout)
            else:
                hardware_id = resolve_or_none(irrigation_id_map, relay)
                if hardware_id is None:
                    _log(request, 400, detail=f"invalid relay '{relay}'")
                    return jsonify({'error': f'Invalid relay: {relay}'}), 400
                response = handler_command(irrigation_socket, f"status {hardware_id}", timeout=socket_timeout)

            result = json.loads(response)
            _log(request, 200)
            return jsonify(result), 200

        except ConnectionError as e:
            _log(request, 503, detail=str(e))
            return jsonify({'error': str(e)}), 503
        except json.JSONDecodeError:
            _log(request, 200)
            return jsonify({'output': response}), 200

    # ===============================
    # LED endpoints
    # ===============================

    @app.route('/api/leds', methods=['POST'])
    @require_token
    def control_leds():
        """
        Control LEDs, by hardware_id or alias (LEDs have no user_id -
        hardware_id and led labels are read-only).
        POST /api/leds  {"led": "sysblue", "action": "on"}
        POST /api/leds  {"led": "led1", "action": "flash-red-blue", "duration": "10s"}
        POST /api/leds  {"led": "led2red", "action": "patternblink", "count": 3}
        """
        data = request.get_json(silent=True)

        if not data:
            _log(request, 400, detail="no JSON data provided")
            return jsonify({'error': 'No JSON data provided'}), 400

        led = (data.get('led') or '').lower()
        action = (data.get('action') or '').lower()

        if not led or not action:
            _log(request, 400, detail="missing led or action field")
            return jsonify({'error': 'Missing required fields: led and action'}), 400

        # LEDs/groups are looked up but not required to resolve to a
        # hardware_id here - group names (e.g. "led1") aren't in led_map
        # and are valid too; the LED handler itself is the source of
        # truth for what's a valid target.
        target = resolve_or_none(led_id_map, led) or led

        # Build handler command
        if action in ('on', 'off'):
            command = f"{target} {action}"
        elif action == 'fastblink':
            command = f"{target} fastblink"
        elif action.startswith('flash'):
            duration = data.get('duration', '5s')
            command = f"{target} {action} {duration}"
        elif action == 'patternblink':
            count = data.get('count', 1)
            command = f"{target} patternblink {count}"
        else:
            _log(request, 400, detail=f"unknown action '{action}'")
            return jsonify({'error': f'Unknown action: {action}'}), 400

        try:
            response = handler_command(leds_socket, command, timeout=socket_timeout)
            _log(request, 200)
            return jsonify({
                'led': led,
                'action': action,
                'output': response,
                'success': True
            }), 200
        except ConnectionError as e:
            _log(request, 503, detail=str(e))
            return jsonify({'error': str(e)}), 503

    @app.route('/api/leds/status', methods=['GET'])
    @require_token
    def led_status():
        """
        GET /api/leds/status          - all LEDs
        GET /api/leds/status?led=X    - single LED, group, or alias
        """
        led = request.args.get('led')

        try:
            if led:
                target = resolve_or_none(led_id_map, led.lower()) or led.lower()
                command = f"status {target}"
            else:
                command = "status"

            response = handler_command(leds_socket, command, timeout=socket_timeout)
            result = json.loads(response)
            _log(request, 200)
            return jsonify(result), 200

        except ConnectionError as e:
            _log(request, 503, detail=str(e))
            return jsonify({'error': str(e)}), 503
        except json.JSONDecodeError:
            _log(request, 200)
            return jsonify({'output': response}), 200

    # ===============================
    # Weather data endpoint
    # ===============================

    @app.route('/api/weather', methods=['GET'])
    @require_token
    def get_weather():
        """
        GET /api/weather               - latest reading (live from the
                                          weather handler's socket, if
                                          reachable; otherwise the last
                                          line of weather_file)
        GET /api/weather?last=10       - last N readings from weather_file
        """
        last_n = request.args.get('last', '1')
        try:
            last_n = int(last_n)
            if last_n < 1:
                last_n = 1
            if last_n > 1000:
                last_n = 1000
        except ValueError:
            last_n = 1

        # Sensor-map id -> friendly API field name, for the sensors the
        # frontend has bespoke labels/units for (kept in sync with
        # WEATHER_FIELD_DEFS in public/js/app.js). Anything else in the
        # live cache -- present or future (e.g. s_hz once enabled) --
        # still passes through under its own sensor_map id instead of
        # being silently dropped. This also keeps the live-socket path
        # and the weather.csv fallback path returning identical field
        # names, which previously they did not.
        KNOWN_FIELD_RENAMES = {
            's_wind_speed': 'windspeed_mph',
            's_rain': 'rain_inches',
            's_daylight': 'daylight_lux',
            's_pressure': 'pressure_v',
            's_moisture1': 'moisture1_v',
            's_moisture2': 'moisture2_v',
            's_moisture3': 'moisture3_v',
            's_wind_dir': 'wind_dir_deg',
            's_int_temp': 'int_temp_f',
            's_int_humidity': 'int_humidity',
            's_ext_temp': 'ext_temp_f',
            's_ext_humidity': 'ext_humidity',
        }
        # int_temp/ext_temp are stored in the cache (and in weather.csv) as
        # Celsius -- the frontend displays Fahrenheit, so convert here
        # rather than changing what's persisted to disk for WeeWx.
        CELSIUS_FIELDS = {'int_temp_f', 'ext_temp_f'}

        def _c_to_f(value):
            try:
                return round((float(value) * 9.0 / 5.0) + 32.0, 3)
            except (TypeError, ValueError):
                return value

        def _normalize_live_reading(raw):
            out = {}
            for sensor_id, value in raw.items():
                field = KNOWN_FIELD_RENAMES.get(sensor_id, sensor_id)
                if field in CELSIUS_FIELDS and value is not None:
                    value = _c_to_f(value)
                out[field] = value
            return out

        # A single-reading request (the common case) tries the live
        # handler socket first, since that reflects the current in-memory
        # cache rather than whatever was last flushed to disk.
        if last_n == 1:
            try:
                response = handler_command(weather_socket, "status", timeout=socket_timeout)
                raw_reading = json.loads(response)
                reading = _normalize_live_reading(raw_reading)
                _log(request, 200)
                return jsonify({'reading': reading, 'success': True}), 200
            except (ConnectionError, json.JSONDecodeError) as e:
                log.warning(f"Live weather read failed, falling back to {weather_csv}: {e}")

        weather_headers = [
            'timestamp', 'windspeed_mph', 'rain_inches', 'daylight_lux',
            'pressure_v', 'moisture1_v', 'moisture2_v', 'moisture3_v',
            'wind_dir_deg', 'int_temp_f', 'int_humidity',
            'ext_temp_f', 'ext_humidity'
        ]

        try:
            if not os.path.exists(weather_csv):
                _log(request, 404, detail=f"{weather_csv} not found")
                return jsonify({'error': 'No weather data available'}), 404

            with open(weather_csv, 'r') as f:
                all_lines = f.readlines()

            if not all_lines:
                _log(request, 404, detail=f"{weather_csv} is empty")
                return jsonify({'error': 'Weather file is empty'}), 404

            recent_lines = all_lines[-last_n:]
            readings = []

            for line in recent_lines:
                line = line.strip()
                if not line:
                    continue
                reader = csv.reader(io.StringIO(line))
                for row in reader:
                    reading = {}
                    for i, header in enumerate(weather_headers):
                        if i >= len(row):
                            break
                        val = row[i]
                        if header == 'timestamp' or val == '':
                            reading[header] = val
                        else:
                            try:
                                num = float(val)
                                # weather.csv stores int/ext temp in Celsius;
                                # convert here to match the live-socket path.
                                if header in CELSIUS_FIELDS:
                                    num = round((num * 9.0 / 5.0) + 32.0, 3)
                                reading[header] = num
                            except ValueError:
                                reading[header] = val
                    readings.append(reading)

            _log(request, 200)
            if last_n == 1 and readings:
                return jsonify({'reading': readings[0], 'success': True}), 200
            else:
                return jsonify({
                    'readings': readings,
                    'count': len(readings),
                    'success': True
                }), 200

        except Exception as e:
            _log(request, 500, detail=str(e))
            return jsonify({'error': f'Failed to read weather data: {str(e)}'}), 500

    # ===============================
    # Error handlers
    # ===============================

    @app.errorhandler(404)
    def not_found(e):
        _log(request, 404)
        return jsonify({'error': 'Endpoint not found'}), 404

    @app.errorhandler(500)
    def internal_error(e):
        _log(request, 500, detail=str(e))
        return jsonify({'error': 'Internal server error'}), 500

    return app


# --------------------------
# Standalone dev server
# --------------------------

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Garden API standalone dev server")
    parser.add_argument(
        "--config", "-c",
        type=str,
        default=None,
        help=f"Path to garden.json config file (default: {DEFAULT_CONFIG_FILE})"
    )
    parser.add_argument(
        "--loglevel", "-l",
        type=str,
        default=None,
        choices=sorted(LEVEL_ALIASES.keys()),
        help="Override both handlers.api.log_level and config.global_log_level"
    )
    parser.add_argument(
        "--token", "-t",
        type=str,
        default=None,
        help="Override handlers.api.token"
    )
    dev_args = parser.parse_args()

    app = create_app(
        config_path=dev_args.config,
        log_level=dev_args.loglevel,
        token=dev_args.token,
    )
    cfg = app.config['GARDEN_CFG']
    api_token = app.config['GARDEN_API_TOKEN']

    cert_file = cfg["cert_file"]
    key_file = cfg["key_file"]
    listen_port = cfg["listen_port"]

    # SSL context for dev mode
    import ssl
    if not os.path.exists(cert_file) or not os.path.exists(key_file):
        log.critical("SSL certificate files not found!")
        log.critical(f"  Expected: {cert_file}")
        log.critical(f"  Expected: {key_file}")
        log.critical("Generate with:")
        log.critical("  openssl req -x509 -newkey rsa:4096 -nodes \\")
        log.critical("    -out node.pem -keyout node.key -days 365")
        sys.exit(1)

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_file, key_file)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE

    print("=" * 60)
    print(f"Garden API Server v{VERSION} (Development Mode)")
    print("=" * 60)
    print(f"API Token: {'SET' if api_token else 'NOT SET (OPEN ACCESS)'}")
    print(f"HTTPS on: https://0.0.0.0:{listen_port}")
    print("=" * 60)
    print()
    print("Endpoints:")
    print("  GET  /api/health                  - Health check (no auth)")
    print("  GET  /api/adc?channel=ID          - Read ADC channel (hardware_id or user_id)")
    print("  GET  /api/adc?channel=all         - Read all ADC channels")
    print("  POST /api/irrigation              - Control relay (hardware_id or user_id)")
    print("  GET  /api/irrigation/status       - All relay status")
    print("  POST /api/leds                    - Control LEDs")
    print("  GET  /api/leds/status             - All LED status")
    print("  GET  /api/weather                 - Latest weather reading")
    print("  GET  /api/weather?last=N          - Last N weather readings")
    print()
    print("For production, run with gunicorn:")
    print(f"  gunicorn --bind 0.0.0.0:{listen_port} --workers 4 \\")
    print(f"    --certfile {cert_file} --keyfile {key_file} \\")
    print("    'api:create_app()'")
    print("=" * 60)

    app.run(
        host='0.0.0.0',
        port=listen_port,
        ssl_context=context,
        debug=False
    )
