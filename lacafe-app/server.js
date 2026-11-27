// LaCafe Member — server utama. Jalankan: node server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from './src/db.js';
import { seed, isEmpty } from './src/seed.js';
import { buildRouter } from './src/routes.js';
import { HttpError, parseCookies, readBody, sendJson, forbidden, unauthorized } from './src/http.js';
import { securityHeaders, safeEqual } from './src/security.js';

process.removeAllListeners('warning'); // sembunyikan peringatan "SQLite experimental"

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const COOKIE_SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === '1' : process.env.NODE_ENV === 'production';

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Kunci rahasia server (untuk kode member berputar). Dibuat sekali, disimpan dengan izin 600.
function loadSecret() {
  if (process.env.APP_SECRET && process.env.APP_SECRET.length >= 32) return process.env.APP_SECRET;
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(48).toString('base64url'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

const db = openDb(path.join(DATA_DIR, 'lacafe.db'));
// Data awal: cari seed.json di beberapa lokasi (folder data bisa tertutup volume hosting)
const SEED_FILE = [process.env.SEED_FILE, path.join(DATA_DIR, 'seed.json'), path.join(ROOT, 'seed', 'seed.json'), path.join(ROOT, 'data', 'seed.json')]
  .find((f) => f && fs.existsSync(f));
if (isEmpty(db)) seed(db, SEED_FILE || path.join(DATA_DIR, 'seed.json'));
const { router, loadAuth } = buildRouter({ db, secret: loadSecret(), uploadsDir: UPLOADS_DIR, cookieSecure: COOKIE_SECURE });

// Bersihkan sesi kedaluwarsa tiap jam
setInterval(() => db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run(), 3600_000).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};

function serveFile(res, file, headers, cache) {
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext];
  if (!type) { res.writeHead(404, headers); return res.end(); }
  const stream = fs.createReadStream(file);
  stream.on('error', () => { if (!res.headersSent) res.writeHead(404, headers); res.end(); });
  res.writeHead(200, { ...headers, 'Content-Type': type, 'Cache-Control': cache });
  stream.pipe(res);
}

function safeJoin(base, rel) {
  const p = path.resolve(base, '.' + path.sep + rel);
  return p.startsWith(base + path.sep) ? p : null;
}

const server = http.createServer(async (req, res) => {
  const isHttps = TRUST_PROXY ? req.headers['x-forwarded-proto'] === 'https' : !!req.socket.encrypted;
  const headers = securityHeaders(isHttps);
  const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400, headers); return res.end(); }
  const pathname = decodeURIComponent(url.pathname);

  // ---------------- API ----------------
  if (pathname.startsWith('/api/')) {
    try {
      const found = router.match(req.method, pathname);
      if (!found) throw new HttpError(404, 'Endpoint tidak ditemukan', 'not_found');
      if (found.methodNotAllowed) throw new HttpError(405, 'Metode tidak diizinkan', 'method');
      const { route, params } = found;
      const opts = route.opts || {};
      const mutating = req.method !== 'GET';

      // Tolak request lintas situs (selain CSRF token di bawah)
      if (mutating) {
        const origin = req.headers.origin;
        if (origin) {
          let ok = false;
          try { ok = new URL(origin).host === req.headers.host; } catch {}
          if (!ok) throw forbidden('Asal permintaan tidak diizinkan');
        }
      }

      const auth = loadAuth(parseCookies(req.headers.cookie));
      const need = opts.auth;
      if (need) {
        if (!auth) throw unauthorized();
        if (need === 'customer' && auth.kind !== 'customer') throw forbidden();
        if ((need === 'staff' || need === 'admin') && auth.kind !== 'staff') throw forbidden();
        if (need === 'admin' && auth.role !== 'admin') throw forbidden('Hanya admin yang bisa melakukan ini');
        if (auth.kind === 'staff' && auth.mustChange && !opts.allowMustChange) throw new HttpError(403, 'Ganti kata sandi awal terlebih dahulu', 'must_change_password');
      }
      if (mutating && opts.csrf !== false && auth) {
        if (!safeEqual(req.headers['x-csrf-token'], auth.csrf)) throw new HttpError(403, 'Sesi tidak valid, muat ulang halaman', 'csrf');
      }

      const body = mutating ? await readBody(req, opts.limit || 100_000) : {};
      const result = await route.handler({ req, res, params, query: url.searchParams, body, auth, ip });
      if (opts.raw) {
        res.writeHead(200, { ...headers, 'Content-Type': result.type, 'Content-Disposition': `attachment; filename="${result.filename}"`, 'Cache-Control': 'no-store' });
        return res.end(result.body);
      }
      return sendJson(res, 200, result, headers);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, code: err.code }, headers);
      if (String(err?.message || '').includes('UNIQUE constraint')) return sendJson(res, 409, { error: 'Data bentrok dengan data lain, coba lagi', code: 'conflict' }, headers);
      console.error(new Date().toISOString(), req.method, pathname, err);
      return sendJson(res, 500, { error: 'Terjadi kesalahan di server', code: 'server_error' }, headers);
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers); return res.end(); }

  // ---------------- Gambar upload ----------------
  if (pathname.startsWith('/uploads/')) {
    const name = pathname.slice('/uploads/'.length);
    if (!/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(name)) { res.writeHead(404, headers); return res.end(); }
    return serveFile(res, path.join(UPLOADS_DIR, name), headers, 'public, max-age=31536000, immutable');
  }

  // ---------------- File statis + SPA ----------------
  const file = pathname === '/' ? null : safeJoin(PUBLIC_DIR, pathname);
  if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
    return serveFile(res, file, headers, pathname.startsWith('/assets/') ? 'no-cache' : 'no-cache');
  }
  if (path.extname(pathname)) { res.writeHead(404, headers); return res.end(); }
  return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), headers, 'no-cache');
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(PORT, HOST, () => {
  console.log(`☕ LaCafe Member berjalan di http://localhost:${PORT}`);
  console.log(`   Customer : http://localhost:${PORT}/`);
  console.log(`   Admin    : http://localhost:${PORT}/#/admin`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
