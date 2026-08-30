# garden_logger.py
#
# Centralized logging function for all GardenPi python scripts
#
# Usage example in upstream scripts
#
# import logging
# from garden_logger import init_logging
#
# init_logging(level=logging.DEBUG)      # by logging constant
# init_logging(level="warn")             # or by name (debug/info/warn/error/critical)
#
# log = logging.getLogger(__name__)
#
#  log.critical("Payment gateway connection timed out.")
#  log.error("Could not write payload to file cache.")
#  log.warning("API response latency is higher than 500ms.")
#  log.info("Worker thread #4 spawned successfully.")
#  log.debug("Database query took 4.12ms: SELECT * FROM users;")
#
# v1.3 2026/08/27
# - renamed "daemon" -> "handler" throughout (terminology only; no
#   behavior change) to match the rest of the v3.0 release
# v1.2 2026/08/25
# - added resolve_effective_level() so handlers no longer each reimplement
#   the "more restrictive of two configured levels" comparison themselves
# v1.1 2026/08/25
# - added support for string log levels (e.g. "warn", "debug") so upstream
#   scripts can set severity without importing the logging module directly
# v1.0 2026/08/25
# - initial version
import logging
import os
import sys
from datetime import datetime

# Accepted string aliases -> logging module constants.
# Both "warn" and "warning" are accepted since the syslog-style output below
# displays "warn", but Python's logging module itself calls it "WARNING".
LEVEL_ALIASES = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warn": logging.WARNING,
    "warning": logging.WARNING,
    "error": logging.ERROR,
    "critical": logging.CRITICAL,
}


def _resolve_level(level):
  # Accepts either a logging constant (e.g. logging.DEBUG / 10) or a
  # case-insensitive string (e.g. "debug", "WARN") and returns the
  # corresponding logging module constant.
  if isinstance(level, str):
    key = level.strip().lower()
    if key not in LEVEL_ALIASES:
      valid = ", ".join(sorted(set(LEVEL_ALIASES.keys())))
      raise ValueError(f"Unknown log level '{level}'. Valid options: {valid}")
    return LEVEL_ALIASES[key]
  return level


def resolve_effective_level(handler_level, global_level):
  # Given a per-handler level and a global level (each either a logging
  # constant or a string name), returns the numerically higher - i.e. more
  # restrictive/severe - of the two as a logging module constant.
  #
  # This lets a stricter global_log_level clamp down a noisier per-handler
  # log_level, without letting the handler override a stricter global
  # setting. Used by handlers that support both config.global_log_level and
  # their own handlers.<name>.log_level.
  resolved_handler = _resolve_level(handler_level)
  resolved_global = _resolve_level(global_level)
  return resolved_handler if resolved_handler >= resolved_global else resolved_global


class ISOFormatter(logging.Formatter):
  # Formats log records with ISO 8601 timestamps and lowercase syslog labels.
  def formatTime(self, record, datefmt=None):
    dt = datetime.fromtimestamp(record.created)
    return dt.isoformat(timespec="milliseconds")
  def format(self, record):
    level_mapping = {
        "DEBUG": "debug",
        "INFO": "info",
        "WARNING": "warn",
        "ERROR": "error",
        "CRITICAL": "critical",
    }
    record.syslog_level = level_mapping.get(
        record.levelname, record.levelname.lower()
    )
    return super().format(record)


def init_logging(level=logging.INFO):
  # Initializes global console logging with the custom ISO/Syslog format.
  # `level` sets the minimum severity that will be displayed: any message
  # logged below this level is suppressed. Accepts either a logging
  # constant (logging.DEBUG, logging.WARNING, ...) or a string name
  # ("debug", "warn", "error", "critical", "info").
  #
  # Example: level="warn" displays warn/error/critical, but suppresses
  # info and debug messages.
  resolved_level = _resolve_level(level)

  # Get the root logger so this applies to all scripts and sub-modules
  root_logger = logging.getLogger()
  root_logger.setLevel(resolved_level)

  # Prevent adding duplicate handlers if init_logging is called multiple times
  if not root_logger.handlers:
    handler = logging.StreamHandler(sys.stdout)
    formatter = ISOFormatter(
        fmt="%(asctime)s %(syslog_level)s: %(message)s", datefmt=None
    )
    handler.setFormatter(formatter)
    root_logger.addHandler(handler)
  else:
    # Handler(s) already exist (init_logging called again) - just make sure
    # they also respect the newly requested level.
    for h in root_logger.handlers:
      h.setLevel(resolved_level)
