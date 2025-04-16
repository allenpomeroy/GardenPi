#!/usr/bin/python3
#
# mcp-daemon.py
#
# Control daemon for Allen Pomeroy PowerController hardware v2.4.2
# See pomeroy.us/2022/12/building-an-irrigation-power-controller/
# MCP23017 based I2C bus expansion board
# - 5x 24VAC valve relays
# - 2x 12VDC pump relay feeds
# - 3x 5v GPIO digital lines
# - AC Hz sensor
# 
# Turns pump and valve relays on or off based on JSON formatted commands
# received at socket typically sent by client script.
#
# Copyright 2025 Allen Pomeroy - MIT license
#
# =====
# Usage
#
# Installation:
#  sudo cp mcp-daemon.py /usr/local/bin
#  sudo chown root: /usr/local/bin/mcp-daemon.py
#  sudo chmod 750   /usr/local/bin/mcp-daemon.py
# 
#  sudo cp mcp-daemon.service /etc/systemd/system
#  sudo chown root: /etc/systemd/system/mcp-daemon.service
#  sudo chmod 644   /etc/systemd/system/mcp-daemon.service
#  sudo systemctl daemon-reload
#  sudo systemctl enable mcp-daemon --now
#
# Command line options:
# mcp-daemon.py -i {I2C addr hex} -l {0-5}
# -i i2c address  -i 0x27
# -l log level    -l 5
#
# Command Format:
# Valid relay names:
# valve1, valve2, valve3, valve4, valve5, pump1, pump2, all
# Valid action values:
# on, off, status
#
# Examples:
#  {"relay":"plants","action":"status","username":"pi"}
#  {"relay":"all","action":"status","username":"pi"}
#  {"relay":"plants","action":"on","username":"pi"}
#  {"relay":"plants","action":"off","username":"pi"}
#  {"relay":"all","action":"off","username":"pi"}
# 
# Optionally can specify "all" for relay name for "off" action.
# Client is expected to send username of caller for informational purposes
# no security value (sender can provide arbitrary value).
# 
# Logging levels
# 0 normal and error messages
# 1 exception messages
# 2 function info
# 3 function detail
# 4 function verbose
# 5 general info
#
# WARNING
# It is recommended to only activate a maximum of two (2) valves and
# either or both pumps simultaneously to limit the aggregate current draw.
# Activating more valves simulaneously is likely to cause excessive heat
# generation and possible permanent damage to the circuit board or
# components.
#
# ==================================
# Hardware Configuration - HW v2.4.2
#
# PowerController i2c bus address jumpers
#  A2 A1 A0
#  0  0  0  0x20
#  0  0  1  0x21
#  0  1  0  0x22
#  0  1  1  0x23
#  1  0  0  0x24
#  1  0  1  0x25 
#  1  1  0  0x26
#  1  1  1  0x27 (default)
#
# Hardware I/O configuration
#
# GPIO Pin Layout - PCB and Breadboard
#
# GPIO-ID  PIN  IC-PIN  HW       BREADBOARD
# GPIOA0   0    21      -        RED
# GPIOA1   1    22      -        YEL
# GPIOA2   2    23      -        GREEN
# GPIOA3   3    24      ACSENSE  BLUE
# GPIOA4   4    25      -        -
# GPIOA5   5    26      PUMP1    -
# GPIOA6   6    27      VALVE2   -
# GPIOA7   7    28      VALVE4   -
# GPIOB0   8     1      VALVE5   RELAY
# GPIOB1   9     2      VALVE3   -
# GPIOB2   10    3      VALVE1   -
# GPIOB3   11    4      PUMP2    -
# GPIOB4   12    5      -        -
# GPIOB5   13    6      LINE0    -
# GPIOB6   14    7      LINE1    - 
# GPIOB7   15    8      LINE2    -
#
# example uses for external inputs
# line0 - water pressure sensor
# line1 - water flow sensor
# line2 - extra digital input
#
# =======
# History
# v2.7.0 2025/03/04
# - split into daemon and client to avoid running MCP23017 chip
#   initialization every client iteration which can lead to output
#   pins cycling off erroneously. commands can be sent to daemon by
#   any user that can write to the Unix socket.
# v2.6.1 2025/02/28
# - added locking to make simultaneous execution safe
# v2.4.3 2024/05/25
# - added retry logic for I2C bus communication errors
# - reduced code redundancy
# v2.4
# - updated for v2.4 hardware
# v1.0
# - initial release
# - Uses Adafruit libraries
#   https://docs.circuitpython.org/projects/mcp230xx/en/latest/api.html#adafruit_mcp230xx.digital_inout.DigitalInOut.value
# - need to install the libraries prior to using this script
#   sudo pip3 install adafruit-circuitpython-mcp230xx
#
# TODO:
# - convert linear code to functions
# - add optional pin configuration to accomodate prototyping
# - add sample interrupt handling to measure frequency

# -------
# imports
# -------

import os
import sys
import socket
import json
import time
import fcntl
import syslog
import board
import busio
import argparse
from datetime import datetime
from digitalio import Direction
from adafruit_mcp230xx.mcp23017 import MCP23017
import signal

# --------------------------
# constants and globals
# --------------------------

version = "2.7.0"
loglevel = 3
sendsyslog = 1  # future: enable foreground run for testing/debugging
socket_file = "/tmp/mcp-daemon.sock"

# Relay definitions: relay-name -> (index, pin-number)
relay_dict = {
    "farbed":  (0, 10),
    "nearbed": (1, 6),
    "mag":     (2, 9),
    "plants":  (3, 7),
    "valve5":  (4, 8),
    "pump1":   (5, 5),
    "pump2":   (6, 11)
}

# global MCP object; will be set once on startup
MCP = None

# --------------------------
# argument parsing
# --------------------------

def parse_arguments():
    parser = argparse.ArgumentParser(description="MCP Daemon Service")
    parser.add_argument(
        "--loglevel", "-l",
        type=int,
        default=3,
        help="Set log level (0=basic, 5=verbose)"
    )
    parser.add_argument(
        "--i2caddr", "-i",
        type=str,
        default="0x27",
        help="I2C address of the MCP in hex (0x27)"
    )
    return parser.parse_args()

# ----------------------------
# logging and helper functions
# ----------------------------

def openlog(ident=None, logopt=0, facility=syslog.LOG_USER):
    if ident is None:
        ident = os.path.basename(__file__)
    syslog.openlog(ident, logopt, facility)

openlog()

def log_message_json(message, level, severity):
    global loglevel
    if loglevel >= level:
        timestamp = datetime.now().isoformat()
        log_entry = {
            "timestamp": timestamp,
            "message": message,
            "level": level,
            "severity": severity
        }
        json_log = json.dumps(log_entry, separators=(',', ':'))
        # Remove newline characters for syslog
        json_log = json_log.replace('\n', ' ').replace('\r', '')
        if sendsyslog:
            syslog.syslog(json_log)
        print(json_log)

def translate_state(state):
    return "on" if state else "off"

def retry(operation, description, attempts=3, delay=0.1):
    for attempt in range(attempts):
        log_message_json(
            {"action": description, "retry attempt": attempt + 1},
            3,
            "info"
        )
        try:
            return operation()
        except Exception as e:
            if attempt < attempts - 1:
                log_message_json(
                    {"action": description, "result": f"exception on attempt {attempt + 1}"},
                    1,
                    "exception"
                )
                time.sleep(delay)
            else:
                raise e

# -----------------------------
# MCP and relay setup functions
# -----------------------------

def initialize_i2c():
    log_message_json({"action": "initializing I2C"}, 4, "info")
    return retry(lambda: busio.I2C(board.SCL, board.SDA), "initialize_i2c")

def initialize_mcp(i2c, address):
    log_message_json({"action": "initialize MCP connection"}, 4, "info")
    return retry(lambda: MCP23017(i2c, address=address), "initialize_mcp")

def setup_relay_pins(mcp):
    for relay_name, (index, pin_number) in relay_dict.items():
        log_message_json(
            {"action": "setup_relay_pins", "relay": relay_name, "pin number": pin_number},
            3,
            "info"
        )
        pin = mcp.get_pin(pin_number)
        # Replace the tuple with (index, pin object)
        relay_dict[relay_name] = (index, pin)
        retry(lambda: setattr(pin, 'direction', Direction.OUTPUT), f"set_pin {relay_name} output")

def perform_action_on_relay(relay_name, action):
    index, pin = relay_dict[relay_name]
    log_message_json({"function": "perform_action_on_relay", "relay": relay_name, "action": action}, 3, "info")
    if action == 'on':
        retry(lambda: setattr(pin, 'value', True), f"set_pin {relay_name} True")
    elif action == 'off':
        retry(lambda: setattr(pin, 'value', False), f"set_pin {relay_name} False")
    elif action == 'status':
        # simply read the pin
        pass
    status = pin.value
    result = {"relay": relay_name, "status": translate_state(status)}
    log_message_json({"result": result}, 0, "info")
    return result

def perform_all_action(action):
    result = {}
    for relay_name, (index, pin) in relay_dict.items():
        if action == 'off':
            retry(lambda: setattr(pin, 'value', False), f"set_pin {relay_name} False")
        # For 'status' we simply read the pin
        result[relay_name] = translate_state(pin.value)
    log_message_json({"action": "perform_all_action", "result": result}, 0, "info")
    return result

# ------------------------------------
# signal handler for graceful shutdown
# ------------------------------------

def signal_handler(sig, frame):
    log_message_json("Received termination signal; shutting down.", 2, "info")
    if os.path.exists(socket_file):
        os.unlink(socket_file)
    sys.exit(0)

signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)

# --------------------------
# daemon main loop
# --------------------------

def main():
    global MCP, loglevel

    # Parse command-line arguments to set the log level and I2C address
    args = parse_arguments()
    loglevel = args.loglevel
    i2caddr = int(args.i2caddr, 16)

    log_message_json({"action": "startup", "version": version, "i2caddress": f"0x{i2caddr:02X}"}, 5, "info")
    i2c = initialize_i2c()
    MCP = initialize_mcp(i2c, i2caddr)
    setup_relay_pins(MCP)

    # Remove stale socket file if it exists
    if os.path.exists(socket_file):
        os.unlink(socket_file)

    # Create Unix Domain Socket
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(socket_file)
    # Set appropriate permissions for the socket file (e.g., 0666)
    os.chmod(socket_file, 0o666)
    server.listen(5)
    log_message_json({"action": "daemon_listening", "socket": socket_file}, 2, "info")

    while True:
        try:
            conn, _ = server.accept()
            with conn:
                data = conn.recv(1024)
                if not data:
                    continue
                try:
                    request = json.loads(data.decode("utf-8"))
                    # Expected JSON keys: "relay", "action", and
                    # optionally "username"
                    relay = request.get("relay")
                    action = request.get("action")
                    #log_message_json(
                    #    {"received": request, "username": request.get("username", "unknown")},
                    #    3,
                    #    "info"
                    #)
                    log_message_json(
                        {
                            "received": request
                        },
                        3,
                        "info"
                    )
                    if relay == "all":
                        result = perform_all_action(action)
                    elif relay in relay_dict:
                        result = perform_action_on_relay(relay, action)
                    else:
                        result = {"error": "Invalid relay name"}
                except Exception as e:
                    result = {"error": str(e)}
                response = json.dumps(result).encode("utf-8")
                conn.sendall(response)
        except Exception as e:
            log_message_json({"error": str(e)}, 0, "exception")
            time.sleep(0.1)  # brief pause to avoid tight loop on error

if __name__ == '__main__':
    main()
