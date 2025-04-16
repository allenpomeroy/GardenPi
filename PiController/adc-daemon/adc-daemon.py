#!/opt/garden/python3/bin/python3
#
# adc-daemon.py
#
# Control daemon for Allen Pomeroy PiController hardware v7.1.1 ADC
# analog inputs (temperature, moisture, water pressure, daylight)
#
# See pomeroy.us/202x/xx/building-a-garden-controller/
# that uses both MCP3008 ADC and MCP23017 based I2C bus expansion
# - 9x LED (3x RGB) outputs
# - 4x button switch inputs
# - 3x PIV motion sensor inputs
# - Break out of Raspberry GPIO lines
# - Si7021 I2C sensors internal to enclosure and external
# 
# Returns ADC value for input channel based on channel number
# received at socket typically sent by client script.
#
# Copyright 2025 Allen Pomeroy - MIT license
#
# =====
# Usage
#
# Installation:
#  sudo cp adc-daemon.py /opt/garden/bin
#  sudo chown root: /opt/garden/bin/adc-daemon.py
#  sudo chmod 750   /opt/garden/bin/adc-daemon.py
# 
#  sudo cp adc-daemon.service /etc/systemd/system
#  sudo chown root: /etc/systemd/system/adc-daemon.service
#  sudo chmod 644   /etc/systemd/system/adc-daemon.service
#  sudo systemctl daemon-reload
#  sudo systemctl enable adc-daemon --now
#
# Command line options:
# adc-daemon.py -l {0-5}
# -l log level    -l 5
#
# Command Format:
# Valid channel name:
# 0, 1, 2, 3, 4, 5, 6, 7
#
# Logging levels
# 0 normal and error messages
# 1 exception messages
# 2 function info
# 3 function detail
# 4 function verbose
# 5 general info
#
# ===============================================
# Hardware Configuration - PiController PCBs
#
# ADC I/O configuration
#
#      V2.2          V5.1        V7.1
# CS   26            26          25
# Ch0  DAYLIGHT1     MOIST1      DAYLIGHT1
# Ch1  WINDDIR1      MOIST1      PWRCTRL5V
# Ch2  MOIST1        MOIST1      PRESSURE
# Ch3                DAYLIGHT1   MISC5V
# Ch4                WINDDIR1    MOIST1
# Ch5                PWRCTRL5V   MOIST2
# Ch6                PRESSURE    MOIST3
# Ch7  9VFAILDETECT  MISC5V      WINDDIR1

# =======
# History
# v1.0.0 2025/04/15
# - initial version based on irrigation-daemon.py
#   installed at /opt/garden/bin
#   uses /opt/garden/python3
# - need to install the libraries prior to using this script
#   sudo /opt/garden/python3/bin/pip3 install adafruit-circuitpython-mcp230xx
#   sudo /opt/garden/python3/bin/pip3 install adafruit-circuitpython-mcp3xxx
#
# TODO:
# - convert linear code to functions
# - add optional pin configuration to accomodate prototyping
# - add sample interrupt handling to measure frequency

import os
import sys
import socket
import json
import time
import syslog
import board
import busio
import argparse
from datetime import datetime
import digitalio
import signal
import adafruit_mcp3xxx.mcp3008 as MCP
from adafruit_mcp3xxx.analog_in import AnalogIn

# --------------------------
# constants and globals
# --------------------------

version = "1.0.0"
loglevel = 3
socket_file = "/tmp/adc-daemon.sock"

# Global ADC objects
channels = []

# --------------------------
# argument parsing
# --------------------------

def parse_arguments():
    parser = argparse.ArgumentParser(description="ADC Daemon Service")
    parser.add_argument(
        "--loglevel", "-l",
        type=int,
        default=3,
        help="Set log level (0=basic, 5=verbose)"
    )
    parser.add_argument(
        '--hwversion',
        '-p',
        type=str,
        required=True,
        choices=['2.2', '5.1', '7.1'],
        default='7.1',
        help='PCB version (2.2, 5.1, or 7.1)')
    return parser.parse_args()

# ----------------------------
# logging functions
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
        json_log = json_log.replace('\n', ' ').replace('\r', '')
        syslog.syslog(json_log)
        print(json_log)

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
    global loglevel, channels

    args = parse_arguments()
    loglevel = args.loglevel
    hwversion = args.hwversion

    # Set CS pin based on hardware version
    if hwversion in ["2.2", "5.1"]:
        adccs = digitalio.DigitalInOut(board.D26)
    elif hwversion == "7.1":
        adccs = digitalio.DigitalInOut(board.D25)

    log_message_json(f"Starting ADC daemon for hardware version {hwversion}", 2, "info")

    try:
        # Create SPI bus
        spi = busio.SPI(clock=board.SCK, MISO=board.MISO, MOSI=board.MOSI)
        
        # Initialize MCP3008 ADC
        mcp = MCP.MCP3008(spi, adccs)
        
        # Create analog input channels 0-7
        channels = [
            AnalogIn(mcp, MCP.P0),
            AnalogIn(mcp, MCP.P1),
            AnalogIn(mcp, MCP.P2),
            AnalogIn(mcp, MCP.P3),
            AnalogIn(mcp, MCP.P4),
            AnalogIn(mcp, MCP.P5),
            AnalogIn(mcp, MCP.P6),
            AnalogIn(mcp, MCP.P7)
        ]
        log_message_json("ADC channels initialized successfully", 3, "info")

    except Exception as e:
        log_message_json({"error": str(e)}, 0, "exception")
        exit(1)

    # Cleanup previous socket file
    if os.path.exists(socket_file):
        os.unlink(socket_file)

    # Create Unix Domain Socket
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(socket_file)
    os.chmod(socket_file, 0o666)
    server.listen(5)
    log_message_json(f"Listening on socket {socket_file}", 2, "info")

    while True:
        try:
            conn, _ = server.accept()
            with conn:
                data = conn.recv(1024)
                if not data:
                    continue
                
                try:
                    channel_str = data.decode('utf-8').strip()
                    channel = int(channel_str)
                    log_message_json(f"Received request for channel {channel}", 3, "info")
                    
                    if 0 <= channel <= 7:
                        voltage = channels[channel].voltage
                        response = f"{voltage:.4f}"
                        log_message_json(f"Channel {channel} voltage: {response}V", 3, "info")
                    else:
                        response = "ERROR: Channel must be 0-7"
                        
                except ValueError:
                    response = "ERROR: Invalid channel format"
                except Exception as e:
                    response = f"ERROR: {str(e)}"
                
                conn.sendall(response.encode('utf-8'))
                
        except Exception as e:
            log_message_json({"error": str(e)}, 0, "exception")
            time.sleep(0.1)

if __name__ == '__main__':
    main()
