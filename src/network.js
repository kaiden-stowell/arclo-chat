'use strict';

const os = require('os');

/**
 * Find the first non-internal IPv4 interface — the machine's LAN address.
 * Returns null when the machine is offline / has no LAN interface.
 */
function getLanInterface() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) {
        return { name, address: info.address, netmask: info.netmask };
      }
    }
  }
  return null;
}

/** Strip the IPv6-mapped IPv4 prefix (`::ffff:`) that Node adds on dual-stack sockets. */
function normalizeIp(ip) {
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (Number.isNaN(n) || n < 0 || n > 255) return null;
    acc = (acc << 8) + n;
  }
  return acc >>> 0;
}

/** True when `ip` is inside the subnet defined by `netAddress` + `netmask`. */
function ipInSubnet(ip, netAddress, netmask) {
  const i = ipToInt(ip);
  const n = ipToInt(netAddress);
  const m = ipToInt(netmask);
  if (i === null || n === null || m === null) return false;
  return ((i & m) >>> 0) === ((n & m) >>> 0);
}

module.exports = { getLanInterface, normalizeIp, ipToInt, ipInSubnet };
