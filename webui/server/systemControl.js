// GardenPi Control v2.1.0 — server/systemControl.js
//
// Status and restart of the gardenpi-* systemd services, plus system
// reboot/shutdown, for the Configuration page's Services card.
//
// Privilege model: status is read with plain `systemctl show` (no root
// needed). Every state-changing action runs as
//
//     sudo -n <systemctl> <exact argument list>
//
// and relies on /etc/sudoers.d/gardenpi, written by
// scripts/setup-sudoers.sh, which allows EXACTLY those command lines for
// the webui's service user and nothing else (no wildcards -- a `*` in a
// sudoers argument list also matches spaces, so "restart gardenpi-*"
// would let a caller append any other unit). `-n` makes sudo fail
// immediately instead of hanging on a password prompt if sudoers isn't set
// up, which is surfaced to the UI as a friendly "run setup-sudoers.sh" hint.
//
// !! The unit list and the restart-all argument order below MUST match
// !! scripts/setup-sudoers.sh exactly, or sudo will refuse the command.
//
// Deliberately NOT offered: stopping a service. If gardenpi-webui stops,
// the only way back is an ssh session.
//
// Shutdown does NOT call systemctl poweroff / shutdown directly. It runs
// scripts/pijuice-safe-shutdown.py, which first arms the PiJuice (wake up
// on charge, cut the 5V rail 60s later) and then runs
// `sudo shutdown -h now` itself -- without that arming step the PiJuice
// never turns the Pi back on after a power outage.
//
// The script runs as this web UI's own user, NOT via sudo as root:
// /opt/gardenpi is owned by the service user (fix-perms.sh), so a sudo
// rule running a file that user can edit would hand it root. The only
// root command involved is the script's own `shutdown -h now`, which
// setup-sudoers.sh allows as that exact command line.
const fs = require('fs');
const { execFile } = require('child_process');
const logger = require('./logger');

const SUDO = '/usr/bin/sudo';
// Prefer /usr/bin (Raspberry Pi OS bookworm and any merged-/usr system);
// setup-sudoers.sh resolves the same path with the same rule.
const SYSTEMCTL = fs.existsSync('/usr/bin/systemctl') ? '/usr/bin/systemctl' : '/bin/systemctl';
// Same resolution rule as setup-sudoers.sh. Only used for the sudo -l
// pre-flight: the script itself runs a bare `sudo shutdown -h now`, and
// sudo resolves that through secure_path to this same path.
const SHUTDOWN = fs.existsSync('/usr/sbin/shutdown') ? '/usr/sbin/shutdown' : '/sbin/shutdown';
const SHUTDOWN_ARGS = ['-h', 'now'];
// System python (not the /opt/gardenpi/python3 venv): the pijuice module
// comes from the pijuice-base apt package, and the script's shebang is
// /usr/bin/python3. Invoked explicitly so the file's exec bit doesn't matter.
const PYTHON = '/usr/bin/python3';
const PIJUICE_SHUTDOWN_SCRIPT = process.env.GARDENPI_PIJUICE_SHUTDOWN_SCRIPT || '/opt/gardenpi/scripts/pijuice-safe-shutdown.py';
// Read-only PiJuice check, run before shutting down: proves the module
// imports, the I2C bus is accessible to this user, and the PiJuice at
// 0x14 answers. If any of that fails, the arming step in the shutdown
// script would fail too and the Pi would go down with nothing set to wake
// it -- so the shutdown is refused instead.
const PIJUICE_PROBE = [
  'import sys',
  'from pijuice import PiJuice',
  'r = PiJuice(1, 0x14).status.GetStatus()',
  "sys.exit(0 if isinstance(r, dict) and r.get('error') == 'NO_ERROR' else 2)"
].join('\n');

// Startup order, matching add-services.sh / restart-services.sh.
const SERVICES = [
  { unit: 'gardenpi-init.service', label: 'Hardware init', oneshot: true },
  { unit: 'gardenpi-leds.service', label: 'LEDs handler' },
  { unit: 'gardenpi-adc.service', label: 'ADC handler' },
  { unit: 'gardenpi-irrigation.service', label: 'Irrigation handler' },
  { unit: 'gardenpi-weather.service', label: 'Weather handler' },
  { unit: 'gardenpi-api.service', label: 'API' },
  { unit: 'gardenpi-webui.service', label: 'Web UI', self: true }
];
const SELF_UNIT = 'gardenpi-webui.service';

// "Restart all" = every long-running service (init is excluded: it's a
// one-shot hardware init, and re-running it resets the MCP23017 under the
// running handlers). One `systemctl restart a b c ...` call puts all of
// them in a single systemd transaction, which stops them in reverse
// After= order and starts them in forward order -- the same sequencing
// restart-services.sh does by hand.
const RESTART_ALL_UNITS = SERVICES.filter(s => !s.oneshot).map(s => s.unit);

const PROPS = ['Id', 'Description', 'LoadState', 'ActiveState', 'SubState',
  'Result', 'UnitFileState', 'ActiveEnterTimestamp', 'ExecMainStartTimestamp', 'MainPID'];

function run(file, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function systemdAvailable() {
  return process.platform === 'linux' && fs.existsSync(SYSTEMCTL);
}

function findService(unit) {
  const normalized = unit.endsWith('.service') ? unit : `${unit}.service`;
  return SERVICES.find(s => s.unit === normalized) || null;
}

// Turns a sudo/systemctl failure into something a person can act on.
function friendlyError(result, what) {
  const text = `${result.stderr}\n${result.stdout}`.trim();
  if (/password is required|a terminal is required|not allowed to execute|may not run sudo|not in the sudoers/i.test(text)) {
    return `${what} is not permitted for this web UI's user yet. On the Pi, run: sudo /opt/gardenpi/scripts/setup-sudoers.sh`;
  }
  if (result.err && result.err.killed) return `${what} timed out. Check "journalctl -u <service>" on the Pi.`;
  if (result.err && result.err.code === 'ENOENT') return `${what} failed: sudo or systemctl was not found on this system.`;
  const firstLine = text.split('\n').find(Boolean);
  return `${what} failed${firstLine ? `: ${firstLine}` : '.'}`;
}

// Parses `systemctl show a b c --property=...` output: one KEY=VALUE block
// per unit, blocks separated by a blank line.
function parseShow(stdout) {
  const byId = {};
  for (const block of stdout.split(/\n\s*\n/)) {
    const props = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) props[line.slice(0, i)] = line.slice(i + 1);
    }
    if (props.Id) byId[props.Id] = props;
  }
  return byId;
}

function systemdTimestampToIso(ts) {
  if (!ts || ts === 'n/a' || ts === '0') return null;
  const d = new Date(ts.replace(/^[A-Za-z]{3}\s+/, '').replace(/\s+[A-Z]{2,5}$/, ''));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Cached for a minute: a `sudo -l` check per page view is plenty.
let sudoCheck = { at: 0, ok: null };
async function sudoConfigured() {
  if (Date.now() - sudoCheck.at < 60000 && sudoCheck.ok !== null) return sudoCheck.ok;
  // `sudo -n -l <cmd>` only asks whether <cmd> would be allowed; it never runs it.
  const r = await run(SUDO, ['-n', '-l', SYSTEMCTL, 'restart', SERVICES[1].unit], { timeoutMs: 5000 });
  sudoCheck = { at: Date.now(), ok: r.code === 0 };
  return sudoCheck.ok;
}

async function listServices() {
  if (!systemdAvailable()) {
    return { ok: false, message: 'systemd is not available on this machine, so services cannot be listed or restarted from here.' };
  }
  const units = SERVICES.map(s => s.unit);
  const r = await run(SYSTEMCTL, ['show', ...units, `--property=${PROPS.join(',')}`], { timeoutMs: 10000 });
  if (r.code !== 0 && !r.stdout) {
    return { ok: false, message: friendlyError(r, 'Reading service status') };
  }
  const byId = parseShow(r.stdout);
  const services = SERVICES.map(s => {
    const p = byId[s.unit] || {};
    const installed = p.LoadState === 'loaded';
    return {
      unit: s.unit,
      name: s.unit.replace(/\.service$/, ''),
      label: s.label,
      description: p.Description || '',
      installed,
      activeState: installed ? (p.ActiveState || 'unknown') : 'not-installed',
      subState: p.SubState || '',
      result: p.Result || '',
      enabled: p.UnitFileState || '',
      since: systemdTimestampToIso(p.ActiveEnterTimestamp) || systemdTimestampToIso(p.ExecMainStartTimestamp),
      mainPid: Number(p.MainPID) || null,
      oneshot: !!s.oneshot,
      self: !!s.self
    };
  });
  return { ok: true, services, restartControlsEnabled: await sudoConfigured() };
}

async function restartService(unit) {
  const svc = findService(unit);
  if (!svc) {
    const err = new Error(`"${unit}" is not a GardenPi service.`);
    err.code = 'BAD_INPUT';
    throw err;
  }
  if (!systemdAvailable()) throw Object.assign(new Error('systemd is not available on this machine.'), { code: 'BAD_INPUT' });
  logger.info('Restarting service via web UI', { unit: svc.unit });
  const r = await run(SUDO, ['-n', SYSTEMCTL, 'restart', svc.unit], { timeoutMs: 90000 });
  if (r.code !== 0) {
    const message = friendlyError(r, `Restarting ${svc.unit}`);
    logger.warn('Service restart failed', { unit: svc.unit, code: r.code, stderr: r.stderr.trim() });
    throw Object.assign(new Error(message), { code: 'BAD_INPUT' });
  }
  return svc;
}

// Everything below replaces the running web UI process (restart of
// gardenpi-webui itself, restart-all, reboot, poweroff), so the HTTP
// response must go out FIRST. These fire after a short delay; the caller
// has already answered the request. systemd owns the job once systemctl
// hands it over, so the job completes even though this process is killed
// part-way through it.
function runDetachedAfterResponse(args, what, delayMs = 750) {
  setTimeout(async () => {
    logger.info(`${what} (via web UI)`, { command: [SYSTEMCTL, ...args].join(' ') });
    const r = await run(SUDO, ['-n', SYSTEMCTL, ...args], { timeoutMs: 120000 });
    // Only reached if this process survived (e.g. sudo refused the command).
    if (r.code !== 0) logger.error(`${what} failed`, { code: r.code, stderr: r.stderr.trim() });
  }, delayMs);
}

// Pre-flight for detached actions: since their result can't be reported
// back, check with `sudo -n -l` first that the exact command is allowed,
// so a missing sudoers entry is a clear error instead of silence.
async function assertAllowed(args, what) {
  if (!systemdAvailable()) throw Object.assign(new Error('systemd is not available on this machine.'), { code: 'BAD_INPUT' });
  const r = await run(SUDO, ['-n', '-l', SYSTEMCTL, ...args], { timeoutMs: 5000 });
  if (r.code !== 0) throw Object.assign(new Error(friendlyError(r, what)), { code: 'BAD_INPUT' });
}

async function scheduleSelfRestart() {
  await assertAllowed(['restart', SELF_UNIT], 'Restarting the web UI');
  runDetachedAfterResponse(['restart', SELF_UNIT], 'Restarting web UI');
}

async function scheduleRestartAll() {
  await assertAllowed(['restart', ...RESTART_ALL_UNITS], 'Restarting all services');
  runDetachedAfterResponse(['restart', ...RESTART_ALL_UNITS], 'Restarting all GardenPi services');
}

// Split in two so the caller can do work (stop the relays) between
// "is this allowed?" and "do it".
function powerWhat(action) {
  if (action !== 'reboot' && action !== 'poweroff') {
    throw Object.assign(new Error('Unknown power action.'), { code: 'BAD_INPUT' });
  }
  return action === 'reboot' ? 'Rebooting the system' : 'Shutting down the system';
}

async function checkPowerAllowed(action) {
  const what = powerWhat(action);
  if (action === 'reboot') {
    await assertAllowed(['reboot'], what);
    return;
  }

  // Shutdown pre-flight: every piece the PiJuice script needs, checked
  // before anything is stopped, since its result can't be reported back.
  if (!fs.existsSync(PIJUICE_SHUTDOWN_SCRIPT)) {
    throw Object.assign(new Error(`Shutdown script not found at ${PIJUICE_SHUTDOWN_SCRIPT}.`), { code: 'BAD_INPUT' });
  }
  if (!fs.existsSync(PYTHON)) {
    throw Object.assign(new Error(`${PYTHON} not found; it is needed to run the PiJuice shutdown script.`), { code: 'BAD_INPUT' });
  }
  const probe = await run(PYTHON, ['-c', PIJUICE_PROBE], { timeoutMs: 10000 });
  if (probe.code !== 0) {
    const detail = `${probe.stderr}`.trim().split('\n').pop() || '';
    let message = 'Shutdown refused: the PiJuice is not reachable, so it could not be set to power the Pi back on.';
    if (/No module named ['"]?pijuice/i.test(probe.stderr)) {
      message += ' The pijuice Python module is not installed (sudo apt install pijuice-base).';
    } else if (/Permission denied|Errno 13/i.test(probe.stderr)) {
      message += " This web UI's user cannot open the I2C bus (add it to the i2c group: sudo usermod -aG i2c pi, then restart).";
    } else if (detail) {
      message += ` (${detail})`;
    }
    logger.warn('PiJuice pre-flight check failed; shutdown refused', { code: probe.code, stderr: probe.stderr.trim() });
    throw Object.assign(new Error(message), { code: 'BAD_INPUT' });
  }
  const r = await run(SUDO, ['-n', '-l', SHUTDOWN, ...SHUTDOWN_ARGS], { timeoutMs: 5000 });
  if (r.code !== 0) throw Object.assign(new Error(friendlyError(r, what)), { code: 'BAD_INPUT' });
}

function schedulePower(action) {
  const what = powerWhat(action);
  if (action === 'reboot') {
    runDetachedAfterResponse(['reboot'], what, 1500);
    return;
  }
  setTimeout(async () => {
    logger.warn('Shutting down via PiJuice safe-shutdown script (via web UI)', { script: PIJUICE_SHUTDOWN_SCRIPT });
    const r = await run(PYTHON, [PIJUICE_SHUTDOWN_SCRIPT], { timeoutMs: 60000 });
    // Normally never reached: the script's `shutdown -h now` takes this
    // process down first. If we get here, something in the script failed.
    if (r.code !== 0) {
      logger.error('PiJuice shutdown script failed', { code: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim() });
    } else {
      logger.warn('PiJuice shutdown script exited but the system is still up', { stdout: r.stdout.trim(), stderr: r.stderr.trim() });
    }
  }, 1500);
}

module.exports = {
  SERVICES,
  SELF_UNIT,
  RESTART_ALL_UNITS,
  SYSTEMCTL,
  SHUTDOWN,
  PIJUICE_SHUTDOWN_SCRIPT,
  findService,
  listServices,
  restartService,
  scheduleSelfRestart,
  scheduleRestartAll,
  checkPowerAllowed,
  schedulePower,
  _internal: { parseShow, systemdTimestampToIso, friendlyError }
};
