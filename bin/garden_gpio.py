# garden_gpio.py
#
# Shared raw-GPIO-pin access for the GardenPi handlers.
#
# v1.1 2026/08/27
# - fixed: adc-handler.py crashed at startup with "'GpioOutputPin' object
#   has no attribute 'switch_to_output'" (a fatal error, not a warning -
#   the handler exited immediately every time). Root cause: adafruit_
#   mcp3xxx.mcp3008.MCP3008 hands its chip-select pin to
#   adafruit_bus_device.spi_device.SPIDevice, which expects a full
#   digitalio.DigitalInOut-compatible object and unconditionally calls
#   `chip_select.switch_to_output(value=True)` in its own constructor -
#   GpioOutputPin only implemented `.value`/`.write()`, not that method.
#   Added switch_to_output()/switch_to_input()/direction to GpioOutputPin
#   to satisfy that contract. (`.value` get/set, used per-transaction by
#   SPIDevice.__enter__/__exit__ to assert/deassert CS, was already
#   correct - only the one-time constructor call was missing.)
#
# v1.0 2026/08/27
# - initial version. Replaces RPi.GPIO (weather-handler.py) and Blinka's
#   digitalio pin control (adc-handler.py's SPI chip-select pin) with
#   lgpio, since this is now a multi-process environment: several handler
#   processes each own different physical pins, and lgpio's gpiochip
#   character-device model claims/releases individual pins through the
#   kernel rather than RPi.GPIO's whole-chip, single-owner-in-practice
#   approach - so one handler's pin access can't interfere with another's.
#   Falls back to pigpio (talking to the system pigpiod daemon) if lgpio
#   isn't installed, since either library is acceptable for this purpose.
#
#   Note: I2C (busio.I2C / smbus2) and hardware SPI (busio.SPI) are NOT
#   changed here - the kernel already arbitrates access to those bus
#   character devices per-transaction, so multiple handler processes
#   sharing an I2C/SPI bus was never the same class of problem as two
#   processes fighting over a bit-banged GPIO pin.
#
# Copyright 2025-2026 Allen Pomeroy - MIT license

import logging

log = logging.getLogger(__name__)

_BACKEND = None
_lgpio = None
_pigpio = None

try:
    import lgpio as _lgpio
    _BACKEND = "lgpio"
except ImportError:
    try:
        import pigpio as _pigpio
        _BACKEND = "pigpio"
    except ImportError:
        _BACKEND = None


class GpioError(Exception):
    """Raised on GPIO backend/initialization/pin-claim failures."""


def backend_name():
    """Which GPIO backend is active ("lgpio", "pigpio"), or None if
    neither is installed."""
    return _BACKEND


EDGE_RISING = "rising"
EDGE_FALLING = "falling"
EDGE_BOTH = "both"


class GpioChip:
    """
    A single open handle to a GPIO chip (normally gpiochip0 on a
    Raspberry Pi), shared by every pin this process claims. Each handler
    process opens its own GpioChip - lgpio/pigpio arbitrate concurrent
    per-pin claims from separate processes at the kernel/daemon level, so
    two handlers can safely own different pins on the same chip.
    """

    def __init__(self, chip=0):
        if _BACKEND is None:
            raise GpioError(
                "No GPIO backend available - install 'lgpio' (preferred) or "
                "'pigpio' (requires pigpiod running). RPi.GPIO is no longer "
                "supported in this multi-process release."
            )
        self.chip = chip
        self._handle = None
        self._callbacks = []  # keep references alive (lgpio/pigpio)
        if _BACKEND == "lgpio":
            self._handle = _lgpio.gpiochip_open(chip)
        else:  # pigpio
            self._handle = _pigpio.pi()
            if not self._handle.connected:
                raise GpioError(
                    "Could not connect to pigpiod - is the pigpiod service running?"
                )

    def claim_output(self, pin, initial=0):
        """Claim `pin` as an output, driven to `initial` (0/1)."""
        if _BACKEND == "lgpio":
            _lgpio.gpio_claim_output(self._handle, pin, initial)
        else:
            self._handle.set_mode(pin, _pigpio.OUTPUT)
            self._handle.write(pin, initial)
        return GpioOutputPin(self, pin)

    def claim_input(self, pin, pull_up=True):
        """Claim `pin` as an input, with pull-up (default) or none."""
        if _BACKEND == "lgpio":
            flags = _lgpio.SET_PULL_UP if pull_up else 0
            _lgpio.gpio_claim_input(self._handle, pin, flags)
        else:
            self._handle.set_mode(pin, _pigpio.INPUT)
            if pull_up:
                self._handle.set_pull_up_down(pin, _pigpio.PUD_UP)
        return GpioInputPin(self, pin)

    def claim_alert(self, pin, callback, edge=EDGE_FALLING, pull_up=True,
                     debounce_us=0):
        """
        Claim `pin` as an input and invoke callback(pin, level, tick) on
        every matching edge. `edge` is one of EDGE_RISING/EDGE_FALLING/
        EDGE_BOTH. Returns the GpioInputPin (keep a reference for the
        life of the callback).
        """
        input_pin = self.claim_input(pin, pull_up=pull_up)
        if _BACKEND == "lgpio":
            edge_map = {
                EDGE_RISING: _lgpio.RISING_EDGE,
                EDGE_FALLING: _lgpio.FALLING_EDGE,
                EDGE_BOTH: _lgpio.BOTH_EDGES,
            }
            if debounce_us:
                _lgpio.gpio_set_debounce_micros(self._handle, pin, debounce_us)
            cb = _lgpio.callback(self._handle, pin, edge_map[edge], callback)
        else:
            edge_map = {
                EDGE_RISING: _pigpio.RISING_EDGE,
                EDGE_FALLING: _pigpio.FALLING_EDGE,
                EDGE_BOTH: _pigpio.EITHER_EDGE,
            }
            if debounce_us:
                self._handle.set_glitch_filter(pin, debounce_us)
            cb = self._handle.callback(pin, edge_map[edge], callback)
        self._callbacks.append(cb)
        return input_pin

    def close(self):
        for cb in self._callbacks:
            try:
                cb.cancel()
            except Exception:
                pass
        self._callbacks = []
        if self._handle is None:
            return
        try:
            if _BACKEND == "lgpio":
                _lgpio.gpiochip_close(self._handle)
            else:
                self._handle.stop()
        except Exception as e:
            log.warning(f"Error closing GPIO chip: {e}")
        self._handle = None


class GpioOutputPin:
    """A single claimed output pin. Also exposes a digitalio-compatible
    `.value` property so it can be dropped in wherever code (e.g. the
    adafruit_mcp3xxx library's chip-select argument) expects a
    digitalio.DigitalInOut-like object."""

    def __init__(self, chip, pin):
        self._chip = chip
        self._pin = pin
        self._value = 0

    def write(self, level):
        self._value = 1 if level else 0
        if _BACKEND == "lgpio":
            _lgpio.gpio_write(self._chip._handle, self._pin, self._value)
        else:
            self._chip._handle.write(self._pin, self._value)

    @property
    def value(self):
        return bool(self._value)

    @value.setter
    def value(self, level):
        self.write(level)

    # --- digitalio.DigitalInOut-compatible surface ---
    #
    # adafruit_bus_device.spi_device.SPIDevice (used internally by
    # adafruit_mcp3xxx.mcp3008.MCP3008 for chip-select management) expects
    # its `chip_select` argument to behave like a real
    # digitalio.DigitalInOut, not just expose `.value`. Its constructor
    # calls `chip_select.switch_to_output(value=True)` unconditionally, so
    # that method - and `direction`/`switch_to_input`, for the same API
    # contract - must exist here too, even though this pin was already
    # claimed as an output (and given its initial value) back in
    # GpioChip.claim_output().
    def switch_to_output(self, value=False, drive_mode=None):
        self.write(value)

    def switch_to_input(self, pull=None):
        raise NotImplementedError(
            "GpioOutputPin was claimed as an output-only pin; switching a "
            "chip-select pin to input is not supported."
        )

    @property
    def direction(self):
        return "OUTPUT"

    @direction.setter
    def direction(self, _value):
        # Already an output (claimed via GpioChip.claim_output()); nothing
        # to do, but accept the assignment since some callers (mirroring
        # digitalio usage) set this unconditionally after construction.
        pass


class GpioInputPin:
    """A single claimed input pin."""

    def __init__(self, chip, pin):
        self._chip = chip
        self._pin = pin

    def read(self):
        if _BACKEND == "lgpio":
            return _lgpio.gpio_read(self._chip._handle, self._pin)
        return self._chip._handle.read(self._pin)

    @property
    def value(self):
        return bool(self.read())
