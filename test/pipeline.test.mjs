import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

const base = Number(process.env.CICADA_TEST_PORT ?? 14300);
const tls = base + 2;
const dashboard = `http://127.0.0.1:${base}`;
const local = `http://127.0.0.1:${base + 1}`;

async function waitUntil(work, ms = 10000) {
  const limit = Date.now() + ms;
  let detail;
  do {
    try {
      const result = await work();
      if (result) return result;
    } catch (error) { detail = error; }
    await delay(200);
  } while (Date.now() < limit);
  throw new Error('Condition did not become true', { cause: detail });
}
async function json(url, data, headers = {}, expected = 200) {
  const res = await fetch(url, { method: data === undefined ? 'GET' : 'POST',
    headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: data === undefined ? undefined : JSON.stringify(data) });
  assert.equal(res.status, expected, await res.clone().text());
  return res.json();
}
function ingest(port, wire, token, ca) {
  return new Promise((resolve, reject) => {
    const req = request(`https://127.0.0.1:${port}/v1/ingest`, { method: 'POST', ca,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(wire);
  });
}

test('live metadata boundary, incidents, access isolation and durable replay', { timeout: 85000 }, async t => {
  const data = mkdtempSync(join(tmpdir(), 'cicada-test-'));
  const child = spawn(process.execPath, ['src/start.mjs'], { env: { ...process.env, CICADA_DATA: data,
    CICADA_DEMO: '1', CICADA_PORT: String(base), CICADA_TLS_PORT: String(tls) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      if (child.connected) child.send('shutdown');
      await exited;
    }
    for (const file of readdirSync(data)) rmSync(join(data, file));
    rmdirSync(data);
  });
  await waitUntil(async () => (await fetch(dashboard)).ok && (await fetch(local)).ok)
    .catch(error => { throw new Error(output, { cause: error }); });
  const { tenants } = JSON.parse(readFileSync(join(data, 'installation.json')));
  const auth = { Authorization: `Bearer ${tenants[0].viewer}` };
  const other = { Authorization: `Bearer ${tenants[1].viewer}` };
  const ca = readFileSync(join(data, 'tls.pem'));
  const snapshot = () => json(dashboard + '/api/snapshot?site=mumbai', undefined, auth);
  const proof = id => json(local + '/api/proof?site=mumbai' + (id ? `&id=${id}` : ''));
  const scenario = (kind, status = 202) => json(local + '/api/scenario?site=mumbai', { kind }, {}, status);

  await t.test('seeds live metrics and rejects cross-tenant reads and wrong-region ingest', async () => {
    const warm = await waitUntil(async () => {
      const value = await snapshot();
      return value.trend.length > 60 && value;
    });
    assert.equal(warm.tenant.id, 'northstar');
    await json(dashboard + '/api/snapshot?site=mumbai', undefined, {}, 401);
    await json(dashboard + '/api/snapshot?site=mumbai', undefined, other, 404);
    const separate = await json(dashboard + '/api/snapshot', undefined, other);
    assert.equal(separate.tenant.id, 'kepler');
    assert.equal(separate.sites.some(site => site.id === 'mumbai'), false);
    const signedIn = await fetch(dashboard + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant: 'northstar' }) });
    const cookie = signedIn.headers.get('set-cookie').split(';')[0];
    assert.equal((await json(dashboard + '/api/snapshot', undefined, { Cookie: cookie })).tenant.id, 'northstar');
    const wire = (await proof()).audit[0].payload;
    assert.equal(await ingest(tls + 1, wire, tenants[0].sites[0].token, ca), 401);
    const extra = { ...JSON.parse(wire), id: randomUUID(), message: 'unapproved' };
    assert.equal(await ingest(tls, JSON.stringify(extra), tenants[0].sites[0].token, ca), 422);
  });

  await t.test('exact wire bytes keep secrets local and dual-store hashes match', async () => {
    const { ids: [id] } = await scenario('secret');
    const localData = await waitUntil(async () => {
      const value = await proof(id);
      return value.audit.find(row => row.id === id)?.delivered && value;
    });
    const row = localData.audit.find(item => item.id === id);
    const receipt = (await snapshot()).receipts.find(item => item.id === id);
    assert.ok(localData.raw.some(item => item.item.includes('DEMO-SECRET-cicada-42')));
    assert.doesNotMatch(row.payload, /DEMO-SECRET|operator@internal|prod-mumbai/);
    assert.equal(createHash('sha256').update(row.payload).digest('hex'), row.digest);
    assert.equal(row.digest, receipt.digest);
    assert.equal(await ingest(tls, JSON.stringify({ ...JSON.parse(row.payload), records: [] }), tenants[0].sites[0].token, ca), 409);
    const repeated = await scenario('duplicate', 200);
    assert.equal((await snapshot()).receipts.filter(item => item.id === repeated.id).length, 1);
    assert.ok((await snapshot()).receipts.find(item => item.id === repeated.id).duplicates > 0);
  });

  await t.test('correlates live anomalies, handles late data and audits simulated remediation', async () => {
    await scenario('correlation');
    const incident = await waitUntil(async () => (await snapshot()).incidents.find(item => item.signals.length >= 4));
    assert.ok(incident.signals.some(signal => signal.metric === 'cpu' && signal.deviation >= 3));
    assert.ok(incident.signals.some(signal => signal.metric === 'available'));
    assert.ok(incident.signals.every(signal => signal.raised - signal.at <= 15000));
    for (const step of ['propose', 'approve', 'simulate', 'rollback']) {
      await json(dashboard + '/api/action', { id: incident.id, step }, auth);
    }
    await json(dashboard + '/api/action', { id: incident.id, step: 'simulate' }, auth, 409);
    await scenario('late');
    await scenario('auth');
    const after = await waitUntil(async () => {
      const value = await snapshot();
      return value.incidents.some(item => item.signals.some(signal => signal.metric === 'authFailures' && signal.value === 7)) && value;
    });
    assert.deepEqual(after.trend.map(item => item.at), after.trend.map(item => item.at).sort((a, b) => a - b));
    assert.equal(after.incidents.find(item => item.id === incident.id).audit.at(-1).status, 'Rolled back');
    const ids = after.sites[0].latest.map(item => item.id);
    await json(dashboard + '/api/rendered?site=mumbai', { ids }, auth);
    assert.ok((await snapshot()).measurements.renderP95 < 10000);
  });

  await t.test('replays an external NDJSON file with rebased, out-of-order event times', async () => {
    const input = join(data, 'organizer-format-test.ndjson');
    const events = [0, 400, -1300].map((offset, index) => ({
      at: new Date(1577836800000 + offset).toISOString(), source: 'import-test.internal',
      zone: 'Australia/Sydney', metrics: { latency: 20 + index }
    }));
    writeFileSync(input, events.map(value => JSON.stringify(value)).join('\n'));
    const { stdout } = await run(process.execPath, ['scripts/replay.mjs', input, 'sydney', '--rebase'], {
      env: { ...process.env, CICADA_DATA: data, CICADA_PORT: String(base) }
    });
    const ids = stdout.trim().split(/\r?\n/).flatMap(line => JSON.parse(line).ids);
    assert.equal(ids.length, 2);
    const value = await waitUntil(async () => {
      const result = await json(dashboard + '/api/snapshot?site=sydney', undefined, auth);
      return ids.every(id => result.receipts.some(receipt => receipt.id === id)) && result;
    });
    const readings = value.trend.filter(row => row.metric === 'latency' && [20, 21, 22].includes(row.value));
    assert.deepEqual(readings.map(row => row.value), [22, 20, 21]);
    assert.equal(readings[1].at - readings[0].at, 1300);
    assert.equal(readings[2].at - readings[1].at, 400);
  });

  await t.test('reports offline within one minute and reconciles every buffered ID after reconnect', async () => {
    await scenario('disconnect', 200);
    const { ids: [queued] } = await scenario('secret');
    assert.equal((await proof(queued)).audit.find(item => item.id === queued).delivered, null);
    const offline = await waitUntil(async () => {
      const value = await snapshot();
      return value.sites[0].link === 'Poor' && value;
    }, 59000);
    assert.ok(offline.measurements.offlineLast >= 50000 && offline.measurements.offlineLast <= 60000);
    const pending = (await proof(queued)).audit.filter(item => item.delivered === null);
    assert.ok(pending.length > 1);
    await scenario('reconnect', 200);
    const recovered = await waitUntil(async () => {
      const result = await proof();
      return result.outage?.total >= pending.length && result.outage.total === result.outage.delivered && result.delivery.pending === 0 && result;
    });
    const actual = (await snapshot()).receipts;
    for (const row of pending) {
      assert.equal(actual.filter(receipt => receipt.id === row.id).length, 1);
      assert.equal(actual.find(receipt => receipt.id === row.id).digest, row.digest);
    }
    t.diagnostic(`Offline detection ${offline.measurements.offlineLast} ms, replay ${recovered.outage.delivered}/${recovered.outage.total} unique IDs.`);
  });
});
