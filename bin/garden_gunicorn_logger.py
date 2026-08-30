# garden_gunicorn_logger.py
#
# Custom gunicorn Logger for api.py.
#
# gunicorn's default Logger.access() always logs access lines at INFO,
# regardless of the HTTP status code. GardenGunicornLogger overrides just
# that method to pick info/warning/error the same way api.py's own
# _log() helper does, so a failed request stands out in the log at a
# glance instead of looking identical to a successful one.
#
# Paired with gunicorn.conf.py, which routes this logger's output through
# garden_logger.ISOFormatter so gunicorn's access/error lines share the
# same timestamp format and severity labels as the application's own log
# lines.
#
# v1.0 2026/08/25 - initial version
import traceback

from gunicorn.glogging import Logger as GunicornBaseLogger


class GardenGunicornLogger(GunicornBaseLogger):
    def access(self, resp, req, environ, request_time):
        # See http://httpd.apache.org/docs/2.0/logs.html#combined
        # for format details. Mirrors gunicorn's own Logger.access(),
        # except the log level depends on the response status.
        if not self.access_log_enabled:
            return

        safe_atoms = self.atoms_wrapper_class(
            self.atoms(resp, req, environ, request_time)
        )

        status = resp.status
        if isinstance(status, str):
            status = status.split(None, 1)[0]
        try:
            status_code = int(status)
        except (TypeError, ValueError):
            status_code = 0

        try:
            if status_code >= 500:
                self.access_log.error(self.cfg.access_log_format, safe_atoms)
            elif status_code >= 400:
                self.access_log.warning(self.cfg.access_log_format, safe_atoms)
            else:
                self.access_log.info(self.cfg.access_log_format, safe_atoms)
        except Exception:
            self.error(traceback.format_exc())
