#!/bin/bash
#
# install-adc-daemon.sh
#
# v1.0 2025/04/16
# - initial version
#
# Installation:
sudo cp adc-daemon.py /opt/garden/bin || exit 1
sudo chown root: /opt/garden/bin/adc-daemon.py || exit 1
sudo chmod 750   /opt/garden/bin/adc-daemon.py || exit 1
#
sudo cp adc-daemon.service /etc/systemd/system || exit 1
sudo chown root: /etc/systemd/system/adc-daemon.service || exit 1
sudo chmod 644   /etc/systemd/system/adc-daemon.service || exit 1
sudo systemctl daemon-reload || exit 1
sudo systemctl enable adc-daemon --now || exit 1
