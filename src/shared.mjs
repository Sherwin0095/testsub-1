import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const settings = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url)));
export const states = ['Excellent', 'Good', 'Fair', 'Poor'];
export const metrics = {
  cpu: { name: 'CPU utilization', unit: '%', max: 100, sigma: 4, category: 'Infrastructure' },
  memory: { name: 'Memory utilization', unit: '%', max: 100, sigma: 3, category: 'Infrastructure' },
  disk: { name: 'Disk utilization', unit: '%', max: 100, sigma: 3, category: 'Infrastructure' },
  bandwidth: { name: 'Bandwidth', unit: ' Mbps', max: 1e7, sigma: 25, category: 'Network' },
  latency: { name: 'Network latency', unit: ' ms', max: 1e6, sigma: 8, category: 'Network' },
  loss: { name: 'Packet loss', unit: '%', max: 100, sigma: 0.2, category: 'Network' },
  connected: { name: 'Connectivity', unit: '', max: 1, category: 'Network' },
  available: { name: 'Service availability', unit: '', max: 1, category: 'Application' },
  authFailures: { name: 'Failed logins / 30s', unit: '', max: 100000, category: 'Security' },
  suspicious: { name: 'Suspicious signals / 30s', unit: '', max: 100000, category: 'Security' }
};
const recordShape = (value, keys) => value && typeof value === 'object' &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const zones = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC', 'Asia/Kolkata']);
export const validZone = value => zones.has(value);
export function validMetric(key, value) {
  return Object.hasOwn(metrics, key) && Number.isFinite(value) && value >= 0 && value <= metrics[key].max &&
    (!['available', 'connected', 'authFailures', 'suspicious'].includes(key) || Number.isInteger(value));
}
export function validEnvelope(value) {
  return recordShape(value, ['version', 'id', 'sentAt', 'heartbeat', 'records']) &&
    value.version === 1 && typeof value.id === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(value.id) &&
    iso(value.sentAt) && Date.parse(value.sentAt) <= Date.now() + 5000 &&
    recordShape(value.heartbeat, ['cpuMs', 'rssMb', 'version', 'configuration']) &&
    Number.isFinite(value.heartbeat.cpuMs) && value.heartbeat.cpuMs >= 0 && value.heartbeat.cpuMs <= 1e12 &&
    Number.isFinite(value.heartbeat.rssMb) && value.heartbeat.rssMb >= 0 && value.heartbeat.rssMb <= 1e7 &&
    value.heartbeat.version === 1 && value.heartbeat.configuration === 'active' &&
    Array.isArray(value.records) && value.records.length <= 600 && value.records.every(record =>
      recordShape(record, ['at', 'zone', 'source', 'metric', 'value']) &&
      iso(record.at) && Date.parse(record.at) <= Date.parse(value.sentAt) + 5000 &&
      validZone(record.zone) && typeof record.source === 'string' && /^[\da-f]{24}$/.test(record.source) &&
      validMetric(record.metric, record.value));
}
export const utc = (time = Date.now()) => new Date(time).toISOString();
export const sha = body => createHash('sha256').update(body).digest('hex');
export const matches = (left, right) => typeof left === 'string' && typeof right === 'string' &&
  timingSafeEqual(Buffer.from(sha(left), 'hex'), Buffer.from(sha(right), 'hex'));
export const bearer = req => req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
export const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;

export function openDb(path, schema) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  db.exec(schema);
  return db;
}
export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
export function secureHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}
export async function body(req, limit = 256 * 1024) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw Object.assign(new Error('Payload too large'), { status: 413 });
    parts.push(part);
  }
  return Buffer.concat(parts);
}
export async function readJson(req) {
  try { return JSON.parse(await body(req)); }
  catch (error) { throw Object.assign(new Error(error.status ? error.message : 'Invalid JSON'), { status: error.status ?? 400 }); }
}
export const originOk = req => req.headers.origin === undefined || req.headers.origin === `http://${req.headers.host}`;
export const localHost = req => /^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '');
