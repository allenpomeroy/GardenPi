#!/opt/gardenpi/python3/bin/python3
#
# adc.py
#
# Queries the ADC Handler for voltage level on any or all configured
# channels, by hardware_id or user_id.
#
# v3.0 2026/08/27
# - the CLI now takes a hardware_id or user_id (e.g. "channel3" or
#   "moisture1") instead of a bare numeric channel 0-7, matching
#   handlers.adc.channel_map. "all" reads every channel defined there,
#   in config order, rather than a hardcoded range(8).
#
# v2.2 2026/08/26
# - simplified socket naming
# v2.1 2026/08/25
# - socket path and socket timeout are now loaded from garden.json
#   (handlers.adc.socket, config.socket_timeout) instead of
#   being hardcoded, via a new --config flag (default:
#   /opt/gardenpi/config/garden.json). Neither value falls back to a
#   hardcoded default if missing from config - the script exits with a
#   clear error naming the missing key instead.
# - CLI output (voltage readings, error text) is unchanged - this stays a
#   plain stdout/stderr tool, not routed through the handlers' structured
#   logging, so existing scripts piping its output keep working.
#
# v2.0 2026/04/11
# - add socket timeout
# - clean up error handling
# v1.2 2025/06/25
# v1.0 2025/04/16

import argparse
import json
import socket
import sys
import time
import colorama
from colorama import Fore, Style

from garden_config import ConfigError, require, require_nonempty, build_id_map, display_id

version = "3.0"

# The only hardcoded default kept: where to find garden.json.
DEFAULT_CONFIG_FILE = "/opt/gardenpi/config/garden.json"


def load_config(config_path):
    with open(config_path) as f:
        cfg = json.load(f)

    global_cfg = cfg.get("config", {})
    adc_cfg = cfg.get("handlers", {}).get("adc", {})

    socket_path = require(adc_cfg, "socket", "handlers.adc.socket")
    socket_timeout = require(global_cfg, "socket_timeout", "config.socket_timeout")
    channel_map_cfg = require_nonempty(adc_cfg, "channel_map", "handlers.adc.channel_map")
    id_map = build_id_map(channel_map_cfg, "handlers.adc.channel_map")

    return socket_path, socket_timeout, id_map


def get_adc_voltage(channel_id, socket_path, timeout):
    """Get voltage from ADC handler for the given hardware_id/user_id"""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout)
            sock.connect(socket_path)
            sock.sendall(str(channel_id).encode('utf-8'))
            response = sock.recv(1024).decode('utf-8').strip()
            if response.startswith("ERROR"):
                raise RuntimeError(response)
            return float(response)
    except socket.timeout:
        print(f"Timeout reading channel {channel_id}", file=sys.stderr)
        return None
    except ConnectionRefusedError:
        print(f"ADC handler not running", file=sys.stderr)
        return None
    except Exception as e:
        print(f"Communication error: {str(e)}", file=sys.stderr)
        return None


def printvalue(last, current):
    """Print value with color coding for significant changes"""
    if current is None:
        print("ERROR\t", end='', flush=True)
        return

    delta = current - last
    if current > 0:
        gap = delta / current * 100.0
    else:
        gap = 0

    if abs(gap) > 10.0:
        print(Fore.GREEN + '{:.4f}'.format(round(current, 4)), '\t', end='', flush=True)
        print(Style.RESET_ALL, end='', flush=True)
    else:
        print('{:.4f}'.format(round(current, 4)), '\t', end='', flush=True)


def main():
    parser = argparse.ArgumentParser(
        description='Read ADC value from a channel by hardware_id or user_id'
    )
    parser.add_argument(
        'channel',
        help='hardware_id (e.g. channel3) or user_id (e.g. moisture1) from '
             'handlers.adc.channel_map, or "all"'
    )
    parser.add_argument('--verbose', '-v', action='store_true', help='Enable verbose output')
    parser.add_argument('--loop', '-l', action='store_true', help='Continuously read values')
    parser.add_argument(
        '--config', '-c',
        type=str, default=DEFAULT_CONFIG_FILE,
        help=f'Path to garden.json config file (default: {DEFAULT_CONFIG_FILE})'
    )

    args = parser.parse_args()

    try:
        socket_path, socket_timeout, id_map = load_config(args.config)
    except Exception as e:
        print(f"Fatal error loading config '{args.config}': {e}", file=sys.stderr)
        sys.exit(1)

    colorama.init()

    if args.verbose:
        print(Fore.GREEN + "ADC Display" + Style.RESET_ALL)

    all_hardware_ids = id_map["order"]

    if args.channel == 'all':
        channels = all_hardware_ids
    elif args.channel in id_map["lookup"]:
        channels = [id_map["lookup"][args.channel]]
    else:
        print(f"Error: Unknown channel '{args.channel}'. Valid: {', '.join(all_hardware_ids)}, all")
        sys.exit(1)

    if args.loop:
        linecount = 0
        lastreading = {hw_id: 0.0 for hw_id in all_hardware_ids}
        thisreading = {hw_id: 0.0 for hw_id in all_hardware_ids}

        try:
            while True:
                if (linecount % 20) == 0 and args.channel == "all":
                    print("\t".join(display_id(id_map, hw_id) for hw_id in channels))

                for hw_id in channels:
                    voltage = get_adc_voltage(hw_id, socket_path, socket_timeout)
                    thisreading[hw_id] = voltage if voltage is not None else 0.0
                    printvalue(lastreading[hw_id], thisreading[hw_id])
                    lastreading[hw_id] = thisreading[hw_id]

                print("")
                linecount += 1
                time.sleep(1)

        except KeyboardInterrupt:
            print("\nExiting loop.")
    else:
        for hw_id in channels:
            voltage = get_adc_voltage(hw_id, socket_path, socket_timeout)
            label = display_id(id_map, hw_id)
            if voltage is not None:
                if args.verbose:
                    print(f"{label} ({hw_id}) voltage: {voltage:.4f} V")
                else:
                    print(f"{voltage:.4f}")
            else:
                print(f"Error reading channel {label} ({hw_id})")


if __name__ == "__main__":
    main()
