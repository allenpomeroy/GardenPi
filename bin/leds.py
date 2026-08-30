#!/opt/gardenpi/python3/bin/python3
#
# leds.py
#
# CLI client for led-handler
#
# v2.1 2026/08/25
# - socket path and socket timeout are now loaded from garden.json
#   (handlers.leds.socket, config.socket_timeout) instead of
#   being hardcoded, via a new --config/-c flag (default:
#   /opt/gardenpi/config/garden.json). Since this script's argument handling
#   is positional/custom rather than argparse, --config is pulled out of
#   argv separately before the existing positional parsing runs. Neither
#   value falls back to a hardcoded default if missing from config - the
#   script exits with a clear error naming the missing key instead.
# - CLI output is unchanged - this stays a plain stdout tool, not routed
#   through the handlers' structured logging.
#
# v2.0 2026/04/11
# - add socket timeout
# v1.1 2025/11/11
# v1.0

import sys
import os
import socket
import json
import re

from garden_config import ConfigError, require

# The only hardcoded default kept: where to find garden.json.
DEFAULT_CONFIG_FILE = "/opt/gardenpi/config/garden.json"

VALID_ACTIONS = {
    "on": {"args": 0},
    "off": {"args": 0},
    "blink": {"args": 1, "type": "count"},
    "fastblink": {"args": 0},
    "flash": {"args": 2, "type": "colors+duration"},
    "patternblink": {"args": 1, "type": "count"},
    "status": {"args": 0, "optional_args": 1, "type": "led_name"}
}


def load_config(config_path):
    with open(config_path) as f:
        cfg = json.load(f)

    global_cfg = cfg.get("config", {})
    leds_cfg = cfg.get("handlers", {}).get("leds", {})

    socket_path = require(leds_cfg, "socket", "handlers.leds.socket")
    socket_timeout = require(global_cfg, "socket_timeout", "config.socket_timeout")

    return socket_path, socket_timeout


def extract_config_path(argv):
    """
    Pull an optional --config/-c <path> out of argv, returning
    (config_path, remaining_argv) with argv[0] (the script name) and
    positional ordering otherwise preserved. This script's own argument
    handling is positional/custom rather than argparse, so --config is
    handled as a separate pass rather than folded into validate_args().
    """
    remaining = []
    config_path = DEFAULT_CONFIG_FILE
    i = 0
    while i < len(argv):
        if argv[i] in ("--config", "-c") and i + 1 < len(argv):
            config_path = argv[i + 1]
            i += 2
            continue
        remaining.append(argv[i])
        i += 1
    return config_path, remaining


def usage():
    print("Usage examples:")
    print("  leds.py sysblue on")
    print("  leds.py led2blue blink 5")
    print("  leds.py led2blue fastblink")
    print("  leds.py led1 red-blue flash 10s")
    print("  leds.py led2red patternblink 4")
    print("  leds.py led1red off")
    print("  leds.py status          # Get status of ALL LEDs")
    print("  leds.py status led1red  # Get status of a single LED")
    print()
    print("Actions:")
    print("  on, off, blink <count>, fastblink, flash <colors> <duration>,")
    print("  patternblink <count>, status [led_name]")
    sys.exit(1)


def validate_args(args):
    if len(args) < 2:
        usage()

    action = args[1].lower()

    if action == 'status':
        if len(args) == 2:
            return "all", "status", []
        elif len(args) == 3:
            led = args[2]
            return led, "status", [led]
        else:
            print("Status takes zero or one argument (an LED/group name).")
            usage()

    if len(args) < 3:
        usage()

    led = args[1]
    action = args[2].lower()

    if action not in VALID_ACTIONS:
        print(f"Unknown action: {action}")
        usage()

    action_info = VALID_ACTIONS[action]
    needed = action_info["args"]
    extra_args = []

    if needed == 0:
        if len(args) != 3:
            print(f"Action '{action}' does not take extra arguments.")
            usage()
    elif needed == 1:
        if len(args) != 4:
            print(f"Action '{action}' requires one argument.")
            usage()
        extra_args = [args[3]]
    elif needed == 2:
        if len(args) != 5:
            print(f"Action '{action}' requires two arguments (colors and duration).")
            usage()
        extra_args = [args[3], args[4]]

    if action in ("blink", "patternblink"):
        try:
            count = int(extra_args[0])
            if not (1 <= count <= 5):
                raise ValueError
        except ValueError:
            print("Count must be an integer between 1 and 5.")
            usage()

    if action == "flash":
        colors = extra_args[0]
        duration = extra_args[1]
        if not re.match(r"^([a-z]+-)*[a-z]+$", colors):
            print("Colors must be dash-separated, e.g. red-blue")
            usage()
        if not re.match(r"^\d+s$", duration):
            print("Duration must be in seconds, e.g. 5s or 10s")
            usage()

    return led, action, extra_args


def build_command(led, action, extra_args):
    if action in ("on", "off"):
        return f"{led} {action}"
    if action == "blink":
        return f"{led} patternblink {extra_args[0]}"
    if action == "fastblink":
        return f"{led} fastblink"
    if action == "flash":
        return f"{led} flash-{extra_args[0]} {extra_args[1]}"
    if action == "patternblink":
        return f"{led} patternblink {extra_args[0]}"
    if action == "status":
        return f"status {led}" if led != "all" else "status"
    return None


def handle_status_response(response):
    try:
        data = json.loads(response)
        if "error" in data:
            print(f"Handler Error: {data['error']}")
            return

        status_data = data.get("status", {})
        if not status_data:
            print("No LED status available.")
            return

        print("--- LED Status ---")
        for led_name, status in status_data.items():
            state = status['state'].upper()
            effect = status['effect'].replace('active (', '').replace(')', '')
            effect_str = f"({effect})" if effect != 'static' else ""
            print(f"  {led_name:15}: **{state:3}** {effect_str}")
        print("------------------")

    except json.JSONDecodeError:
        print(response)
    except Exception as e:
        print(f"Error processing status response: {e}")
        print(f"Raw response: {response}")


def send_command(command, socket_path, timeout):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout)
            sock.connect(socket_path)
            sock.sendall(command.encode() + b"\n")
            sock.shutdown(socket.SHUT_WR)
            response = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response += chunk
            return response.decode().strip()
    except ConnectionRefusedError:
        return "Error: Could not connect to the handler."
    except FileNotFoundError:
        return f"Error: Socket {socket_path} not found. Is the handler running?"
    except socket.timeout:
        return "Error: Timeout communicating with handler."
    except Exception as e:
        return f"Error: {e}"


def main():
    config_path, argv = extract_config_path(sys.argv)

    try:
        socket_path, socket_timeout = load_config(config_path)
    except Exception as e:
        print(f"Fatal error loading config '{config_path}': {e}", file=sys.stderr)
        sys.exit(1)

    if len(argv) < 2:
        usage()

    action_arg = argv[1].lower()
    if action_arg == 'status':
        led, action, extra_args = validate_args(argv)
        command = build_command(led, action, extra_args)
        if not command:
            print("Failed to build command.")
            sys.exit(1)
        response = send_command(command, socket_path, socket_timeout)
        handle_status_response(response)
    else:
        led, action, extra_args = validate_args(argv)
        command = build_command(led, action, extra_args)
        if not command:
            print("Failed to build command.")
            sys.exit(1)
        response = send_command(command, socket_path, socket_timeout)
        print(response)


if __name__ == "__main__":
    main()
