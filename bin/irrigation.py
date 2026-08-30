#!/opt/gardenpi/python3/bin/python3
#
# irrigation.py
#
# v4.1 2026/08/27
# - fixed: "too many values to unpack (expected 3)" fatal error on every
#   invocation. load_config() had been changed to return 4 values
#   (socket_file, socket_timeout, valid_relays, and the hardware_id-only
#   list used by "-r all") but the call site in __main__ was never updated
#   to match, so it always crashed before argument parsing even ran.
# - fixed: "-r all -a off" was iterating valid_relays (which contains BOTH
#   each relay's hardware_id and user_id as separate accepted tokens for
#   -r) instead of the hardware_id-only list, so it was silently sending
#   "off" twice per physical relay. Now iterates hardware_ids once per
#   relay.
#
# v4.0 2026/08/27
# - terminology: reads handlers.irrigation.relay_map (list of
#   {hardware_id, user_id, friendly}) instead of relay_name_map. The
#   -r/--relay choices list now includes both hardware_id and user_id for
#   every relay (either is accepted and forwarded as-is - the handler
#   resolves it).
#
# v3.3 2026/08/26
# - simplified socket naming
# v3.2 2026/08/25
# - socket path, socket timeout, and the set of valid relay names are now
#   loaded from garden.json (handlers.irrigation.socket,
#   config.socket_timeout, handlers.irrigation.relay_name_map)
#   instead of the hardcoded relay_dict, via a new --config/-c flag
#   (default: /opt/gardenpi/config/garden.json). Since argparse needs the
#   valid relay names to build the -r/--relay choices list before it can
#   parse the rest of the arguments, --config is parsed in a separate
#   early pass.
# - both socket connections now set a timeout (from config.socket_timeout)
#   where previously neither had one and could hang indefinitely if the
#   handler was unresponsive.
# - neither value falls back to a hardcoded default if missing from
#   config - the script exits with a clear error naming the missing key.
# - CLI output is unchanged - this stays a plain stdout/JSON tool, not
#   routed through the handlers' structured logging.

import argparse
import os
import socket
import json
import sys
from datetime import datetime

from garden_config import ConfigError, require, require_nonempty, build_id_map

# ---------
# constants and globals
# ---------

version = "4.1"

# The only hardcoded default kept: where to find garden.json.
DEFAULT_CONFIG_FILE = "/opt/gardenpi/config/garden.json"


def load_config(config_path):
    with open(config_path) as f:
        cfg = json.load(f)

    global_cfg = cfg.get("config", {})
    irrigation_cfg = cfg.get("handlers", {}).get("irrigation", {})

    socket_file = require(irrigation_cfg, "socket", "handlers.irrigation.socket")
    socket_timeout = require(global_cfg, "socket_timeout", "config.socket_timeout")

    relay_map_cfg = require_nonempty(irrigation_cfg, "relay_map", "handlers.irrigation.relay_map")
    id_map = build_id_map(relay_map_cfg, "handlers.irrigation.relay_map")
    # Accept either hardware_id or user_id on the command line - both are
    # keys in id_map["lookup"]. For "-r all", iterate hardware_ids only
    # (id_map["order"]) so each physical relay is only addressed once.
    valid_relays = sorted(id_map["lookup"].keys())

    return socket_file, socket_timeout, valid_relays, id_map["order"]


def log_message_json(message, level, severity):
    timestamp = datetime.now().isoformat()
    log_entry = {
        "timestamp": timestamp,
        "message": message,
        "level": level,
        "severity": severity
    }
    json_log = json.dumps(log_entry, separators=(',', ':'))
    print(json_log)

# ---------------------
# Argument Parsing
# ---------------------

class CustomArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        error_message = {"action": "parse args", "result": "error", "error": message}
        log_message_json(error_message, 0, "error")
        self.print_help()
        self.exit(2)


def parse_config_arg():
    """Pull --config/-c out in an early pass, since argparse needs the
    valid relay names (loaded from that config) to build the -r/--relay
    choices before it can parse the rest of the arguments."""
    pre_parser = argparse.ArgumentParser(add_help=False)
    pre_parser.add_argument("-c", "--config", type=str, default=DEFAULT_CONFIG_FILE)
    known, _ = pre_parser.parse_known_args()
    return known.config


def parse_arguments(valid_relays):
    parser = CustomArgumentParser()
    parser.add_argument("-c", "--config",
                        type=str, default=DEFAULT_CONFIG_FILE,
                        help=f"Path to garden.json config file (default: {DEFAULT_CONFIG_FILE})")
    parser.add_argument("-l", "--loglevel",
                        help="Set log level 0=none 5=max",
                        type=int, default=0)
    parser.add_argument("-r", "--relay",
                        type=str, required=True,
                        choices=valid_relays + ['all'],
                        help="hardware_id or user_id of the relay to operate on")
    parser.add_argument("-a", "--action",
                        type=str, required=True,
                        choices=['on', 'off', 'status'],
                        help="Action to perform on relay. Note relay 'all' can only accept actions 'off' or 'status'")
    return parser.parse_args()

# ---------------------
# Main Execution
# ---------------------

if __name__ == '__main__':
    config_path = parse_config_arg()

    try:
        socket_file, socket_timeout, valid_relays, hardware_ids = load_config(config_path)
    except Exception as e:
        print(json.dumps({"error": f"Fatal error loading config '{config_path}': {e}"}), file=sys.stderr)
        sys.exit(1)

    args = parse_arguments(valid_relays)
    relay = args.relay
    action = args.action

    # Compose the command string for the handler protocol
    if relay == "all":
        if action == "status":
            command = "status all"
        elif action == "off":
            # Send off command to all relays, once per physical relay
            # (hardware_ids only) - valid_relays deliberately also
            # contains each relay's user_id as a separate accepted token
            # for -r, so iterating that here would send "off" twice per
            # relay (once by hardware_id, once by user_id).
            for r in hardware_ids:
                try:
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                        client.settimeout(socket_timeout)
                        client.connect(socket_file)
                        client.sendall(f"{r} off".encode("utf-8"))
                        response = client.recv(1024).decode("utf-8").strip()
                        print(f"{r}: {response}")
                except Exception as e:
                    print(json.dumps({"relay": r, "error": str(e)}))
            exit(0)
        else:
            print(json.dumps({"error": "Relay 'all' only supports 'off' or 'status'"}))
            exit(1)
    else:
        if action == "status":
            # Request status for specific relay
            command = f"status {relay}"
        else:
            command = f"{relay} {action}"

    # Send the command and print the response
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(socket_timeout)
            client.connect(socket_file)
            client.sendall(command.encode("utf-8"))
            response = client.recv(1024).decode("utf-8").strip()
            # Pretty print JSON if response is JSON, else print as is
            try:
                parsed = json.loads(response)
                print(json.dumps(parsed, indent=2, ensure_ascii=False))
            except Exception:
                print(response)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
