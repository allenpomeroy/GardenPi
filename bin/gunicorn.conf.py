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
# Usage:
#   gunicorn -c gunicorn.conf.py --bind 0.0.0.0:5000 --workers 4 \
#            --certfile /etc/pki/tls/certs/node.pem \
#            --keyfile /etc/pki/tls/private/node.key \
#            --timeout 30 \
#            'api:create_app()'
#
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
