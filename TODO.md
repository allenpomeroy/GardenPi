# TODO List

As of 2026/09/23

## Errors and errata

(none open)

## Additional functionality and enhancements

- Remove the config keyword for API Access Token under webui. Just have
  the webui use the handlers.api.token versus a duplicate webui.api_token
  Then remove the API Access Token field from Configuration > Web UI

- Consider setting the rain delay automatically from the weather station's
  rain gauge (e.g. more than N inches in the last 24 hours -> 2-day delay).

- Consider a per-service "View log" button on Configuration > Services
  (last N lines of `journalctl -u <service>`; the webui user would need to
  be in the `systemd-journal` group, no sudo needed)

## Done

- 2026/10/02 PiJuice battery charge limiter (`bin/pijuice-charge-limiter.py`,
  `pijuice-charge-limiter.service`) holds the battery at 45-50% and blocks
  charging outside 0-40°C. `install-gardenpi.sh` installs `pijuice-base`;
  `add-services.sh` installs and starts the service when `pijuice` imports
  (`--no-charge-limiter` to leave it out).

- 2026/10/02 sudoers: the service user may run any command with sudo after
  entering its password (`setup-sudoers.sh --no-admin` to leave it out); the
  password-less systemctl / shutdown rules are unchanged.

- 2026/10/02 API: `GET /api/irrigation/rain-delay` reports whether the rain
  delay is active, when it ends and who set it (read-only, token-protected).
  Documented in Configuration > API Reference.

- 2026/10/02 Schedule tab: **Rain delay**. Pause all scheduled watering for
  1/2/3/7 days or through a chosen date (max 30), with +1 day and Cancel.
  Stops a scheduled run in progress; manual runs unaffected. Shown on the
  dashboard Scheduler widget and in Recent Activity.

- 2026/10/02 Schedule tab: **Skip next** column. Skips one run of a window
  and then clears itself; the header checkbox skips the next run of every
  window for that valve (a week off in one click). Skipped runs are logged
  in Recent Activity and shown as SKIPPED / struck-through in Next run.

- 2026/09/23 System uptime badge in the header, left of the API badge
  (`Up 5h 12m`, `Up 45d 3h`, `Up 1y 45d`; hover for exact boot time).

- 2026/09/23 `config.last_changed` and `config.version` are now updated on
  Configuration > Save changes (patch version bump, local timestamp). A save
  with no real changes is a no-op.
- 2026/09/23 Restart services from the web UI (Configuration > Services):
  status of every gardenpi-* service, a Restart button for each, and
  Restart All. No Stop button, by design.
  - `scripts/setup-sudoers.sh` grants the exact, password-less sudo rules
    needed; `install-gardenpi.sh` runs it.
- 2026/09/23 System Reboot and Shut down buttons (typed confirmation; all
  valves/pumps are turned off first). Shut down runs
  `scripts/pijuice-safe-shutdown.py` so the PiJuice powers the Pi back on
  when external power returns; refused if the PiJuice doesn't answer.
- 2026/09/23 install-gardenpi.sh: runs from any directory; the missing
  `add-remove-logs-crontab.sh` now exists.
