#!/opt/gardenpi/python3/bin/python3
#
# irrigation-handler.py
#
# v5.0 2026/08/27
# - terminology: garden.json's handlers.irrigation.relay_name_map is
#   replaced by handlers.irrigation.relay_map (a list of {hardware_id,
#   user_id, friendly}) - hardware_id (e.g. "valve1"/"pump1") is
#   read-only, always maps 1:1 to a physical relay pin via
#   hardware.powercontroller.pin_map (type "relay"); user_id/friendly are
#   customer configurable. The socket protocol now accepts either the
#   hardware_id or the user_id for a relay - both resolve to the same
#   physical relay.
# - max_valve_duration_sec and no_timeout_relays moved from
#   hardware.powercontroller to handlers.irrigation (as
#   max_valve_run_time and no_timeout_relays respectively - the latter
#   still lists hardware_ids), since these are handler policy, not a
#   physical hardware fact. Added handlers.irrigation.allow_concurrent_valves
#   (bool): when false (the default/safe setting), turning a valve on
#   while another valve is already on is rejected instead of both running
#   together. Pumps are not subject to this rule.
# - fixed: several `threading.Thread(..., handler=True)` / `timer.handler
#   = True` calls left over from an earlier, over-eager "daemon -> handler"
#   terminology pass had accidentally renamed the *unrelated* stdlib
#   `threading.Thread(daemon=True)` / `Timer.daemon` attribute too. That's
#   Python's own API (marks a thread as a background/daemon thread so it
#   doesn't block process exit) and must stay `daemon=True` - restored.
#
# v4.5 2026/08/26
# - simplified socket naming
# v4.4 2026/08/25
# - removed the socket chown/group-ownership logic entirely. The socket is
#   created by whatever user runs this handler (expected to be "pi"), so
#   its owning user is already correct with no extra step; only the
#   permission bits (0660) are still set explicitly.
# - removed every hardcoded config fallback except the config *file path*
#   itself (DEFAULT_CONFIG_FILE) - including LEGACY_RELAY_PIN_FALLBACK and
#   the full built-in DEFAULT_RELAY_MAP/DEFAULT_NO_TIMEOUT_RELAYS. A relay
#   whose pin is missing from hardware.powercontroller's pin map is now
#   simply skipped with a logged error and left unavailable, rather than
#   silently substituted with a guessed pin. If relay_map is missing/empty
#   entirely, or no relay could be built at all, the handler now raises
#   garden_config.ConfigError and exits instead of falling back to a
#   built-in relay map.
#
# v4.1 2026/06/12
# - NO_TIMEOUT_RELAYS: exempt specific relays (e.g. pump1) from valve safety timeout
#
# v4.0 2026/04/11
# - thread-safe shutdown via threading.Event
# - valve safety timeout (auto-off after max duration)
# - I2C hardware lock for pin access
# - queue.get with timeout for clean shutdown
# - LED calls via subprocess remain (cross-handler)
#
# v3.5 2026/01/20
# v3.1 2025/06/25
#
# Copyright 2025-2026 Allen Pomeroy - MIT license

import os
import sys
import time
import json
import socket
import threading
import queue
import argparse
import logging
import signal
import subprocess

import board
import busio
from digitalio import Direction
from adafruit_mcp230xx.mcp23017 import MCP23017

from garden_logger import init_logging, resolve_effective_level, LEVEL_ALIASES
from garden_config import (
    ConfigError, require, require_nonempty, parse_i2c_addr,
    build_id_map, resolve_id, display_id, pin_for_hardware_id,
)

# --------------------------
# Constants
# --------------------------

VERSION = "5.0"

# The only hardcoded default kept: where to find garden.json. Every other
# value below must be present in the config file - see garden_config.py.
DEFAULT_CONFIG_FILE = "/opt/gardenpi/config/garden.json"

# Not sourced from garden.json (no corresponding key exists there) - this
# is simply a fixed path to a sibling script, not a config fallback.
LED_CLIENT_PATH = "/opt/gardenpi/bin/leds.py"

log = logging.getLogger(__name__)


# --------------------------
# Configuration loading
# --------------------------

def load_config(config_path):
    with open(config_path) as f:
        cfg = json.load(f)

    global_cfg = cfg.get("config", {})
    irrigation_cfg = cfg.get("handlers", {}).get("irrigation", {})
    pc_cfg = cfg.get("hardware", {}).get("powercontroller", {})

    socket_timeout = require(global_cfg, "socket_timeout", "config.socket_timeout")
    socket_file = require(irrigation_cfg, "socket", "handlers.irrigation.socket")
    handler_log_level = require(irrigation_cfg, "log_level", "handlers.irrigation.log_level")
    global_log_level = require(global_cfg, "global_log_level", "config.global_log_level")

    i2c_addr = parse_i2c_addr(
        require(pc_cfg, "i2c_addr", "hardware.powercontroller.i2c_addr"),
        "hardware.powercontroller.i2c_addr"
    )
    max_valve_run_time = require(
        irrigation_cfg, "max_valve_run_time", "handlers.irrigation.max_valve_run_time"
    )
    allow_concurrent_valves = bool(require(
        irrigation_cfg, "allow_concurrent_valves", "handlers.irrigation.allow_concurrent_valves"
    ))

    relay_map_cfg = require_nonempty(irrigation_cfg, "relay_map", "handlers.irrigation.relay_map")
    id_map = build_id_map(relay_map_cfg, "handlers.irrigation.relay_map")

    pin_map_cfg = require_nonempty(pc_cfg, "pin_map", "hardware.powercontroller.pin_map")
    # Absence here is a meaningful, safety-favoring default (nothing is
    # exempt from the safety timeout), not a guessed stand-in for a real
    # value, so this one key stays optional. Entries are hardware_ids.
    no_timeout_hw_ids = set(irrigation_cfg.get("no_timeout_relays", []))

    relay_pins = {}
    for hardware_id in id_map["order"]:
        pin = pin_for_hardware_id(pin_map_cfg, hardware_id, pin_type="relay")
        if pin is None:
            log.error(
                f"No 'relay' pin defined for hardware_id '{hardware_id}' in "
                f"hardware.powercontroller.pin_map; this relay will be unavailable."
            )
            continue
        relay_pins[hardware_id] = pin

    if not relay_pins:
        raise ConfigError(
            "No usable relays could be built from "
            "handlers.irrigation.relay_map / hardware.powercontroller.pin_map"
        )

    return {
        "socket_timeout": socket_timeout,
        "socket_file": socket_file,
        "handler_log_level": handler_log_level,
        "global_log_level": global_log_level,
        "i2c_addr": i2c_addr,
        "max_valve_run_time": max_valve_run_time,
        "allow_concurrent_valves": allow_concurrent_valves,
        "id_map": id_map,
        "relay_pins": relay_pins,
        "no_timeout_relays": no_timeout_hw_ids,
    }


# --------------------------
# LED Control Functions
# --------------------------

def call_led_client(led_name, action, *args):
    """Call the LED client script with specified parameters"""
    try:
        cmd = [LED_CLIENT_PATH, led_name, action] + list(args)
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        if result.returncode != 0:
            log.warning(f"LED client error: {result.stderr}")
            return False
        return True
    except subprocess.TimeoutExpired:
        log.warning("LED client call timed out")
        return False
    except Exception as e:
        log.warning(f"Failed to call LED client: {str(e)}")
        return False


def indicate_irrigationrun():
    call_led_client("irrigationrun", "on")
    log.info("LED: Irrigation run indicator on")

def indicate_valve_on(valve_index):
    blink_count = str(valve_index + 1)
    call_led_client("valve", "blink", blink_count)
    log.debug(f"LED: Valve {valve_index + 1} blink pattern started")

def indicate_valve_off():
    call_led_client("irrigationrun", "on")
    log.debug("LED: Irrigation run indicator on")

def indicate_error():
    call_led_client("irrigationerr", "blink", "1")
    log.warning("LED: Error indicator activated")


# --------------------------
# Relay Controller
# --------------------------

class IrrigationController:
    def __init__(self, i2c_addr, id_map, relay_pins, no_timeout_relays,
                 max_valve_run_time, allow_concurrent_valves):
        self.i2c_addr = i2c_addr
        self.id_map = id_map
        self.relay_pins = relay_pins
        self.no_timeout_relays = no_timeout_relays
        self.max_valve_run_time = max_valve_run_time
        self.allow_concurrent_valves = allow_concurrent_valves
        self.mcp = None
        self.pins = {}
        self._hw_lock = threading.Lock()
        # Valve safety timers: hardware_id -> Timer
        self._valve_timers = {}
        self._timer_lock = threading.Lock()
        self.initialize_system()

    def initialize_system(self):
        try:
            self.mcp = self.initialize_hardware()
            self.pins = self.setup_pins()
            log.info("Irrigation controller initialized successfully")
            time.sleep(1)
            indicate_irrigationrun()
        except Exception as e:
            log.critical(f"Fatal initialization error: {str(e)}")
            indicate_error()
            raise

    def initialize_hardware(self):
        try:
            log.info("Initializing I2C and MCP23017")
            i2c = busio.I2C(board.SCL, board.SDA)
            return MCP23017(i2c, address=self.i2c_addr)
        except Exception as e:
            log.critical(f"Hardware initialization failed: {str(e)}")
            indicate_error()
            raise

    def setup_pins(self):
        try:
            pins = {}
            for hardware_id, pin_num in self.relay_pins.items():
                pin = self.mcp.get_pin(pin_num)
                pin.direction = Direction.OUTPUT
                pin.value = False
                pins[hardware_id] = pin
            log.info("Relay pins initialized")
            return pins
        except Exception as e:
            log.critical(f"Pin setup failed: {str(e)}")
            indicate_error()
            raise

    def _cancel_valve_timer(self, hardware_id):
        """Cancel any existing safety timer for a relay"""
        with self._timer_lock:
            timer = self._valve_timers.pop(hardware_id, None)
            if timer is not None:
                timer.cancel()

    def _start_valve_timer(self, hardware_id):
        """Start a safety timer that auto-closes a valve after
        self.max_valve_run_time seconds.

        Relays listed in self.no_timeout_relays (by hardware_id) are
        exempt and will not receive a timer.
        """
        self._cancel_valve_timer(hardware_id)

        if hardware_id in self.no_timeout_relays:
            log.info(f"Relay {hardware_id} is exempt from safety timeout, "
                     f"running without limit")
            return

        def auto_off():
            log.warning(f"SAFETY: Auto-closing valve {hardware_id} after "
                        f"{self.max_valve_run_time}s")
            with self._hw_lock:
                self.pins[hardware_id].value = False
            indicate_valve_off()
            with self._timer_lock:
                self._valve_timers.pop(hardware_id, None)

        timer = threading.Timer(self.max_valve_run_time, auto_off)
        timer.daemon = True
        with self._timer_lock:
            self._valve_timers[hardware_id] = timer
        timer.start()

    def _any_valve_on(self, exclude=None):
        """True if any relay other than a pump (i.e. any 'valveN'
        hardware_id) other than `exclude` is currently on."""
        with self._hw_lock:
            for hardware_id, pin in self.pins.items():
                if hardware_id == exclude:
                    continue
                if hardware_id.startswith("valve") and pin.value:
                    return True
        return False

    def handle_command(self, command):
        try:
            parts = command.strip().lower().split()
            if not parts:
                return json.dumps({"error": "No command received"})

            cmd = parts[0]

            if cmd == "status":
                if len(parts) > 1 and parts[1] != "all":
                    hardware_id = resolve_id(self.id_map, parts[1])
                    if hardware_id is None or hardware_id not in self.pins:
                        return json.dumps({"error": f"Unknown relay: {parts[1]}"})
                    with self._hw_lock:
                        val = self.pins[hardware_id].value
                    status_value = "on" if val else "off"
                    return json.dumps({display_id(self.id_map, hardware_id): status_value})
                else:
                    with self._hw_lock:
                        status = {
                            display_id(self.id_map, hardware_id): ("on" if pin.value else "off")
                            for hardware_id, pin in self.pins.items()
                        }
                    return json.dumps(status)

            hardware_id = resolve_id(self.id_map, cmd)
            if hardware_id is not None and hardware_id in self.pins:
                if len(parts) < 2:
                    return json.dumps({"error": f"Missing action for {cmd} (use 'on' or 'off')"})

                action = parts[1]
                relay_label = display_id(self.id_map, hardware_id)
                valve_index = self.id_map["order"].index(hardware_id)

                if action == "on":
                    if (not self.allow_concurrent_valves
                            and hardware_id.startswith("valve")
                            and self._any_valve_on(exclude=hardware_id)):
                        return json.dumps({
                            "error": "Another valve is already running and "
                                     "handlers.irrigation.allow_concurrent_valves is false",
                            "relay": relay_label,
                        })
                    with self._hw_lock:
                        self.pins[hardware_id].value = True
                    self._start_valve_timer(hardware_id)
                    indicate_valve_on(valve_index)
                    log.info(f"Valve {relay_label} ({hardware_id}) turned on")
                    timeout_info = "none" if hardware_id in self.no_timeout_relays else self.max_valve_run_time
                    return json.dumps({
                        "relay": relay_label,
                        "action": "on",
                        "success": True,
                        "safety_timeout_sec": timeout_info
                    })

                elif action == "off":
                    with self._hw_lock:
                        self.pins[hardware_id].value = False
                    self._cancel_valve_timer(hardware_id)
                    indicate_valve_off()
                    log.info(f"Valve {relay_label} ({hardware_id}) turned off")
                    return json.dumps({
                        "relay": relay_label,
                        "action": "off",
                        "success": True
                    })

                else:
                    return json.dumps({"error": f"Unknown action: {action}"})

            else:
                return json.dumps({"error": f"Unknown command or relay: {cmd}"})

        except Exception as e:
            log.error(f"Command handling error: {str(e)}")
            indicate_error()
            return json.dumps({"error": f"Error processing command: {str(e)}"})

    def shutdown_all_valves(self):
        """Emergency shutdown: close all valves and cancel all timers"""
        log.warning("Shutting down all valves")
        with self._hw_lock:
            for hardware_id, pin in self.pins.items():
                pin.value = False
                self._cancel_valve_timer(hardware_id)


# --------------------------
# Handler
# --------------------------

class IrrigationHandler:
    def __init__(self, controller, socket_file, socket_timeout):
        self.controller = controller
        self.socket_file = socket_file
        self.socket_timeout = socket_timeout
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._shutdown = threading.Event()
        self.command_queue = queue.Queue()

    def start(self):
        try:
            if os.path.exists(self.socket_file):
                os.remove(self.socket_file)

            self.sock.bind(self.socket_file)
            # The socket is created by whichever user runs this handler
            # (expected to be "pi"), so ownership is already correct with
            # no extra step - just restrict the permission bits.
            os.chmod(self.socket_file, 0o660)
            self.sock.listen(5)
            self.sock.settimeout(self.socket_timeout)
            log.info(f"Irrigation handler v{VERSION} started, listening on {self.socket_file}")

            threading.Thread(target=self.worker, daemon=True).start()

            while not self._shutdown.is_set():
                try:
                    conn, _ = self.sock.accept()
                    threading.Thread(
                        target=self.handle_client, args=(conn,), daemon=True
                    ).start()
                except socket.timeout:
                    continue
                except Exception as e:
                    if not self._shutdown.is_set():
                        log.error(f"Connection error: {str(e)}")

        except Exception as e:
            log.critical(f"Handler start error: {str(e)}")
            indicate_error()
            raise

    def handle_client(self, conn):
        try:
            data = conn.recv(1024).decode().strip()
            if data:
                self.command_queue.put((data, conn))
            else:
                conn.close()
        except Exception as e:
            log.error(f"Client error: {str(e)}")
            conn.close()

    def worker(self):
        while not self._shutdown.is_set():
            try:
                command, conn = self.command_queue.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                response = self.controller.handle_command(command)
                try:
                    conn.sendall((response + "\n").encode())
                except Exception as e:
                    log.error(f"Error sending response: {str(e)}")
                finally:
                    conn.close()
            except Exception as e:
                log.error(f"Worker error: {str(e)}")
                indicate_error()

    def stop(self):
        log.info("Stopping irrigation handler...")
        self.controller.shutdown_all_valves()
        indicate_error()
        self._shutdown.set()
        try:
            self.sock.close()
        except Exception:
            pass
        if os.path.exists(self.socket_file):
            os.remove(self.socket_file)
        log.info("Irrigation handler stopped")


# --------------------------
# argument parsing
# --------------------------

def parse_arguments():
    parser = argparse.ArgumentParser(
        description="Irrigation MCP23017 Handler with LED Integration and Safety Timeouts"
    )
    parser.add_argument(
        "--config", "-c",
        type=str,
        default=DEFAULT_CONFIG_FILE,
        help=f"Path to garden.json config file (default: {DEFAULT_CONFIG_FILE})"
    )
    parser.add_argument(
        "--loglevel", "-l",
        type=str,
        default=None,
        choices=sorted(LEVEL_ALIASES.keys()),
        help="Override both handlers.irrigation.log_level and "
             "config.global_log_level (debug, info, warn/warning, error, critical)"
    )
    parser.add_argument(
        "--i2caddr", "-i",
        type=str,
        default=None,
        help="Override hardware.powercontroller.i2c_addr, e.g. 0x27"
    )
    parser.add_argument(
        "--max-valve-sec",
        type=int,
        default=None,
        help="Override handlers.irrigation.max_valve_run_time"
    )
    return parser.parse_args()


# --------------------------
# main
# --------------------------

handler = None


def signal_handler(sig, frame):
    global handler
    if handler:
        handler.stop()
    sys.exit(0)


def main():
    global handler

    args = parse_arguments()

    try:
        cfg = load_config(args.config)
    except Exception as e:
        # logging isn't configured yet at this point, so fall back to stderr
        print(f"Fatal error loading config '{args.config}': {e}", file=sys.stderr, flush=True)
        sys.exit(1)

    if args.loglevel is not None:
        # CLI flag wins outright, overriding both config.global_log_level
        # and handlers.irrigation.log_level.
        level = LEVEL_ALIASES[args.loglevel.strip().lower()]
    else:
        try:
            level = resolve_effective_level(cfg["handler_log_level"], cfg["global_log_level"])
        except ValueError as e:
            print(f"Fatal error resolving log level: {e}", file=sys.stderr, flush=True)
            sys.exit(1)

    init_logging(level=level)

    i2c_addr = parse_i2c_addr(args.i2caddr, "--i2caddr") if args.i2caddr else cfg["i2c_addr"]
    max_valve_run_time = args.max_valve_sec if args.max_valve_sec is not None else cfg["max_valve_run_time"]

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    try:
        if not os.path.exists(LED_CLIENT_PATH):
            log.warning(f"LED client not found at {LED_CLIENT_PATH}, LED features disabled")

        controller = IrrigationController(
            i2c_addr,
            cfg["id_map"],
            cfg["relay_pins"],
            cfg["no_timeout_relays"],
            max_valve_run_time,
            cfg["allow_concurrent_valves"],
        )
        handler = IrrigationHandler(
            controller,
            cfg["socket_file"],
            cfg["socket_timeout"],
        )
        handler.start()

    except KeyboardInterrupt:
        log.info("Received keyboard interrupt, shutting down")
        if handler:
            handler.stop()

    except Exception as e:
        log.critical(f"Fatal error: {str(e)}")
        indicate_error()
        if handler:
            handler.stop()
        sys.exit(1)


if __name__ == "__main__":
    main()
