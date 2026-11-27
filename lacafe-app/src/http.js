// Router & utilitas HTTP minimal (tanpa dependency).
export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}
export const bad = (msg, code = 'invalid') => new HttpError(400, msg, code);
export const unauthorized = (msg = 'Silakan masuk terlebih dahulu') => new HttpError(401, msg, 'unauthorized');
export const forbidden = (msg = 'Anda tidak punya akses untuk tindakan ini') => new HttpError(403, msg, 'forbidden');
export const notFound = (msg = 'Data tidak ditemukan') => new HttpError(404, msg, 'not_found');
export const conflict = (msg) => new HttpError(409, msg, 'conflict');

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, opts, handler) {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^\\/]+)'; }) + '$');
    this.routes.push({ method, re, keys, opts, handler });
  }
  get(p, o, h) { this.add('GET', p, o, h); }
  post(p, o, h) { this.add('POST', p, o, h); }
  patch(p, o, h) { this.add('PATCH', p, o, h); }
  put(p, o, h) { this.add('PUT', p, o, h); }
  delete(p, o, h) { this.add('DELETE', p, o, h); }
  match(method, path) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = path.match(r.re);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Data terlalu besar', 'too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const ct = String(req.headers['content-type'] || '');
      if (!ct.includes('application/json')) return reject(bad('Content-Type harus application/json'));
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v === null || typeof v !== 'object' || Array.isArray(v)) return reject(bad('Format data tidak valid'));
        resolve(v);
      } catch { reject(bad('JSON tidak valid')); }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(body);
}

// ---------- Validasi input ----------
export const v = {
  str(x, name, { min = 0, max = 200, required = true, pattern } = {}) {
    if (x === undefined || x === null || x === '') {
      if (required) throw bad(`${name} wajib diisi`);
      return null;
    }
    if (typeof x !== 'string') throw bad(`${name} tidak valid`);
    const s = x.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (s.length < min) throw bad(`${name} minimal ${min} karakter`);
    if (s.length > max) throw bad(`${name} maksimal ${max} karakter`);
    if (pattern && !pattern.test(s)) throw bad(`${name} tidak valid`);
    return s;
  },
  int(x, name, { min = -1e12, max = 1e12, required = true } = {}) {
    if (x === undefined || x === null || x === '') {
      if (required) throw bad(`${name} wajib diisi`);
      return null;
    }
    const n = typeof x === 'string' ? Number(x) : x;
    if (!Number.isInteger(n)) throw bad(`${name} harus bilangan bulat`);
    if (n < min || n > max) throw bad(`${name} harus di antara ${min} dan ${max}`);
    return n;
  },
  num(x, name, { min = -1e12, max = 1e12 } = {}) {
    const n = typeof x === 'string' ? Number(x) : x;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw bad(`${name} harus angka`);
    if (n < min || n > max) throw bad(`${name} harus di antara ${min} dan ${max}`);
    return n;
  },
  bool(x, def = false) { return x === undefined ? def : !!x; },
  oneOf(x, name, list, { required = true } = {}) {
    if ((x === undefined || x === null || x === '') && !required) return null;
    if (!list.includes(x)) throw bad(`${name} tidak valid`);
    return x;
  },
  phone(x, { required = true } = {}) {
    if (x === undefined || x === null || x === '') {
      if (required) throw bad('Nomor WhatsApp wajib diisi');
      return null;
    }
    let d = String(x).replace(/\D/g, '');
    if (d.startsWith('62')) d = '0' + d.slice(2);
    else if (d && !d.startsWith('0')) d = '0' + d;
    if (!/^08\d{7,12}$/.test(d)) throw bad('Nomor WhatsApp tidak valid (contoh: 0812xxxxxxx)');
    return d;
  },
  date(x, name, { required = true } = {}) {
    if (!x) { if (required) throw bad(`${name} wajib diisi`); return null; }
    if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x) || Number.isNaN(Date.parse(x))) throw bad(`${name} tidak valid`);
    return x;
  },
  color(x, name) {
    if (typeof x !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(x)) throw bad(`${name} harus warna hex, contoh #1E2A5A`);
    return x.toUpperCase();
  },
  password(x) {
    if (typeof x !== 'string' || x.length < 8) throw bad('Kata sandi minimal 8 karakter');
    if (x.length > 128) throw bad('Kata sandi maksimal 128 karakter');
    if (!/[A-Za-z]/.test(x) || !/\d/.test(x)) throw bad('Kata sandi harus berisi huruf dan angka');
    return x;
  },
};
