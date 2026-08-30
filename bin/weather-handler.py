#!/opt/gardenpi/python3/bin/python3
#
# weather-handler.py
#
# v5.2 2026/08/28
# - fixed: the sensors LED indicator functions were calling nonexistent
#   LED aliases "sensorsinit"/"sensorsrun"/"sensorserr" (an errant extra
#   "s") - garden.json's handlers.leds.led_map only defines "sensorinit"/
#   "sensorrun"/"sensorerr". Corrected to match.
# - added startup coordination with adc-handler.py over the shared
#   "sensors" LED: this handler now checks (via a direct query to the LED
#   handler's own socket - handlers.leds.socket - since leds.py only
#   reports success/failure of a command, never state) whether sensorerr
#   is already red before touching the LED. If it's already red, startup
#   proceeds normally but the LED is left red throughout (no green/blue
#   transition); if it starts successfully and sensorerr was not already
#   set, the LED is set to blue (sensorrun) as before. A failed startup
#   still sets it red via the existing indicate_error() call in main().
#
# v5.1 2026/08/27
# - full rewrite onto the same pattern as the other v3.0-release handlers:
#     * configuration now comes entirely from garden.json's
#       handlers.weather stanza (socket, log_level, weather_file, hz_file,
#       input_map, sensor_map, sample_periods, reference_values) plus
#       hardware.raspberrypi.pin_map (type "gpio") for the wind/hz/rain pins
#       config.
#     * this handler now runs its own Unix socket listener
#       (handlers.weather.socket), matching adc/leds/irrigation, so the
#       API (and any other handler that needs a live reading) can query
#       it directly instead of only reading weather_file/hz_file off disk.
#     * GPIO: RPi.GPIO is replaced by garden_gpio (lgpio, falling back to
#       pigpio) for the wind-speed/hz/rain pulse-counting inputs, since
#       this is a multi-process environment and RPi.GPIO's whole-chip
#       model doesn't arbitrate cleanly against the other handler
#       processes that also own GPIO pins. The Si7021 I2C sensors
#       (smbus2) are unaffected - I2C bus access was never the same class
#       of multi-process problem as a bit-banged GPIO pin.
#     * centralized logging via garden_logger.init_logging()
#     * every sensor this handler reports (handlers.weather.sensor_map) is
#       sampled on its own thread at its own handlers.weather.sample_periods
#       period, into a shared in-memory cache; weather_file/hz_file are
#       written from snapshots of that cache (weather_file at the
#       "default" period, hz_file at s_hz's own period), and the socket
#       listener answers from the same cache - so a live query and the
#       CSV rows are always consistent with each other.
#     * queries accept a sensor_id (handlers.weather.sensor_map key, e.g.
#       "s_daylight"), or - for the sensors this handler reads directly -
#       the input_map hardware_id/user_id (e.g. "wind_speed"). Sensors
#       whose sensor_map "source" is another handler (e.g. "adc") are
#       read from that handler's own socket, using its hardware_id/
#       user_id, exactly as any other client of that handler would.
#
# v4.0 2026/04/11
# - FIXED: race condition on global tick counters (threading.Lock)
# - FIXED: Timer list memory leak (replaced with dedicated sampling threads)
# - FIXED: Si7021 uninitialized variable when t_code/rh_code == 0
# - FIXED: proper shutdown with threading.Event
# - Added ADC handler health monitoring (alarm after N consecutive failures)
#
# Copyright 2025-2026 Allen Pomeroy - MIT license

import os
import sys
import json
import time
import socket
import signal
import logging
import argparse
import threading
import subprocess
import csv
import io

import numpy as np
import smbus2
from smbus2 import i2c_msg

from garden_logger import init_logging, resolve_effective_level, LEVEL_ALIASES
from garden_config import (
    ConfigError, require, require_nonempty, build_id_map, resolve_id,
    pin_for_hardware_id,
)
import garden_gpio

VERSION = "5.2"

# The only hardcoded default kept: where to find garden.json. Every other
# value below must be present in the config file - see garden_config.py.
DEFAULT_CONFIG_FILE = "/opt/gardenpi/config/garden.json"

# Not sourced from garden.json (no corresponding key exists there) - a
# fixed path to a sibling script, not a config fallback.
LED_CLIENT_PATH = "/opt/gardenpi/bin/leds.py"

# Si7021 constants (command codes are the same for every Si7021 regardless
# of bus/address, which are now sourced per-sensor from garden.json's
# hardware.picontroller.pin_map)
CMD_MEASURE_TEMP_NOHOLD = 0xF3
CMD_MEASURE_RH_NOHOLD = 0xF5
CMD_RESET = 0xFE

log = logging.getLogger(__name__)

# Sensors this handler reads directly (input_map hardware_ids) that
# aren't yet wired to a real sensor - reserved for a future 1-wire
# DS18B20-style ground temperature probe. Queries for these return None
# rather than a fabricated value.
UNIMPLEMENTED_LOCAL_SENSORS = {"ground_temp1", "ground_temp2"}


# --------------------------
# Configuration loading
# --------------------------

def i2c_entry_for_hardware_id(pin_map_cfg, hardware_id, pin_type="i2c"):
    """Find a {hardware_id, pin, type, addr} entry in a pin_map list.

    Used for the Si7021 sensors, which live on the picontroller board's
    pin_map (hardware.picontroller.pin_map) as type 'i2c' entries, where
    'pin' is the I2C bus number and 'addr' is the device address.
    """
    for entry in pin_map_cfg:
        if entry.get("hardware_id") == hardware_id and entry.get("type") == pin_type:
            return entry
    return None


def load_config(config_path):
    with open(config_path) as f:
        cfg = json.load(f)

    global_cfg = cfg.get("config", {})
    weather_cfg = cfg.get("handlers", {}).get("weather", {})
    adc_cfg = cfg.get("handlers", {}).get("adc", {})
    leds_cfg = cfg.get("handlers", {}).get("leds", {})
    rpi_cfg = cfg.get("hardware", {}).get("raspberrypi", {})

    socket_timeout = require(global_cfg, "socket_timeout", "config.socket_timeout")
    socket_file = require(weather_cfg, "socket", "handlers.weather.socket")
    handler_log_level = require(weather_cfg, "log_level", "handlers.weather.log_level")
    global_log_level = require(global_cfg, "global_log_level", "config.global_log_level")

    weather_file = require(weather_cfg, "weather_file", "handlers.weather.weather_file")
    hz_file = require(weather_cfg, "hz_file", "handlers.weather.hz_file")

    input_map_cfg = require_nonempty(weather_cfg, "input_map", "handlers.weather.input_map")
    input_id_map = build_id_map(input_map_cfg, "handlers.weather.input_map")

    sensor_map = require_nonempty(weather_cfg, "sensor_map", "handlers.weather.sensor_map")
    sample_periods = require_nonempty(weather_cfg, "sample_periods", "handlers.weather.sample_periods")
    default_period = require(sample_periods, "default", "handlers.weather.sample_periods.default")

    reference_values = require_nonempty(
        weather_cfg, "reference_values", "handlers.weather.reference_values"
    )
    adc_ref_voltage = require(
        reference_values, "adc_ref_voltage", "handlers.weather.reference_values.adc_ref_voltage"
    )
    rain_bucket_size_mm = require(
        reference_values, "rain_bucket_size_mm", "handlers.weather.reference_values.rain_bucket_size_mm"
    )

    # GPIO pins for the sensors this handler reads directly off the Pi's
    # own header (hardware.raspberrypi.pin_map, type "gpio").
    pin_map_cfg = require_nonempty(rpi_cfg, "pin_map", "hardware.raspberrypi.pin_map")
    gpio_pins = {}
    for hardware_id in ("wind_speed", "hz", "rain"):
        pin = pin_for_hardware_id(pin_map_cfg, hardware_id, pin_type="gpio")
        if pin is None:
            raise ConfigError(
                f"No 'gpio' pin defined for hardware_id '{hardware_id}' in "
                f"hardware.raspberrypi.pin_map"
            )
        gpio_pins[hardware_id] = pin

    adc_socket = require(adc_cfg, "socket", "handlers.adc.socket")

    # Needed so this handler can check the shared "sensors" LED's current
    # state directly (see led_is_red()) before deciding whether to leave
    # sensorerr red on startup.
    leds_socket = require(leds_cfg, "socket", "handlers.leds.socket")

    # Si7021 temperature/humidity sensors - these live on the picontroller
    # expansion board (see hardware.picontroller comment), not on the Pi's
    # own header, so their bus/address come from that board's pin_map
    # rather than hardware.raspberrypi.pin_map.
    picontroller_cfg = cfg.get("hardware", {}).get("picontroller", {})
    picontroller_pin_map = require_nonempty(
        picontroller_cfg, "pin_map", "hardware.picontroller.pin_map"
    )
    si7021_int_entry = i2c_entry_for_hardware_id(picontroller_pin_map, "si7021_internal")
    si7021_ext_entry = i2c_entry_for_hardware_id(picontroller_pin_map, "si7021_external")
    if si7021_int_entry is None:
        raise ConfigError(
            "No 'i2c' pin_map entry for hardware_id 'si7021_internal' in "
            "hardware.picontroller.pin_map"
        )
    if si7021_ext_entry is None:
        raise ConfigError(
            "No 'i2c' pin_map entry for hardware_id 'si7021_external' in "
            "hardware.picontroller.pin_map"
        )
    try:
        si7021_int_bus = int(si7021_int_entry["pin"])
        si7021_ext_bus = int(si7021_ext_entry["pin"])
        si7021_int_addr = int(str(si7021_int_entry["addr"]), 16)
        si7021_ext_addr = int(str(si7021_ext_entry["addr"]), 16)
    except (KeyError, ValueError) as e:
        raise ConfigError(
            f"Invalid or missing 'pin'/'addr' on a si7021 pin_map entry in "
            f"hardware.picontroller.pin_map: {e}"
        )

    return {
        "socket_timeout": socket_timeout,
        "socket_file": socket_file,
        "handler_log_level": handler_log_level,
        "global_log_level": global_log_level,
        "weather_file": weather_file,
        "hz_file": hz_file,
        "input_id_map": input_id_map,
        "sensor_map": sensor_map,
        "sample_periods": sample_periods,
        "default_period": default_period,
        "adc_ref_voltage": float(adc_ref_voltage),
        "rain_bucket_size_mm": float(rain_bucket_size_mm),
        "gpio_pins": gpio_pins,
        "adc_socket": adc_socket,
        "leds_socket": leds_socket,
        "si7021_int_bus": si7021_int_bus,
        "si7021_int_addr": si7021_int_addr,
        "si7021_ext_bus": si7021_ext_bus,
        "si7021_ext_addr": si7021_ext_addr,
    }


# ==============================
# Si7021 Sensor
# ==============================

class Si7021Sensor:
    def __init__(self, i2c_bus, i2c_addr):
        self.bus = smbus2.SMBus(i2c_bus)
        self.addr = i2c_addr
        self._lock = threading.Lock()
        self.reset()

    def reset(self):
        with self._lock:
            self.bus.write_byte(self.addr, CMD_RESET)
        time.sleep(0.05)

    def _read_sensor_data(self, command):
        with self._lock:
            write = i2c_msg.write(self.addr, [command])
            self.bus.i2c_rdwr(write)
            time.sleep(0.03)
            read = i2c_msg.read(self.addr, 3)
            self.bus.i2c_rdwr(read)
        return list(read)

    def read_temperature_c(self):
        raw = self._read_sensor_data(CMD_MEASURE_TEMP_NOHOLD)
        t_code = (raw[0] << 8) | raw[1]
        if t_code > 0:
            return (175.72 * t_code / 65536.0) - 46.85
        return 0.0

    def read_temperature_f(self):
        return self.read_temperature_c() * 1.8 + 32.0

    def read_humidity(self):
        raw = self._read_sensor_data(CMD_MEASURE_RH_NOHOLD)
        rh_code = (raw[0] << 8) | raw[1]
        if rh_code > 0:
            return (125.0 * rh_code / 65536.0) - 6.0
        return 0.0


class Si7021Handler:
    """moduleId 0 = internal, moduleId 1 = external. Bus/address for each
    come from hardware.picontroller.pin_map (hardware_id 'si7021_internal'
    / 'si7021_external', type 'i2c') in garden.json."""

    def __init__(self, int_bus, int_addr, ext_bus, ext_addr):
        self.sensors = [
            Si7021Sensor(i2c_bus=int_bus, i2c_addr=int_addr),
            Si7021Sensor(i2c_bus=ext_bus, i2c_addr=ext_addr),
        ]

    def get_temp_c(self, sensor_id):
        return self.sensors[sensor_id].read_temperature_c()

    def get_temp_f(self, sensor_id):
        return self.sensors[sensor_id].read_temperature_f()

    def get_humidity(self, sensor_id):
        return self.sensors[sensor_id].read_humidity()


# ===========================
# LED functions
# ===========================

def call_led_client(led_name, action, *args):
    try:
        cmd = [LED_CLIENT_PATH, led_name, action] + list(args)
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        if result.returncode != 0:
            log.warning(f"LED client error: {result.stderr}")
            return False
        return True
    except subprocess.TimeoutExpired:
        log.warning("LED client call timed out")
        return False
    except Exception as e:
        log.warning(f"Failed to call LED client: {str(e)}")
        return False


def indicate_init():
    call_led_client("sensorinit", "on")

def indicate_run():
    call_led_client("sensorrun", "on")

def indicate_error():
    call_led_client("sensorerr", "blink", "1")

def indicate_stop():
    call_led_client("sensorerr", "on")


def query_led_status(socket_path, led_name, timeout):
    """Query the LED handler's own socket directly (not via leds.py, which
    only reports success/failure of a command, never state) for the
    current status of led_name (a hardware_id or alias). Returns the
    {"state": "on"/"off", "effect": "static"/"active (...)"} dict for
    that LED, or None if the query fails or the LED is unknown.
    """
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout)
            sock.connect(socket_path)
            sock.sendall(f"status {led_name}".encode("utf-8"))
            response = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response += chunk
                if b"\n" in chunk:
                    break
        data = json.loads(response.decode("utf-8").strip())
        status = data.get("status", {})
        if not status:
            return None
        # led_name resolves to a single hardware_id (e.g. "sensorerr" ->
        # "led1red") on the LED handler side, so there's exactly one entry.
        return next(iter(status.values()), None)
    except Exception as e:
        log.warning(f"Failed to query LED status for '{led_name}': {str(e)}")
        return None


def led_is_red(socket_path, led_name, timeout):
    """True if led_name is currently lit steady or has an active
    blink/flash effect running (i.e. it's signalling an error/alert),
    False if it's off, and False (fail-safe: don't assume an error we
    couldn't actually confirm) if the LED handler can't be reached.
    """
    info = query_led_status(socket_path, led_name, timeout)
    if info is None:
        return False
    return info.get("state") == "on" or info.get("effect", "static") != "static"


# ===========================
# ADC client (via ADC handler socket, hardware_id/user_id protocol)
# ===========================

class AdcClient:
    def __init__(self, socket_path, timeout):
        self.socket_path = socket_path
        self.timeout = timeout
        self._consecutive_failures = 0
        self.FAILURE_THRESHOLD = 5

    def read(self, adc_id):
        """adc_id is a hardware_id or user_id understood by the ADC
        handler's own channel_map."""
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                sock.settimeout(self.timeout)
                sock.connect(self.socket_path)
                sock.sendall(str(adc_id).encode('ascii'))
                response = sock.recv(1024).decode('ascii').strip()
                if response.startswith("ERROR"):
                    raise RuntimeError(response)
                voltage = float(response)
                self._consecutive_failures = 0
                return voltage
        except Exception as e:
            self._consecutive_failures += 1
            log.error(f"ADC error reading '{adc_id}': {str(e)} "
                      f"(failures: {self._consecutive_failures})")
            if self._consecutive_failures >= self.FAILURE_THRESHOLD:
                log.critical(f"ADC handler unreachable for {self._consecutive_failures} reads!")
                indicate_error()
            return None


# ===========================
# Shared sensor cache
# ===========================

class SensorCache:
    """Thread-safe latest-value store, keyed by sensor_id (the keys of
    handlers.weather.sensor_map)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._values = {}

    def set(self, sensor_id, value):
        with self._lock:
            self._values[sensor_id] = value

    def get(self, sensor_id):
        with self._lock:
            return self._values.get(sensor_id)

    def snapshot(self):
        with self._lock:
            return dict(self._values)


# ===========================
# Wind direction lookup
# ===========================

WIND_DIR_MAP = np.array([
    (112.5, 0.0,  0.24), (67.5,  0.24, 0.28), (90,    0.28, 0.35),
    (157.5, 0.35, 0.50), (135,   0.50, 0.69), (202.5, 0.69, 0.86),
    (180,   0.86, 1.12), (22.5,  1.12, 1.40), (45,    1.40, 1.71),
    (247.5, 1.71, 1.98), (225,   1.98, 2.15), (337.5, 2.15, 2.40),
    (0,     2.40, 2.60), (292.5, 2.60, 2.76), (315,   2.76, 2.95),
    (270,   2.95, 3.30)
])


def volts_to_wind_dir(volts):
    for idx in range(WIND_DIR_MAP.shape[0]):
        if WIND_DIR_MAP[idx, 1] <= volts <= WIND_DIR_MAP[idx, 2]:
            return float(WIND_DIR_MAP[idx, 0])
    return 0.0


def volts_to_lux(daylight_volts, adc_ref_voltage):
    ldr_voltage = adc_ref_voltage - daylight_volts
    ldr_resistance = (ldr_voltage / daylight_volts * 10000) if daylight_volts > 0 else 0
    LUX_CALC_SCALAR = 12518931
    LUX_CALC_EXPONENT = -1.405
    return LUX_CALC_SCALAR * pow(ldr_resistance, LUX_CALC_EXPONENT) if ldr_resistance > 0 else 0.0


# ===========================
# Weather handler
# ===========================

class WeatherHandler:
    def __init__(self, cfg):
        self.cfg = cfg
        self.cache = SensorCache()
        self.adc_client = AdcClient(cfg["adc_socket"], cfg["socket_timeout"])
        self.si7021 = None

        self._shutdown = threading.Event()
        self._tick_lock = threading.Lock()
        self._ticks = {"wind_speed": 0, "hz": 0, "rain": 0}

        self._gpio_chip = None
        self._sample_threads = []
        self._sensorerr_was_active = False

        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)

    # ---- setup ----

    def initialize_sensors(self):
        log.info("Initializing Si7021 temperature/humidity sensors")
        self.si7021 = Si7021Handler(
            int_bus=self.cfg["si7021_int_bus"], int_addr=self.cfg["si7021_int_addr"],
            ext_bus=self.cfg["si7021_ext_bus"], ext_addr=self.cfg["si7021_ext_addr"],
        )

        log.info("Initializing GPIO for wind speed / hz / rain pulse counting")
        self._gpio_chip = garden_gpio.GpioChip()
        pins = self.cfg["gpio_pins"]

        def make_callback(name):
            def _cb(chip_handle, gpio, level, tick):
                with self._tick_lock:
                    self._ticks[name] += 1
            return _cb

        self._gpio_chip.claim_alert(
            pins["wind_speed"], make_callback("wind_speed"),
            edge=garden_gpio.EDGE_FALLING, pull_up=True, debounce_us=90000
        )
        self._gpio_chip.claim_alert(
            pins["hz"], make_callback("hz"),
            edge=garden_gpio.EDGE_FALLING, pull_up=True, debounce_us=90000
        )
        self._gpio_chip.claim_alert(
            pins["rain"], make_callback("rain"),
            edge=garden_gpio.EDGE_FALLING, pull_up=True, debounce_us=150000
        )

    def _consume_ticks(self, name):
        with self._tick_lock:
            n = self._ticks[name]
            self._ticks[name] = 0
        return n

    # ---- resolving a query token to a sensor_id ----

    def resolve_sensor_id(self, token):
        sensor_map = self.cfg["sensor_map"]
        if token in sensor_map:
            return token
        # Fall back to the input_map (hardware_id/user_id) for sensors
        # this handler reads directly, e.g. "wind_speed" -> "s_wind_speed".
        hardware_id = resolve_id(self.cfg["input_id_map"], token)
        if hardware_id is None:
            return None
        for sensor_id, entry in sensor_map.items():
            if entry.get("source") == "weather" and entry.get("source_id") == hardware_id:
                return sensor_id
        return None

    # ---- reading a single sensor on demand ----

    def read_sensor(self, sensor_id):
        entry = self.cfg["sensor_map"].get(sensor_id)
        if entry is None:
            return None
        source = entry.get("source")
        source_id = entry.get("source_id")

        if source == "adc":
            return self.adc_client.read(source_id)

        if source == "weather":
            return self._read_local(source_id)

        log.error(f"Unknown sensor source '{source}' for sensor_id '{sensor_id}'")
        return None

    def _read_local(self, hardware_id):
        if hardware_id in UNIMPLEMENTED_LOCAL_SENSORS:
            return None
        if hardware_id == "wind_speed":
            period = self.cfg["sample_periods"].get("s_wind_speed", self.cfg["default_period"])
            ticks = self._consume_ticks("wind_speed")
            return ticks / period * 1.492
        if hardware_id == "hz":
            return self._consume_ticks("hz")
        if hardware_id == "rain":
            ticks = self._consume_ticks("rain")
            return (ticks * self.cfg["rain_bucket_size_mm"]) / 25.4
        if hardware_id == "int_temp":
            return self.si7021.get_temp_c(0)
        if hardware_id == "int_humidity":
            return self.si7021.get_humidity(0)
        if hardware_id == "ext_temp":
            return self.si7021.get_temp_c(1)
        if hardware_id == "ext_humidity":
            return self.si7021.get_humidity(1)
        log.error(f"No local reader for input hardware_id '{hardware_id}'")
        return None

    # ---- background per-sensor sampling ----

    def _period_for(self, sensor_id):
        return self.cfg["sample_periods"].get(sensor_id, self.cfg["default_period"])

    def _sampling_loop(self, sensor_id):
        period = self._period_for(sensor_id)
        while not self._shutdown.is_set():
            if self._shutdown.wait(timeout=period):
                break
            try:
                value = self.read_sensor(sensor_id)
                if value is not None:
                    self.cache.set(sensor_id, value)
            except Exception as e:
                log.error(f"Error sampling '{sensor_id}': {e}")

    def start_sampling_threads(self):
        for sensor_id, entry in self.cfg["sensor_map"].items():
            if not entry.get("enabled", False):
                continue
            t = threading.Thread(
                target=self._sampling_loop, args=(sensor_id,),
                daemon=True, name=f"sample-{sensor_id}"
            )
            self._sample_threads.append(t)
            t.start()
        log.info(f"Started {len(self._sample_threads)} sensor sampling thread(s)")

    # ---- CSV writers ----

    def _write_csv_line(self, filename, row):
        try:
            with open(filename, "a", newline='') as f:
                csv.writer(f).writerow(row)
        except Exception as e:
            log.error(f"Failed to write to {filename}: {e}")
            indicate_error()

    def weather_csv_loop(self):
        period = self.cfg["default_period"]
        headers_sensor_ids = [
            "s_wind_speed", "s_rain", "s_daylight", "s_pressure",
            "s_moisture1", "s_moisture2", "s_moisture3", "s_wind_dir",
            "s_int_temp", "s_int_humidity", "s_ext_temp", "s_ext_humidity",
        ]
        while not self._shutdown.is_set():
            if self._shutdown.wait(timeout=period):
                break
            timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
            row = [timestamp]
            for sensor_id in headers_sensor_ids:
                value = self.cache.get(sensor_id)
                row.append(value if value is not None else '')
            self._write_csv_line(self.cfg["weather_file"], row)

    def hz_csv_loop(self):
        entry = self.cfg["sensor_map"].get("s_hz")
        if not entry or not entry.get("enabled", False):
            log.info("s_hz disabled in handlers.weather.sensor_map; hz_file writer not started")
            return
        period = self._period_for("s_hz")
        while not self._shutdown.is_set():
            if self._shutdown.wait(timeout=period):
                break
            timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
            value = self.cache.get("s_hz")
            self._write_csv_line(self.cfg["hz_file"], [timestamp, value if value is not None else ''])

    # ---- socket server ----

    def handle_command(self, command):
        parts = command.strip().lower().split()
        if not parts:
            return json.dumps({"error": "No command received"})

        if parts[0] == "status":
            if len(parts) > 1:
                sensor_id = self.resolve_sensor_id(parts[1])
                if sensor_id is None:
                    return json.dumps({"error": f"Unknown sensor: {parts[1]}"})
                return json.dumps({sensor_id: self.cache.get(sensor_id)})
            return json.dumps(self.cache.snapshot())

        sensor_id = self.resolve_sensor_id(parts[0])
        if sensor_id is None:
            return "ERROR: Unknown sensor"

        value = self.cache.get(sensor_id)
        if value is None:
            # Not yet sampled (or disabled) - try a live read as a fallback.
            value = self.read_sensor(sensor_id)
        if value is None:
            return "ERROR: No reading available"
        return f"{value:.4f}" if isinstance(value, float) else str(value)

    def start_socket_server(self):
        socket_file = self.cfg["socket_file"]
        if os.path.exists(socket_file):
            os.remove(socket_file)
        self.sock.bind(socket_file)
        os.chmod(socket_file, 0o660)
        self.sock.listen(5)
        self.sock.settimeout(self.cfg["socket_timeout"])
        log.info(f"Weather Handler v{VERSION} listening on {socket_file}")

        while not self._shutdown.is_set():
            try:
                conn, _ = self.sock.accept()
                threading.Thread(
                    target=self._handle_client, args=(conn,), daemon=True
                ).start()
            except socket.timeout:
                continue
            except Exception as e:
                if not self._shutdown.is_set():
                    log.error(f"Connection error: {str(e)}")

    def _handle_client(self, conn):
        try:
            data = conn.recv(1024).decode().strip()
            if data:
                response = self.handle_command(data)
                conn.sendall((response + "\n").encode())
        except Exception as e:
            log.error(f"Client error: {str(e)}")
        finally:
            conn.close()

    # ---- lifecycle ----

    def start(self):
        # Check the shared "sensors" LED before touching it: if adc-handler.py
        # (or a previous run of this handler) already left sensorerr red,
        # leave it red through startup and beyond, even if everything below
        # succeeds - a prior unresolved error shouldn't be masked by a
        # fresh green/blue transition.
        self._sensorerr_was_active = led_is_red(
            self.cfg["leds_socket"], "sensorerr", self.cfg["socket_timeout"]
        )
        if self._sensorerr_was_active:
            log.warning("sensorerr LED already active at startup; leaving it red")
        else:
            indicate_init()

        self.initialize_sensors()
        self.start_sampling_threads()

        threading.Thread(target=self.weather_csv_loop, daemon=True, name="weather-csv-writer").start()
        threading.Thread(target=self.hz_csv_loop, daemon=True, name="hz-csv-writer").start()

        if not self._sensorerr_was_active:
            indicate_run()
        self.start_socket_server()  # blocks until shutdown

    def stop(self):
        log.info("Shutting down Weather Handler...")
        self._shutdown.set()
        try:
            self.sock.close()
        except Exception:
            pass
        if os.path.exists(self.cfg["socket_file"]):
            try:
                os.remove(self.cfg["socket_file"])
            except Exception:
                pass
        if self._gpio_chip:
            self._gpio_chip.close()
        indicate_stop()
        log.info("Weather Handler stopped")


# --------------------------
# argument parsing
# --------------------------

def parse_arguments():
    parser = argparse.ArgumentParser(description="Weather Handler Service")
    parser.add_argument(
        "--config", "-c",
        type=str,
        default=DEFAULT_CONFIG_FILE,
        help=f"Path to garden.json config file (default: {DEFAULT_CONFIG_FILE})"
    )
    parser.add_argument(
        "--loglevel", "-l",
        type=str,
        default=None,
        choices=sorted(LEVEL_ALIASES.keys()),
        help="Override both handlers.weather.log_level and config.global_log_level "
             "(debug, info, warn/warning, error, critical)"
    )
    return parser.parse_args()


# --------------------------
# main
# --------------------------

handler = None


def signal_handler(sig, frame):
    global handler
    if handler:
        handler.stop()
    sys.exit(0)


def main():
    global handler

    args = parse_arguments()

    try:
        cfg = load_config(args.config)
    except Exception as e:
        print(f"Fatal error loading config '{args.config}': {e}", file=sys.stderr, flush=True)
        sys.exit(1)

    if args.loglevel is not None:
        level = LEVEL_ALIASES[args.loglevel.strip().lower()]
    else:
        try:
            level = resolve_effective_level(cfg["handler_log_level"], cfg["global_log_level"])
        except ValueError as e:
            print(f"Fatal error resolving log level: {e}", file=sys.stderr, flush=True)
            sys.exit(1)

    init_logging(level=level)

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    try:
        handler = WeatherHandler(cfg)
        handler.start()
    except KeyboardInterrupt:
        if handler:
            handler.stop()
    except Exception as e:
        log.critical(f"Fatal error: {str(e)}")
        indicate_error()
        if handler:
            handler.stop()
        sys.exit(1)


if __name__ == '__main__':
    main()
