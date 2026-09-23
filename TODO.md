# TODO List

As of 2026/09/23

## Errors and errata

(none open)

## Additional functionality

- consider a per-service "View log" button on Configuration > Services
  (last N lines of `journalctl -u <service>`; the webui user would need to
  be in the `systemd-journal` group, no sudo needed)

## Done

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
