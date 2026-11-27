// Uji otomatis: hitungan Excel, keamanan, dan aturan poin. Jalankan: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = process.env.TARGET || 'node'; // 'node' atau 'php'
const PORT = 3900 + Math.floor(Math.random() * 90);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = TARGET === 'php' ? `${ORIGIN}/api.php` : ORIGIN;
let dir, proc;

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async req(method, p, body, headers = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (method !== 'GET') { h['content-type'] = 'application/json'; if (this.csrf && !('x-csrf-token' in h)) h['x-csrf-token'] = this.csrf; }
    const r = await fetch(BASE + p, { method, headers: h, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    const sc = r.headers.get('set-cookie');
    if (sc) { this.cookie = sc.split(';')[0]; this.lastSetCookie = sc; }
    let data = null; try { data = await r.json(); } catch {}
    if (data?.csrf) this.csrf = data.csrf;
    return { status: r.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b, h) { return this.req('POST', p, b, h); }
  patch(p, b) { return this.req('PATCH', p, b); }
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lacafe-test-'));
  fs.copyFileSync(path.join(ROOT, 'data', 'seed.json'), path.join(dir, 'seed.json'));
  if (TARGET === 'php') {
    const docroot = path.join(ROOT, 'dist-cpanel', 'lacafe');
    const env = { ...process.env, LACAFE_CONFIG: path.join(dir, 'config.php'), PHP_CLI_SERVER_WORKERS: '4' };
    const { execFileSync } = await import('node:child_process');
    execFileSync('php', [path.join(docroot, 'install.php'), '--admin-password=AdminTest123', `--data=${dir}`, `--seed=${path.join(ROOT, 'data', 'seed.json')}`], { env });
    proc = spawn('php', ['-S', `127.0.0.1:${PORT}`, '-t', docroot], { env, stdio: 'pipe' });
  } else {
    proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dir, ADMIN_PASSWORD: 'AdminTest123' }, stdio: 'pipe' });
  }
  for (let i = 0; i < 50; i++) { try { const r = await fetch(BASE + '/api/auth/session'); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('server tidak start');
});
after(() => { proc?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const admin = new Client();
const kasir = new Client();
const cust = new Client();

test('angka hasil import sama persis dengan rumus Excel', async () => {
  assert.equal((await admin.post('/api/auth/staff/login', { username: 'admin', password: 'AdminTest123' })).status, 200);
  const { data } = await admin.get('/api/staff/customers');
  const byCode = Object.fromEntries(data.map((c) => [c.memberCode, c]));
  const expect = { LC001: [1, 46000, 'reguler', 4], LC002: [1, 30000, 'reguler', 3], LC003: [1, 25000, 'reguler', 2], LC004: [1, 870000, 'silver', 87] };
  for (const [code, [visits, spend, tier, pts]] of Object.entries(expect)) {
    const s = byCode[code].stats;
    assert.deepEqual([s.visits, s.totalSpend, s.tier.key, s.points], [visits, spend, tier, pts], code);
  }
});

test('cookie sesi HttpOnly + SameSite=Strict', () => {
  assert.match(admin.lastSetCookie, /HttpOnly/);
  assert.match(admin.lastSetCookie, /SameSite=Strict/);
});

test('tanpa token CSRF / dari origin lain ditolak', async () => {
  assert.equal((await admin.post('/api/staff/customers', { name: 'X Test' }, { 'x-csrf-token': 'salah' })).status, 403);
  assert.equal((await admin.post('/api/staff/customers', { name: 'X Test' }, { origin: 'https://jahat.example' })).status, 403);
});

test('path traversal & file sensitif tidak bisa diakses', async () => {
  for (const p of ['/../server.js', '/%2e%2e/data/lacafe.db', '/uploads/../secret.key', '/data/secret.key']) {
    const r = await fetch(ORIGIN + p);
    const t = await r.text();
    assert.ok(!t.includes('DatabaseSync') && !t.includes('SQLite format'), p);
  }
});

test('aktivasi akun customer lama (kode sekali pakai)', async () => {
  const { data } = await admin.post('/api/staff/customers/4/activation', {});
  assert.match(data.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const r = await cust.post('/api/auth/customer/activate', { identifier: 'LC004', code: data.code, password: 'Aisah2026' });
  assert.equal(r.status, 200);
  const again = await new Client().post('/api/auth/customer/activate', { identifier: 'LC004', code: data.code, password: 'Lain12345' });
  assert.equal(again.status, 400, 'kode tidak boleh dipakai dua kali');
});

test('customer tidak bisa membuka endpoint staf', async () => {
  for (const p of ['/api/staff/customers', '/api/staff/dashboard', '/api/staff/audit']) assert.equal((await cust.get(p)).status, 403, p);
  assert.equal((await cust.post('/api/staff/customers/4/adjust-points', { delta: 9999, reason: 'curang' })).status, 403);
});

test('harga dari browser diabaikan, server memakai harga menu', async () => {
  const boot = (await cust.get('/api/public/bootstrap')).data;
  const kopi = boot.menu.find((m) => m.name === 'Kopi Susu Malaka');
  const r = await cust.post('/api/me/orders', { items: [{ menuItemId: kopi.id, qty: 2, price: 1 }], paymentMethod: boot.options.payments[0], total: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.data.total, kopi.price * 2);
  // poin belum masuk sebelum dibayar
  assert.equal((await cust.get('/api/me')).data.stats.points, 87);
  // kasir menyelesaikan -> poin kumulatif: INT((870000+46000)/10000) - 87 = 4
  const done = await admin.post(`/api/staff/orders/${r.data.id}/status`, { status: 'processing' });
  assert.equal(done.status, 200);
  await admin.post(`/api/staff/orders/${r.data.id}/status`, { status: 'ready' });
  const fin = await admin.post(`/api/staff/orders/${r.data.id}/status`, { status: 'completed', payment: boot.options.payments[0] });
  assert.equal(fin.data.pointsEarned, 4);
  assert.equal((await cust.get('/api/me')).data.stats.points, 91);
});

test('status pesanan tidak bisa melompat / customer tidak bisa batalkan pesanan yang diproses', async () => {
  const boot = (await cust.get('/api/public/bootstrap')).data;
  const r = await cust.post('/api/me/orders', { items: [{ menuItemId: boot.menu[0].id, qty: 1 }], paymentMethod: boot.options.payments[0] });
  assert.equal((await admin.post(`/api/staff/orders/${r.data.id}/status`, { status: 'completed' })).status, 409);
  await admin.post(`/api/staff/orders/${r.data.id}/status`, { status: 'processing' });
  assert.equal((await cust.post(`/api/me/orders/${r.data.id}/cancel`, {})).status, 400);
  assert.equal((await admin.post(`/api/staff/orders/${r.data.id}/status`, { status: 'cancelled', reason: 'tes' })).status, 200);
});

test('tukar poin bersamaan tidak bisa double-spend', async () => {
  const rewards = (await cust.get('/api/public/bootstrap')).data.rewards;
  const r30 = rewards.find((r) => r.pointsCost === 30 && !r.minTier);
  const before = (await cust.get('/api/me')).data.stats.points; // 91
  const results = await Promise.all(Array.from({ length: 6 }, () => cust.post('/api/me/redeem', { rewardId: r30.id })));
  const ok = results.filter((x) => x.status === 200).length;
  assert.equal(ok, Math.floor(before / 30));
  const after = (await cust.get('/api/me')).data.stats.points;
  assert.equal(after, before - ok * 30);
  assert.ok(after >= 0);
});

test('reward khusus level lebih tinggi ditolak', async () => {
  const rewards = (await cust.get('/api/public/bootstrap')).data.rewards;
  const gold = rewards.find((r) => r.minTier === 'gold');
  const r = await cust.post('/api/me/redeem', { rewardId: gold.id });
  assert.equal(r.status, 400);
});

test('voucher dipakai sekali; voucher member lain ditolak', async () => {
  const v = (await cust.get('/api/me/vouchers')).data.find((x) => x.status === 'active');
  const menu = (await admin.get('/api/staff/menu')).data.menu;
  const item = menu.find((m) => m.id === v.menuItemId);
  const other = await admin.post('/api/staff/transactions', { customerId: 1, items: [{ menuItemId: item.id, qty: 1 }], payment: 'Cash', voucherCode: v.code });
  assert.equal(other.status, 400);
  const sale = await admin.post('/api/staff/transactions', { customerId: 4, items: [{ menuItemId: item.id, qty: 2 }], payment: 'Cash', voucherCode: v.code });
  assert.equal(sale.status, 200);
  assert.equal(sale.data.discount, item.price);
  assert.equal(sale.data.total, item.price);
  const reuse = await admin.post('/api/staff/transactions', { customerId: 4, items: [{ menuItemId: item.id, qty: 1 }], payment: 'Cash', voucherCode: v.code });
  assert.equal(reuse.status, 400);
});

test('pembatalan transaksi menarik poin', async () => {
  const before = (await cust.get('/api/me')).data.stats.points;
  const menu = (await admin.get('/api/staff/menu')).data.menu;
  const sale = await admin.post('/api/staff/transactions', { customerId: 4, items: [{ menuItemId: menu.find((m) => m.price === 58000).id, qty: 5 }], payment: 'Cash' });
  assert.ok(sale.data.pointsEarned > 0);
  assert.equal((await cust.get('/api/me')).data.stats.points, before + sale.data.pointsEarned);
  assert.equal((await admin.post(`/api/staff/transactions/${sale.data.id}/void`, { reason: 'salah input' })).status, 200);
  assert.equal((await cust.get('/api/me')).data.stats.points, before);
  assert.equal((await admin.post(`/api/staff/transactions/${sale.data.id}/void`, { reason: 'lagi' })).status, 409);
});

test('kasir: bisa transaksi, tidak bisa koreksi poin / void / ubah harga / ubah aturan', async () => {
  const u = await admin.post('/api/staff/users', { username: 'kasir1', name: 'Kasir Satu', role: 'kasir', password: 'Kasir12345' });
  assert.equal(u.status, 200);
  await kasir.post('/api/auth/staff/login', { username: 'kasir1', password: 'Kasir12345' });
  assert.equal((await kasir.get('/api/staff/customers')).status, 403, 'wajib ganti password dulu');
  assert.equal((await kasir.post('/api/auth/password', { current: 'Kasir12345', next: 'KasirBaru99' })).status, 200);
  const menu = (await kasir.get('/api/staff/menu')).data.menu;
  assert.equal((await kasir.post('/api/staff/transactions', { customerId: 2, items: [{ menuItemId: menu[0].id, qty: 1 }], payment: 'Cash' })).status, 200);
  assert.equal((await kasir.post('/api/staff/customers/2/adjust-points', { delta: 100, reason: 'bonus' })).status, 403);
  assert.equal((await kasir.post('/api/staff/transactions/1/void', { reason: 'test' })).status, 403);
  assert.equal((await kasir.patch(`/api/staff/menu/${menu[0].id}`, { price: 1 })).status, 403);
  assert.equal((await kasir.patch(`/api/staff/menu/${menu[0].id}`, { available: false })).status, 200);
  assert.equal((await kasir.req('PUT', '/api/staff/settings/loyalty', { rupiahPerPoint: 1 })).status, 403);
  assert.equal((await kasir.post('/api/staff/transactions', { customerId: 2, items: [{ menuItemId: menu[1].id, qty: 1 }], payment: 'Cash', date: '2026-01-01' })).status, 403, 'kasir tidak boleh backdate');
});

test('buku besar poin append-only di level database', () => {
  const db = new DatabaseSync(path.join(dir, 'lacafe.db'));
  assert.throws(() => db.prepare('UPDATE points_ledger SET delta = 99999').run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM points_ledger').run(), /append-only/);
  db.close();
});

test('login dikunci setelah 5 kali salah', async () => {
  const c = new Client();
  const codes = [];
  const { data } = await admin.post('/api/staff/customers/2/activation', {});
  await new Client().post('/api/auth/customer/activate', { identifier: 'LC002', code: data.code, password: 'Joko12345' });
  for (let i = 0; i < 6; i++) codes.push((await c.post('/api/auth/customer/login', { identifier: 'LC002', password: 'salah' + i })).status);
  assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(codes[5], 423);
  const r = await c.post('/api/auth/customer/login', { identifier: 'LC002', password: 'Joko12345' });
  assert.equal(r.status, 423, 'password benar pun ditolak selama terkunci');
});

test('pendaftaran: validasi & nomor yang sudah tercatat harus aktivasi', async () => {
  const c = new Client();
  assert.equal((await c.post('/api/auth/customer/register', { name: 'A', phone: '0812', password: 'abc' })).status, 400);
  const dup = await c.post('/api/auth/customer/register', { name: 'Fadhil Palsu', phone: '085899017510', password: 'Palsu12345' });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.code, 'needs_activation');
  const ok = await c.post('/api/auth/customer/register', { name: '<img src=x onerror=alert(1)>', phone: '081234567890', password: 'Baru12345' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.memberCode, 'LC005');
});

test('upload hanya menerima gambar asli', async () => {
  const svg = 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64');
  assert.equal((await admin.post('/api/staff/upload', { dataUrl: svg })).status, 400);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const r = await admin.post('/api/staff/upload', { dataUrl: png });
  assert.equal(r.status, 200);
  assert.match(r.data.url, /^\/?uploads\/[a-f0-9]{32}\.png$/);
});

test('header keamanan terpasang', async () => {
  const r = await fetch(TARGET === 'php' ? BASE + '/api/auth/session' : BASE + '/');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});
