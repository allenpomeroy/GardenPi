#!/opt/garden/python3/bin/python3
#
# adc.py
#
# Queries PiController ADC Daemon for voltage level
# on any or all of the 8 channels.  Daemon does not
# distinguish between channel functions, adc.py
# client is responsible for displaying headers that
# align to the PiController hardware version being
# queried.
#
# Usage:
#  adc.py {channel} --loop --hwversion --verbose
#   channel must be 0-7 or "all"
#   --loop (-l) will display the requested channel(s)
#          continuously
#   --hwversion {2.2, 5.1, 7.1} controls the header
#               displayed to correspond with each
#               PCB channel layout
#
# v1.0 2025/04/16
# - initial version
#
# PiController PCB
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

# imports
import argparse
import socket
import sys
import time
import array as arr
import colorama
from colorama import Fore, Style

# globals
version = "1.0"
socket_path = "/tmp/adc-daemon.sock"

def get_adc_voltage(channel):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.connect(socket_path)
            sock.sendall(str(channel).encode('ascii'))
            response = sock.recv(1024).decode('ascii').strip()
            if response.startswith("ERROR"):
                raise RuntimeError(response)
            return float(response)
    except Exception as e:
        print(f"Communication error: {str(e)}")
        return None

def printheader(hwversion):
    if hwversion == "2.2":
        print("Day\tWind\tMag\tCh3\tCh4\tCh5\tCh6\t9VFail")
    elif hwversion == "5.1":
        print("Mag\tM2\tM3\tDay\tWind\tPwr5\tPress\tMisc")
    elif hwversion == "7.1":
        print("Day\tPwr5\tPress\tMisc\tMag\tM2\tM3\tWind")


def printvalue(last: float,current: float):
    delta = current - last
    if current > 0:
      gap = delta / current * 100.0
    else:
      gap = 0

    if gap > 10.0:
        print(Fore.GREEN + '{:.4f}'.format(round(current, 4)), '\t', end='', flush=True)
        print(Style.RESET_ALL, end='', flush=True)
    else:
        print('{:.4f}'.format(round(current, 4)), '\t', end='', flush=True)


def read_and_print():
    for ch in channels:
        voltage = get_adc_voltage(ch)
        if voltage is not None:
            if args.verbose:
                print(f"[VERBOSE] Read from channel {ch}: {voltage:.4f} V")
            else:
                print(f"Channel {ch} voltage: {voltage:.4f} V")
        else:
            print(f"Error reading channel {ch}")


def main():
    parser = argparse.ArgumentParser(description='Read ADC value from a specified channel')
    parser.add_argument(
        'channel',
        help='ADC channel number (0-7) or "all"',
    )
    parser.add_argument('--verbose', '-v', action='store_true', help='Enable verbose output')
    parser.add_argument('--loop', '-l', action='store_true', help='Continuously read values in a loop')
    parser.add_argument(
        '--hwversion', '-p',
        type=str, default='5.1',
        choices=["2.2","5.1","7.1"],
        help='PCB version (2.2, 5.1, or 7.1)'
    )

    args = parser.parse_args()
    hwversion = args.hwversion
    verbose = args.verbose

    if verbose:
        print(Fore.GREEN + "ADC Display")
        print(Style.RESET_ALL)


    # Validate channel argument
    if args.channel == 'all':
        channels = list(range(8))
    else:
        try:
            channel_num = int(args.channel)
            if not 0 <= channel_num <= 7:
                raise ValueError
            channels = [channel_num]
        except ValueError:
            print("Error: Channel must be 0-7 or 'all'.")
            sys.exit(1)

    if args.loop:

        linecount = 0
        lastreading = arr.array('d',[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
        thisreading = arr.array('d',[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])

        try:
            while True:

                if (linecount % 20) == 0 and args.channel == "all":
                    printheader(hwversion)
            
                # cycle through all selected channels
                for current_channel in channels:
                    # get channel voltage from daemon
                    thisreading[current_channel] = get_adc_voltage(current_channel)
                    # display value
                    printvalue(lastreading[current_channel],thisreading[current_channel])
                    # update last value
                    lastreading[current_channel] = thisreading[current_channel]

                # terminate line and inc line count
                print("")
                linecount+=1
                time.sleep(1)

        except KeyboardInterrupt:
            print("\nExiting loop.")
    else:
        # display value for selected channel(s)
        for ch in channels:
            # get voltage
            voltage = get_adc_voltage(ch)
            if voltage is not None:
                if args.verbose:
                    print(f"Channel {ch} voltage: {voltage:.4f} V")
                else:
                    print(f"{voltage:.4f}")
            else:
                print(f"Error reading channel {ch}")

if __name__ == "__main__":
    main()
