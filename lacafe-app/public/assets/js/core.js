// Utilitas UI: template aman-XSS, DOM helper, toast, sheet/dialog, format.
import { rupiah } from './loyalty.js';

// ---------- Template HTML yang otomatis meng-escape semua nilai ----------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s ?? ''));
function val(x) {
  if (x instanceof Raw) return x.s;
  if (Array.isArray(x)) return x.map(val).join('');
  if (x === null || x === undefined || x === false) return '';
  return esc(x);
}
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += val(vals[i]) + strings[i + 1];
  return new Raw(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function mount(el, content) { el.innerHTML = val(content); return el; }
export function on(root, event, selector, fn) {
  const h = (e) => {
    const t = e.target.closest(selector);
    if (t && root.contains(t)) fn(e, t);
  };
  root.addEventListener(event, h);
  return () => root.removeEventListener(event, h);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Format ----------
export { rupiah };
export const num = (n) => Math.round(Number(n) || 0).toLocaleString('id-ID');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
export function fdate(iso, withYear = true) {
  if (!iso) return '–';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${withYear ? ' ' + y : ''}`;
}
export function fdatetime(sql) {
  if (!sql) return '–';
  const d = new Date(String(sql).replace(' ', 'T') + (String(sql).includes('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return fdate(sql);
  return d.toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
export function ago(sql) {
  const d = new Date(String(sql).replace(' ', 'T') + 'Z');
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'baru saja';
  if (s < 3600) return `${Math.floor(s / 60)} menit lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return fdatetime(sql);
}
export function greeting() {
  const h = new Date().getHours();
  return h < 11 ? 'Selamat pagi' : h < 15 ? 'Selamat siang' : h < 18 ? 'Selamat sore' : 'Selamat malam';
}
export const firstName = (n) => String(n || '').split(' ')[0];

// ---------- Tema ----------
const RADII = { sharp: [4, 6, 10], soft: [8, 14, 20], round: [12, 20, 28] };
const FONTS = {
  jakarta: ["'Plus Jakarta Sans', system-ui, sans-serif", "'Plus Jakarta Sans', system-ui, sans-serif"],
  system: ['system-ui, -apple-system, Segoe UI, Roboto, sans-serif', 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif'],
  serif: ["'Plus Jakarta Sans', system-ui, sans-serif", "'Fraunces', Georgia, serif"],
};
export const THEMES = {
  indigo: { label: 'Indigo aren', colors: { primary: '#1E2A5A', accent: '#E0A43A', bg: '#F4F5F9', surface: '#FFFFFF', text: '#161A2B' } },
  pandan: { label: 'Pandan', colors: { primary: '#1D5C45', accent: '#E7B04B', bg: '#F3F6F2', surface: '#FFFFFF', text: '#14221B' } },
  kenangan: { label: 'Merah bata', colors: { primary: '#7A1F2B', accent: '#F0C05A', bg: '#F8F4F3', surface: '#FFFFFF', text: '#241416' } },
  espresso: { label: 'Espresso', colors: { primary: '#3B2A20', accent: '#D19A5B', bg: '#F6F3F0', surface: '#FFFFFF', text: '#1E1712' } },
  laut: { label: 'Laut', colors: { primary: '#0E4C66', accent: '#F28C38', bg: '#F1F6F8', surface: '#FFFFFF', text: '#0F2029' } },
  malam: { label: 'Malam', colors: { primary: '#E0A43A', accent: '#7FB5FF', bg: '#12141C', surface: '#1C1F2B', text: '#ECEDF3' } },
};
export function applyTheme(app, el = document.documentElement) {
  const c = app.colors || THEMES.indigo.colors;
  const [s, m, l] = RADII[app.radius] || RADII.soft;
  const [body, display] = FONTS[app.font] || FONTS.jakarta;
  const set = (k, v) => el.style.setProperty(k, v);
  set('--primary', c.primary); set('--accent', c.accent); set('--bg', c.bg); set('--surface', c.surface); set('--text', c.text);
  set('--on-primary', readableOn(c.primary)); set('--on-accent', readableOn(c.accent));
  set('--r-sm', s + 'px'); set('--r-md', m + 'px'); set('--r-lg', l + 'px');
  set('--font', body); set('--font-display', display);
  if (el === document.documentElement) {
    document.title = app.brandName || 'LaCafe';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', c.primary);
  }
}
export function readableOn(hex, threshold = 0.42) {
  const n = parseInt(String(hex).slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > threshold ? '#14161F' : '#FFFFFF';
}

// ---------- Toast ----------
export function toast(message, type = 'info') {
  let host = document.getElementById('toasts');
  if (!host) { host = document.createElement('div'); host.id = 'toasts'; host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite'); document.body.append(host); }
  const t = document.createElement('div');
  t.className = 'toast toast-' + type;
  t.textContent = message;
  host.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, type === 'error' ? 4500 : 2800);
}

// ---------- Sheet (bottom-sheet di HP, dialog di desktop) ----------
export function sheet(content, { title = '', wide = false, className = '', onClose } = {}) {
  const prevFocus = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop';
  wrap.innerHTML = val(html`<div class="sheet ${wide ? 'sheet-wide' : ''} ${className}" role="dialog" aria-modal="true" aria-label="${title || 'Dialog'}">
    ${title ? html`<header class="sheet-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="Tutup">${icon('x')}</button></header>` : html`<button class="icon-btn sheet-x" data-close aria-label="Tutup">${icon('x')}</button>`}
    <div class="sheet-body"></div></div>`);
  const body = wrap.querySelector('.sheet-body');
  mount(body, content);
  document.body.append(wrap);
  document.body.classList.add('no-scroll');
  requestAnimationFrame(() => wrap.classList.add('in'));
  const close = () => {
    wrap.classList.remove('in');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => { wrap.remove(); if (!document.querySelector('.sheet-backdrop')) document.body.classList.remove('no-scroll'); prevFocus?.focus?.(); }, 220);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape' && wrap === [...document.querySelectorAll('.sheet-backdrop')].pop()) close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
  setTimeout(() => (wrap.querySelector('[autofocus]') || wrap.querySelector('.sheet'))?.focus?.(), 50);
  wrap.querySelector('.sheet').tabIndex = -1;
  return { el: body, close, root: wrap };
}

export function confirmDialog(message, { title = 'Konfirmasi', confirmText = 'Ya, lanjutkan', danger = false, input = null } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const s = sheet(html`<p class="dialog-msg">${message}</p>
      ${input ? html`<label class="field"><span>${input.label}</span><input name="dlg" maxlength="${input.max || 200}" placeholder="${input.placeholder || ''}" autofocus></label>` : ''}
      <div class="dialog-actions"><button class="btn btn-ghost" data-close>Batal</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${confirmText}</button></div>`,
    { title, onClose: () => { if (!done) resolve(input ? null : false); } });
    s.el.querySelector('[data-ok]').addEventListener('click', () => {
      if (input) {
        const v = s.el.querySelector('input').value.trim();
        if ((input.min || 0) > v.length) { toast(`${input.label} minimal ${input.min} karakter`, 'error'); return; }
        done = true; resolve(v);
      } else { done = true; resolve(true); }
      s.close();
    });
  });
}

export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else if (el.type === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
    else out[el.name] = el.value;
  }
  return out;
}

export function busy(btn, on = true) {
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle('is-busy', on);
}

// ---------- Ikon (SVG garis, 24px) ----------
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-6h4v6"/>',
  cup: '<path d="M5 8h12v6a6 6 0 0 1-6 6h0a6 6 0 0 1-6-6V8Z"/><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3c0 1 1 1 1 2s-1 1-1 2M12 3c0 1 1 1 1 2s-1 1-1 2"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v8h14v-8M12 8v12"/><path d="M12 8C10 4 6 4 6.5 6.5S12 8 12 8Zm0 0c2-4 6-4 5.5-1.5S12 8 12 8Z"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.5 3.5-5.5 6.5-5.5s5.5 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2 .7 3 2.5 3.5 5"/>',
  ticket: '<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4V8Z"/><path d="M14 6v12" stroke-dasharray="2 2"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M7 12h10"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  bag: '<path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  register: '<rect x="3" y="11" width="18" height="9" rx="1.5"/><path d="M6 11V5h8v6M14 7h4v4"/><path d="M7 15h2M11 15h2M15 15h2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.9M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m3 17 5-5 4 4 3-3 6 6"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  drag: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M14 9l2 2"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5c0-1 1-1.5 2.5-1.5s2.5.7 2.5 1.7-1 1.5-2.5 1.8-2.5.8-2.5 1.8 1 1.7 2.5 1.7 2.5-.5 2.5-1.5"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 7a8 8 0 1 0 11.4 0"/>',
};
export function icon(name, size = 20) {
  return raw(`<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`);
}

// ---------- Ilustrasi menu (dipakai bila menu belum punya foto) ----------
const TINTS = [['#F3E3D3', '#7A4A2A'], ['#E6E9F5', '#2C3A73'], ['#E4EFE7', '#2D6047'], ['#F6E7E1', '#8A3A2A'], ['#EEE6F3', '#5B3A73'], ['#F5EDD6', '#7A5A12']];
function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
export function menuArt(item, catKey = '') {
  const [bg, fg] = TINTS[hash(item.name) % TINTS.length];
  const n = item.name.toLowerCase();
  let body;
  if (catKey === 'makanan' || /toast|croissant|fries|platter|sausage|cake|bread|roti/.test(n)) {
    body = `<ellipse cx="32" cy="44" rx="20" ry="5" fill="${fg}" opacity=".15"/><path d="M14 38c2-10 9-16 18-16s16 6 18 16c-6 3-12 4-18 4s-12-1-18-4Z" fill="${fg}" opacity=".85"/><path d="M22 30c2 2 4 3 6 3M32 27c1 3 1 5 0 8M42 30c-2 2-4 3-6 3" stroke="${bg}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  } else if (item.temp === 'hot' || /hot|v60/.test(n)) {
    body = `<path d="M24 12c0 2 2 2 2 4s-2 2-2 4M32 10c0 2 2 2 2 4s-2 2-2 4M40 12c0 2 2 2 2 4s-2 2-2 4" stroke="${fg}" stroke-width="2" fill="none" stroke-linecap="round" opacity=".5"/><path d="M16 26h32v8a14 14 0 0 1-14 14h-4a14 14 0 0 1-14-14v-8Z" fill="${fg}"/><path d="M48 29h3a5 5 0 0 1 0 10h-4" stroke="${fg}" stroke-width="3" fill="none"/><ellipse cx="32" cy="52" rx="20" ry="3" fill="${fg}" opacity=".18"/>`;
  } else {
    body = `<path d="M37 6 33 18" stroke="${fg}" stroke-width="2.5" stroke-linecap="round"/><path d="M19 18h26l-3 34a3 3 0 0 1-3 3H25a3 3 0 0 1-3-3l-3-34Z" fill="${fg}" opacity=".9"/><path d="M20.5 30h23" stroke="${bg}" stroke-width="2" opacity=".6"/><rect x="25" y="34" width="6" height="6" rx="1.5" fill="${bg}" opacity=".45"/><rect x="33" y="40" width="6" height="6" rx="1.5" fill="${bg}" opacity=".35"/><rect x="17" y="15" width="30" height="4" rx="2" fill="${fg}"/>`;
  }
  return raw(`<svg viewBox="0 0 64 64" class="art" aria-hidden="true" style="background:${bg}">${body}</svg>`);
}
export function menuThumb(item, catKey) {
  if (item.image) return html`<img class="art" src="${item.image}" alt="" loading="lazy">`;
  return menuArt(item, catKey);
}
