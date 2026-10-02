#!/usr/bin/env python3
"""
pijuice_charge_limiter.py - keep a PiJuice LiPo at a reduced state of charge.

Disables PiJuice battery charging when the charge level reaches UPPER %
(default 50) and re-enables it when the level falls below LOWER % (default 45).
Optionally also blocks charging when the battery is too hot or too cold,
which matters for LiPo cells in sun-exposed outdoor enclosures.

Designed to run as a systemd service on Raspberry Pi OS / Debian Bookworm.
Requires the PiJuice Python API (pijuice-base package) and I2C enabled.
"""

import argparse
import logging
import signal
import sys
import threading
import time

try:
    from pijuice import PiJuice
except ImportError:
    sys.stderr.write(
        "ERROR: could not import 'pijuice'. Install the pijuice-base package "
        "and make sure I2C is enabled (raspi-config > Interface Options > I2C).\n"
    )
    sys.exit(1)

log = logging.getLogger("pijuice-charge-limiter")


class PiJuiceCommError(Exception):
    """Raised when the PiJuice cannot be read/written after retries."""


class ChargeLimiter:
    def __init__(self, args):
        self.args = args
        self.pj = None
        self.stop_event = threading.Event()
        self.last_switch = 0.0          # monotonic time of last charging change
        self.temp_block = False         # True while temperature is out of range
        self.last_summary = 0.0

    # ------------------------------------------------------------------ I/O
    def connect(self):
        """Open the I2C connection, retrying until it works or we are stopped."""
        while not self.stop_event.is_set():
            try:
                self.pj = PiJuice(self.args.bus, self.args.address)
                # Probe once to make sure the device actually answers.
                self._call(self.pj.status.GetStatus)
                log.info("Connected to PiJuice on bus %d, address 0x%02X",
                         self.args.bus, self.args.address)
                return True
            except Exception as exc:
                log.warning("PiJuice not reachable yet (%s); retrying in 10 s", exc)
                self.stop_event.wait(10)
        return False

    def _call(self, fn, *a, **kw):
        """Call a PiJuice API function, retrying on I2C errors."""
        last_err = None
        for attempt in range(self.args.retries):
            try:
                result = fn(*a, **kw)
            except Exception as exc:  # smbus raises OSError on bus errors
                last_err = repr(exc)
            else:
                if result.get("error") == "NO_ERROR":
                    return result.get("data")
                last_err = result.get("error")
            time.sleep(0.5 * (attempt + 1))
        raise PiJuiceCommError(f"{getattr(fn, '__name__', fn)} failed: {last_err}")

    def charge_level(self):
        return int(self._call(self.pj.status.GetChargeLevel))

    def battery_temp(self):
        if self.args.no_temp:
            return None
        try:
            return int(self._call(self.pj.status.GetBatteryTemperature))
        except PiJuiceCommError as exc:
            log.warning("Could not read battery temperature: %s", exc)
            return None

    def charging_enabled(self):
        cfg = self._call(self.pj.config.GetChargingConfig)
        return bool(cfg.get("charging_enabled"))

    def set_charging(self, enabled, reason):
        self._call(self.pj.config.SetChargingConfig,
                   {"charging_enabled": enabled}, self.args.non_volatile)
        # Read back to confirm the MCU accepted the change.
        if self.charging_enabled() != enabled:
            raise PiJuiceCommError("charging config did not stick after write")
        self.last_switch = time.monotonic()
        log.info("Charging %s (%s)", "ENABLED" if enabled else "DISABLED", reason)

    # --------------------------------------------------------------- logic
    def update_temp_block(self, temp):
        """Temperature lockout with hysteresis so it doesn't flap."""
        if temp is None:
            return
        a = self.args
        if not self.temp_block:
            if temp >= a.max_temp or temp <= a.min_temp:
                self.temp_block = True
                log.warning("Battery temperature %d°C outside %d..%d°C - blocking charge",
                            temp, a.min_temp, a.max_temp)
        else:
            if (a.min_temp + a.temp_hysteresis) <= temp <= (a.max_temp - a.temp_hysteresis):
                self.temp_block = False
                log.info("Battery temperature back to %d°C - lifting temperature block", temp)

    def step(self):
        level = self.charge_level()
        temp = self.battery_temp()
        enabled = self.charging_enabled()
        self.update_temp_block(temp)

        want, reason = enabled, None
        if self.temp_block:
            want, reason = False, f"battery temperature {temp}°C out of range"
        elif level >= self.args.upper:
            want, reason = False, f"charge {level}% >= {self.args.upper}%"
        elif level < self.args.lower:
            want, reason = True, f"charge {level}% < {self.args.lower}%"
        # Between lower and upper: keep current state (hysteresis band).

        log.debug("level=%d%% temp=%s charging=%s temp_block=%s",
                  level, temp, enabled, self.temp_block)

        if want != enabled:
            # Disabling for safety is always immediate; enabling respects
            # a minimum interval to avoid rapid toggling from noisy readings.
            since = time.monotonic() - self.last_switch
            if want and self.last_switch and since < self.args.min_switch_interval:
                log.debug("Holding off re-enable for %.0f s more",
                          self.args.min_switch_interval - since)
            else:
                self.set_charging(want, reason)
                enabled = want

        now = time.monotonic()
        if now - self.last_summary >= self.args.summary_interval:
            self.last_summary = now
            log.info("Status: charge %d%%, battery temp %s, charging %s",
                     level, f"{temp}°C" if temp is not None else "n/a",
                     "enabled" if enabled else "disabled")

    def run(self):
        if not self.connect():
            return
        errors = 0
        while not self.stop_event.is_set():
            try:
                self.step()
                errors = 0
            except PiJuiceCommError as exc:
                errors += 1
                log.error("Communication problem (%d in a row): %s", errors, exc)
                if errors >= 10:
                    log.error("Too many consecutive errors; reconnecting")
                    if not self.connect():
                        break
                    errors = 0
            self.stop_event.wait(self.args.interval)

    def shutdown(self):
        if self.args.on_exit == "enable" and self.pj is not None:
            try:
                self.set_charging(True, "service stopping, --on-exit=enable")
            except Exception as exc:
                log.error("Failed to re-enable charging on exit: %s", exc)
        log.info("Stopped")


def parse_args():
    p = argparse.ArgumentParser(description="Limit PiJuice LiPo charge level.")
    p.add_argument("--upper", type=int, default=50,
                   help="disable charging at or above this %% (default 50)")
    p.add_argument("--lower", type=int, default=45,
                   help="re-enable charging below this %% (default 45)")
    p.add_argument("--interval", type=float, default=30,
                   help="seconds between checks (default 30)")
    p.add_argument("--min-switch-interval", type=float, default=120,
                   help="minimum seconds before re-enabling after a change (default 120)")
    p.add_argument("--max-temp", type=int, default=45,
                   help="block charging at/above this battery temp °C (default 45)")
    p.add_argument("--min-temp", type=int, default=0,
                   help="block charging at/below this battery temp °C (default 0)")
    p.add_argument("--temp-hysteresis", type=int, default=3,
                   help="°C a temperature must recover before unblocking (default 3)")
    p.add_argument("--no-temp", action="store_true",
                   help="ignore battery temperature entirely")
    p.add_argument("--non-volatile", action="store_true",
                   help="write charging setting to PiJuice EEPROM (default: RAM only)")
    p.add_argument("--on-exit", choices=["leave", "enable"], default="leave",
                   help="what to do with charging when the service stops (default leave)")
    p.add_argument("--bus", type=int, default=1, help="I2C bus (default 1)")
    p.add_argument("--address", type=lambda x: int(x, 0), default=0x14,
                   help="PiJuice I2C address (default 0x14)")
    p.add_argument("--retries", type=int, default=3, help="I2C retries per call")
    p.add_argument("--summary-interval", type=float, default=900,
                   help="seconds between status log lines (default 900)")
    p.add_argument("--debug", action="store_true", help="verbose logging")
    args = p.parse_args()

    if not 0 < args.lower < args.upper <= 100:
        p.error("need 0 < --lower < --upper <= 100")
    if args.min_temp + args.temp_hysteresis >= args.max_temp - args.temp_hysteresis:
        p.error("temperature limits/hysteresis overlap")
    return args


def main():
    args = parse_args()
    # No timestamps: journald adds its own.
    logging.basicConfig(level=logging.DEBUG if args.debug else logging.INFO,
                        format="%(levelname)s: %(message)s")

    limiter = ChargeLimiter(args)

    def handle_signal(signum, _frame):
        log.info("Received signal %d, stopping", signum)
        limiter.stop_event.set()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    log.info("Starting: disable >= %d%%, enable < %d%%, temp window %s",
             args.upper, args.lower,
             "off" if args.no_temp else f"{args.min_temp}..{args.max_temp}°C")
    try:
        limiter.run()
    finally:
        limiter.shutdown()


if __name__ == "__main__":
    main()
