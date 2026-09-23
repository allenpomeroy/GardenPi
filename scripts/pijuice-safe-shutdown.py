#!/usr/bin/python3

import os
import time
from pijuice import PiJuice

# Initialize PiJuice
pj = PiJuice(1, 0x14)

# 1. Set the Wake Up on Charge percentage (Note the capital 'U')
pj.power.SetWakeUpOnCharge(5)

# 2. Tell PiJuice to cut the 5V power rail to the Pi in 60 seconds
pj.power.SetPowerOff(60)

# 3. Issue the clean OS shutdown command immediately
os.system("sudo shutdown -h now")

