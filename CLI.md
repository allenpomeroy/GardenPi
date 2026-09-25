# GardenPi Command Line Interface Reference

## Command Line Utilities

Must be at command line, using `pi` user, on the Raspberry Pi.  CLI tools call the
expected socket for each handler.  Likely hardcoded, does not yet read the 
`/opt/gardenpi/config/garden.json` config file for the socket paths.

Users are encouraged to use the GardenPi Web UI instead.

## ADC on PiController

Intended to provide single point of direct contact for the MCP3008 ADC chip used in my PiController expansion boards.
Client program  adc.py  communicates with handler to ask for voltage reading on any channel

**Usage**

    adc.py {channel} --loop

   channel must be 0-7 or "all"
   --loop (-l) will display the requested channel(s) continuously

## Irrigation PowerController

`irrigation.py`

**Usage**

    irrigation.py -r valve1 -a on
    irrigation.py -r valve1 -a off
    irrigation.py -r valve1 -a status
    irrigation.py -r all -a status

**Output**

    {"relay": "valve1", "status": "on"}
    {"relay": "valve1", "status": "off"}
    {"relay": "valve1", "status": "off"}
    {"valve1": "off", "nearbed": "off", "mag": "off", "plants": "off", "valve5": "off", "pump1": "off", "pump2": "off"}

## System Status LEDs on PiController

Intended to provide single point of direct contact for the expansion MCP23017 chip used in my PiController expansion boards.
Client program  leds.py  communicates with handler to ask for LED status and send control commands.

**Usage**

    leds.py status {led-label}
    leds.py {led-label} {command} 

LED labels - you can use hardware labels below or any alias

    sysred sysgreen sysblue
    led1red led1green led1blue
    led2red led2green led2blue

LED commands

    on
    off
    blink {count}
    fastblink
    flash <colors> <duration>

Examples

  leds.py sysblue on
  leds.py sensorerr on  (alias for led1red)
  leds.py led2blue blink 5
  leds.py led2blue fastblink
  leds.py led1 red-blue flash 10s
  leds.py led2red patternblink 4
  leds.py led1red off
  leds.py status          # Get status of ALL LEDs
  leds.py status led1red  # Get status of a single LED
