import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [input, site, mode] = process.argv.slice(2);
if (!input || !site || ![undefined, '--rebase'].includes(mode)) {
  throw new Error('Usage: npm run replay -- <events.ndjson> <site-id> [--rebase]');
}
const lines = readFileSync(resolve(input), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
const events = lines.flatMap((line, index) => {
  if (!line.trim()) return [];
  try {
    const event = JSON.parse(line);
    if (typeof event?.at !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(event.at) || !Number.isFinite(Date.parse(event.at))) throw new Error();
    return [event];
  } catch { throw new Error(`Invalid event or timestamp on line ${index + 1}`); }
});
if (!events.length) throw new Error('No events found.');
const { operator } = JSON.parse(readFileSync(resolve(process.env.CICADA_DATA ?? '.data', 'installation.json')));
const port = Number(process.env.CICADA_PORT ?? 4100) + 1;
const endpoint = new URL(`http://127.0.0.1:${port}/api/events`);
endpoint.searchParams.set('site', site);
const base = Date.parse(events[0].at);
const start = Date.now();
for (let index = 0; index < events.length;) {
  const first = Date.parse(events[index].at);
  const shift = mode === '--rebase' ? start - base : 0;
  const wait = first + shift - Date.now();
  if (wait > 0) await delay(wait);
  const batch = [];
  while (index < events.length && batch.length < 200 && Date.parse(events[index].at) <= first + 100) {
    const event = events[index++];
    batch.push(shift ? { ...event, at: new Date(Date.parse(event.at) + shift).toISOString() } : event);
  }
  const response = await fetch(endpoint, { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${operator}`
  }, body: JSON.stringify({ events: batch }) });
  const receipt = await response.json();
  if (!response.ok) throw new Error(`Collector rejected events ending at row ${index}: ${receipt.error}`);
  console.log(JSON.stringify(receipt));
}
