#!/opt/gardenpi/python3/bin/python3
#
# led-handler.py
#
# v3.0 2026/08/27
# - terminology: garden.json's handlers.leds.leds + hardware.picontroller.
#   mcp_led_pins are replaced by a single handlers.leds.led_map (a list of
#   {hardware_id, group, aliases}) plus hardware.picontroller.pin_map
#   (type "led") for the pin number. hardware_id and the led_map itself
#   are read-only (no user_id - LED labels cannot be customer-renamed);
#   aliases remain the only alternate lookup names, unchanged in behavior.
# - fixed: several `threading.Thread(..., handler=True)` calls left over
#   from an earlier, over-eager "daemon -> handler" terminology pass had
#   accidentally renamed the *unrelated* stdlib
#   `threading.Thread(daemon=True)` keyword argument too. That argument is
#   Python's own API (marks a thread as a background/daemon thread so it
#   doesn't block process exit) and must stay `daemon=True` - restored.
#
# v2.3 2026/08/25
# - removed the socket chown/group-ownership logic entirely. The socket is
#   created by whatever user runs this handler (expected to be "pi"), so
#   its owning user is already correct with no extra step; only the
#   permission bits (0660) are still set explicitly.
# - removed every hardcoded config fallback except the config *file path*
#   itself (DEFAULT_CONFIG_FILE). All other values (socket path, socket
#   timeout, log levels, I2C address, LED pin/alias/group data) must now
#   be present in garden.json; a missing required value raises
#   garden_config.ConfigError naming the exact dotted path that needs to
#   be added, and the handler exits rather than silently substituting a
#   guessed default.
#
# v2.2 2026/08/25
# - configuration is now fully sourced from garden.json: config.socket_timeout,
#   config.socket_group_name, config.global_log_level, and the
#   handlers.leds stanza (socket, log_level, leds/aliases/groups),
#   merged with hardware.picontroller.mcp_led_pins for pin numbers and
#   hardware.picontroller.i2c_addr for the MCP23017 address
# - all logging now goes through the centralized garden_logger.init_logging()
#   helper instead of the old LEDController.log() method
# - effective log level is the more restrictive (numerically higher) of
#   handlers.leds.log_level and config.global_log_level, either of
#   which can be overridden from the command line via --loglevel
# - socket group ownership now comes from config.socket_group_name (was a
#   hardcoded "pi" constant) and permissions remain 0660
#
# v2.1 2026/08/25
# - migrate to use garden.json and centralized logging
# v2.0 2026/04/11
# - thread-safe active_effects with dedicated lock
# - I2C hardware lock for all pin access
# - effect threads route through set_led_raw (lock-protected)
# - clean shutdown via threading.Event
# - queue.get with timeout
#
# v1.3 2025/11/11
# v1.2 2025/06/24
# v1.0 2025/05/23
#
# Copyright 2025-2026 Allen Pomeroy - MIT license

import os
import sys
import time
import json
import socket
import signal
import logging
import argparse
import threading
import queue
from digitalio import Direction
import board
import busio
from adafruit_mcp230xx.mcp23017 import MCP23017

from garden_logger import init_logging, resolve_effective_level, LEVEL_ALIASES
from garden_config import (
    ConfigError, require, require_nonempty, parse_i2c_addr,
    build_id_map, resolve_id, pin_for_hardware_id,
)

VERSION = "3.0"

# The only hardcoded default kept: where to find garden.json. Every other
# value below must be present in the config file - see garden_config.py.
DEFAULT_CONFIG_FILE = "/opt/gardenpi/config/garden.json"

log = logging.getLogger(__name__)


def load_config(config_path):
    with open(config_path, "r") as f:
        cfg = json.load(f)

    global_cfg = cfg.get("config", {})
    led_cfg = cfg.get("handlers", {}).get("leds", {})
    picontroller_cfg = cfg.get("hardware", {}).get("picontroller", {})

    socket_timeout = require(global_cfg, "socket_timeout", "config.socket_timeout")
    socket_file = require(led_cfg, "socket", "handlers.leds.socket")
    handler_log_level = require(led_cfg, "log_level", "handlers.leds.log_level")
    global_log_level = require(global_cfg, "global_log_level", "config.global_log_level")

    i2c_addr = parse_i2c_addr(
        require(picontroller_cfg, "i2c_addr", "hardware.picontroller.i2c_addr"),
        "hardware.picontroller.i2c_addr"
    )

    pin_map_cfg = require_nonempty(picontroller_cfg, "pin_map", "hardware.picontroller.pin_map")
    led_map_cfg = require_nonempty(led_cfg, "led_map", "handlers.leds.led_map")

    # led_map (hardware_id/group/aliases - read only, no user_id) is the
    # source of truth for names; pin_map (type "led") supplies pin numbers.
    id_map = build_id_map(led_map_cfg, "handlers.leds.led_map")

    led_pins = {}
    groups = {}
    for hardware_id, entry in id_map["by_hardware_id"].items():
        pin = pin_for_hardware_id(pin_map_cfg, hardware_id, pin_type="led")
        if pin is None:
            log.error(
                f"LED '{hardware_id}' has no 'led' pin assignment in "
                f"hardware.picontroller.pin_map; skipping"
            )
            continue
        led_pins[hardware_id] = pin
        group = entry.get("group")
        if group:
            groups.setdefault(group, []).append(hardware_id)

    if not led_pins:
        raise ConfigError(
            "No usable LEDs could be built from handlers.leds.led_map / "
            "hardware.picontroller.pin_map"
        )

    return {
        "socket_timeout": socket_timeout,
        "socket_file": socket_file,
        "handler_log_level": handler_log_level,
        "global_log_level": global_log_level,
        "i2c_addr": i2c_addr,
        "led_pins": led_pins,
        "id_map": id_map,
        "groups": groups,
    }


class LEDController:
    def __init__(self, led_pins, id_map, groups, i2c_addr):
        self.led_states = {}
        self.active_effects = {}  # hardware_id -> (stop_event, thread)
        self._effects_lock = threading.Lock()
        self._hw_lock = threading.Lock()
        self.led_pins = led_pins
        self.id_map = id_map
        self.groups = groups
        self.i2c_addr = i2c_addr
        self.mcp = self.initialize_hardware()
        self.pins = self.setup_pins()

    def initialize_hardware(self):
        log.debug("Initializing I2C...")
        i2c = busio.I2C(board.SCL, board.SDA)
        log.debug(f"Initializing MCP23017 at address {hex(self.i2c_addr)}...")
        return MCP23017(i2c, address=self.i2c_addr)

    def setup_pins(self):
        pins = {}
        for hardware_id, pin_num in self.led_pins.items():
            pin = self.mcp.get_pin(pin_num)
            pin.direction = Direction.OUTPUT
            # Read current state instead of forcing off — preserves whatever
            # init-picontroller-mcp.service left (e.g. sysgreen on)
            current_value = pin.value
            pins[hardware_id] = pin
            # active low: value=False means LED is on
            self.led_states[hardware_id] = 'off' if current_value else 'on'
        log.debug("Pins initialized (preserved existing state)")
        return pins

    def _set_pin(self, hardware_id, value):
        """Low-level pin write with hardware lock. value=True means LED off (active low)."""
        if hardware_id in self.pins:
            with self._hw_lock:
                self.pins[hardware_id].value = value

    def resolve_led_name(self, token):
        """Resolve a hardware_id, alias, or group name to itself if it's a
        group, or to the canonical hardware_id otherwise."""
        if token in self.groups:
            return token
        return resolve_id(self.id_map, token) or token

    def is_group(self, name):
        return name in self.groups

    def get_group(self, hardware_id):
        for group, members in self.groups.items():
            if hardware_id in members:
                return members
        return []

    def stop_effect(self, name):
        """Stop any running effect on the given LED/group. Thread-safe."""
        with self._effects_lock:
            effect = self.active_effects.pop(name, None)
        if effect:
            stop_event, thread = effect
            stop_event.set()
            if threading.current_thread() != thread:
                thread.join(timeout=2)

    def set_led(self, led_name, state, skip_stop_effect=False):
        resolved_name = self.resolve_led_name(led_name)
        if self.is_group(resolved_name):
            for member in self.groups[resolved_name]:
                self.set_led(member, state, skip_stop_effect=skip_stop_effect)
            return True

        if resolved_name not in self.pins:
            log.error(f"Unknown LED: {resolved_name}")
            return False

        if not skip_stop_effect:
            self.stop_effect(resolved_name)

        group = self.get_group(resolved_name)

        if state == 'on':
            # Turn off group members first
            for member in group:
                if member != resolved_name and member in self.pins:
                    self.stop_effect(member)
                    self._set_pin(member, True)  # off
                    self.led_states[member] = 'off'
            self._set_pin(resolved_name, False)  # on
            self.led_states[resolved_name] = 'on'
        elif state == 'off':
            self._set_pin(resolved_name, True)  # off
            self.led_states[resolved_name] = 'off'

        return True

    def get_status(self, led_name=None):
        status_data = {}
        target_leds = list(self.led_states.keys())

        if led_name:
            resolved_name = self.resolve_led_name(led_name)
            if self.is_group(resolved_name):
                target_leds = self.groups[resolved_name]
            elif resolved_name in self.led_states:
                target_leds = [resolved_name]
            else:
                return {"error": f"Unknown LED or group: {led_name}"}

        with self._effects_lock:
            effects_snapshot = dict(self.active_effects)

        for name in sorted(target_leds):
            effect_status = 'static'
            if name in effects_snapshot:
                thread_name = effects_snapshot[name][1].name
                effect_status = f"active ({thread_name})"
            status_data[name] = {
                "state": self.led_states.get(name, 'unknown'),
                "effect": effect_status
            }

        return {"status": status_data}

    def handle_command(self, command):
        parts = command.strip().lower().split()
        if not parts:
            return "Invalid command format"

        if parts[0] == 'status':
            led_name = parts[1] if len(parts) > 1 else None
            return json.dumps(self.get_status(led_name))

        if len(parts) < 2:
            return "Invalid command format"

        led_name, action = parts[0], parts[1]
        resolved_name = self.resolve_led_name(led_name)

        if resolved_name not in self.pins and not self.is_group(resolved_name):
            return f"Unknown LED: {led_name}"

        if action == 'on':
            self.set_led(resolved_name, 'on')
            return f"{led_name} turned on"
        elif action == 'off':
            self.set_led(resolved_name, 'off')
            return f"{led_name} turned off"
        elif action.startswith('flash'):
            return self.handle_flash(resolved_name, action, parts)
        elif action == 'fastblink':
            return self.handle_blink(resolved_name, 0.2)
        elif action == 'patternblink':
            return self.handle_patternblink(resolved_name, parts)
        else:
            return f"Unknown action: {action}"

    def _register_effect(self, name, stop_event, thread):
        """Register an effect thread. Thread-safe."""
        with self._effects_lock:
            self.active_effects[name] = (stop_event, thread)

    def handle_flash(self, name, action, parts):
        if '-' not in action:
            return "Invalid flash command"

        colors = action.split('-')[1:]
        interval = 0.5
        duration = None
        if len(parts) > 2 and parts[2].endswith('s'):
            try:
                duration = float(parts[2][:-1])
            except ValueError:
                pass

        if self.is_group(name):
            member_leds = self.groups[name]
            color_leds = []
            for color in colors:
                for member in member_leds:
                    if member.endswith(color):
                        color_leds.append(member)
            if not color_leds:
                return f"No matching LEDs for colors {colors} in group {name}"
        else:
            base = name[:-3] if name.endswith(('red', 'green', 'blue')) else name
            color_leds = [f"{base}{color}" for color in colors]

        self.stop_effect(name)
        stop_event = threading.Event()

        def flash_cycle():
            start_time = time.time()
            while not stop_event.is_set():
                for led in color_leds:
                    if stop_event.is_set():
                        break
                    self.set_led(led, 'on', skip_stop_effect=True)
                    if stop_event.wait(interval):
                        break
                    self.set_led(led, 'off', skip_stop_effect=True)
                if duration and (time.time() - start_time) >= duration:
                    break
            for led in color_leds:
                self.set_led(led, 'off', skip_stop_effect=True)

        t = threading.Thread(target=flash_cycle, daemon=True, name=f"flash-{name}")
        self._register_effect(name, stop_event, t)
        t.start()
        return f"{name} flashing {colors} every {interval}s"

    def handle_blink(self, name, interval):
        self.stop_effect(name)
        stop_event = threading.Event()

        if self.is_group(name):
            member_leds = self.groups[name]

            def blink_cycle():
                while not stop_event.is_set():
                    for led in member_leds:
                        self.set_led(led, 'on', skip_stop_effect=True)
                    if stop_event.wait(interval):
                        break
                    for led in member_leds:
                        self.set_led(led, 'off', skip_stop_effect=True)
                    if stop_event.wait(interval):
                        break

            t = threading.Thread(
                target=blink_cycle, daemon=True, name=f"fastblink-group-{name}"
            )
        else:
            def blink_cycle():
                while not stop_event.is_set():
                    self.set_led(name, 'on', skip_stop_effect=True)
                    if stop_event.wait(interval):
                        break
                    self.set_led(name, 'off', skip_stop_effect=True)
                    if stop_event.wait(interval):
                        break

            t = threading.Thread(
                target=blink_cycle, daemon=True, name=f"fastblink-{name}"
            )

        self._register_effect(name, stop_event, t)
        t.start()
        return f"{name} blinking every {interval*2}s"

    def handle_patternblink(self, name, parts):
        if len(parts) < 3:
            return "Missing blink count for patternblink"
        try:
            count = int(parts[2])
            if not (1 <= count <= 5):
                raise ValueError
        except ValueError:
            return "Invalid blink count"

        self.stop_effect(name)
        stop_event = threading.Event()

        def pattern_blink_cycle():
            while not stop_event.is_set():
                for i in range(count):
                    if stop_event.is_set():
                        break
                    self.set_led(name, 'on', skip_stop_effect=True)
                    if stop_event.wait(0.25):
                        break
                    self.set_led(name, 'off', skip_stop_effect=True)
                    if stop_event.wait(0.25):
                        break
                if stop_event.wait(1.0):
                    break

        t = threading.Thread(
            target=pattern_blink_cycle, daemon=True, name=f"patternblink-{name}-{count}"
        )
        self._register_effect(name, stop_event, t)
        t.start()
        return f"{name} pattern blinking {count} times per cycle"

    def stop_all_effects(self):
        """Stop all running effects. Called during shutdown."""
        with self._effects_lock:
            names = list(self.active_effects.keys())
        for name in names:
            self.stop_effect(name)


class LEDHandler:
    def __init__(self, led_pins, id_map, groups, i2c_addr,
                 socket_file, socket_timeout):
        self.controller = LEDController(led_pins, id_map, groups, i2c_addr)
        self.socket_file = socket_file
        self.socket_timeout = socket_timeout
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._shutdown = threading.Event()
        self.command_queue = queue.Queue()

    def start(self):
        if os.path.exists(self.socket_file):
            os.remove(self.socket_file)
        self.sock.bind(self.socket_file)
        # The socket is created by whichever user runs this handler
        # (expected to be "pi"), so ownership is already correct with no
        # extra step - just restrict the permission bits.
        os.chmod(self.socket_file, 0o660)
        self.sock.listen(5)
        self.sock.settimeout(self.socket_timeout)
        self._shutdown.clear()
        log.info(f"LED Handler v{VERSION} started - Listening for connections on {self.socket_file}")

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

    def stop(self):
        log.info("Shutting down LED handler...")
        self.controller.stop_all_effects()
        try:
            self.controller.set_led('sysred', 'on')
        except Exception as e:
            log.error(f"Failed to set sysred during stop: {str(e)}")
        self._shutdown.set()
        try:
            self.sock.close()
        except Exception:
            pass
        if os.path.exists(self.socket_file):
            os.remove(self.socket_file)
        log.info("LED Handler stopped")


# --------------------------
# argument parsing
# --------------------------

def parse_arguments():
    parser = argparse.ArgumentParser(description="LED Handler Service")
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
        help="Override both handlers.leds.log_level and config.global_log_level "
             "(debug, info, warn/warning, error, critical)"
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
        # and handlers.leds.log_level.
        level = LEVEL_ALIASES[args.loglevel.strip().lower()]
    else:
        try:
            level = resolve_effective_level(cfg["handler_log_level"], cfg["global_log_level"])
        except ValueError as e:
            print(f"Fatal error resolving log level: {e}", file=sys.stderr, flush=True)
            sys.exit(1)

    init_logging(level=level)

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    try:
        handler = LEDHandler(
            cfg["led_pins"],
            cfg["id_map"],
            cfg["groups"],
            cfg["i2c_addr"],
            cfg["socket_file"],
            cfg["socket_timeout"],
        )
        handler.start()
    except KeyboardInterrupt:
        if handler:
            handler.stop()
    except Exception as e:
        log.critical(f"Fatal error: {str(e)}")
        if handler:
            handler.stop()
        sys.exit(1)


if __name__ == "__main__":
    main()
