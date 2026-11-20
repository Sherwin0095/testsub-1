import { createServer } from 'node:http';
import { request } from 'node:https';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bearer, json, localHost, matches, openDb, originOk, readJson, secureHeaders, settings, sha, transaction, utc, validEnvelope, validMetric, validZone } from './shared.mjs';

const dir = process.env.CICADA_DATA;
const { tenants, operator } = JSON.parse(readFileSync(join(dir, 'installation.json')));
const ca = readFileSync(join(dir, 'tls.pem'));
const port = Number(process.env.CICADA_PORT) + 1;
const tlsPort = Number(process.env.CICADA_TLS_PORT);
const demo = process.env.CICADA_DEMO !== '0';
const simulator = demo && process.env.CICADA_SIMULATOR !== '0';
const db = openDb(join(dir, 'collector.sqlite'), `
  CREATE TABLE IF NOT EXISTS raw (id INTEGER PRIMARY KEY, site TEXT, accepted INTEGER, at INTEGER, source TEXT, kind TEXT, item TEXT);
  CREATE INDEX IF NOT EXISTS local_signals ON raw(site,source,kind,at);
  CREATE TABLE IF NOT EXISTS egress (
    id TEXT PRIMARY KEY, site TEXT, payload TEXT, digest TEXT, prepared INTEGER,
    attempts INTEGER DEFAULT 0, attempted INTEGER, delivered INTEGER, error TEXT, duplicate INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS pending ON egress(site,delivered,prepared);
  CREATE TABLE IF NOT EXISTS outages (id INTEGER PRIMARY KEY, site TEXT, started INTEGER, ended INTEGER);
`);
const sites = tenants.flatMap((tenant, index) => tenant.sites.map(site => ({
  ...site, tenantId: tenant.id, region: tenant.region, endpoint: `https://127.0.0.1:${tlsPort + index}/v1/ingest`,
  offline: false, paused: false, scenario: null, busy: false, lastProbe: 0
})));
const scenarios = new Set(['secret', 'auth', 'network', 'cpu', 'correlation', 'late', 'duplicate', 'disconnect', 'reconnect', 'pause', 'resume']);
const authKinds = new Map([['auth_failure', 'authFailures'], ['suspicious_activity', 'suspicious']]);
const saveRaw = db.prepare('INSERT INTO raw(site,accepted,at,source,kind,item) VALUES (?,?,?,?,?,?)');
const countSignal = db.prepare('SELECT count(*) AS total FROM raw WHERE site=? AND source=? AND kind=? AND at BETWEEN ? AND ?');
const saveEnvelope = db.prepare('INSERT INTO egress(id,site,payload,digest,prepared) VALUES (?,?,?,?,?)');
const previousCpu = { usage: process.cpuUsage(), time: Date.now() };

function heartbeat() {
  const now = Date.now();
  const usage = process.cpuUsage();
  const cpuMs = Math.max(0, Math.round((usage.user + usage.system - previousCpu.usage.user - previousCpu.usage.system) /
    Math.max(1, now - previousCpu.time)));
  if (now > previousCpu.time + 1000) Object.assign(previousCpu, { usage, time: now });
  return { version: 1, cpuMs, rssMb: Math.round(process.memoryUsage().rss / 1048576), configuration: 'active' };
}

function normalize(site, events, sentAt) {
  return events.map(item => {
    if (!item || Array.isArray(item) || typeof item !== 'object' || typeof item.source !== 'string' ||
      item.source.length === 0 || item.source.length > 512 || typeof item.at !== 'string' ||
      !/(?:Z|[+-]\d\d:\d\d)$/.test(item.at) || !Number.isFinite(Date.parse(item.at)) || Date.parse(item.at) > sentAt + 5000 ||
      (item.zone !== undefined && !validZone(item.zone))) {
      throw Object.assign(new Error('Each event needs a source, timestamp with UTC offset, and optional IANA timezone.'), { status: 400 });
    }
    return {
      item, at: Date.parse(item.at), zone: item.zone ?? site.zone,
      kind: authKinds.has(item.kind) ? item.kind : 'telemetry',
      source: createHmac('sha256', site.salt).update(item.source).digest('hex').slice(0, 24)
    };
  });
}

function collect(site, events, sentAt = Date.now()) {
  const normalized = normalize(site, events, sentAt);
  const batches = new Map();
  return transaction(db, () => {
    for (const event of normalized) {
      saveRaw.run(site.id, Date.now(), event.at, event.source, event.kind, JSON.stringify(event.item));
    }
    function aggregate(event, metric, value, count = false) {
      const group = JSON.stringify([Math.floor(event.at / 1000), event.zone, event.source, metric]);
      const existing = batches.get(group);
      if (existing) {
        existing.at = Math.max(existing.at, event.at);
        existing.total = count ? Math.max(existing.total, value) : existing.total + value;
        if (!count) existing.count += 1;
      } else {
        batches.set(group, { at: event.at, zone: event.zone, source: event.source, metric, total: value, count: 1 });
      }
    }
    for (const event of normalized) {
      const input = event.item.metrics;
      if (input && typeof input === 'object' && !Array.isArray(input)) {
        for (const [metric, value] of Object.entries(input)) {
          if (metric !== 'authFailures' && metric !== 'suspicious' && validMetric(metric, value)) {
            aggregate(event, metric, value);
          }
        }
      }
      const metric = authKinds.get(event.kind);
      if (metric) {
        const { total } = countSignal.get(site.id, event.source, event.kind, event.at - 30000, event.at);
        aggregate(event, metric, Math.min(total, 100000), true);
      }
    }
    const records = [...batches.values()].map(({ at, zone, source, metric, total, count }) => ({
      at: utc(at), zone, source, metric, value: ['connected', 'available'].includes(metric)
        ? Number(total === count) : Number((total / count).toFixed(3))
    }));
    const ids = [];
    for (let offset = 0; offset < records.length || offset === 0; offset += 600) {
      const envelope = { version: 1, id: randomUUID(), sentAt: utc(sentAt), heartbeat: heartbeat(), records: records.slice(offset, offset + 600) };
      if (!validEnvelope(envelope)) throw new Error('Local allow-list rejected the outgoing payload.');
      const wire = JSON.stringify(envelope);
      saveEnvelope.run(envelope.id, site.id, wire, sha(wire), Date.now());
      ids.push(envelope.id);
    }
    return { ids, events: events.length, records: records.length };
  });
}

function transmit(site, wire) {
  return new Promise((resolve, reject) => {
    if (site.offline) return reject(new Error('Demo uplink unavailable'));
    const req = request(site.endpoint, { method: 'POST', ca, minVersion: 'TLSv1.2', headers: {
      Authorization: `Bearer ${site.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(wire)
    } }, res => {
      let reply = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { reply += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200 && res.statusCode !== 201) return reject(new Error(`Regional ingest returned HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(reply)); } catch (error) { reject(error); }
      });
    });
    req.setTimeout(2500, () => req.destroy(new Error('Ingest timed out')));
    req.on('error', reject);
    req.end(wire);
  });
}
const pending = db.prepare('SELECT id,payload,digest FROM egress WHERE site=? AND delivered IS NULL ORDER BY prepared,rowid LIMIT 32');
const attempt = db.prepare('UPDATE egress SET attempts=attempts+1, attempted=? WHERE id=?');
const acknowledged = db.prepare('UPDATE egress SET delivered=COALESCE(delivered,?), error=NULL, duplicate=duplicate+? WHERE id=?');
const markError = db.prepare('UPDATE egress SET error=? WHERE id=?');
const currentOutage = db.prepare('SELECT * FROM outages WHERE site=? ORDER BY id DESC LIMIT 1');
function beginOutage(site, now) {
  const recent = currentOutage.get(site.id);
  if (!recent || recent.ended !== null) db.prepare('INSERT INTO outages(site,started) VALUES (?,?)').run(site.id, now);
}
function endOutage(site, now) {
  db.prepare('UPDATE outages SET ended=? WHERE site=? AND ended IS NULL').run(now, site.id);
}
async function deliver(site, row) {
  attempt.run(Date.now(), row.id);
  try {
    const ack = await transmit(site, row.payload);
    if (ack.id !== row.id || ack.digest !== row.digest) throw new Error('Acknowledgement did not match payload ID and hash');
    acknowledged.run(Date.now(), Number(ack.duplicate === true), row.id);
    endOutage(site, Date.now());
    return true;
  } catch (error) {
    markError.run(error.message, row.id);
    const oldest = db.prepare('SELECT min(prepared) AS at FROM egress WHERE site=? AND delivered IS NULL').get(site.id).at;
    beginOutage(site, oldest ?? Date.now());
    return false;
  }
}
async function flush(site) {
  if (site.busy || Date.now() - site.lastProbe < 1000) return;
  site.busy = true;
  try {
    for (const record of pending.all(site.id)) {
      if (!await deliver(site, record)) {
        site.lastProbe = Date.now();
        break;
      }
    }
  } finally { site.busy = false; }
}

function simulated(site, timestamp, kind = null) {
  const wave = Math.sin(timestamp / 3500 + site.bias);
  const noise = Math.sin(timestamp / 2200 + 1);
  const core = { cpu: 39 + site.bias + wave * 6 + noise * 2, memory: 49 + site.bias + wave * 5,
    disk: 46 + site.bias + wave, bandwidth: 235 + site.bias * 13 + wave * 38, latency: 34 + site.bias * 4 + noise * 11,
    loss: 0.18 + (wave + 1) * 0.09, available: 1, connected: 1 };
  if (kind === 'network' || kind === 'correlation') {
    Object.assign(core, { latency: 184 + noise * 15, loss: 3.3 + wave, available: 0 });
  }
  if (kind === 'cpu' || kind === 'correlation') Object.assign(core, { cpu: 76 + wave * 3, memory: 81 + wave });
  const source = `prod-${site.id}-gateway.internal`;
  const at = utc(timestamp);
  const result = [{ at, zone: site.zone, source, metrics: core, message: 'Gateway telemetry' }];
  if (kind === 'secret') result[0].message = 'Synthetic checkout event api_key=DEMO-SECRET-cicada-42 user=operator@internal';
  if (kind === 'auth') {
    for (let index = 0; index < 7; index++) {
      result.push({ at, zone: site.zone, source, kind: 'auth_failure', actor: 'demo-admin', address: '192.0.2.31', message: 'Rejected demo credentials' });
    }
    result.push({ at, zone: site.zone, source, kind: 'suspicious_activity', message: 'Local signal from authentication policy' });
  }
  return result;
}

if (simulator) {
  const seeded = db.prepare('SELECT count(*) AS total FROM egress').get().total;
  if (!seeded) {
    const now = Date.now();
    for (let delta = 44000; delta >= 2000; delta -= 2000) {
      for (const site of sites) collect(site, simulated(site, now - delta), now - delta);
    }
  }
}
setInterval(() => {
  const now = Date.now();
  for (const site of sites) {
    if (site.paused) continue;
    const scenario = site.scenario?.until > now ? site.scenario.kind : null;
    collect(site, simulator || scenario ? simulated(site, now, scenario) : [], now);
  }
}, 2000);
setInterval(() => sites.forEach(site => void flush(site)), 500);
function purge() {
  const cutoff = Date.now() - settings.retentionHours * 3600000;
  db.prepare('DELETE FROM raw WHERE accepted<?').run(cutoff);
  db.prepare('DELETE FROM egress WHERE delivered<?').run(cutoff);
  db.prepare('DELETE FROM outages WHERE ended<?').run(cutoff);
}
purge();
setInterval(purge, 60000);

const assets = { '/': ['collector.html', 'text/html'], '/style.css': ['style.css', 'text/css'],
  '/collector.js': ['collector.js', 'text/javascript'], '/ui.js': ['ui.js', 'text/javascript'] };
const siteList = () => sites.map(({ id, name, region, offline, paused, tenantId }) => ({
  id, name, region, offline, paused, tenantId
}));
createServer(async (req, res) => {
  secureHeaders(res);
  try {
    if (!localHost(req) || !originOk(req)) return json(res, 403, { error: 'Local collector access required' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    if (req.method === 'GET' && Object.hasOwn(assets, path)) {
      const [file, type] = assets[path];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
      return res.end(readFileSync(new URL(`../public/${file}`, import.meta.url)));
    }
    if (!demo && !matches(bearer(req), operator)) return json(res, 401, { error: 'Collector operator token required' });
    if (req.method === 'GET' && path === '/api/sites') return json(res, 200, { sites: siteList(), demo });
    const site = sites.find(item => item.id === url.searchParams.get('site'));
    if (!site) return json(res, 404, { error: 'Unknown collector site' });
    if (req.method === 'POST' && path === '/api/events') {
      const data = await readJson(req);
      if (!Array.isArray(data?.events) || !data.events.length || data.events.length > 200) return json(res, 400, { error: 'Provide 1–200 events' });
      return json(res, 202, collect(site, data.events));
    }
    if (req.method === 'GET' && path === '/api/proof') {
      const audit = db.prepare('SELECT * FROM egress WHERE site=? ORDER BY prepared DESC,rowid DESC LIMIT 35').all(site.id);
      const raw = db.prepare('SELECT at,item FROM raw WHERE site=? ORDER BY id DESC LIMIT 25').all(site.id);
      const delivery = db.prepare(`SELECT count(*) FILTER (WHERE delivered IS NULL) AS pending,
        count(delivered) AS delivered, coalesce(sum(duplicate),0) AS duplicates,
        count(*) FILTER (WHERE error IS NOT NULL AND delivered IS NULL)>0 AS unavailable FROM egress WHERE site=?`).get(site.id);
      const last = currentOutage.get(site.id);
      const outage = last ? { started: last.started, ended: last.ended,
        ...db.prepare('SELECT count(*) AS total, count(delivered) AS delivered FROM egress WHERE site=? AND prepared BETWEEN ? AND ?')
          .get(site.id, last.started, last.ended ?? Date.now()) } : null;
      const selected = url.searchParams.get('id');
      if (selected && !audit.some(row => row.id === selected)) {
        const row = db.prepare('SELECT * FROM egress WHERE site=? AND id=?').get(site.id, selected);
        if (row) audit.unshift(row);
      }
      return json(res, 200, { site: siteList().find(item => item.id === site.id), audit, raw, delivery, outage, retentionHours: settings.retentionHours });
    }
    if (demo && req.method === 'POST' && path === '/api/scenario') {
      const data = await readJson(req);
      const kind = data?.kind;
      if (!scenarios.has(kind)) return json(res, 400, { error: 'Unknown demo scenario' });
      const now = Date.now();
      if (kind === 'disconnect' || kind === 'reconnect') {
        site.offline = kind === 'disconnect';
        if (site.offline) beginOutage(site, now);
        site.lastProbe = 0;
      } else if (kind === 'pause' || kind === 'resume') {
        site.paused = kind === 'pause';
      } else if (kind === 'duplicate') {
        const record = db.prepare('SELECT id,payload,digest FROM egress WHERE site=? AND delivered IS NOT NULL ORDER BY delivered DESC LIMIT 1').get(site.id);
        if (!record) return json(res, 409, { error: 'Wait for the first delivery' });
        return json(res, await deliver(site, record) ? 200 : 503, { id: record.id, kind });
      } else {
        if (['cpu', 'network', 'correlation'].includes(kind)) site.scenario = { kind, until: now + 14000 };
        const { ids } = collect(site, simulated(site, kind === 'late' ? now - 19000 : now, kind), now);
        return json(res, 202, { kind, ids });
      }
      return json(res, 200, { kind });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    if (!error.status) console.error(error);
    return json(res, error.status ?? 500, { error: error.status ? error.message : 'Collector request failed' });
  }
}).listen(port, '127.0.0.1', () => console.log(`Collector console: http://127.0.0.1:${port}`));
