import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localCertificate } from './certificate.mjs';

const data = resolve(process.env.CICADA_DATA ?? '.data');
mkdirSync(data, { recursive: true });
const file = join(data, 'installation.json');
const token = () => randomBytes(32).toString('hex');
const base = Number(process.env.CICADA_PORT ?? 4100);
const tlsBase = Number(process.env.CICADA_TLS_PORT ?? 8443);
if (!Number.isInteger(base) || !Number.isInteger(tlsBase) || base < 1024 || tlsBase < 1024 ||
    base > 65534 || tlsBase > 65534 || Math.abs(base - tlsBase) < 2) {
  throw new Error('Set distinct port pairs in CICADA_PORT and CICADA_TLS_PORT.');
}
if (!existsSync(file)) {
  const tenants = [
    { id: 'northstar', name: 'Northstar Labs', region: 'ap-south-1', regionName: 'Mumbai',
      sites: [
        { id: 'mumbai', name: 'Mumbai Core', zone: 'Asia/Kolkata', kind: 'Data center', bias: 0 },
        { id: 'singapore', name: 'Singapore Edge', zone: 'Asia/Singapore', kind: 'Edge cluster', bias: 6 },
        { id: 'sydney', name: 'Sydney Cloud', zone: 'Australia/Sydney', kind: 'Cloud region', bias: 11 }
      ] },
    { id: 'kepler', name: 'Kepler Systems', region: 'eu-central-1', regionName: 'Frankfurt',
      sites: [
        { id: 'frankfurt', name: 'Frankfurt Core', zone: 'Europe/Berlin', kind: 'Data center', bias: 0 },
        { id: 'dublin', name: 'Dublin Edge', zone: 'Europe/Dublin', kind: 'Edge cluster', bias: 8 }
      ] }
  ];
  for (const tenant of tenants) {
    tenant.viewer = token();
    for (const site of tenant.sites) {
      site.token = token();
      site.salt = token();
    }
  }
  writeFileSync(file, JSON.stringify({ tenants, operator: token() }, null, 2), { flag: 'wx', mode: 0o600 });
}
if (!existsSync(join(data, 'tls.pem')) || !existsSync(join(data, 'tls-key.pem'))) {
  const { cert, key } = localCertificate();
  writeFileSync(join(data, 'tls-key.pem'), key, { mode: 0o600 });
  writeFileSync(join(data, 'tls.pem'), cert);
}

const children = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  children.forEach(child => child.kill());
}
for (const name of ['saas', 'collector']) {
  const child = spawn(process.execPath, [fileURLToPath(new URL(`./${name}.mjs`, import.meta.url))], {
    stdio: 'inherit',
    env: { ...process.env, CICADA_DATA: data, CICADA_PORT: String(base), CICADA_TLS_PORT: String(tlsBase) }
  });
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => stop(code ?? 1));
  children.push(child);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
if (process.connected) {
  process.on('message', message => {
    if (message === 'shutdown') {
      process.disconnect();
      stop(0);
    }
  });
  process.on('disconnect', () => stop(0));
}
if (process.env.CICADA_DEMO === '0') console.log(`Auth configuration is stored in ${file}.`);
