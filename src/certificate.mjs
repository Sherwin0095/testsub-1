import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

// Minimal DER for a local self-signed certificate with an IPv4 loopback SAN.
function der(tag, ...values) {
  const value = Buffer.concat(values);
  const length = value.length;
  const size = length < 128 ? [length] : length < 256 ? [0x81, length] : [0x82, length >> 8, length & 255];
  return Buffer.concat([Buffer.from([tag, ...size]), value]);
}
const seq = (...values) => der(0x30, ...values);
const integer = value => der(0x02, Buffer.from(value));
const oid = bytes => der(0x06, Buffer.from(bytes));
const utcTime = date => der(0x17, Buffer.from(date.toISOString().slice(2, 19).replace(/\D/g, '') + 'Z'));
const pem = (label, bytes) => `-----BEGIN ${label}-----\n${bytes.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

export function localCertificate() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = seq(oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 1, 11]), der(0x05));
  const name = seq(der(0x31, seq(oid([0x55, 4, 3]), der(0x0c, Buffer.from('CICADA local ingest')))));
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) || 1;
  const now = Date.now();
  const san = seq(oid([0x55, 0x1d, 0x11]), der(0x04, seq(der(0x87, Buffer.from([127, 0, 0, 1])))));
  const data = seq(der(0xa0, integer([2])), integer(serial), algorithm, name,
    seq(utcTime(new Date(now - 3600000)), utcTime(new Date(now + 365 * 86400000))), name,
    publicKey.export({ type: 'spki', format: 'der' }), der(0xa3, seq(san)));
  const signature = der(0x03, Buffer.from([0]), sign('sha256', data, privateKey));
  return { cert: pem('CERTIFICATE', seq(data, algorithm, signature)), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
