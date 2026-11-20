import { $, api, message, fillSelect, stat, clock } from './ui.js';

const siteSelect = $('#site');
const payloads = $('#payloads');
const rawEvents = $('#raw-events');
const query = new URLSearchParams(location.search);
let token;
let proof;
let pinned = query.get('id');
let selectedRaw;
let generation = 0;
let loading = false;

function endpoint(path, id = null) {
  const parameters = new URLSearchParams({ site: siteSelect.value });
  if (id) parameters.set('id', id);
  return `${path}?${parameters}`;
}
function selectedWire() { return payloads.value ? proof?.audit.find(item => item.id === payloads.value) : proof?.audit[0]; }
function drawSelection() {
  const row = selectedWire();
  const local = proof?.raw[Number(rawEvents.value)];
  $('#raw').textContent = local ? JSON.stringify(JSON.parse(local.item), null, 2) : 'Waiting for telemetry';
  $('#wire').textContent = row?.payload ?? 'Waiting for an audited payload';
  const delivery = $('#delivery-state');
  delivery.className = `chip ${row?.delivered ? 'excellent' : 'fair'}`;
  delivery.textContent = !row ? 'No payload' : row.delivered ? 'Hash verified' : 'Queued locally';
  $('#payload-info').textContent = row ? `Prepared ${clock(row.prepared, 'UTC', true)} · ${row.attempts} attempts${row.error ? ` · ${row.error}` : ''}` : '';
  $('#digest').textContent = row ? `SHA-256  ${row.digest}` : '';
  $('#copy').disabled = !row;
}
function draw() {
  const { site, audit, raw, delivery, outage } = proof;
  const selectedSite = siteSelect.selectedOptions[0]?.text;
  $('#summary').innerHTML =
    stat('Buffered locally', delivery.pending, 'Pending regional acknowledgement', '▤') +
    stat('Hash-verified delivery', delivery.delivered, 'Payload IDs acknowledged by SaaS', '◈', 'green') +
    stat('Duplicate acknowledgements', delivery.duplicates, 'Retries matched an existing ID', '⇄', 'blue') +
    stat('Last outage replay', outage ? `${outage.delivered}/${outage.total}` : '—',
      outage ? `${outage.total - outage.delivered} awaiting acknowledgement` : site.region, '◷', 'amber');
  const live = $('#uplink');
  const failed = site.offline || delivery.unavailable;
  live.classList.toggle('failed', failed);
  live.replaceChildren(document.createElement('i'), failed ? ' Uplink unavailable' :
    site.paused ? ' Collection paused' : ` ${selectedSite} · Local`);
  for (const [id, active, on, off, onLabel, offLabel] of [
    ['disconnect', site.offline, 'reconnect', 'disconnect', 'Reconnect uplink', 'Disconnect uplink'],
    ['pause', site.paused, 'resume', 'pause', 'Resume collection', 'Pause collection']
  ]) {
    const button = `#${id}`;
    $(button).dataset.kind = active ? on : off;
    $(button).textContent = active ? onLabel : offLabel;
  }
  $('#retention').textContent = `${proof.retentionHours} h`;
  fillSelect(payloads, [['', 'Follow latest payload'], ...audit.map(row => [
    row.id, `${row.id} · ${row.delivered ? 'Delivered' : 'Queued'}`
  ])], pinned ?? '');
  if (!pinned && audit.length) payloads.value = '';
  const rawOptions = raw.map((row, index) => {
    const event = JSON.parse(row.item);
    return [index, `${clock(row.at)} · ${String(event.message ?? event.kind ?? 'Telemetry').slice(0, 80)}`];
  });
  fillSelect(rawEvents, rawOptions, Math.max(0, raw.findIndex(event => event.item === selectedRaw)));
  drawSelection();
}
async function refresh(force = false) {
  if ((!force && loading) || !siteSelect.value) return;
  const current = generation;
  loading = true;
  try {
    const result = await api(endpoint('/api/proof', pinned), { token });
    if (current !== generation) return;
    proof = result;
    draw();
  } catch (error) {
    if (current === generation) message(error.message, true);
  } finally {
    if (current === generation) loading = false;
  }
}
async function init() {
  const result = await api('/api/sites', { token });
  fillSelect(siteSelect, result.sites.map(site => [site.id, site.name]), query.get('site'));
  $('#scenario-panel').hidden = !result.demo;
  $('#login').hidden = true;
  $('#app').hidden = false;
  message();
  await refresh(true);
}
$('#login').addEventListener('submit', async event => {
  event.preventDefault();
  token = $('#token').value;
  try { await init(); $('#token').value = ''; }
  catch (error) { message(error.message, true); }
});
siteSelect.addEventListener('change', () => {
  generation += 1;
  pinned = null;
  selectedRaw = null;
  message();
  void refresh(true);
});
payloads.addEventListener('change', () => { pinned = payloads.value || null; drawSelection(); });
rawEvents.addEventListener('change', () => { selectedRaw = proof?.raw[Number(rawEvents.value)]?.item; drawSelection(); });
$('#copy').addEventListener('click', async () => {
  if (!selectedWire()) return;
  try {
    await navigator.clipboard.writeText(selectedWire().payload);
    message('Exact wire body copied.');
  } catch (error) { message(error.message, true); }
});
$('#scenarios').addEventListener('click', async event => {
  const button = event.target.closest('button[data-kind]');
  if (!button) return;
  button.disabled = true;
  const kind = button.dataset.kind;
  try {
    const response = await api(endpoint('/api/scenario'), { data: { kind }, token });
    if (response.ids?.length || response.id) pinned = response.ids?.[0] ?? response.id;
    if (kind === 'secret') selectedRaw = null;
    message(kind === 'duplicate' ? 'The existing payload ID was retransmitted.' :
      kind === 'disconnect' ? 'Uplink disconnected. New envelopes will stay in the durable queue.' :
      kind === 'reconnect' ? 'Uplink reconnected. Queued envelopes are being replayed.' : `${button.textContent} applied.`);
    await refresh(true);
    if (kind === 'secret') {
      selectedRaw = proof?.raw.find(row => row.item.includes('DEMO-SECRET-cicada-42'))?.item;
      if (selectedRaw) draw();
    }
  } catch (error) { message(error.message, true); }
  finally { button.disabled = false; }
});

try { await init(); }
catch (error) {
  if (error.status === 401) $('#login').hidden = false;
  else message(error.message, true);
}
setInterval(refresh, 1200);
