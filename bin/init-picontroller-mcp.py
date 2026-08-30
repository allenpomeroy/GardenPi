#!/opt/gardenpi/python3/bin/python3
#
# init-picontroller-mcp.py
#
# Initialization script for Allen Pomeroy PiController expansion
# hardware v2.2, 5.1, 7.1 - setup GPIO pins for LED/other output
#
# v1.7 2026/08/27
# - reads LED pin numbers from hardware.picontroller.pin_map (entries with
#   type "led"), matching the shared pin_map schema used by the other
#   handlers, instead of the old standalone mcp_led_pins/mcp_gpio_pins
#   dicts.
# v1.6 2026/08/26
# - simplified socket naming
# v1.5 2026/08/25
# - removed every hardcoded config fallback except the config *file path*
#   itself (DEFAULT_CONFIG_FILE), including DEFAULT_I2C_ADDR,
#   DEFAULT_LOG_LEVEL, DEFAULT_STARTUP_ON_TIME, and DEFAULT_LED_PIN_MAP.
#   All corresponding values must now be present in garden.json; a missing
#   required value raises garden_config.ConfigError naming the exact
#   dotted path that needs to be added, and the script exits rather than
#   silently substituting a guessed default. (hardware.picontroller.mcp_gpio_pins
#   remains optional, since input_map isn't actually consumed by this
#   script - same as before.)
#
# v1.3 2026/08/25
# - configuration is now sourced from garden.json instead of hardcoded
#   constants:
#     * hardware.picontroller.i2c_addr (still overridable via --i2caddress)
#     * hardware.picontroller.mcp_led_pins -> led_pin_map
#     * hardware.picontroller.mcp_gpio_pins -> input_map (kept for parity
#       with garden.json even though nothing in this script currently uses
#       it, same as before)
#     * hardware.picontroller.led_startup_time_sec -> startup_on_time
#     * hardware.picontroller.log_level / config.global_log_level -> log level
# - centralized logging via garden_logger.init_logging() replaces the old
#   debug-threshold log_message()/print()/handle_error() scheme. The old
#   scheme's "always shown" (level=0) messages map to info/warning/error as
#   appropriate; its "only with --debug" (level=1/2) messages map to debug,
#   so the default (garden.json's usual "info" level) output looks the same
#   as the old default (--debug 0) output
# - effective log level is the more restrictive of
#   hardware.picontroller.log_level and config.global_log_level;
#   --loglevel on the command line overrides both (replaces the old
#   numeric --debug flag)
#
# v1.2 2026/04/11
# - exit with sysgreen on to indicate successful init
# v1.1 2026/04/11
# - FIXED: lambda closure bug in setup_led_pins (captured loop var by reference)
#
# v1.0.1
# v1.0.0 2025/03/28
#
# Copyright 2025-2026 Allen Pomeroy - MIT license

import sys
import json
import time
import logging
import argparse
import board
import busio
from digitalio import Direction
from adafruit_mcp230xx.mcp23017 import MCP23017

from garden_logger import init_logging, resolve_effective_level, LEVEL_ALIASES
from garden_config import ConfigError, require, require_nonempty, parse_i2c_addr

VERSION = "1.7"

# The only hardcoded default kept: where to find garden.json. Every other
# value below must be present in the config file - see garden_config.py.
DEFAULT_CONFIG_FILE = "/opt/gardenpi/config/garden.json"

log = logging.getLogger(__name__)


# --------------------------
# Configuration loading
# --------------------------

def load_config(config_path):
    with open(config_path) as f:
        cfg = json.load(f)

    global_cfg = cfg.get("config", {})
    pc_cfg = cfg.get("hardware", {}).get("picontroller", {})

    i2c_addr = parse_i2c_addr(
        require(pc_cfg, "i2c_addr", "hardware.picontroller.i2c_addr"),
        "hardware.picontroller.i2c_addr"
    )

    startup_on_time = require(
        pc_cfg, "led_startup_time_sec", "hardware.picontroller.led_startup_time_sec"
    )

    handler_log_level = require(pc_cfg, "log_level", "hardware.picontroller.log_level")
    global_log_level = require(global_cfg, "global_log_level", "config.global_log_level")

    pin_map_cfg = require_nonempty(pc_cfg, "pin_map", "hardware.picontroller.pin_map")

    led_pin_map = {
        entry["hardware_id"]: entry["pin"]
        for entry in pin_map_cfg
        if entry.get("type") == "led" and entry.get("hardware_id") is not None
    }
    if not led_pin_map:
        raise ConfigError(
            "No 'led' entries found in hardware.picontroller.pin_map"
        )

    return {
        "i2c_addr": i2c_addr,
        "startup_on_time": startup_on_time,
        "handler_log_level": handler_log_level,
        "global_log_level": global_log_level,
        "led_pin_map": led_pin_map,
    }


# --------------------------
# Helpers
# --------------------------

def translate_state(state):
    return "off" if state else "on"


def handle_error(error_message, error_code):
    log.critical(error_message)
    sys.exit(error_code)


def retry(operation, description, attempts=3, delay=0.1):
    for attempt in range(attempts):
        log.debug(f"Attempt {attempt + 1} operation {description}")
        try:
            return operation()
        except Exception as e:
            if attempt < attempts - 1:
                log.warning(f"{description} failed on attempt {attempt + 1}, retrying: {str(e)}")
                time.sleep(delay)
            else:
                raise e


def initialize_i2c():
    log.debug("Initializing I2C")
    return retry(lambda: busio.I2C(board.SCL, board.SDA), "initialize_i2c")


def initialize_mcp(i2c, address):
    log.debug("Create MCP connection")
    return retry(lambda: MCP23017(i2c, address=address), "initialize_mcp")


def setup_led_pins(mcp, led_pin_map):
    led_pins = []
    for pin_name in led_pin_map:
        # use default arg to capture pin_name by value, not reference
        pin = retry(
            lambda pn=pin_name: mcp.get_pin(led_pin_map[pn]),
            f"get_pin {pin_name}"
        )
        retry(
            lambda p=pin: setattr(p, 'direction', Direction.OUTPUT),
            f"set_direction {pin_name}"
        )
        led_pins.append(pin)
    return led_pins


def perform_action_on_led(led, action, led_pins, led_name_map):
    led_index = led_name_map[led]
    try:
        log.debug(f"LED: {led} Action: {action}")
        if action == 'on':
            led_pins[led_index].value = False
        elif action == 'off':
            led_pins[led_index].value = True
        elif action == 'status':
            status = led_pins[led_index].value
            log.info(f"LED {led} state {translate_state(status)}")
    except Exception as e:
        log.error(f"Failed to perform action {action} on LED {led}: {str(e)}")
        handle_error(f"LED action error on {led}", 400 + led_index)


def perform_all_action(action, led_pins, led_name_map):
    if action == 'off':
        log.debug("executing all off")
        for pin in led_pins:
            pin.value = True
    elif action == 'status':
        for led, index in led_name_map.items():
            log.info(f"{led} status {translate_state(led_pins[index].value)}")


def perform_test_action(led_pins, led_name_map, startup_on_time):
    perform_all_action("off", led_pins, led_name_map)
    for led_name in led_name_map:
        perform_action_on_led(led_name, "on", led_pins, led_name_map)
        time.sleep(startup_on_time)
        perform_action_on_led(led_name, "off", led_pins, led_name_map)
    perform_all_action("off", led_pins, led_name_map)


# --------------------------
# argument parsing
# --------------------------

def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "-c", "--config",
        type=str,
        default=DEFAULT_CONFIG_FILE,
        help=f"Path to garden.json config file (default: {DEFAULT_CONFIG_FILE})"
    )
    parser.add_argument(
        "-i", "--i2caddress",
        type=str,
        default=None,
        help="Override hardware.picontroller.i2c_addr, e.g. 0x24"
    )
    parser.add_argument(
        "-l", "--loglevel",
        type=str,
        default=None,
        choices=sorted(LEVEL_ALIASES.keys()),
        help="Override both hardware.picontroller.log_level and "
             "config.global_log_level (debug, info, warn/warning, error, critical)"
    )
    return parser.parse_args()


# --------------------------
# main
# --------------------------

def main():
    args = parse_arguments()

    try:
        cfg = load_config(args.config)
    except Exception as e:
        print(f"Fatal error loading config '{args.config}': {e}", file=sys.stderr, flush=True)
        sys.exit(1)

    if args.loglevel is not None:
        # CLI flag wins outright, overriding both config.global_log_level
        # and hardware.picontroller.log_level.
        level = LEVEL_ALIASES[args.loglevel.strip().lower()]
    else:
        try:
            level = resolve_effective_level(cfg["handler_log_level"], cfg["global_log_level"])
        except ValueError as e:
            print(f"Fatal error resolving log level: {e}", file=sys.stderr, flush=True)
            sys.exit(1)

    init_logging(level=level)

    i2c_addr = parse_i2c_addr(args.i2caddress, "--i2caddress") if args.i2caddress else cfg["i2c_addr"]
    startup_on_time = cfg["startup_on_time"]
    led_pin_map = cfg["led_pin_map"]
    led_name_map = {name: i for i, name in enumerate(led_pin_map.keys())}

    log.debug(f"Version {VERSION}")
    log.debug(f"Initializing I2C at 0x{i2c_addr:02X}")

    try:
        i2c = initialize_i2c()
        mcp = initialize_mcp(i2c, i2c_addr)
        led_pins = setup_led_pins(mcp, led_pin_map)

        log.debug("Performing initialization")
        perform_test_action(led_pins, led_name_map, startup_on_time)

        # Leave sysgreen on to indicate successful initialization
        log.info("Initialization complete")
        perform_action_on_led("sysgreen", "on", led_pins, led_name_map)
        log.info("sysgreen on")
        perform_action_on_led("led1green", "on", led_pins, led_name_map)
        log.info("sysgreen on")
        perform_action_on_led("led2green", "on", led_pins, led_name_map)
        log.info("sysgreen on")
    except Exception as e:
        log.critical(f"Initialization failed: {str(e)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
