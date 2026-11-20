import { $, escape as e, api, message, fillSelect, stat, chip, seconds, clock } from './ui.js';

const content = $('#content');
const environment = $('#environment');
const tenantSelect = $('#tenant');
const views = {
  overview: ['Overview', 'FLEET OBSERVABILITY', 'Operations overview', 'Infrastructure, network and security health across your environments.'],
  incidents: ['Incidents', 'AIOPS', 'Incidents', 'Inspect correlated signals, likely causes and recommended actions.'],
  collectors: ['Collectors', 'COLLECTOR FLEET', 'Collectors', 'Track heartbeat freshness, resource use and configuration.'],
  evidence: ['Delivery evidence', 'PIPELINE ASSURANCE', 'Delivery evidence', 'Review measured latency, replay results and regional ingest receipts.']
};
const state = { view: 'overview', span: 60000, sourceZone: false, generation: 0, ack: new Set() };
let config;
let snapshot;
let loading = false;

function setLive(live, messageText) {
  $('#live').classList.toggle('failed', !live);
  $('#live').replaceChildren(document.createElement('i'), ` ${messageText}`);
}
function timing(value, full = false) {
  return clock(value, state.sourceZone ? snapshot.sites.find(site => site.id === environment.value)?.zone : 'UTC', full);
}
function collectorLink(site = environment.value, id = null) {
  const url = new URL(config.collectorUrl);
  if (site) url.searchParams.set('site', site);
  if (id) url.searchParams.set('id', id);
  return e(url.href);
}
function val(metric, value) {
  if (value === null || value === undefined) return '—';
  if (metric === 'available') return value ? 'Available' : 'Unavailable';
  if (metric === 'connected') return value ? 'Connected' : 'Disconnected';
  return `${Number(value.toFixed(metric === 'loss' ? 2 : 1)).toLocaleString()}${snapshot.metrics[metric].unit}`;
}
function heading(title, description, extra = '') {
  return `<div class="panel-heading"><div><h2>${title}</h2><p>${description}</p></div>${extra}</div>`;
}
function table(columns, rows) {
  return `<div class="table-wrap"><table><thead><tr>${columns.map(column => `<th scope="col">${column}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function fleet(detailed = false) {
  const columns = detailed ? ['Environment', 'Heartbeat', 'Last seen', 'CPU', 'Memory', 'Version', 'Config'] :
    ['Environment', 'Health', 'Collector'];
  const rows = snapshot.sites.map(site => [
    `<button class="table-button" data-site="${e(site.id)}">${e(site.name)}</button><small>${e(site.kind)}</small>`,
    ...(detailed ? [chip(site.link === 'Poor' ? 'Offline' : site.link === 'Fair' ? 'Stale' : 'Online', site.link),
      timing(site.lastSeen, true), site.cpuMs === null ? '—' : `${site.cpuMs} ms/s`,
      site.rssMb === null ? '—' : `${site.rssMb} MB`, e(site.version ?? '—'), e(site.configuration ?? '—')]
      : [`${chip(site.state)}<small>${e(site.reason)}</small>`, site.link === 'Poor' ? 'Offline' : site.link === 'Fair' ? 'Stale' : 'Online'])
  ]);
  return `<section class="panel">${heading(detailed ? 'Collector health' : 'Environment health',
    detailed ? 'Regional collector status and runtime metrics.' : 'Latest status and reason for each environment.',
    `<span class="chip">${snapshot.sites.length} environments</span>`)}${table(columns, rows)}</section>`;
}
function chart(title, description, name, labels, unit, range = false) {
  return `<article class="panel">${heading(title, description, range ? `<select id="span" aria-label="Chart time range">
    <option value="60000" ${state.span === 60000 ? 'selected' : ''}>Last 1 min</option>
    <option value="300000" ${state.span === 300000 ? 'selected' : ''}>Last 5 min</option>
    <option value="900000" ${state.span === 900000 ? 'selected' : ''}>Last 15 min</option></select>` : '')}
    <canvas class="chart" data-chart="${name}" role="img" aria-label="${title} trend in ${unit}"></canvas>
    <div class="chart-key">${labels.map(label => `<span><i></i>${label}</span>`).join('')}</div></article>`;
}
function incidentList() {
  const first = snapshot.incidents.slice(0, 3);
  return `<section class="panel">${heading('Recent incidents', 'Correlated detection across the fleet.',
    '<button class="button" data-view="incidents">View incidents</button>')}
    ${first.length ? first.map(item => `<div class="incident-row"><div class="incident-top">
      <button class="table-button" data-view="incidents">${e(item.title)}</button>${chip(item.severity === 3 ? 'Critical' : 'Warning', item.severity === 3 ? 'poor' : 'fair')}</div>
      <small>${e(snapshot.sites.find(site => site.id === item.site)?.name)} · ${item.count} signals · ${timing(item.last)}</small></div>`).join('')
    : '<div class="empty"><strong>No incidents recorded</strong>Incidents appear when related warning or critical signals are detected.</div>'}</section>`;
}
function metricTable(site) {
  const latest = new Map(site.latest.map(item => [item.metric, item]));
  return `<section class="panel">${heading(`Latest signals · ${e(site.name)}`, 'Most recent readings by signal. Missing and stale values are shown explicitly.')}
    ${table(['Signal', 'Category', 'Reading', 'Event time', 'Source timezone'], Object.entries(snapshot.metrics).map(([metric, meta]) => {
      const item = latest.get(metric);
      return [e(meta.name), e(meta.category), item ? e(val(metric, item.value)) : '<span class="muted">No recent data</span>',
        item ? e(clock(item.at, state.sourceZone ? item.zone : 'UTC', true)) : '—', e(item?.zone ?? site.zone)];
    }))}</section>`;
}
function overview(site) {
  const latest = new Map(site.latest.map(item => [item.metric, item.value]));
  const active = snapshot.incidents.filter(item => item.active);
  const online = snapshot.sites.filter(item => item.link === 'Excellent').length;
  return `<section class="summary-grid" aria-label="Current operations metrics">
    ${stat('Environment health', site.state, site.reason, '◈')}
    ${stat('Collectors online', `${online}/${snapshot.sites.length}`, 'Fresh regional heartbeats', '▤', 'green')}
    ${stat('Active incidents', active.length, active.length ? `${active.filter(item => item.severity === 3).length} critical` : 'No active incidents', '◇', 'amber')}
    ${stat('Network latency', val('latency', latest.get('latency')), `${site.name} · latest reading`, '⌁', 'blue')}
  </section>
  <section class="trend-grid" aria-label="Metric trends">
    ${chart('Infrastructure utilization', e(site.name), 'infra', ['CPU', 'Memory'], 'percent', true)}
    ${chart('Network performance', e(site.name), 'network', ['Latency (ms)', 'Packet loss (%)'], 'milliseconds and percent')}
  </section>
  <section class="detail-grid">${fleet()}${incidentList()}</section>${metricTable(site)}`;
}
function draw(canvas, metrics, scale, now, span, points) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);
  const x0 = 41, x1 = width - (scale.length === 2 ? 38 : 18), y0 = 10, y1 = height - 27;
  const time0 = now - span;
  const x = at => x0 + (x1 - x0) * (at - time0) / span;
  const labels = width < 330 ? 3 : 4;
  context.font = '12px "Segoe UI", sans-serif';
  for (let index = 0; index <= 4; index++) {
    const y = y1 - (y1 - y0) * index / 4;
    context.beginPath();
    context.moveTo(x0, y);
    context.lineTo(x1, y);
    context.strokeStyle = '#ecebf4';
    context.stroke();
    context.textAlign = 'right';
    context.fillStyle = '#69697e';
    context.fillText(String(scale[0] * index / 4), x0 - 7, y + 4);
    if (scale.length === 2) {
      context.textAlign = 'left';
      context.fillText(String(scale[1] * index / 4), x1 + 7, y + 4);
    }
  }
  for (let index = 0; index < labels; index++) {
    const stamp = time0 + span * index / (labels - 1);
    context.textAlign = index === labels - 1 ? 'right' : index === 0 ? 'left' : 'center';
    context.fillText(timing(stamp), x(stamp), height - 7);
  }
  let any = false;
  metrics.forEach((metric, series) => {
    const color = series ? '#259d99' : '#7354e0';
    const maximum = scale[series] ?? scale[0];
    const bySource = new Map();
    for (const sample of points) {
      if (sample.metric !== metric || sample.at < time0 || sample.at > now) continue;
      if (!bySource.has(sample.source)) bySource.set(sample.source, []);
      bySource.get(sample.source).push(sample);
    }
    for (const readings of bySource.values()) {
      any = true;
      let prior = null;
      context.beginPath();
      for (const sample of readings) {
        const y = y1 - (y1 - y0) * Math.min(1, sample.value / maximum);
        if (prior === null || sample.at - prior > snapshot.config.stale) context.moveTo(x(sample.at), y);
        else context.lineTo(x(sample.at), y);
        prior = sample.at;
      }
      context.strokeStyle = color;
      context.lineWidth = 2;
      context.lineJoin = 'round';
      context.stroke();
      const last = readings.at(-1);
      context.beginPath();
      context.arc(x(last.at), y1 - (y1 - y0) * Math.min(1, last.value / maximum), 2.8, 0, 2 * Math.PI);
      context.fillStyle = color;
      context.fill();
    }
  });
  if (!any) {
    context.fillStyle = '#68697e';
    context.textAlign = 'center';
    context.fillText('Waiting for readings', (x0 + x1) / 2, (y0 + y1) / 2);
  }
}
function drawCharts() {
  const infra = $('[data-chart="infra"]');
  if (!infra || !snapshot) return;
  const upper = (key, minimum, step) => snapshot.trend.reduce((max, item) =>
    item.metric === key ? Math.max(max, Math.ceil(item.value / step) * step) : max, minimum);
  draw(infra, ['cpu', 'memory'], [100], snapshot.now, state.span, snapshot.trend);
  draw($('[data-chart="network"]'), ['latency', 'loss'], [upper('latency', 100, 100), upper('loss', 4, 4)],
    snapshot.now, state.span, snapshot.trend);
}
function allIncidents() {
  if (!snapshot.incidents.length) return `<section class="panel"><div class="empty"><strong>No incidents recorded</strong>
    Warning and critical signals are correlated by source and event time.</div></section>`;
  return snapshot.incidents.map(item => {
    const last = item.audit.at(-1)?.status;
    const next = { undefined: ['propose', 'Propose simulation'], Proposed: ['approve', 'Approve simulation'],
      Approved: ['simulate', 'Run simulation'], Simulated: ['rollback', 'Simulate rollback'] }[last];
    return `<article class="panel incident-panel">${heading(e(item.title),
      `${item.id} · ${e(snapshot.sites.find(site => site.id === item.site)?.name)} · ${item.count} signals · ${timing(item.start, true)}`,
      chip(item.active ? item.severity === 3 ? 'Critical' : 'Warning' : 'Historical', item.active ? item.severity === 3 ? 'poor' : 'fair' : 'good'))}
      <div class="incident-body"><p><strong>Likely cause</strong> ${e(item.cause)}</p>
      <p><strong>Recommendation</strong> ${e(item.action)}</p><p><strong>Signal confidence</strong> ${e(item.confidence)} · ${item.signals.length} distinct signals</p>
      <p><strong>Affected source</strong> <span class="mono">${e(item.source)}</span></p></div>
      ${table(['Signal', 'Observed', 'Baseline', 'Deviation', 'Detection reason'], item.signals.map(signal =>
        [e(snapshot.metrics[signal.metric].name), e(val(signal.metric, signal.value)), e(val(signal.metric, signal.baseline)),
          signal.deviation === null ? '—' : `${signal.deviation.toFixed(1)} σ`, e(signal.reason)]))}
      ${config.demo ? `<div class="incident-body"><div class="action-bar">
        ${next ? `<button class="button" data-action="${next[0]}" data-incident="${item.id}">${next[1]}</button>` : ''}
        <span class="muted">Policy · simulation only</span></div>
        ${item.audit.map(log => `<p>${timing(log.at, true)} · ${e(log.status)}</p>`).join('')}</div>` : ''}</article>`;
  }).join('');
}
function collectors() {
  const history = snapshot.history.map(row => [e(snapshot.sites.find(site => site.id === row.site)?.name), e(clock(row.at, 'UTC', true)),
    row.previous === null ? '—' : e(snapshot.states[row.previous]), chip(snapshot.states[row.state]), e(row.reason)]);
  const thresholds = Object.entries(snapshot.config.thresholds).map(([metric, limits]) =>
    [e(snapshot.metrics[metric].name), ...limits.map(limit => e(val(metric, limit)))]);
  return `<div class="section-gap">${fleet(true)}</div>
    <section class="panel legend-panel">${heading('Health policy',
    `Heartbeat is stale after ${snapshot.config.stale / 1000}s and offline after ${snapshot.config.offline / 1000}s. Anomalies and outages can raise severity.`)}
    <div class="legend-states">${snapshot.states.map(label => chip(label)).join('')}</div></section>
    <section class="panel section-gap">${heading('Health transitions', 'State changes are recorded in UTC.')}
    ${history.length ? table(['Environment', 'UTC time', 'Previous', 'New state', 'Reason'], history) : '<div class="empty">Waiting for transitions.</div>'}</section>
    <section class="panel">${heading('Configured thresholds', 'Good, Fair and Poor begin at the listed values. Percentage and network readings below these ranges may still deviate from baseline.')}
    ${table(['Signal', 'Good', 'Fair', 'Poor'], thresholds)}</section>`;
}
function evidence(site) {
  const m = snapshot.measurements;
  return `<section class="summary-grid" aria-label="Measured performance">
    ${stat('Collection to render', seconds(m.renderP95), `${m.renderCount} sampled readings · p95 target ≤ 10 s`, '◷')}
    ${stat('Breach to alert', seconds(m.alertMax), `${m.alertCount} warning or critical signals · target ≤ 15 s`, '◇', 'amber')}
    ${stat('Offline detection', seconds(m.offlineLast), 'Last measured transition · target ≤ 60 s', '▤', 'blue')}
    ${stat('Retries deduplicated', snapshot.duplicateCount, `${snapshot.receiptCount} unique receipts for this collector`, '⇄', 'green')}
  </section>
  <section class="panel">${heading('Regional ingest receipts', `${e(site.name)} · ${e(snapshot.tenant.region)} · latest ${snapshot.receipts.length} receipts`,
    `<a class="button" href="${collectorLink()}" target="_blank" rel="noopener">Open egress proof</a>`)}
    ${snapshot.receipts.length ? table(['Payload ID', 'Received (UTC)', 'SHA-256', 'Retries'], snapshot.receipts.slice(0, 40).map(receipt => [
      `<a class="mono" href="${collectorLink(site.id, receipt.id)}" target="_blank" rel="noopener">${e(receipt.id)}</a>`,
      clock(receipt.received, 'UTC', true), `<span class="mono" title="${e(receipt.digest)}">${e(receipt.digest.slice(0, 22))}…</span>`, receipt.duplicates
    ])) : '<div class="empty">Waiting for regional ingest.</div>'}</section>`;
}
function acknowledgeRender(site) {
  if (state.view !== 'overview' || document.visibilityState !== 'visible') return;
  const ids = site.latest.filter(item => !state.ack.has(item.id)).map(item => item.id);
  if (!ids.length) return;
  ids.forEach(id => state.ack.add(id));
  const generation = state.generation;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (state.generation !== generation || document.visibilityState !== 'visible') {
      if (state.generation === generation) ids.forEach(id => state.ack.delete(id));
      return;
    }
    api(`/api/rendered?site=${encodeURIComponent(site.id)}`, { data: { ids } }).catch(() => {
      if (state.generation === generation) ids.forEach(id => state.ack.delete(id));
    });
  }));
}
function render(force = false) {
  if (!snapshot || (!force && content.contains(document.activeElement))) return;
  const site = snapshot.sites.find(item => item.id === environment.value);
  if (!site) return;
  const [crumb, label, title, subtitle] = views[state.view];
  $('#crumb').textContent = crumb;
  $('#section-label').textContent = label;
  $('#title').textContent = title;
  $('#subtitle').textContent = subtitle;
  $('#side-region').textContent = snapshot.tenant.region;
  $('#collector-link').href = collectorLink();
  $('#timezone').textContent = `◷  ${state.sourceZone ? site.zone : 'UTC'}`;
  const active = snapshot.incidents.filter(item => item.active).length;
  $('#nav-incidents').hidden = active === 0;
  $('#nav-incidents').textContent = active;
  document.querySelectorAll('.nav[data-view]').forEach(button => {
    const current = button.dataset.view === state.view;
    button.classList.toggle('active', current);
    if (current) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  content.innerHTML = ({ overview, incidents: allIncidents, collectors, evidence })[state.view](site);
  $('#app').hidden = false;
  drawCharts();
  acknowledgeRender(site);
}
async function refresh(force = false) {
  if (loading && !force || !config || !$('#login').hidden) return;
  const generation = state.generation;
  loading = true;
  try {
    const query = new URLSearchParams({ span: state.span });
    if (environment.value) query.set('site', environment.value);
    const updated = await api(`/api/snapshot?${query}`);
    if (generation !== state.generation) return;
    snapshot = updated;
    fillSelect(environment, snapshot.sites.map(site => [site.id, site.name]), environment.value);
    $('#workspace-name').textContent = snapshot.tenant.name;
    render(force);
    setLive(true, config.simulator ? 'Live · Simulator' : 'Live');
    if ($('#message').classList.contains('error')) message();
  } catch (error) {
    if (generation !== state.generation) return;
    if (error.status === 401 && !config.demo) {
      $('#login').hidden = false;
      $('#app').hidden = true;
    } else message(error.message, true);
    setLive(false, 'Disconnected');
  } finally {
    if (generation === state.generation) loading = false;
  }
}
async function selectTenant(tenant, token) {
  state.generation += 1;
  state.ack.clear();
  snapshot = null;
  environment.replaceChildren();
  $('#app').hidden = true;
  await api('/api/session', { data: { tenant, token } });
  $('#login').hidden = true;
  await refresh(true);
}
function chooseSite(site) {
  environment.value = site;
  state.generation += 1;
  void refresh(true);
}
tenantSelect.addEventListener('change', () => selectTenant(tenantSelect.value).catch(error => message(error.message, true)));
environment.addEventListener('change', () => chooseSite(environment.value));
$('#timezone').addEventListener('click', () => { state.sourceZone = !state.sourceZone; render(true); });
$('#login').addEventListener('submit', event => {
  event.preventDefault();
  selectTenant(null, $('#token').value).then(() => { $('#token').value = ''; }).catch(error => message(error.message, true));
});
document.addEventListener('click', async event => {
  const view = event.target.closest('button[data-view]');
  if (view) {
    state.view = view.dataset.view;
    render(true);
  }
  const site = event.target.closest('button[data-site]');
  if (site) {
    state.view = 'overview';
    chooseSite(site.dataset.site);
    window.scrollTo(0, 0);
  }
  const action = event.target.closest('button[data-action]');
  if (action) {
    action.disabled = true;
    try {
      await api('/api/action', { data: { id: action.dataset.incident, step: action.dataset.action } });
      await refresh(true);
    } catch (error) { message(error.message, true); }
    finally { action.disabled = false; }
  }
});
content.addEventListener('change', event => {
  if (event.target.id === 'span') {
    state.span = Number(event.target.value);
    state.generation += 1;
    void refresh(true);
  }
});
window.addEventListener('resize', drawCharts);

try {
  config = await api('/api/config');
  if (config.demo) {
    fillSelect(tenantSelect, config.tenants.map(tenant => [tenant.id, tenant.name]), config.tenants[0].id);
    tenantSelect.hidden = false;
    await selectTenant(tenantSelect.value);
  } else {
    $('#workspace-name').hidden = false;
    await refresh(true);
  }
  setInterval(refresh, 1400);
} catch (error) { message(error.message, true); }
