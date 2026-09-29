// GardenPi Control v2.4.1 — server/networkInfo.js
//
// Works out the controller's operational ("primary") IP address for the
// Configuration page.
//
// With more than one interface up (wlan0 + eth0, a VPN, docker0, ...),
// "primary" means the address this Pi uses to reach the host that
// bin/check-wifi.sh pings to decide whether the network is working (its
// dest1=...), i.e. the same source address `ip route get <dest1>` reports.
// That address is read from check-wifi.sh itself, so there's one place to
// change it.
//
// How: ask the kernel with `ip -4 route get <dest1>`, which reports both
// the outgoing interface (dev) and the source address (src) it would use.
// Taking the interface name from the route matters when two interfaces
// share an address (e.g. wlan0 and wlan1 both 10.20.31.14): matching the
// address alone can't tell them apart. Nothing is sent.
//
// If `ip` isn't available, fall back to opening a UDP socket and
// connect()ing it to dest1 -- for UDP that also sends nothing, just picks
// the route -- and reading the source address from socket.address(), with
// the interface name matched from os.networkInterfaces().
//
// Fallbacks, in order: the route to a public address (1.1.1.1, again
// nothing is sent), then the first non-internal IPv4 address. The result
// says which method was used.
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { execFile } = require('child_process');

const IP_BIN = ['/usr/sbin/ip', '/sbin/ip', '/usr/bin/ip', '/bin/ip'].find(p => fs.existsSync(p)) || null;

const CHECK_WIFI = path.resolve(__dirname, '..', '..', 'bin', 'check-wifi.sh');
const PUBLIC_PROBE = '1.1.1.1';
const CACHE_MS = 30000; // DHCP renewals etc. are picked up within 30s

let cache = { at: 0, value: null };

// dest1="10.20.31.100" (quotes optional) from check-wifi.sh, or null.
function readCheckWifiTarget() {
  try {
    const text = fs.readFileSync(CHECK_WIFI, 'utf8');
    const m = /^\s*dest1\s*=\s*["']?([0-9]{1,3}(?:\.[0-9]{1,3}){3})["']?\s*$/m.exec(text);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// { address, interface } from `ip -4 route get <target>`, or null.
// Output looks like:
//   10.20.31.100 dev wlan1 src 10.20.31.14 uid 1000
//   1.1.1.1 via 10.20.31.1 dev eth0 src 10.20.31.15 uid 1000
function routeFor(target) {
  if (!IP_BIN) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(IP_BIN, ['-4', 'route', 'get', target], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = String(stdout).split('\n')[0];
      const src = /\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})/.exec(line);
      const dev = /\bdev\s+(\S+)/.exec(line);
      resolve(src ? { address: src[1], interface: dev ? dev[1] : null } : null);
    });
  });
}

// Source address the kernel would use to reach `target`, or null.
// (Fallback for systems without `ip`.)
function sourceAddressFor(target) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const done = (value) => { try { sock.close(); } catch { /* already closed */ } resolve(value); };
    const timer = setTimeout(() => done(null), 1000);
    sock.on('error', () => { clearTimeout(timer); done(null); });
    // Any port works: connect() on UDP only selects a route.
    sock.connect(9, target, (err) => {
      clearTimeout(timer);
      if (err) return done(null);
      try {
        const addr = sock.address().address;
        done(addr && addr !== '0.0.0.0' ? addr : null);
      } catch {
        done(null);
      }
    });
  });
}

function ipv4Interfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

async function determine() {
  const interfaces = ipv4Interfaces();
  const nameFor = addr => interfaces.find(i => i.address === addr)?.name || null;
  const target = readCheckWifiTarget();

  // Route lookup for `probe`: the kernel's own answer (address + interface)
  // when `ip` works, else the UDP method (address; name matched by address).
  const lookup = async (probe) => {
    const route = await routeFor(probe);
    if (route) return route;
    const address = await sourceAddressFor(probe);
    return address ? { address, interface: nameFor(address) } : null;
  };

  let found = null;
  let method = null;
  if (target) {
    found = await lookup(target);
    if (found) method = `route to ${target} (check-wifi.sh)`;
  }
  if (!found) {
    found = await lookup(PUBLIC_PROBE);
    if (found) method = 'default route';
  }
  if (!found && interfaces.length) {
    found = { address: interfaces[0].address, interface: interfaces[0].name };
    method = 'first network interface';
  }
  const address = found?.address || null;

  return {
    address,
    interface: found?.interface || null,
    method,
    checkWifiTarget: target,
    // Every other interface/address pair -- including another interface
    // that shares the same address, so a duplicate is visible.
    others: interfaces.filter(i => !(i.address === address && (!found?.interface || i.name === found.interface)))
  };
}

async function getPrimaryAddress() {
  if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = await determine();
  cache = { at: Date.now(), value };
  return value;
}

module.exports = { getPrimaryAddress, _internal: { readCheckWifiTarget, routeFor, sourceAddressFor, ipv4Interfaces, determine } };
