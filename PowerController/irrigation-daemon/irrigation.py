#!/opt/garden/python3/bin/python3
#
# irrigation.py
#
# Client control script for Allen Pomeroy PowerController hardware v2.4.2
# See pomeroy.us/2022/12/building-an-irrigation-power-controller/
# MCP23017 based I2C bus expansion board
# - 5x 24VAC valve relays
# - 2x 12VDC pump relay feeds
# - 3x 5v GPIO digital lines
# - AC Hz sensor
# 
# Turns pump and valve relays on or off.
#
# Copyright 2025 Allen Pomeroy - MIT license
#
# =====
# Usage
#
# irrigation.py -r {relay-name|all} -a {on|off|status}
# -r relayname
# -a action
# -l log level
#
# valve1, valve2, valve3, valve4, valve5, pump1, pump2
#
# Examples:
# ./irrigation.py -r valve1 -a on
# ./irrigation.py -r valve1 -a off
# ./irrigation.py -r all -a status
# ./irrigation.py -r all -a off
#
# Example Output:
# {'relay': 'mag', 'status': 'off'}
# {'farbed': 'off', 'nearbed': 'off', 'mag': 'off', 'plants': 'off', 'valve5': 'off', 'pump1': 'off', 'pump2': 'off'}

# 
# Optionally can specify "all" for relay name for "off" action.
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
# =======
# History
# v2.7.0 2025/03/04
# - converted to daemon and client script to avoid
#   each client run performing MCP initialization.
#   now mcp-daemon.py runs as a systemd service 
#   and irrigation.py is simply a  client that reads
#   and writes to Unix socket that daemon listens
#   to for commands and returns command output
#
# TODO:
# - convert linear code to functions
# - add optional pin configuration to accomodate prototyping
# - add sample interrupt handling to measure frequency
#

# -------
# imports
# -------

import time
import argparse
import fcntl
from datetime import datetime
import json
import os
import socket
import getpass

# ---------
# constants and globals
# ---------

version = "2.7.0"
loglevel = 0
script_name = os.path.basename(__file__)
socket_file = "/tmp/irrigation-daemon.sock"

# HW Version 2.4.2 PCB pins
# relay-name, index, pin-number
# - during run time, pin numbers will be updated to MCP23017 pin objects
relay_dict = {
    "farbed":  (0, 10),
    "nearbed": (1, 6),
    "mag":     (2, 9),
    "plants":  (3, 7),
    "valve5":  (4, 8),
    "pump1":   (5, 5),
    "pump2":   (6, 11)
}

# ---------------------------
# Atomic Lock Context Manager
# ---------------------------

class MCPAtomicAccess:
    """
    Context manager that acquires an exclusive file lock to ensure
    that the MCP access portion of the script is not run concurrently.
    
    The lock is obtained when entering the context and released when exiting.
    """
    def __init__(self, lock_file="/tmp/irrigation_client_lockfile.lock"):
        self.lock_file = lock_file
        self.fp = None

    def __enter__(self):
        log_message_json(f"Attempting to acquire lock on {self.lock_file}", 3, "info")
        self.fp = open(self.lock_file, "w")
        fcntl.flock(self.fp, fcntl.LOCK_EX)
        log_message_json(f"Lock acquired on {self.lock_file}", 3, "info")
        return self.fp

    def __exit__(self, exc_type, exc_val, exc_tb):
        log_message_json(f"Lock released on {self.lock_file}", 3, "info")
        fcntl.flock(self.fp, fcntl.LOCK_UN)
        self.fp.close()


# ---------------------------
# Logging and Helper Functions
# ---------------------------

#def openlog(ident=None, logopt=0, facility=syslog.LOG_USER):
#    if ident is None:
#        ident = os.path.basename(__file__)
#    syslog.openlog(ident, logopt, facility)
#
#openlog()


def log_message_json(message, level, severity):
    """
    Logs a message using JSON formatting
    """
    if loglevel >= level:
        timestamp = datetime.now().isoformat()
        log_entry = {
            "timestamp": timestamp,
            "message": message,
            "level": level,
            "severity": severity
        }
        json_log = json.dumps(log_entry, separators=(',', ':'))
        json_log = json_log.replace('\n', ' ').replace('\r', '')
        #if sendsyslog:
        #    syslog.syslog(json_log)
        #else:
        #    print(json_log)
        print(json_log)


def handle_error(error_message, error_code):
    print(error_message)
    exit(error_code)



# ---------------------
# Updated Argument Parsing
# ---------------------

class CustomArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        error_message = {"action": "parse args", "result": "error", "error": message}
        log_message_json(error_message, 0, "error")
        self.print_help()
        self.exit(2)


def parse_arguments():
    parser = CustomArgumentParser()
    #parser.add_argument("-s", "--no-syslog",
    #                    help="Do not send syslog status messages",
    #                    action="store_false", default=True, dest="syslog")
    parser.add_argument("-l", "--loglevel",
                        help="Set log level 0=none 5=max",
                        type=int, default=0)
    parser.add_argument("-r", "--relay",
                        type=str, required=True,
                        choices=list(relay_dict.keys()) + ['all'],
                        help="Name of relay to operate on")
    parser.add_argument("-a", "--action",
                        type=str, required=True,
                        choices=['on', 'off', 'status'],
                        help="Action to perform on relay. Note relay 'all' can only accept actions 'off' or 'status'")
    return parser.parse_args()


# ---------------------
# Main Execution
# ---------------------

if __name__ == '__main__':
    # Parse arguments and print startup messages before obtaining the lock.
    args = parse_arguments()
    username = getpass.getuser()
    loglevel = args.loglevel
    relay = args.relay
    action = args.action

    log_message_json({"action": "startup", "version": version}, 5, "info")

    # obtain the lock for the critical MCP access section.
    with MCPAtomicAccess():
        command = {"relay": args.relay, "action": args.action, "username": username}
        try:
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.connect(socket_file)
            client.sendall(json.dumps(command).encode("utf-8"))
            #response = client.recv(1024)
            #print(json.loads(response.decode("utf-8")))
            response = client.recv(1024)
            decoded_response = response.decode("utf-8")
            parsed_json = json.loads(decoded_response)
            formatted_json = json.dumps(parsed_json, ensure_ascii=False)
            print(formatted_json)

        except Exception as e:
            print({"error": str(e)})
        finally:
            client.close()
