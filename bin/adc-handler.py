#!/opt/gardenpi/python3/bin/python3
#
# adc-handler.py
#
# v3.2 2026/08/28
# - added LED startup indication: sets the shared "sensors" LED blue
#   (sensorrun) once ADC channels are initialized successfully, or red
#   (sensorerr) if hardware initialization fails. This is the same
#   physical LED weather-handler.py reports on; see that file's
#   led_is_red()/start() for how it avoids clobbering a red set here.
#
# v3.1 2026/08/27
# - fixed: startup crash "'GpioOutputPin' object has no attribute
#   'switch_to_output'" (fatal, handler exited immediately every time) -
#   see garden_gpio.py v1.1. No changes needed in this file itself; the
#   fix is entirely in the shared GpioOutputPin shim used by
#   ADCController.initialize_hardware() below.
#
# v3.0 2026/08/27
# - terminology: garden.json's handlers.adc.channels (a list of
#   {number, name}) is replaced by handlers.adc.channel_map (a list of
#   {hardware_id, user_id, friendly}) - hardware_id (e.g. "channel3") is
#   read-only and always maps 1:1 to a physical MCP3008 pin via
#   hardware.picontroller.pin_map (type "adc"); user_id/friendly are
#   customer configurable. The socket protocol now accepts either the
#   hardware_id or the user_id as the command - not a bare channel number
#   - and this handler resolves it internally.
# - GPIO: the SPI chip-select pin (previously a Blinka digitalio.DigitalInOut)
#   is now claimed via garden_gpio (lgpio, falling back to pigpio), since
#   this is a multi-process environment and RPi.GPIO-style whole-chip
#   access doesn't arbitrate cleanly between multiple handler processes.
#   The hardware SPI clock/MOSI/MISO lines are unaffected - those still go
#   through board/busio (a real SPI bus device, not a bit-banged pin).
# - fixed: several `threading.Thread(..., handler=True)` calls left over
#   from an earlier, over-eager "daemon -> handler" terminology pass had
#   accidentally renamed the *unrelated* stdlib
#   `threading.Thread(daemon=True)` keyword argument too. That argument is
#   Python's own API (marks a thread as a background/daemon thread so it
#   doesn't block process exit) and must stay `daemon=True` - restored.
#
# v2.3 2026/08/26
# - simplified socket naming
# v2.2 2026/08/25
# - removed the socket chown/group-ownership logic entirely. The socket is
#   created by whatever user runs this handler (expected to be "pi"), so
#   its owning user is already correct with no extra step; only the
#   permission bits (0660) are still set explicitly.
# - removed every hardcoded config fallback except the config *file path*
#   itself (DEFAULT_CONFIG_FILE). All other values (socket path, socket
#   timeout, log levels, channel list) must now be present in garden.json;
#   a missing required value raises garden_config.ConfigError naming the
#   exact dotted path that needs to be added, and the handler exits rather
#   than silently substituting a guessed default.
#
# v2.1 2026/08/25
# - configuration (socket timeout, socket path, log level, channel names)
#   is now loaded from garden.json instead of hardcoded values / CLI flags
# - all logging now goes through the centralized garden_logger.init_logging()
#   helper instead of the old ADCController.log()/log_json() methods
# - effective log level is the more restrictive (numerically higher) of
#   handlers.adc.log_level and config.global_log_level
#
# v2.0 2026/04/11
# - thread-safe shutdown via threading.Event
# - queue.get with timeout for clean shutdown
# - signal handler uses Event instead of sys.exit
# - fixed: worker now handles queue.Empty gracefully
#
# v1.2 2025/06/25
# - updated to queuing commands
# v1.0 2025/04/15
# - initial version
#
# Copyright 2025-2026 Allen Pomeroy - MIT license

import os
import sys
import socket
import json
import logging
import argparse
import threading
import queue
import subprocess
import board
import busio
import signal
import adafruit_mcp3xxx.mcp3008 as MCP
from adafruit_mcp3xxx.analog_in import AnalogIn

from garden_logger import init_logging, resolve_effective_level, LEVEL_ALIASES
from garden_config import (
    ConfigError, require, require_nonempty,
    build_id_map, resolve_id, display_id, pin_for_hardware_id,
)
import garden_gpio

# --------------------------
# constants and globals
# --------------------------

VERSION = "3.2"

# Only hardcoded default kept: where to find garden.json. Every other
# value below must be present in the config file - see garden_config.py.
DEFAULT_CONFIG_FILE = "/opt/gardenpi/config/garden.json"

# CS pin depends on hardware version (board header revision), not on
# garden.json - see hwversion handling below.
CS_PIN_BY_HWVERSION = {"2.2": 26, "5.1": 26, "7.1": 25}

# Not sourced from garden.json (no corresponding key exists there) - a
# fixed path to a sibling script, not a config fallback.
LED_CLIENT_PATH = "/opt/gardenpi/bin/leds.py"

log = logging.getLogger(__name__)


# --------------------------
# LED Control Functions
# --------------------------
#
# The "sensors" LED (led1 / sensorrun/sensorerr aliases in
# garden.json's handlers.leds.led_map) is shared with weather-handler.py:
# whichever of the two starts first sets it blue on success or red on
# failure; weather-handler.py additionally checks its state at its own
# startup so a red flag raised here isn't silently overwritten - see
# weather-handler.py's led_is_red()/start() for that logic.

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


def indicate_run():
    call_led_client("sensorrun", "on")
    log.info("LED: Sensor run indicator on")


def indicate_error():
    call_led_client("sensorerr", "blink", "1")
    log.warning("LED: Sensor error indicator activated")


def load_config(config_path):
    with open(config_path, "r") as f:
        cfg = json.load(f)

    global_cfg = cfg.get("config", {})
    adc_cfg = cfg.get("handlers", {}).get("adc", {})
    pc_cfg = cfg.get("hardware", {}).get("picontroller", {})

    socket_timeout = require(global_cfg, "socket_timeout", "config.socket_timeout")
    socket_file = require(adc_cfg, "socket", "handlers.adc.socket")
    handler_log_level = require(adc_cfg, "log_level", "handlers.adc.log_level")
    global_log_level = require(global_cfg, "global_log_level", "config.global_log_level")

    channel_map_cfg = require_nonempty(adc_cfg, "channel_map", "handlers.adc.channel_map")
    id_map = build_id_map(channel_map_cfg, "handlers.adc.channel_map")

    pin_map = require_nonempty(pc_cfg, "pin_map", "hardware.picontroller.pin_map")

    # hardware_id (e.g. "channel3") -> physical MCP3008 channel number
    channel_numbers = {}
    for hardware_id in id_map["order"]:
        pin = pin_for_hardware_id(pin_map, hardware_id, pin_type="adc")
        if pin is None:
            log.error(
                f"No 'adc' pin defined for hardware_id '{hardware_id}' in "
                f"hardware.picontroller.pin_map; this channel will be unavailable."
            )
            continue
        channel_numbers[hardware_id] = pin

    if not channel_numbers:
        raise ConfigError(
            "No usable ADC channels could be built from handlers.adc.channel_map / "
            "hardware.picontroller.pin_map"
        )

    return {
        "socket_timeout": socket_timeout,
        "socket_file": socket_file,
        "handler_log_level": handler_log_level,
        "global_log_level": global_log_level,
        "id_map": id_map,
        "channel_numbers": channel_numbers,
    }


class ADCController:
    def __init__(self, hwversion, id_map, channel_numbers):
        self.hwversion = hwversion
        self.id_map = id_map
        self.channel_numbers = channel_numbers
        self.channels = {}  # hardware_id -> AnalogIn
        self._hw_lock = threading.Lock()
        self._gpio_chip = None
        self.initialize_hardware()

    def initialize_hardware(self):
        try:
            if self.hwversion not in CS_PIN_BY_HWVERSION:
                raise ValueError(f"Unsupported hardware version: {self.hwversion}")
            cs_pin_num = CS_PIN_BY_HWVERSION[self.hwversion]

            log.debug(f"Initializing ADC for hardware version {self.hwversion}")

            # Chip-select is a bit-banged GPIO pin, claimed via lgpio/pigpio
            # (garden_gpio) rather than Blinka's digitalio, since this
            # process shares the Pi's GPIO chip with other handlers.
            self._gpio_chip = garden_gpio.GpioChip()
            adccs = self._gpio_chip.claim_output(cs_pin_num, initial=1)

            spi = busio.SPI(clock=board.SCK, MISO=board.MISO, MOSI=board.MOSI)
            mcp = MCP.MCP3008(spi, adccs)

            for hardware_id, channel_num in self.channel_numbers.items():
                pin = getattr(MCP, f"P{channel_num}")
                self.channels[hardware_id] = AnalogIn(mcp, pin)

            log.debug("ADC channels initialized successfully")
            indicate_run()

        except Exception as e:
            log.error(f"Hardware initialization error: {str(e)}")
            indicate_error()
            raise

    def channel_label(self, hardware_id):
        display = display_id(self.id_map, hardware_id)
        return f"{hardware_id} ({display})" if display != hardware_id else hardware_id

    def handle_command(self, command):
        try:
            token = command.strip()
            hardware_id = resolve_id(self.id_map, token)
            if hardware_id is None or hardware_id not in self.channels:
                return f"ERROR: Unknown channel: {token}"

            label = self.channel_label(hardware_id)
            log.debug(f"Reading channel {label}")

            with self._hw_lock:
                voltage = self.channels[hardware_id].voltage
            response = f"{voltage:.4f}"
            log.debug(f"Channel {label} voltage: {response}V")
            return response

        except Exception as e:
            log.error(f"Command handling error: {str(e)}")
            return f"ERROR: {str(e)}"

    def close(self):
        if self._gpio_chip:
            self._gpio_chip.close()


class ADCHandler:
    def __init__(self, hwversion, id_map, channel_numbers, socket_file, socket_timeout):
        self.controller = ADCController(hwversion, id_map, channel_numbers)
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
        log.info(f"ADC Handler v{VERSION} started - Listening for connections on {self.socket_file}")

        threading.Thread(target=self.worker, daemon=True).start()

        while not self._shutdown.is_set():
            try:
                conn, _ = self.sock.accept()
                threading.Thread(target=self.handle_client, args=(conn,), daemon=True).start()
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
        log.info("Shutting down ADC Handler...")
        self._shutdown.set()
        try:
            self.sock.close()
        except Exception:
            pass
        if os.path.exists(self.socket_file):
            os.remove(self.socket_file)
        self.controller.close()
        log.info("ADC Handler stopped")


# --------------------------
# argument parsing
# --------------------------

def parse_arguments():
    parser = argparse.ArgumentParser(description="ADC Handler Service")
    parser.add_argument(
        "--config", "-c",
        type=str,
        default=DEFAULT_CONFIG_FILE,
        help=f"Path to garden.json config file (default: {DEFAULT_CONFIG_FILE})"
    )
    parser.add_argument(
        '--hwversion', '-p',
        type=str,
        required=True,
        choices=['2.2', '5.1', '7.1'],
        default='7.1',
        help='PCB version (2.2, 5.1, or 7.1)')
    parser.add_argument(
        '--loglevel', '-l',
        type=str,
        default=None,
        choices=sorted(LEVEL_ALIASES.keys()),
        help='Override both handlers.adc.log_level and config.global_log_level '
             '(debug, info, warn/warning, error, critical)')
    return parser.parse_args()


# --------------------------
# main
# --------------------------

handler = None

def signal_handler(sig, frame):
    global handler
    if handler:
        log.info("Received termination signal; shutting down.")
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
        # and handler.adc.log_level.
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
        handler = ADCHandler(
            args.hwversion,
            cfg["id_map"],
            cfg["channel_numbers"],
            cfg["socket_file"],
            cfg["socket_timeout"],
        )
        handler.start()
    except KeyboardInterrupt:
        if handler:
            handler.stop()
    except Exception as e:
        log.critical(f"Fatal error: {str(e)}")
        indicate_error()
        if handler:
            handler.stop()
        sys.exit(1)


if __name__ == '__main__':
    main()
