#!/bin/bash
#
# install-irrigation-daemon.sh 
#
# v1.0 2025/04/16
# - initial version
#
# Installation:
sudo cp irrigation-daemon.py /opt/garden/bin || exit 1
sudo chown root: /opt/garden/bin/irrigation-daemon.py || exit 1
sudo chmod 750   /opt/garden/bin/irrigation-daemon.py || exit 1
#
sudo cp irrigation-daemon.service /etc/systemd/system || exit 1
sudo chown root: /etc/systemd/system/irrigation-daemon.service || exit 1
sudo chmod 644   /etc/systemd/system/irrigation-daemon.service || exit 1
sudo systemctl daemon-reload || exit 1
sudo systemctl enable irrigation-daemon --now || exit 1
