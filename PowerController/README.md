# PowerController
Power controller for Garden irrigation project. See https://ogg.pomeroy.us/2022/12/building-an-irrigation-power-controller

Uses the MCP23017 GPIO expansion chip with integrated I2C and the Adafruit MCP23017 python libraries
https://docs.circuitpython.org/projects/mcp230xx/en/latest/api.html#adafruit_mcp230xx.digital_inout.DigitalInOut.value

Need to install the Adafruit libraries "sudo pip3 install adafruit-circuitpython-mcp230xx"

Provides:
- five (5) 24VAC feeds for common irrigation control valves similar to RainBird model
- two (2)  12VDC feeds to drive external 120VAC relays which control pumps

WARNING
It is recommended to only activate a maximum of two (2) valves and either or both pumps simultaneously to limit the aggregate current draw.
Activating more valves simulaneously is likely to cause excessive heat generation and possible permanent damage to the circuit board or components.

**Updated!**

Split the PowerController 2.4.2 hardware control script into two parts - daemon which listens on a socket and client which issues commands to the socket, returning the result.

**Installation**

    sudo cp mcp-daemon.py /usr/local/bin
    sudo chown root: /usr/local/bin/mcp-daemon.py
    sudo chmod 750   /usr/local/bin/mcp-daemon.py
    sudo cp mcp-daemon.service /etc/systemd/system
    sudo chown root: /etc/systemd/system/mcp-daemon.service
    sudo chmod 644   /etc/systemd/system/mcp-daemon.service
    sudo systemctl daemon-reload
    sudo systemctl enable mcp-daemon --now

**Usage**

    irrigation-controller.py -r valve1 -a on
    irrigation-controller.py -r valve1 -a off
    irrigation-controller.py -r valve1 -a status
    irrigation-controller.py -r all -a status

**Output**

    {"relay": "valve1", "status": "on"}
    {"relay": "valve1", "status": "off"}
    {"relay": "valve1", "status": "off"}
    {"valve1": "off", "nearbed": "off", "mag": "off", "plants": "off", "valve5": "off", "pump1": "off", "pump2": "off"}

