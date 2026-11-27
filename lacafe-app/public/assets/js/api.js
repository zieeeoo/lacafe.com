// Klien API. Semua request membawa cookie sesi (HttpOnly) + token CSRF.
// Alamat API mengikuti folder tempat index.html berada (bisa di subfolder hosting).
// Versi PHP menambahkan <meta name="lacafe-api" content="api.php"> sehingga URL menjadi /folder/api.php/api/...
const BASE = new URL('.', document.baseURI).pathname.replace(/\/$/, '');
const ENTRY = document.querySelector('meta[name="lacafe-api"]')?.content || '';
let queryMode = false; // cadangan bila hosting tidak mendukung PATH_INFO: api.php?r=/api/...
const url = (p) => {
  if (!ENTRY) return BASE + p;
  if (!queryMode) return `${BASE}/${ENTRY}${p}`;
  const [path, qs] = p.split('?');
  return `${BASE}/${ENTRY}?r=${encodeURIComponent(path)}${qs ? '&' + qs : ''}`;
};
let csrf = null;
export const setCsrf = (t) => { csrf = t || null; };

export class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

export async function api(method, path, body) {
  // Mode demo (artifact pratinjau): backend tiruan di browser.
  if (window.__LACAFE_DEMO__) {
    const r = await window.__LACAFE_DEMO__.handle(method, path, body);
    if (r.status >= 400) throw new ApiError(r.data.error, r.status, r.data.code);
    return r.data;
  }
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    if (csrf) opts.headers['X-CSRF-Token'] = csrf;
    opts.body = JSON.stringify(body || {});
  }
  let res;
  try { res = await fetch(url(path), opts); } catch { throw new ApiError('Tidak bisa terhubung ke server. Periksa koneksi internet.', 0, 'network'); }
  let data = null;
  try { data = await res.json(); } catch { /* bukan JSON */ }
  if (ENTRY && !queryMode && res.status === 404 && data === null) { queryMode = true; return api(method, path, body); }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new CustomEvent('lacafe:unauthorized'));
    if (data?.code === 'must_change_password') window.dispatchEvent(new CustomEvent('lacafe:mustchange'));
    throw new ApiError(data?.error || `Gagal (${res.status})`, res.status, data?.code);
  }
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b) => api('POST', p, b);
export const patch = (p, b) => api('PATCH', p, b);
export const put = (p, b) => api('PUT', p, b);
export const del = (p) => api('DELETE', p);

export function download(path) {
  if (window.__LACAFE_DEMO__) return window.__LACAFE_DEMO__.download(path);
  const a = document.createElement('a');
  a.href = url(path);
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}
