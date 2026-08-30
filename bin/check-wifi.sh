#!/bin/bash
#
# check-wifi.sh
#
# v1.8 2025/08/26
# - moved to consolidated /opt/gardenpi
# v1.7 2025/06/25
# - change led control to leds.py
# v1.5 2025/05/23
# - change led-control.py syntax
# v1.4 2025/05/22
# - add etc directory
# v1.3 2025/05/10
# - update for PiController V7.1
# v1.2 2023/07/10
#

dest1="10.20.31.100"
export PATH=$PATH:/opt/gardenpi/bin
BINDIR=/opt/gardenpi/bin
failflag="/tmp/wifi-check-failed"
faildelay=5
successflag="/tmp/wifi-check-succeeded"
ledscript="leds.py"

# test connection to dest1
ping -c 1 $dest1 >/dev/null 2>&1
if [ $? -ne 0 ]; then
  # ping failed
  # delay $faildelay seconds and retry
  sleep $faildelay
  ping -c 1 $dest1 >/dev/null 2>&1
  if [ $? -ne 0 ]; then
    # ping failed again
    if [ ! -r $failflag ]; then
      # flag error if we haven't already
      $BINDIR/$ledscript  boot on
      logger "wifi check to $dest1 failed"
      touch $failflag
      rm -f $successflag 2>/dev/null
    fi
  else
    # second ping worked
    rm -f $failflag 2>/dev/null
    touch $successflag
    logger "wifi check to $dest1 succeeded"
    $BINDIR/$ledscript  wifi on
  fi
else
  # ping success

  # if there is a failflag, reset it
  if [ -r $failflag ]; then
    rm -f $failflag
  fi

  # update or create success flag
  touch $successflag

  # log success status
  logger "wifi check to $dest1 succeeded"
  $BINDIR/$ledscript  wifi on

fi
