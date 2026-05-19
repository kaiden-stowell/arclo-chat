'use strict';

const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

/**
 * Load an existing self-signed certificate from `dir`, or generate one.
 * The LAN `host` is added as a Subject Alternative Name so browsers on the
 * network can reach it. Service workers / Web Push require HTTPS.
 */
function loadOrCreateCert(dir, host) {
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }

  fs.mkdirSync(dir, { recursive: true });

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
  ];
  if (host && /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    altNames.push({ type: 7, ip: host });
  }

  const pems = selfsigned.generate([{ name: 'commonName', value: host || 'localhost' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });

  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

module.exports = { loadOrCreateCert };
