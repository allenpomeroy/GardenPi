# garden_config.py
#
# Shared strict-config-lookup helpers for the GardenPi handlers/scripts.
#
# All configuration must come from garden.json. Values are never silently
# substituted with a hardcoded default: if a required key is missing,
# require() raises ConfigError naming the exact dotted path that needs to
# be added to garden.json. Callers are expected to let this propagate up
# to a top-level "log/print fatal error, exit" handler rather than
# continue with a guessed value.
#
# The only hardcoded default any of these scripts use is the path
# to garden.json itself (DEFAULT_CONFIG_FILE in each script) - you have to
# know where to look before you can read what's required from it.
#
# v2.0 2026/08/27
# - added build_id_map()/resolve_id()/display_id() - shared helpers for the
#   hardware source > pin > hardware_id > user_id > friendly name mapping
#   used by handlers.adc.channel_map, handlers.irrigation.relay_map, and
#   handlers.weather.input_map. hardware_id is always read-only; user_id
#   (when present) is what clients should send and what should be shown -
#   otherwise hardware_id is shown/accepted instead.
# - added pin_for_hardware_id() to look up a hardware.<source>.pin_map entry
#   by hardware_id and (optional) pin "type" (gpio/led/adc/relay).
# v1.0 2026/08/25 - initial version


class ConfigError(Exception):
    """Raised when a required garden.json value is missing or empty."""


def require(d, key, path):
    """
    Look up `key` in mapping `d`. Raises ConfigError naming the full
    dotted `path` (e.g. "handlers.adc.socket") if the key is
    absent, so the error tells the operator exactly what to add to
    garden.json - no hardcoded fallback is substituted.
    """
    if not isinstance(d, dict) or key not in d:
        raise ConfigError(f"Missing required config value: {path}")
    return d[key]


def require_nonempty(d, key, path):
    """
    Like require(), but also rejects an empty dict/list/string - for
    config sections that must actually contain entries (e.g.
    handlers.adc.channel_map), not just be present-but-empty.
    """
    value = require(d, key, path)
    if not value:
        raise ConfigError(f"Config value is empty: {path}")
    return value


def parse_i2c_addr(raw, path):
    """
    Parses an I2C address from config (a hex string like "0x24", or an
    int) into an int. Raises ConfigError naming `path` if the value can't
    be parsed - no hardcoded fallback address is substituted.
    """
    try:
        return int(raw, 16) if isinstance(raw, str) else int(raw)
    except (TypeError, ValueError):
        raise ConfigError(f"{path} is not a valid integer/hex value: {raw!r}")


def pin_for_hardware_id(pin_map, hardware_id, pin_type=None):
    """
    Look up the physical pin number for `hardware_id` in a
    hardware.<source>.pin_map list (entries shaped
    {"hardware_id": ..., "pin": ..., "type": ...}). If `pin_type` is
    given, only an entry matching both hardware_id and type is returned.
    Returns None if no match is found - callers decide whether that's
    fatal.
    """
    for entry in pin_map or []:
        if entry.get("hardware_id") != hardware_id:
            continue
        if pin_type is not None and entry.get("type") != pin_type:
            continue
        return entry.get("pin")
    return None


def build_id_map(entries, path):
    """
    Build lookup structures from a handler map list (channel_map,
    relay_map, input_map, led_map - all shaped as a list of dicts with a
    read-only "hardware_id" plus optional "user_id"/"friendly"/"group"/
    "aliases"). Returns a dict:

      {
        "by_hardware_id": {hardware_id: entry, ...},
        "lookup": {token: hardware_id, ...},   # hardware_id, user_id,
                                                # and any aliases all
                                                # resolve to hardware_id
        "order": [hardware_id, ...],           # original order
      }

    Raises ConfigError (naming `path`) if `entries` is empty, if any
    entry is missing "hardware_id", or if two entries collide on the
    same lookup token (e.g. two hardware_ids sharing a user_id).
    """
    if not entries:
        raise ConfigError(f"{path} contained no usable entries")

    by_hardware_id = {}
    lookup = {}
    order = []

    for entry in entries:
        hardware_id = entry.get("hardware_id")
        if not hardware_id:
            raise ConfigError(f"{path} has an entry with no hardware_id: {entry!r}")
        if hardware_id in by_hardware_id:
            raise ConfigError(f"{path} defines hardware_id '{hardware_id}' more than once")

        by_hardware_id[hardware_id] = entry
        order.append(hardware_id)

        tokens = [hardware_id]
        user_id = entry.get("user_id")
        if user_id:
            tokens.append(user_id)
        tokens.extend(entry.get("aliases", []))

        for token in tokens:
            existing = lookup.get(token)
            if existing is not None and existing != hardware_id:
                raise ConfigError(
                    f"{path}: '{token}' resolves to both '{existing}' and "
                    f"'{hardware_id}' - identifiers must be unique"
                )
            lookup[token] = hardware_id

    return {"by_hardware_id": by_hardware_id, "lookup": lookup, "order": order}


def resolve_id(id_map, token):
    """
    Resolve a client-supplied token (hardware_id, user_id, or alias) to
    its canonical, read-only hardware_id. Returns None if the token is
    unknown.
    """
    return id_map["lookup"].get(token)


def display_id(id_map, hardware_id):
    """
    The identifier that should be shown/returned to a caller for a given
    hardware_id: its user_id if one is defined, otherwise the hardware_id
    itself. Matches the rule "always return user_id if defined, otherwise
    hardware_id".
    """
    entry = id_map["by_hardware_id"].get(hardware_id, {})
    return entry.get("user_id") or hardware_id
