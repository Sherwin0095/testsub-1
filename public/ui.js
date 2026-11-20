export const $ = (selector, root = document) => root.querySelector(selector);
export const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export async function api(path, { data, token } = {}) {
  const headers = {};
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { method: data === undefined ? 'GET' : 'POST', headers,
    body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await res.json();
  if (!res.ok) throw Object.assign(new Error(result.error ?? 'Request failed'), { status: res.status });
  return result;
}
export function message(text = '', error = false) {
  const node = $('#message');
  node.textContent = text;
  node.classList.toggle('error', error);
  node.hidden = !text;
}
export function fillSelect(select, options, selected) {
  const same = select.options.length === options.length &&
    options.every(([value, label], index) => select.options[index].value === String(value) && select.options[index].text === label);
  if (!same) select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  select.value = options.some(([value]) => String(value) === String(selected)) ? selected : (options[0]?.[0] ?? '');
}
export const stat = (title, value, note, icon, color = '') => `
  <article class="stat"><div class="stat-top">${escape(title)}<span class="stat-icon ${color}" aria-hidden="true">${icon}</span></div>
  <strong class="stat-value">${escape(value)}</strong><span class="stat-note">${escape(note)}</span></article>`;
export const chip = (label, state = label) => `<span class="chip ${escape(state.toLowerCase())}"><i></i>${escape(label)}</span>`;
export const seconds = value => value === null || value === undefined ? '—' : `${(value / 1000).toFixed(1)} s`;
export function clock(value, zone = 'UTC', full = false) {
  if (value === null || value === undefined) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit',
    ...(full ? { day: '2-digit', month: 'short', timeZoneName: 'short' } : {}) }).format(new Date(value));
}
