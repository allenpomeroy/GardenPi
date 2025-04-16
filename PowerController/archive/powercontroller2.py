#!/usr/bin/python3
#
# powercontroller2.py
#
# v2.4.5 2024/05/29
# - added 'concise' output option for status checks
#   will only return On or Off for relay in question
# v2.4.4 2024/05/26
# - updated debug logging
# v2.4.3 2024/05/25
# - added retry logic for I2C bus communication errors
# - reduced code redundancy
# v2.4
# - updated for v2.4 hardware
# v1.4
# - added status action to display status of specified relay
# v1.3
# - updated pinout mapping for hardware v2.4 relays and pumps
# - IMPORTANT cannot use earlier versions since GPIO pinouts completely changed in hardware v2.4
# - pre-release code .. it's ugly and incomplete with little to no error checking
# v1.2
# - added command line argument processing
# - added syslog output for auditing/monitoring
# v1.1
# - add read of pin value prior to set
# v1.0
# - initial release
# - Uses Adafruit libraries
#   https://docs.circuitpython.org/projects/mcp230xx/en/latest/api.html#adafruit_mcp230xx.digital_inout.DigitalInOut.value
# - need to install the libraries prior to using this script
#   sudo pip3 install adafruit-circuitpython-mcp230xx
#
#
# Control script for Allen Pomeroy PowerController hardware v2.4
# See pomeroy.us/2022/12/building-an-irrigation-power-controller/
# MCP23017 based I2C bus expansion board
# - 5x 24VAC valve relays
# - 2x 12VDC pump relay feeds
# - 3x 5v GPIO digital lines
# - AC Hz sensor
# 
# Turns pump and valve relays on or off.  No sample interrupt handling to measure frequency yet.
#
# Usage:
# powercontroller2.py -r {relay-name|all} -a {on|off} -q
# -r relayname
# -a action
# -s syslog
# -d debug level
# -c concise
#
# valve1, valve2, valve3, valve4, valve5, pump1, pump2, test
#
# Examples:
# ./powercontroller2.py -r test -a on
# ./powercontroller2.py -r valve1 -a on
# ./powercontroller2.py -r valve1 -a off
# ./powercontroller2.py -r all -a status
# 
# Optionally can specify "all" for relay name for "off" action.
# Can specify "test" "on" to run a loop through each relay activated
# sequentially TESTCOUNT times.
#

# 
# WARNING WARNING WARNING WARNING WARNING WARNING WARNING WARNING 
# It is recommended to only activate a maximum of two (2) valves and
# either or both pumps simultaneously to limit the aggregate current draw.
# Activating more valves simulaneously is likely to cause excessive heat
# generation and possible permanent damage to the circuit board or
# components.
#

# Copyright 2024 Allen Pomeroy - MIT license

# TODO:
# - convert linear code to functions
# - add optional pin configuration to accomodate prototyping

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
# GPIO Pin Layout - PCB and Breadboard - HW v2.4
#
# GPIO-ID  PIN  IC-PIN  HW      BREADBOARD
# GPIOA0   0    21      -       RED
# GPIOA1   1    22      -       YEL
# GPIOA2   2    23      -       GREEN
# GPIOA3   3    24      ACSENSE BLUE
# GPIOA4   4    25      -       -
# GPIOA5   5    26      PUMP1   -
# GPIOA6   6    27      VALVE2  -
# GPIOA7   7    28      VALVE4  -
# GPIOB0   8     1      VALVE5  RELAY
# GPIOB1   9     2      VALVE3  -
# GPIOB2   10    3      VALVE1  -
# GPIOB3   11    4      PUMP2   -
# GPIOB4   12    5      -       -
# GPIOB5   13    6      LINE0   -
# GPIOB6   14    7      LINE1   - 
# GPIOB7   15    8      LINE2   -
#
# GPIO_INTA acsense
#
# example uses for external inputs
# line0 - water pressure sensor
# line1 - water flow sensor
# line2 - extra digital input
#

# -------
# imports
# -------

import board
import busio
import time
import argparse
import syslog
from digitalio import Direction
from adafruit_mcp230xx.mcp23017 import MCP23017

# ---------
# constants
# ---------

version = "2.4.4"

# HW Version 2.4 PCB pins
PIN_MAP = {
    'farbed': 10,  # valve1
    'nearbed': 6,   # valve2
    'mag': 9,   # valve3
    'plants': 7,   # valve4
    'valve5': 8,   # valve5
    'pump1': 5,    # pump1
    'pump2': 11    # pump2
}

RELAY_MAP = {
    'farbed': 0,   # valve1
    'nearbed': 1,   # valve2
    'mag': 2,   # valve3
    'plants': 3,   # valve4
    'valve5': 4,   # valve5
    'pump1': 5,    # pump1
    'pump2': 6     # pump2
}

# -------------
# configuration via command line parameters
# -------------
#
# default constants defined in command line argument processing
# I2CADDR = 0x24 # A2=1, A1=0, A0=0
# TESTCOUNT = 3
# TESTONTIME = 1
# TESTOFFTIME = 0.1

parser = argparse.ArgumentParser()
parser.add_argument("-i", "--i2caddress", help="I2C address of the PowerController board", type=str, default='0x27')
parser.add_argument("-t", "--testcount", help="Number of test cycles", type=int, default='1')
parser.add_argument("-o", "--testontime", help="On time for tests (sec)", type=float, default='10')
parser.add_argument("-s", "--syslog", help="Send syslog status messages", action="store_true")
parser.add_argument("-c", "--concise", help="Only output concise status messages", action="store_true")
parser.add_argument("-f", "--testofftime", help="Off time for tests (sec)", type=float, default='10')
parser.add_argument("-d", "--debug", help="Set debug level 0=none 5=max", type=int, default=0)
parser.add_argument("-r", "--relay", type=str, required=True, choices=list(PIN_MAP.keys()) + ['test', 'all'], help="Name of relay to operate on")
parser.add_argument("-a", "--action", type=str, required=True, choices=['on', 'off', 'status'], help="Action to perform on relay. Note relay 'all' can only accept action 'off'")

args = parser.parse_args()
debug = args.debug
testcount = args.testcount
testontime = args.testontime
testofftime = args.testofftime
sendsyslog = args.syslog
i2caddr = int(args.i2caddress, 16)
relay = args.relay
action = args.action
concise = args.concise


# translate state
def translate_state(state):
    if state == True:
        return("On")
    elif state == False:
        return("Off")

# display messages
def log_message(message, level):
    if debug >= level:
        if sendsyslog:
            syslog.syslog(message)
        print(message)

#
def handle_error(error_message, error_code):
    print(error_message)
    exit(error_code)

#
def retry(operation, description, attempts=3, delay=0.1):
    for attempt in range(attempts):
        log_message(f"Attempt {attempt + 1} operation {description}",2)
        try:
            return operation()
        except Exception as e:
            if attempt < attempts - 1:
                log_message("Error .. retrying", 0)
                time.sleep(delay)
            else:
                raise e

# setup i2c handle and access
def initialize_i2c():
    log_message("Initializing I2C", 1)
    return retry(lambda: busio.I2C(board.SCL, board.SDA), "initialize_i2c")

# create MCP connection
def initialize_mcp(i2c, address):
    log_message("Create MCP connection", 1)
    return retry(lambda: MCP23017(i2c, address=address), "initialize_mcp")

# set all the valve and pump pins to output
def setup_relay_pins(mcp):
    relay_pins = []
    for pin_name in PIN_MAP:
        pin = retry(lambda: mcp.get_pin(PIN_MAP[pin_name]), f"get_pin {pin_name}")
        retry(lambda: setattr(pin, 'direction', Direction.OUTPUT), f"get_pin {pin_name}")
        relay_pins.append(pin)
    return relay_pins
    # set all the port B line pins to input, with pullups
    #for pin in port_b_pins:
    #    pin.direction = Direction.INPUT
    #    pin.pull = Pull.UP


def perform_action_on_relay(relay, action, relay_pins):
    #pin0.value = True  # GPIO0 / GPIOA0 to high logic level
    #pin0.value = False # GPIO0 / GPIOA0 to low logic level
    relay_index = RELAY_MAP[relay]
    try:
        log_message("Relay: " + str(relay) + " Action: " + str(action), 1)
        if action == 'on':
            relay_pins[relay_index].value = True
            status = relay_pins[relay_index].value
        elif action == 'off':
            relay_pins[relay_index].value = False
            status = relay_pins[relay_index].value
        elif action == 'status':
            status = relay_pins[relay_index].value
        if concise:
            log_message(translate_state(status), 0)
        else:
            log_message("relay " + str(relay) + " state " + translate_state(status), 0)
    except Exception as e:
        log_message(f"Failed to perform action {action} on relay {relay}: {str(e)}", 0)
        handle_error(f"Relay action error on {relay}", 400 + relay_index)

def perform_all_action(action, relay_pins):
    if action == 'off':
        log_message("executing all off", 0)
        for pin in relay_pins:
            pin.value = False
    elif action == 'status':
        for relay, index in RELAY_MAP.items():
            log_message(str(relay) + " status " + translate_state(relay_pins[index].value), 0)

def perform_test_action(testcount, testontime, testofftime, relay_pins):
    for i in range(testcount):
        for p in range(len(relay_pins)):
            log_message(f"cycle {i} pin{p} on", 0)
            relay_pins[p].value = True
            time.sleep(testontime)
            log_message(f"cycle {i} pin{p} off", 0)
            relay_pins[p].value = False
            time.sleep(testofftime)

log_message(f"Version {version}", 1)
log_message(f"Initializing I2C at 0x{i2caddr:02X}", 1)

i2c = initialize_i2c()
mcp = initialize_mcp(i2c, i2caddr)
relay_pins = setup_relay_pins(mcp)

log_message("Performing action " + action + " relay " + str(relay), 2)
if relay == 'all':
    perform_all_action(action, relay_pins)
elif relay == 'test' and action == 'on':
    perform_test_action(testcount, testontime, testofftime, relay_pins)
else:
    perform_action_on_relay(relay, action, relay_pins)
