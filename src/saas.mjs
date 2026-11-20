import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bearer, body, json, localHost, matches, metrics, openDb, originOk, percentile, readJson, secureHeaders, settings, sha, states, transaction, validEnvelope } from './shared.mjs';

const dir = process.env.CICADA_DATA;
const { tenants } = JSON.parse(readFileSync(join(dir, 'installation.json')));
const port = Number(process.env.CICADA_PORT);
const tlsPort = Number(process.env.CICADA_TLS_PORT);
const demo = process.env.CICADA_DEMO !== '0';
const simulator = demo && process.env.CICADA_SIMULATOR !== '0';
const tls = { key: readFileSync(join(dir, 'tls-key.pem')), cert: readFileSync(join(dir, 'tls.pem')), minVersion: 'TLSv1.2' };
const stores = new Map(tenants.map(tenant => [tenant.id, openDb(join(dir, `saas-${tenant.region}-${tenant.id}.sqlite`), `
  CREATE TABLE IF NOT EXISTS payloads(
    id TEXT PRIMARY KEY, site TEXT, digest TEXT, sent INTEGER, received INTEGER, duplicates INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS collectors(site TEXT PRIMARY KEY, at INTEGER, cpu INTEGER, rss INTEGER, version INTEGER, config TEXT);
  CREATE TABLE IF NOT EXISTS samples(
    id INTEGER PRIMARY KEY, payload TEXT REFERENCES payloads(id), site TEXT, at INTEGER, zone TEXT, source TEXT, metric TEXT, value REAL
  );
  CREATE INDEX IF NOT EXISTS trend ON samples(site,metric,at DESC,id DESC);
  CREATE INDEX IF NOT EXISTS baseline ON samples(site,source,metric,at DESC,id DESC);
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY, payload TEXT REFERENCES payloads(id), site TEXT, at INTEGER, raised INTEGER, source TEXT, metric TEXT,
    value REAL, severity INTEGER, baseline REAL, deviation REAL, reason TEXT
  );
  CREATE INDEX IF NOT EXISTS alert_time ON alerts(at DESC);
  CREATE TABLE IF NOT EXISTS changes (id INTEGER PRIMARY KEY, site TEXT, at INTEGER, state INTEGER, reason TEXT, previous INTEGER);
  CREATE INDEX IF NOT EXISTS site_changes ON changes(site,id DESC);
  CREATE TABLE IF NOT EXISTS renders(sample INTEGER PRIMARY KEY REFERENCES samples(id), delay INTEGER);
  CREATE TABLE IF NOT EXISTS offline_checks(site TEXT PRIMARY KEY, heartbeat INTEGER, delay INTEGER);
  CREATE TABLE IF NOT EXISTS actions(id INTEGER PRIMARY KEY, incident TEXT, at INTEGER, status TEXT);
`)]));

function evaluate(db, site, record) {
  const threshold = settings.thresholds[record.metric];
  let severity = threshold ? threshold.filter(limit => record.value >= limit).length : record.value === 0 ? 3 : 0;
  let reason = severity ? (threshold ? 'Configured threshold crossed' : 'Availability signal is down') : null;
  let mean = null;
  let deviation = null;
  const metric = metrics[record.metric];
  if (metric.sigma) {
    const window = db.prepare('SELECT value FROM samples WHERE site=? AND source=? AND metric=? AND at<? AND at>=? ORDER BY at DESC,id DESC LIMIT 24')
      .all(site.id, record.source, record.metric, record.at, record.at - 120000);
    if (window.length >= 8) {
      // Trim the upper quartile so a sustained spike does not immediately become the baseline.
      const baseline = window.map(row => row.value).sort((a, b) => a - b).slice(0, Math.ceil(window.length * 0.75));
      mean = baseline.reduce((total, value) => total + value, 0) / baseline.length;
      const spread = Math.sqrt(baseline.reduce((sum, value) => sum + (value - mean) ** 2, 0) / baseline.length);
      deviation = (record.value - mean) / Math.max(spread, metric.sigma);
      if (deviation >= 3) {
        reason = 'Above the recent event-time baseline';
        severity = Math.max(severity, deviation >= 9 ? 3 : 2);
      }
    }
  }
  return severity ? { severity, reason, mean, deviation } : null;
}

function updateHealth(db, site, now) {
  const collector = db.prepare('SELECT * FROM collectors WHERE site=?').get(site.id);
  const age = collector ? now - collector.at : Infinity;
  const link = age >= settings.offlineAfterMs ? 3 : age >= settings.staleAfterMs ? 2 : 0;
  const latest = db.prepare('SELECT max(at) AS at FROM samples WHERE site=?').get(site.id).at;
  const alerts = db.prepare(`SELECT a.* FROM alerts a WHERE a.site=? AND a.at>=?
    AND (a.metric IN ('authFailures','suspicious') OR NOT EXISTS (
      SELECT 1 FROM samples s WHERE s.site=a.site AND s.source=a.source AND s.metric=a.metric AND s.at>a.at
    )) ORDER BY severity DESC, at DESC LIMIT 1`).get(site.id, now - 30000);
  let state = link;
  let reason = link === 3 ? (collector ? 'Collector heartbeat expired' : 'Awaiting collector heartbeat') :
    link === 2 ? 'Collector heartbeat is stale' : 'Reporting within expected ranges';
  if (link < 2 && (latest === null || now - latest >= settings.staleAfterMs)) {
    state = 2;
    reason = 'Metric data is missing or stale';
  }
  if (alerts && alerts.severity > state) {
    state = alerts.severity;
    reason = `${metrics[alerts.metric].name}: ${alerts.reason.toLowerCase()}`;
  }
  const previous = db.prepare('SELECT state,at FROM changes WHERE site=? ORDER BY id DESC LIMIT 1').get(site.id);
  if (previous?.state !== state) {
    db.prepare('INSERT INTO changes(site,at,state,reason,previous) VALUES (?,?,?,?,?)').run(site.id, now, state, reason, previous?.state ?? null);
  }
  if (link === 3 && collector) {
    db.prepare(`INSERT INTO offline_checks(site,heartbeat,delay) VALUES (?,?,?)
      ON CONFLICT(site) DO UPDATE SET heartbeat=excluded.heartbeat,delay=excluded.delay
      WHERE excluded.heartbeat>offline_checks.heartbeat`).run(site.id, collector.at, now - collector.at);
  }
  const offlineDelay = db.prepare('SELECT delay FROM offline_checks WHERE site=?').get(site.id)?.delay ?? null;
  return { state: states[state], reason, link: states[link], online: link < 3, offlineDelay,
    lastSeen: collector?.at ?? null, cpuMs: collector?.cpu ?? null, rssMb: collector?.rss ?? null,
    version: collector ? `${collector.version}.0.0` : null, configuration: collector?.config ?? null };
}

function ingest(tenant, site, envelope, digest) {
  const db = stores.get(tenant.id);
  return transaction(db, () => {
    const previous = db.prepare('SELECT site,digest FROM payloads WHERE id=?').get(envelope.id);
    if (previous) {
      if (previous.site !== site.id || previous.digest !== digest) return null;
      db.prepare('UPDATE payloads SET duplicates=duplicates+1 WHERE id=?').run(envelope.id);
      return { id: envelope.id, digest, duplicate: true };
    }
    const now = Date.now();
    const sent = Math.min(Date.parse(envelope.sentAt), now);
    db.prepare('INSERT INTO payloads(id,site,digest,sent,received) VALUES (?,?,?,?,?)').run(envelope.id, site.id, digest, sent, now);
    db.prepare(`INSERT INTO collectors(site,at,cpu,rss,version,config) VALUES (?,?,?,?,?,?)
      ON CONFLICT(site) DO UPDATE SET at=excluded.at,cpu=excluded.cpu,rss=excluded.rss,version=excluded.version,config=excluded.config
      WHERE excluded.at > collectors.at`).run(site.id, sent, envelope.heartbeat.cpuMs, envelope.heartbeat.rssMb,
      envelope.heartbeat.version, envelope.heartbeat.configuration);
    const sample = db.prepare('INSERT INTO samples(payload,site,at,zone,source,metric,value) VALUES (?,?,?,?,?,?,?)');
    const alert = db.prepare('INSERT INTO alerts(payload,site,at,raised,source,metric,value,severity,baseline,deviation,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const records = envelope.records.map(record => ({ ...record, at: Date.parse(record.at) })).sort((a, b) => a.at - b.at);
    for (const record of records) {
      const finding = evaluate(db, site, record);
      sample.run(envelope.id, site.id, record.at, record.zone, record.source, record.metric, record.value);
      if (finding) alert.run(envelope.id, site.id, record.at, now, record.source, record.metric, record.value,
        finding.severity, finding.mean, finding.deviation, finding.reason);
    }
    updateHealth(db, site, now);
    return { id: envelope.id, digest, duplicate: false };
  });
}

tenants.forEach((tenant, index) => {
  createSecureServer(tls, async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/v1/ingest') return json(res, 404, { error: 'Not found' });
      const credential = bearer(req);
      const site = tenant.sites.find(item => matches(credential, item.token));
      if (!site) return json(res, 401, { error: 'Collector authentication failed for this region' });
      if (req.headers['content-type'] !== 'application/json') return json(res, 415, { error: 'Expected application/json' });
      const wire = await body(req);
      let envelope;
      try { envelope = JSON.parse(wire); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
      if (!validEnvelope(envelope)) return json(res, 422, { error: 'Payload rejected by metadata allow-list' });
      const receipt = ingest(tenant, site, envelope, sha(wire));
      if (!receipt) return json(res, 409, { error: 'Payload ID conflicts with a stored envelope' });
      return json(res, receipt.duplicate ? 200 : 201, receipt);
    } catch (error) {
      if (!error.status) console.error(error);
      return json(res, error.status ?? 500, { error: error.status ? error.message : 'Ingest failed' });
    }
  }).listen(tlsPort + index, '127.0.0.1');
});
setInterval(() => {
  for (const tenant of tenants) for (const site of tenant.sites) updateHealth(stores.get(tenant.id), site, Date.now());
}, 1000);

function incidents(db, now) {
  const groups = new Map();
  const result = [];
  const rows = db.prepare('SELECT * FROM alerts WHERE at >= ? AND severity >= 2 ORDER BY at,id')
    .all(now - 3600000);
  for (const item of rows) {
    const key = `${item.site}/${item.source}`;
    let group = groups.get(key);
    if (!group || item.at - group.last > settings.correlationMs) {
      group = { anchor: item.id, site: item.site, source: item.source,
        start: item.at, last: item.at, severity: 0, signals: new Map(), count: 0 };
      groups.set(key, group);
      result.push(group);
    }
    group.last = item.at;
    group.anchor = Math.min(group.anchor, item.id);
    group.severity = Math.max(group.severity, item.severity);
    group.count += 1;
    const prior = group.signals.get(item.metric);
    if (!prior || item.severity > prior.severity || item.severity === prior.severity && item.value > prior.value) {
      group.signals.set(item.metric, item);
    }
  }
  return result.sort((a, b) => Number(b.last >= now - settings.correlationMs) - Number(a.last >= now - settings.correlationMs) ||
    b.severity - a.severity || b.last - a.last).slice(0, 25).map(group => {
    const { anchor, signals, ...details } = group;
    const id = `INC-${String(anchor).padStart(4, '0')}`;
    const categories = new Set([...signals.keys()].map(key => metrics[key].category));
    const network = categories.has('Network');
    const security = categories.has('Security');
    const infra = categories.has('Infrastructure');
    const [title, cause, action] = security
      ? ['Authentication failures', 'Repeated login failures or suspicious activity were observed at the source.', 'Review local authentication records and verify whether the failures match an expected change.']
      : network
        ? [categories.has('Application') ? 'Network degradation and service impact' : 'Network performance degradation',
          'Network degradation is a likely contributor to the symptoms at this source.',
          'Check the local uplink, packet drops and recent route changes. Verify service availability after the link recovers.']
        : infra
          ? ['Resource baseline deviation', 'Resource utilization rose above its recent baseline or crossed a configured threshold.',
            'Inspect recent deploys and local resource consumers. Compare CPU and memory usage before changing capacity.']
          : ['Service availability degraded', 'The source reported an unavailable service.', 'Inspect local service health and recent deploys.'];
    const audit = db.prepare('SELECT at,status FROM actions WHERE incident=? ORDER BY id').all(id);
    return { id, ...details, title, cause, action, active: group.last >= now - settings.correlationMs,
      confidence: signals.size >= 3 ? 'High' : signals.size >= 2 ? 'Moderate' : 'Low',
      signals: [...signals.values()], audit };
  });
}

function snapshot(tenant, selected, span) {
  const db = stores.get(tenant.id);
  const now = Date.now();
  const sites = tenant.sites.map(site => {
    const latest = db.prepare(`SELECT s.id,s.metric,s.value,s.at,s.zone FROM samples s
      WHERE s.site=? AND s.id=(SELECT id FROM samples WHERE site=s.site AND metric=s.metric ORDER BY at DESC,id DESC LIMIT 1)
      AND s.at>=? ORDER BY s.metric`).all(site.id, now - settings.staleAfterMs);
    return { id: site.id, name: site.name, zone: site.zone, kind: site.kind, ...updateHealth(db, site, now), latest };
  });
  const trend = db.prepare(`SELECT id,at,metric,value,zone,source FROM samples
    WHERE site=? AND at>=? AND metric IN ('cpu','memory','latency','loss') ORDER BY at,id`).all(selected.id, now - span);
  const history = db.prepare('SELECT site,at,state,reason,previous FROM changes ORDER BY id DESC LIMIT 60').all();
  const displayed = db.prepare('SELECT delay FROM renders ORDER BY sample DESC LIMIT 1000').all().map(row => row.delay);
  const alertTimes = db.prepare('SELECT raised-at AS delay FROM alerts WHERE severity>=2 AND raised>=at ORDER BY id DESC LIMIT 1000').all();
  const cutoff = now - settings.retentionHours * 3600000;
  const recentReceipts = db.prepare(`SELECT site,id,digest,sent,received,duplicates FROM payloads
    WHERE site=? AND received>=? ORDER BY received DESC,rowid DESC LIMIT 40`).all(selected.id, cutoff);
  const receiptSummary = db.prepare('SELECT count(*) AS total, coalesce(sum(duplicates),0) AS duplicates FROM payloads WHERE site=? AND received>=?')
    .get(selected.id, cutoff);
  return { now, tenant: { id: tenant.id, name: tenant.name, region: tenant.region, regionName: tenant.regionName }, sites, trend,
    history, incidents: incidents(db, now), receipts: recentReceipts, receiptCount: receiptSummary.total,
    duplicateCount: receiptSummary.duplicates, metrics, states,
    config: { stale: settings.staleAfterMs, offline: settings.offlineAfterMs, thresholds: settings.thresholds },
    measurements: { renderP95: percentile(displayed, 0.95), renderCount: displayed.length,
      alertP95: percentile(alertTimes.map(item => item.delay), 0.95), alertMax: percentile(alertTimes.map(item => item.delay), 1),
      alertCount: alertTimes.length, offlineLast: sites.find(site => site.id === selected.id)?.offlineDelay ?? null } };
}

const assets = { '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'],
  '/dashboard.js': ['dashboard.js', 'text/javascript'], '/ui.js': ['ui.js', 'text/javascript'] };
const sessions = new Map();
function authorized(req) {
  const credential = bearer(req);
  if (credential) return tenants.find(item => matches(credential, item.viewer));
  const id = req.headers.cookie?.split(/; */).find(cookie => cookie.startsWith('cicada_session='))?.slice(15);
  const session = sessions.get(id);
  return session?.until > Date.now() ? session.tenant : null;
}
function session(res, tenant) {
  const id = randomUUID();
  const now = Date.now();
  for (const [key, value] of sessions) if (value.until <= now) sessions.delete(key);
  sessions.set(id, { tenant, until: now + 28800000 });
  res.setHeader('Set-Cookie', `cicada_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
}
createServer(async (req, res) => {
  secureHeaders(res);
  try {
    if (!localHost(req) || !originOk(req)) return json(res, 403, { error: 'Local console access required' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    if (req.method === 'GET' && Object.hasOwn(assets, path)) {
      const [file, type] = assets[path];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
      return res.end(readFileSync(new URL(`../public/${file}`, import.meta.url)));
    }
    if (req.method === 'GET' && path === '/api/config') return json(res, 200, {
      demo, simulator, collectorUrl: `http://127.0.0.1:${port + 1}`,
      tenants: demo ? tenants.map(({ id, name }) => ({ id, name })) : []
    });
    if (req.method === 'POST' && path === '/api/session') {
      const data = await readJson(req);
      const tenant = demo && data?.tenant ? tenants.find(item => item.id === data.tenant) :
        tenants.find(item => matches(data?.token, item.viewer));
      if (!tenant) return json(res, 401, { error: 'Invalid viewer credentials' });
      session(res, tenant);
      return json(res, 200, { tenant: tenant.id });
    }
    const tenant = authorized(req);
    if (!tenant) return json(res, 401, { error: 'Viewer session required' });
    const db = stores.get(tenant.id);
    const siteId = url.searchParams.get('site') ?? tenant.sites[0].id;
    const site = tenant.sites.find(item => item.id === siteId);
    if (!site) return json(res, 404, { error: 'Unknown environment' });
    if (req.method === 'GET' && path === '/api/snapshot') {
      const span = [60000, 300000, 900000].find(value => value === Number(url.searchParams.get('span'))) ?? 60000;
      return json(res, 200, snapshot(tenant, site, span));
    }
    if (req.method === 'POST' && path === '/api/rendered') {
      const { ids } = await readJson(req) ?? {};
      if (!Array.isArray(ids) || ids.length > 120 || ids.some(id => !Number.isSafeInteger(id))) return json(res, 400, { error: 'Invalid sample IDs' });
      const now = Date.now();
      const insert = db.prepare(`INSERT OR IGNORE INTO renders(sample,delay)
        SELECT s.id,?-s.at FROM samples s JOIN payloads p ON p.id=s.payload
        WHERE s.id=? AND s.site=? AND s.at<=? AND p.sent-s.at BETWEEN -5000 AND 5000`);
      transaction(db, () => ids.forEach(id => insert.run(now, id, site.id, now)));
      return json(res, 200, { ok: true });
    }
    if (demo && req.method === 'POST' && path === '/api/action') {
      const { id, step } = await readJson(req) ?? {};
      const now = Date.now();
      const incident = incidents(db, now).find(item => item.id === id);
      if (!incident) return json(res, 404, { error: 'Unknown incident' });
      const current = incident.audit.at(-1)?.status;
      const next = ({ undefined: 'propose', Proposed: 'approve', Approved: 'simulate', Simulated: 'rollback' })[current];
      if (!next || step !== next) return json(res, 409, { error: 'Action is outside the simulation approval sequence' });
      const status = { propose: 'Proposed', approve: 'Approved', simulate: 'Simulated', rollback: 'Rolled back' }[step];
      db.prepare('INSERT INTO actions(incident,at,status) VALUES (?,?,?)').run(id, now, status);
      return json(res, 200, { status });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    if (!error.status) console.error(error);
    return json(res, error.status ?? 500, { error: error.status ? error.message : 'Dashboard request failed' });
  }
}).listen(port, '127.0.0.1', () => console.log(`Operations dashboard: http://127.0.0.1:${port}`));
