# gunicorn.conf.py
#
# Gunicorn logging configuration for api.py.
#
# Goals:
#   - Route gunicorn's access/error logs through the same
#     garden_logger.ISOFormatter used by the Flask app, so every log line
#     (app + gunicorn) shares one timestamp format and severity vocabulary
#     instead of two different date/log formats side by side.
#   - Vary gunicorn's own access-log level with the HTTP status code
#     (info/warning/error) via GardenGunicornLogger, instead of gunicorn's
#     default of always logging every access line at INFO.
#   - Trim the access log format down to just the fields api.py's
#     own request logging doesn't already provide - client IP, bytes sent,
#     user-agent. Method/path/status are dropped here since they're
#     redundant with api.py's own "[METHOD] url - status" lines.
#
#   - Take the listen port (handlers.api.listen_port) and the TLS
#     certificate and key (config.tls_cert_file / config.tls_key_file, the
#     same settings the web UI uses) from garden.json, instead of values
#     hard-coded on the gunicorn command line.
#
# Usage (gunicorn loads ./gunicorn.conf.py from its working directory
# automatically, so -c is optional when run from /opt/gardenpi/bin):
#   gunicorn -c gunicorn.conf.py --workers 4 \
#            --timeout 30 \
#            'api:create_app()'
# Passing --bind / --certfile / --keyfile on the command line still works
# and overrides garden.json.
#
# v1.1 2026/09/25 - bind (listen port), certfile and keyfile from garden.json
# v1.0 2026/08/25 - initial version

logger_class = "garden_gunicorn_logger.GardenGunicornLogger"

accesslog = "-"   # stdout - journald/systemd captures it
errorlog = "-"

# Only the fields api.py's own logging doesn't already cover:
# client IP, bytes sent, user-agent.
access_log_format = '%(h)s "%(r)s" %(s)s %(b)s "%(a)s"'

logconfig_dict = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "garden": {
            "()": "garden_logger.ISOFormatter",
            "fmt": "%(asctime)s %(syslog_level)s: %(message)s",
        },
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "garden",
        },
    },
    "loggers": {
        "gunicorn.error": {
            "handlers": ["console"],
            "level": "INFO",
            "propagate": False,
        },
        "gunicorn.access": {
            "handlers": ["console"],
            "level": "INFO",
            "propagate": False,
        },
    },
}


# ---- Listen port and TLS: from garden.json ----
# Same file api.py reads (DEFAULT_CONFIG_FILE there). If it can't be read,
# or a value is missing, fall back to the long-standing defaults (port 5000,
# /etc/pki/tls/...) so the API behaves exactly as it did before these
# settings were read here. A listen_port that is set but isn't a valid port
# stops the API with a clear message (api.py itself also refuses a
# non-numeric one), rather than quietly listening somewhere else.
import json as _json

_GARDEN_JSON = "/opt/gardenpi/config/garden.json"
_DEFAULT_CERT = "/etc/pki/tls/certs/node.pem"
_DEFAULT_KEY = "/etc/pki/tls/private/node.key"

_DEFAULT_PORT = 5000

try:
    with open(_GARDEN_JSON) as _f:
        _garden = _json.load(_f) or {}
except (OSError, ValueError):
    _garden = {}
_cfg = _garden.get("config", {}) or {}

_raw_port = ((_garden.get("handlers") or {}).get("api") or {}).get("listen_port")
if _raw_port is None or str(_raw_port).strip() == "":
    _port = _DEFAULT_PORT
else:
    try:
        _port = int(str(_raw_port).strip())
    except ValueError:
        _port = 0
    if not 1 <= _port <= 65535:
        raise SystemExit(
            f"garden.json handlers.api.listen_port is {_raw_port!r}; "
            "it must be a port number from 1 to 65535.")

bind = [f"0.0.0.0:{_port}"]

certfile = _cfg.get("tls_cert_file") or _DEFAULT_CERT
keyfile = _cfg.get("tls_key_file") or _DEFAULT_KEY
