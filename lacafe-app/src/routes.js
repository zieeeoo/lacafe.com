import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router, v, bad, unauthorized, forbidden, notFound, conflict, HttpError } from './http.js';
import { tx, getLoyalty, getAppearance, getOptions, setSetting, DEFAULT_APPEARANCE } from './db.js';
import {
  hashPassword, verifyPassword, randomToken, sha256, safeEqual, activationCode, memberPassCode, passExpiresIn, PASS_WINDOW, RateLimiter,
} from './security.js';
import * as S from './services.js';

const STAFF_SESSION_HOURS = 12;
const CUSTOMER_SESSION_DAYS = 30;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export const authLimiter = new RateLimiter({ windowMs: 10 * 60 * 1000, max: 20 });
const redeemLimiter = new RateLimiter({ windowMs: 60 * 1000, max: 10 });
const orderLimiter = new RateLimiter({ windowMs: 10 * 60 * 1000, max: 10 });
const lookupLimiter = new RateLimiter({ windowMs: 60 * 1000, max: 30 });

const sqlTime = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
const addMs = (ms) => sqlTime(new Date(Date.now() + ms));

export function buildRouter({ db, secret, uploadsDir, cookieSecure }) {
  const r = new Router();

  // ======================================================================
  // Sesi & cookie
  // ======================================================================
  function setSessionCookie(res, token, maxAgeSec) {
    const parts = [`lc_sid=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
    if (cookieSecure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }
  function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `lc_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${cookieSecure ? '; Secure' : ''}`);
  }
  function startSession(ctx, kind, subjectId) {
    const token = randomToken(32);
    const csrf = randomToken(24);
    const hours = kind === 'staff' ? STAFF_SESSION_HOURS : CUSTOMER_SESSION_DAYS * 24;
    db.prepare('INSERT INTO sessions(id, kind, subject_id, csrf, ip, ua, expires_at) VALUES (?,?,?,?,?,?,?)')
      .run(sha256(token), kind, subjectId, csrf, ctx.ip, String(ctx.req.headers['user-agent'] || '').slice(0, 200), addMs(hours * 3600 * 1000));
    // batasi jumlah sesi aktif per akun
    db.prepare(`DELETE FROM sessions WHERE kind = ? AND subject_id = ? AND id NOT IN
      (SELECT id FROM sessions WHERE kind = ? AND subject_id = ? ORDER BY created_at DESC LIMIT 5)`).run(kind, subjectId, kind, subjectId);
    setSessionCookie(ctx.res, token, hours * 3600);
    return csrf;
  }

  // Dipanggil oleh server untuk setiap request API.
  function loadAuth(cookies) {
    const token = cookies.lc_sid;
    if (!token || token.length > 100) return null;
    const s = db.prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')").get(sha256(token));
    if (!s) return null;
    if (s.kind === 'staff') {
      const u = db.prepare('SELECT * FROM staff WHERE id = ? AND active = 1').get(s.subject_id);
      if (!u) return null;
      return { kind: 'staff', id: u.id, name: u.name, role: u.role, username: u.username, mustChange: !!u.must_change_password, csrf: s.csrf, sessionId: s.id };
    }
    const c = db.prepare('SELECT * FROM customers WHERE id = ? AND active = 1').get(s.subject_id);
    if (!c) return null;
    return { kind: 'customer', id: c.id, name: c.name, role: 'customer', memberCode: c.member_code, csrf: s.csrf, sessionId: s.id };
  }

  function sessionPayload(auth) {
    if (!auth) return { kind: null };
    if (auth.kind === 'staff') return { kind: 'staff', csrf: auth.csrf, user: { id: auth.id, name: auth.name, role: auth.role, username: auth.username, mustChange: auth.mustChange } };
    return { kind: 'customer', csrf: auth.csrf, user: { id: auth.id, name: auth.name, memberCode: auth.memberCode } };
  }

  function rateLimit(limiter, key) {
    if (!limiter.hit(key)) throw new HttpError(429, `Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil(limiter.retryAfter(key) / 60)} menit`, 'rate_limited');
  }

  function checkLock(row) {
    if (row?.locked_until && row.locked_until > sqlTime(new Date())) {
      throw new HttpError(423, `Akun dikunci sementara karena terlalu banyak percobaan gagal. Coba lagi setelah ${LOCK_MINUTES} menit`, 'locked');
    }
  }
  function registerFail(table, row) {
    if (!row) return;
    const n = row.failed_logins + 1;
    db.prepare(`UPDATE ${table} SET failed_logins = ?, locked_until = ? WHERE id = ?`)
      .run(n >= MAX_FAILED ? 0 : n, n >= MAX_FAILED ? addMs(LOCK_MINUTES * 60000) : null, row.id);
  }
  const resetFail = (table, id) => db.prepare(`UPDATE ${table} SET failed_logins = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?`).run(id);

  function findCustomerByIdentifier(identifier) {
    const raw = v.str(identifier, 'Nomor WhatsApp / ID member', { max: 40 });
    if (/^[A-Za-z]{1,4}\d{1,6}$/.test(raw)) return db.prepare('SELECT * FROM customers WHERE member_code = ? COLLATE NOCASE').get(raw.toUpperCase());
    let phone;
    try { phone = v.phone(raw); } catch { return null; }
    return db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
  }

  // ======================================================================
  // AUTH
  // ======================================================================
  r.get('/api/auth/session', { auth: null, allowMustChange: true }, ({ auth }) => sessionPayload(auth));

  r.post('/api/auth/staff/login', { auth: null, csrf: false }, (ctx) => {
    rateLimit(authLimiter, 'login:' + ctx.ip);
    const username = v.str(ctx.body.username, 'Username', { max: 40 });
    const password = String(ctx.body.password || '');
    const u = db.prepare('SELECT * FROM staff WHERE username = ?').get(username);
    checkLock(u);
    const ok = verifyPassword(password, u?.password_hash);
    if (!ok || !u.active) { registerFail('staff', u); S.audit(db, null, 'login_gagal', 'staff:' + username, null, ctx.ip); throw unauthorized('Username atau kata sandi salah'); }
    resetFail('staff', u.id);
    const csrf = startSession(ctx, 'staff', u.id);
    S.audit(db, { kind: 'staff', id: u.id, name: u.name }, 'login', 'staff', null, ctx.ip);
    return { kind: 'staff', csrf, user: { id: u.id, name: u.name, role: u.role, username: u.username, mustChange: !!u.must_change_password } };
  });

  r.post('/api/auth/customer/login', { auth: null, csrf: false }, (ctx) => {
    rateLimit(authLimiter, 'login:' + ctx.ip);
    const c = findCustomerByIdentifier(ctx.body.identifier);
    checkLock(c);
    const ok = verifyPassword(String(ctx.body.password || ''), c?.password_hash);
    if (!ok || !c.active) {
      registerFail('customers', c);
      if (c && !c.password_hash) throw new HttpError(401, 'Akun member ini belum diaktifkan. Minta kode aktivasi ke kasir, lalu pilih "Aktifkan akun".', 'not_activated');
      throw unauthorized('Nomor/ID member atau kata sandi salah');
    }
    resetFail('customers', c.id);
    const csrf = startSession(ctx, 'customer', c.id);
    return { kind: 'customer', csrf, user: { id: c.id, name: c.name, memberCode: c.member_code } };
  });

  r.post('/api/auth/customer/register', { auth: null, csrf: false }, (ctx) => {
    rateLimit(authLimiter, 'register:' + ctx.ip);
    const b = ctx.body;
    const name = v.str(b.name, 'Nama', { min: 2, max: 60 });
    const phone = v.phone(b.phone);
    const password = v.password(b.password);
    const options = getOptions(db);
    const gender = b.gender ? v.oneOf(b.gender, 'Gender', options.genders) : null;
    const birthday = v.date(b.birthday, 'Tanggal lahir', { required: false });
    const exist = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
    if (exist?.password_hash) throw conflict('Nomor ini sudah terdaftar. Silakan masuk.');
    if (exist) throw new HttpError(409, 'Nomor ini sudah tercatat sebagai member di kasir. Minta kode aktivasi ke kasir, lalu pilih "Aktifkan akun".', 'needs_activation');
    const c = tx(db, () => {
      const code = S.nextMemberCode(db);
      const id = Number(db.prepare(`INSERT INTO customers(member_code, name, phone, gender, birthday, source, joined_at, password_hash)
        VALUES (?,?,?,?,?,?,?,?)`).run(code, name, phone, gender, birthday, 'Aplikasi', S.today(), hashPassword(password)).lastInsertRowid);
      S.audit(db, { kind: 'customer', id, name }, 'daftar_member', code, null, ctx.ip);
      return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    });
    const csrf = startSession(ctx, 'customer', c.id);
    return { kind: 'customer', csrf, user: { id: c.id, name: c.name, memberCode: c.member_code } };
  });

  r.post('/api/auth/customer/activate', { auth: null, csrf: false }, (ctx) => {
    rateLimit(authLimiter, 'activate:' + ctx.ip);
    const c = findCustomerByIdentifier(ctx.body.identifier);
    const code = String(ctx.body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const password = v.password(ctx.body.password);
    checkLock(c);
    const valid = c && c.activation_hash && c.activation_expires > sqlTime(new Date()) && safeEqual(sha256(code), c.activation_hash);
    if (!valid) { registerFail('customers', c); throw bad('Kode aktivasi salah atau sudah kedaluwarsa. Minta kode baru ke kasir.'); }
    db.prepare('UPDATE customers SET password_hash = ?, activation_hash = NULL, activation_expires = NULL WHERE id = ?').run(hashPassword(password), c.id);
    db.prepare("DELETE FROM sessions WHERE kind = 'customer' AND subject_id = ?").run(c.id);
    resetFail('customers', c.id);
    S.audit(db, { kind: 'customer', id: c.id, name: c.name }, 'aktivasi_akun', c.member_code, null, ctx.ip);
    const csrf = startSession(ctx, 'customer', c.id);
    return { kind: 'customer', csrf, user: { id: c.id, name: c.name, memberCode: c.member_code } };
  });

  r.post('/api/auth/logout', { auth: 'any', allowMustChange: true }, (ctx) => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(ctx.auth.sessionId);
    clearSessionCookie(ctx.res);
    return { ok: true };
  });

  r.post('/api/auth/password', { auth: 'any', allowMustChange: true }, (ctx) => {
    rateLimit(authLimiter, 'pw:' + ctx.ip);
    const table = ctx.auth.kind === 'staff' ? 'staff' : 'customers';
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(ctx.auth.id);
    if (!verifyPassword(String(ctx.body.current || ''), row.password_hash)) throw bad('Kata sandi lama salah');
    const next = v.password(ctx.body.next);
    if (next === ctx.body.current) throw bad('Kata sandi baru harus berbeda');
    db.prepare(`UPDATE ${table} SET password_hash = ?${table === 'staff' ? ', must_change_password = 0' : ''} WHERE id = ?`).run(hashPassword(next), row.id);
    db.prepare('DELETE FROM sessions WHERE kind = ? AND subject_id = ? AND id != ?').run(ctx.auth.kind, row.id, ctx.auth.sessionId);
    S.audit(db, ctx.auth, 'ganti_password', table, null, ctx.ip);
    return { ok: true };
  });

  // ======================================================================
  // PUBLIK (tanpa login): tampilan, menu, rewards
  // ======================================================================
  function categoriesAll(includeInactive = false) {
    return db.prepare(`SELECT * FROM categories ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, id`).all()
      .map((c) => ({ id: c.id, key: c.key, name: c.name, sort: c.sort, active: !!c.active }));
  }
  const menuDto = (m) => ({ id: m.id, code: m.code, name: m.name, categoryId: m.category_id, price: m.price, description: m.description,
    image: m.image, temp: m.temp, featured: !!m.featured, available: !!m.available, sort: m.sort });
  const menuAll = () => db.prepare('SELECT * FROM menu_items WHERE archived = 0 ORDER BY sort, id').all().map(menuDto);
  const rewardsAll = (all = false) => db.prepare(`SELECT * FROM rewards WHERE archived = 0 ${all ? '' : 'AND active = 1'} ORDER BY sort, points_cost`).all().map(S.rewardDto);

  r.get('/api/public/bootstrap', { auth: null }, () => {
    const loyalty = getLoyalty(db);
    const options = getOptions(db);
    return {
      appearance: getAppearance(db),
      categories: categoriesAll(),
      menu: menuAll(),
      rewards: rewardsAll(),
      loyalty: { rupiahPerPoint: loyalty.rupiahPerPoint, inactiveDays: loyalty.inactiveDays, tiers: loyalty.tiers, tierBasis: loyalty.tierBasis },
      options: { genders: options.genders, payments: options.payments, sources: options.sources },
    };
  });

  // ======================================================================
  // CUSTOMER
  // ======================================================================
  const meRow = (id) => db.prepare('SELECT * FROM customers WHERE id = ?').get(id);

  r.get('/api/me', { auth: 'customer' }, ({ auth }) => {
    const row = meRow(auth.id);
    const dto = S.customerDto(row, S.statsFor(db, row.id), { includePrivate: false });
    S.expireVouchers(db);
    dto.activeVouchers = db.prepare("SELECT COUNT(*) n FROM vouchers WHERE customer_id = ? AND status = 'active'").get(row.id).n;
    dto.activeOrders = db.prepare("SELECT * FROM orders WHERE customer_id = ? AND status IN ('pending','processing','ready') ORDER BY id DESC").all(row.id).map((o) => S.orderDto(db, o));
    return dto;
  });

  r.patch('/api/me', { auth: 'customer' }, ({ auth, body }) => {
    const options = getOptions(db);
    const name = body.name !== undefined ? v.str(body.name, 'Nama', { min: 2, max: 60 }) : undefined;
    const gender = body.gender !== undefined ? (body.gender ? v.oneOf(body.gender, 'Gender', options.genders) : null) : undefined;
    const birthday = body.birthday !== undefined ? v.date(body.birthday, 'Tanggal lahir', { required: false }) : undefined;
    const row = meRow(auth.id);
    db.prepare('UPDATE customers SET name = ?, gender = ?, birthday = ? WHERE id = ?')
      .run(name ?? row.name, gender === undefined ? row.gender : gender, birthday === undefined ? row.birthday : birthday, row.id);
    return S.customerDto(meRow(auth.id), S.statsFor(db, auth.id), { includePrivate: false });
  });

  r.get('/api/me/pass', { auth: 'customer' }, ({ auth }) => ({
    memberCode: auth.memberCode, code: memberPassCode(secret, auth.memberCode), expiresIn: passExpiresIn(), window: PASS_WINDOW,
  }));

  r.get('/api/me/points', { auth: 'customer' }, ({ auth }) => S.ledgerFor(db, auth.id, 200));
  r.get('/api/me/transactions', { auth: 'customer' }, ({ auth }) => S.listTransactions(db, { customerId: auth.id, limit: 100 })
    .map((t) => ({ ...t, staffName: undefined })));
  r.get('/api/me/vouchers', { auth: 'customer' }, ({ auth }) => {
    S.expireVouchers(db);
    return db.prepare('SELECT * FROM vouchers WHERE customer_id = ? ORDER BY id DESC LIMIT 100').all(auth.id).map(S.voucherDto);
  });
  r.post('/api/me/redeem', { auth: 'customer' }, (ctx) => {
    rateLimit(redeemLimiter, 'redeem:' + ctx.auth.id);
    const voucher = S.redeemReward(db, ctx.auth.id, v.int(ctx.body.rewardId, 'Reward', { min: 1 }));
    S.audit(db, ctx.auth, 'tukar_poin', voucher.code, { reward: voucher.name, poin: voucher.pointsCost }, ctx.ip);
    return voucher;
  });

  r.get('/api/me/orders', { auth: 'customer' }, ({ auth }) =>
    db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 50').all(auth.id).map((o) => S.orderDto(db, o)));

  r.post('/api/me/orders', { auth: 'customer' }, (ctx) => {
    if (!getAppearance(db).orderingEnabled) throw bad('Pemesanan lewat aplikasi sedang ditutup');
    rateLimit(orderLimiter, 'order:' + ctx.auth.id);
    const options = getOptions(db);
    const order = S.createOrder(db, ctx.auth.id, {
      items: ctx.body.items,
      paymentMethod: v.oneOf(ctx.body.paymentMethod, 'Metode bayar', options.payments),
      note: v.str(ctx.body.note, 'Catatan', { max: 200, required: false }),
      voucherCode: ctx.body.voucherCode ? v.str(ctx.body.voucherCode, 'Voucher', { max: 20 }) : null,
    });
    S.audit(db, ctx.auth, 'pesanan_baru', order.code, { total: order.total }, ctx.ip);
    return order;
  });

  r.post('/api/me/orders/:id/cancel', { auth: 'customer' }, (ctx) =>
    S.setOrderStatus(db, v.int(ctx.params.id, 'ID', { min: 1 }), 'cancelled', { byCustomer: ctx.auth.id }));

  // ======================================================================
  // STAFF (kasir & admin)
  // ======================================================================
  r.get('/api/staff/dashboard', { auth: 'staff' }, () => S.dashboard(db));

  r.get('/api/staff/customers', { auth: 'staff' }, () => S.listCustomers(db));

  r.get('/api/staff/lookup', { auth: 'staff' }, (ctx) => {
    rateLimit(lookupLimiter, 'lookup:' + ctx.auth.id);
    const code = String(ctx.query.get('code') || '').replace(/\D/g, '');
    if (code.length !== 6) throw bad('Kode member harus 6 digit');
    const now = Date.now();
    for (const row of db.prepare('SELECT * FROM customers WHERE active = 1').all()) {
      if (safeEqual(memberPassCode(secret, row.member_code, now), code) || safeEqual(memberPassCode(secret, row.member_code, now - PASS_WINDOW * 1000), code)) {
        return S.customerDto(row, S.statsFor(db, row.id));
      }
    }
    throw notFound('Kode tidak cocok atau sudah kedaluwarsa. Minta customer membuka ulang kode member.');
  });

  function customerInput(body, { isAdmin, partial }) {
    const o = getOptions(db);
    const out = {};
    const has = (k) => body[k] !== undefined;
    if (!partial || has('name')) out.name = v.str(body.name, 'Nama', { min: 2, max: 60 });
    if (has('gender')) out.gender = body.gender ? v.oneOf(body.gender, 'Gender', o.genders) : null;
    if (has('source')) out.source = body.source ? v.oneOf(body.source, 'Sumber', [...o.sources, 'Aplikasi']) : null;
    if (has('birthday')) out.birthday = v.date(body.birthday, 'Tanggal lahir', { required: false });
    if (has('note')) out.note = v.str(body.note, 'Catatan', { max: 300, required: false });
    if (has('favoriteNote')) out.favorite_note = v.str(body.favoriteNote, 'Menu favorit', { max: 120, required: false });
    if (has('phone')) {
      if (partial && !isAdmin) throw forbidden('Hanya admin yang bisa mengubah nomor WhatsApp');
      out.phone = v.phone(body.phone, { required: false });
    }
    if (has('active')) { if (!isAdmin) throw forbidden(); out.active = body.active ? 1 : 0; }
    return out;
  }

  r.post('/api/staff/customers', { auth: 'staff' }, (ctx) => {
    const data = customerInput(ctx.body, { isAdmin: ctx.auth.role === 'admin', partial: false });
    if (data.phone && db.prepare('SELECT 1 FROM customers WHERE phone = ?').get(data.phone)) throw conflict('Nomor WhatsApp sudah dipakai member lain');
    const row = tx(db, () => {
      const code = S.nextMemberCode(db);
      const cols = ['member_code', 'joined_at', ...Object.keys(data)];
      const id = Number(db.prepare(`INSERT INTO customers(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(code, S.today(), ...Object.values(data)).lastInsertRowid);
      S.audit(db, ctx.auth, 'tambah_customer', code, { name: data.name }, ctx.ip);
      return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    });
    return S.customerDto(row, S.statsFor(db, row.id));
  });

  r.get('/api/staff/customers/:id', { auth: 'staff' }, (ctx) => {
    const id = v.int(ctx.params.id, 'ID', { min: 1 });
    const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!row) throw notFound('Customer tidak ditemukan');
    S.expireVouchers(db);
    return {
      ...S.customerDto(row, S.statsFor(db, id)),
      activationPending: !!(row.activation_hash && row.activation_expires > sqlTime(new Date())),
      transactions: S.listTransactions(db, { customerId: id, limit: 100 }),
      ledger: S.ledgerFor(db, id, 100),
      vouchers: db.prepare('SELECT * FROM vouchers WHERE customer_id = ? ORDER BY id DESC LIMIT 50').all(id).map(S.voucherDto),
      orders: db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 20').all(id).map((o) => S.orderDto(db, o)),
    };
  });

  r.patch('/api/staff/customers/:id', { auth: 'staff' }, (ctx) => {
    const id = v.int(ctx.params.id, 'ID', { min: 1 });
    const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!row) throw notFound('Customer tidak ditemukan');
    const data = customerInput(ctx.body, { isAdmin: ctx.auth.role === 'admin', partial: true });
    if (data.phone && db.prepare('SELECT 1 FROM customers WHERE phone = ? AND id != ?').get(data.phone, id)) throw conflict('Nomor WhatsApp sudah dipakai member lain');
    if (!Object.keys(data).length) throw bad('Tidak ada perubahan');
    db.prepare(`UPDATE customers SET ${Object.keys(data).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(data), id);
    if (data.active === 0) db.prepare("DELETE FROM sessions WHERE kind='customer' AND subject_id = ?").run(id);
    S.audit(db, ctx.auth, 'ubah_customer', row.member_code, data, ctx.ip);
    return S.customerDto(db.prepare('SELECT * FROM customers WHERE id = ?').get(id), S.statsFor(db, id));
  });

  r.post('/api/staff/customers/:id/activation', { auth: 'staff' }, (ctx) => {
    const id = v.int(ctx.params.id, 'ID', { min: 1 });
    const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!row) throw notFound('Customer tidak ditemukan');
    const code = activationCode();
    db.prepare("UPDATE customers SET activation_hash = ?, activation_expires = datetime('now', '+72 hours'), failed_logins = 0, locked_until = NULL WHERE id = ?")
      .run(sha256(code.replace('-', '')), id);
    S.audit(db, ctx.auth, row.password_hash ? 'reset_akses_customer' : 'buat_kode_aktivasi', row.member_code, null, ctx.ip);
    return { code, expiresInHours: 72, memberCode: row.member_code, phone: row.phone, reset: !!row.password_hash };
  });

  r.post('/api/staff/customers/:id/adjust-points', { auth: 'admin' }, (ctx) => {
    const id = v.int(ctx.params.id, 'ID', { min: 1 });
    const delta = v.int(ctx.body.delta, 'Jumlah poin', { min: -100000, max: 100000 });
    if (delta === 0) throw bad('Jumlah poin tidak boleh 0');
    const reason = v.str(ctx.body.reason, 'Alasan', { min: 3, max: 200 });
    return tx(db, () => {
      const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
      if (!row) throw notFound('Customer tidak ditemukan');
      const bal = S.pointsBalance(db, id);
      if (bal + delta < 0) throw bad(`Saldo poin tidak cukup (saldo ${bal})`);
      const after = S.addLedger(db, { customerId: id, delta, type: 'adjust', note: reason, staffId: ctx.auth.id });
      S.audit(db, ctx.auth, 'koreksi_poin', row.member_code, { delta, reason, saldo: after }, ctx.ip);
      return { balance: after };
    });
  });

  // ---------- Transaksi / Kasir ----------
  r.get('/api/staff/transactions', { auth: 'staff' }, (ctx) => S.listTransactions(db, {
    from: ctx.query.get('from') || null, to: ctx.query.get('to') || null,
    q: (ctx.query.get('q') || '').slice(0, 40) || null, limit: Math.min(1000, Number(ctx.query.get('limit')) || 300),
  }));

  r.post('/api/staff/transactions', { auth: 'staff' }, (ctx) => {
    const b = ctx.body;
    const options = getOptions(db);
    const customerId = b.customerId ? v.int(b.customerId, 'Customer', { min: 1 }) : null;
    if (customerId && !db.prepare('SELECT 1 FROM customers WHERE id = ? AND active = 1').get(customerId)) throw notFound('Customer tidak ditemukan / nonaktif');
    const payment = v.oneOf(b.payment, 'Metode bayar', options.payments);
    let date = null;
    if (b.date && b.date !== S.today()) {
      if (ctx.auth.role !== 'admin') throw forbidden('Hanya admin yang bisa mencatat transaksi tanggal lain');
      date = v.date(b.date, 'Tanggal');
      if (date > S.today()) throw bad('Tanggal tidak boleh di masa depan');
    }
    const sale = tx(db, () => {
      const { lines, subtotal } = S.priceLines(db, b.items, { allowUnavailable: true });
      return S.createSale(db, { customerId, lines, subtotal, payment, voucherCode: b.voucherCode || null, date, staffId: ctx.auth.id, source: 'pos' });
    });
    S.audit(db, ctx.auth, 'transaksi', sale.code, { total: sale.total, poin: sale.pointsEarned, customer: sale.customer?.memberCode || null }, ctx.ip);
    return sale;
  });

  r.post('/api/staff/transactions/:id/void', { auth: 'admin' }, (ctx) => {
    const reason = v.str(ctx.body.reason, 'Alasan pembatalan', { min: 3, max: 200 });
    const t = S.voidTransaction(db, v.int(ctx.params.id, 'ID', { min: 1 }), reason, ctx.auth.id);
    S.audit(db, ctx.auth, 'batal_transaksi', t.code, { reason, poinDitarik: t.pointsEarned }, ctx.ip);
    return t;
  });

  r.get('/api/staff/vouchers/:code', { auth: 'staff' }, (ctx) => {
    S.expireVouchers(db);
    const row = db.prepare('SELECT v.*, c.name customer_name, c.member_code FROM vouchers v JOIN customers c ON c.id = v.customer_id WHERE v.code = ?')
      .get(String(ctx.params.code).toUpperCase().slice(0, 20));
    if (!row) throw notFound('Voucher tidak ditemukan');
    return { ...S.voucherDto(row), customer: { id: row.customer_id, name: row.customer_name, memberCode: row.member_code } };
  });

  // ---------- Pesanan online ----------
  r.get('/api/staff/orders', { auth: 'staff' }, (ctx) => {
    const scope = ctx.query.get('scope') || 'active';
    const where = scope === 'active' ? "WHERE status IN ('pending','processing','ready')" : '';
    return db.prepare(`SELECT * FROM orders ${where} ORDER BY id DESC LIMIT 200`).all().map((o) => S.orderDto(db, o));
  });

  r.post('/api/staff/orders/:id/status', { auth: 'staff' }, (ctx) => {
    const options = getOptions(db);
    const next = v.oneOf(ctx.body.status, 'Status', ['processing', 'ready', 'completed', 'cancelled']);
    const payment = ctx.body.payment ? v.oneOf(ctx.body.payment, 'Metode bayar', options.payments) : null;
    const reason = v.str(ctx.body.reason, 'Alasan', { max: 200, required: false });
    const o = S.setOrderStatus(db, v.int(ctx.params.id, 'ID', { min: 1 }), next, { payment, reason, staffId: ctx.auth.id });
    S.audit(db, ctx.auth, 'status_pesanan', o.code, { status: next }, ctx.ip);
    return o;
  });

  // ---------- Menu & kategori ----------
  r.get('/api/staff/menu', { auth: 'staff' }, () => ({ categories: categoriesAll(true), menu: menuAll() }));

  function imageField(x) {
    if (x === null || x === undefined || x === '') return null;
    if (typeof x !== 'string' || !/^\/uploads\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(x)) throw bad('Gambar tidak valid');
    return x;
  }
  function menuInput(b, partial) {
    const out = {};
    const has = (k) => b[k] !== undefined;
    if (!partial || has('name')) out.name = v.str(b.name, 'Nama menu', { min: 2, max: 60 });
    if (!partial || has('price')) out.price = v.int(b.price, 'Harga', { min: 0, max: 10000000 });
    if (!partial || has('categoryId')) {
      out.category_id = v.int(b.categoryId, 'Kategori', { min: 1 });
      if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(out.category_id)) throw bad('Kategori tidak ditemukan');
    }
    if (has('description')) out.description = v.str(b.description, 'Deskripsi', { max: 240, required: false });
    if (has('image')) out.image = imageField(b.image);
    if (has('temp')) out.temp = v.oneOf(b.temp || null, 'Suhu', ['hot', 'cold', null]);
    if (has('featured')) out.featured = b.featured ? 1 : 0;
    if (has('available')) out.available = b.available ? 1 : 0;
    if (has('sort')) out.sort = v.int(b.sort, 'Urutan', { min: 0, max: 100000 });
    return out;
  }

  r.post('/api/staff/menu', { auth: 'admin' }, (ctx) => {
    const data = menuInput(ctx.body, false);
    data.code = (data.name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim() || 'MENU') + '';
    let code = data.code;
    for (let i = 2; db.prepare('SELECT 1 FROM menu_items WHERE code = ?').get(code); i++) code = `${data.code} ${i}`;
    data.code = code;
    if (data.sort === undefined) data.sort = (db.prepare('SELECT MAX(sort) m FROM menu_items').get().m || 0) + 1;
    const cols = Object.keys(data);
    const id = Number(db.prepare(`INSERT INTO menu_items(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(data)).lastInsertRowid);
    S.audit(db, ctx.auth, 'tambah_menu', data.name, { price: data.price }, ctx.ip);
    return menuDto(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id));
  });

  r.patch('/api/staff/menu/:id', { auth: 'staff' }, (ctx) => {
    const id = v.int(ctx.params.id, 'ID', { min: 1 });
    const row = db.prepare('SELECT * FROM menu_items WHERE id = ? AND archived = 0').get(id);
    if (!row) throw notFound('Menu tidak ditemukan');
    if (ctx.auth.role !== 'admin' && Object.keys(ctx.body).some((k) => k !== 'available')) throw forbidden('Kasir hanya bisa mengubah status stok (tersedia/habis)');
    const data = menuInput(ctx.body, true);
    if (!Object.keys(data).length) throw bad('Tidak ada perubahan');
    db.prepare(`UPDATE menu_items SET ${Object.keys(data).map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(data), id);
    S.audit(db, ctx.auth, 'ubah_menu', row.name, data, ctx.ip);
    return menuDto(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id));
  });

  r.delete('/api/staff/menu/:id', { auth: 'admin' }, (ctx) => {
    const id = v.int(ctx.params.id, 'ID', { min: 1 });
    const row = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
    if (!row) throw notFound('Menu tidak ditemukan');
    db.prepare("UPDATE menu_items SET archived = 1, featured = 0, updated_at = datetime('now') WHERE id = ?").run(id); // arsip, riwayat transaksi tetap utuh
    S.audit(db, ctx.auth, 'hapus_menu', row.name, null, ctx.ip);
    return { ok: true };
  });

  r.post('/api/staff/menu/reorder', { auth: 'admin' }, (ctx) => {
    const ids = ctx.body.ids;
    if (!Array.isArray(ids) || ids.length > 1000) throw bad('Urutan tidak valid');
    tx(db, () => ids.forEach((id, i) => db.prepare('UPDATE menu_items SET sort = ? WHERE id = ?').run(i + 1, v.int(id, 'ID', { min: 1 }))));
    return { ok: true };
  });

  r.post('/api/staff/categories', { auth: 'admin' }, (ctx) => {
    const name = v.str(ctx.body.name, 'Nama kategori', { min: 2, max: 30 });
    let key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'kategori';
    for (let i = 2; db.prepare('SELECT 1 FROM categories WHERE key = ?').get(key); i++) key = key.replace(/-\d+$/, '') + '-' + i;
    const sort = (db.prepare('SELECT MAX(sort) m FROM categories').get().m || 0) + 1;
    db.prepare('INSERT INTO categories(key, name, sort) VALUES (?,?,?)').run(key, name, sort);
    S.audit(db, ctx.auth, 'tambah_kategori', name, null, ctx.ip);
    return categoriesAll(true);
  });

  r.patch('/api/staff/categories/:id', { auth: 'admin' }, (ctx) => {
    const id = v.int(ctx.params.id, 'ID', { min: 1 });
    const row = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    if (!row) throw notFound('Kategori tidak ditemukan');
    const name = ctx.body.name !== undefined ? v.str(ctx.body.name, 'Nama kategori', { min: 2, max: 30 }) : row.name;
    const sort = ctx.body.sort !== undefined ? v.int(ctx.body.sort, 'Urutan', { min: 0, max: 1000 }) : row.sort;
    const active = ctx.body.active !== undefined ? (ctx.body.active ? 1 : 0) : row.active;
    db.prepare('UPDATE categories SET name = ?, sort = ?, active = ? WHERE id = ?').run(name, sort, active, id);
    S.audit(db, ctx.auth, 'ubah_kategori', name, { sort, active }, ctx.ip);
    return categoriesAll(true);
  });

  r.delete('/api/staff/categories/:id', { auth: 'admin' }, (ctx) => {
    const id = v.int(ctx.params.id, 'ID', { min: 1 });
    if (db.prepare('SELECT 1 FROM menu_items WHERE category_id = ? AND archived = 0').get(id)) throw conflict('Kategori masih berisi menu. Pindahkan atau hapus menunya dulu.');
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    S.audit(db, ctx.auth, 'hapus_kategori', String(id), null, ctx.ip);
    return categoriesAll(true);
  });

  // ---------- Rewards ----------
  r.get('/api/staff/rewards', { auth: 'staff' }, () => rewardsAll(true));

  function rewardInput(b, partial) {
    const loyalty = getLoyalty(db);
    const out = {};
    const has = (k) => b[k] !== undefined;
    if (!partial || has('name')) out.name = v.str(b.name, 'Nama reward', { min: 2, max: 60 });
    if (has('description')) out.description = v.str(b.description, 'Deskripsi', { max: 200, required: false });
    if (!partial || has('pointsCost')) out.points_cost = v.int(b.pointsCost, 'Harga poin', { min: 1, max: 1000000 });
    if (has('minTier')) out.min_tier = b.minTier ? v.oneOf(b.minTier, 'Minimal level', loyalty.tiers.map((t) => t.key)) : null;
    if (has('stock')) out.stock = b.stock === null || b.stock === '' ? null : v.int(b.stock, 'Stok', { min: 0, max: 1000000 });
    if (!partial || has('type')) out.type = v.oneOf(b.type, 'Jenis reward', ['free_item', 'discount_amount', 'discount_percent']);
    if (has('value')) out.value = v.int(b.value, 'Nilai', { min: 0, max: 10000000 });
    if (has('menuItemId')) out.menu_item_id = b.menuItemId ? v.int(b.menuItemId, 'Menu', { min: 1 }) : null;
    if (has('validDays')) out.valid_days = v.int(b.validDays, 'Masa berlaku', { min: 1, max: 365 });
    if (has('image')) out.image = imageField(b.image);
    if (has('active')) out.active = b.active ? 1 : 0;
    if (has('sort')) out.sort = v.int(b.sort, 'Urutan', { min: 0, max: 100000 });
    const type = out.type;
    if (type === 'free_item' && !out.menu_item_id && !partial) throw bad('Pilih menu yang digratiskan');
    if (type === 'discount_percent' && (out.value ?? 0) > 100) throw bad('Diskon persen maksimal 100');
    if (type && type !== 'free_item' && !partial && !out.value) throw bad('Isi nilai diskon');
    return out;
  }

  r.post('/api/staff/rewards', { auth: 'admin' }, (ctx) => {
    const data = rewardInput(ctx.body, false);
    const cols = Object.keys(data);
    const id = Number(db.prepare(`INSERT INTO rewards(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(data)).lastInsertRowid);
    S.audit(db, ctx.auth, 'tambah_reward', data.name, { poin: data.points_cost }, ctx.ip);
    return S.rewardDto(db.prepare('SELECT * FROM rewards WHERE id = ?').get(id));
  });
  r.patch('/api/staff/rewards/:id', { auth: 'admin' }, (ctx) => {
    const id = v.int(ctx.params.id, 'ID', { min: 1 });
    if (!db.prepare('SELECT 1 FROM rewards WHERE id = ? AND archived = 0').get(id)) throw notFound('Reward tidak ditemukan');
    const data = rewardInput(ctx.body, true);
    if (!Object.keys(data).length) throw bad('Tidak ada perubahan');
    db.prepare(`UPDATE rewards SET ${Object.keys(data).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(data), id);
    S.audit(db, ctx.auth, 'ubah_reward', String(id), data, ctx.ip);
    return S.rewardDto(db.prepare('SELECT * FROM rewards WHERE id = ?').get(id));
  });
  r.delete('/api/staff/rewards/:id', { auth: 'admin' }, (ctx) => {
    const id = v.int(ctx.params.id, 'ID', { min: 1 });
    db.prepare('UPDATE rewards SET archived = 1, active = 0 WHERE id = ?').run(id);
    S.audit(db, ctx.auth, 'hapus_reward', String(id), null, ctx.ip);
    return { ok: true };
  });

  // ---------- Pengaturan ----------
  r.get('/api/staff/settings', { auth: 'staff' }, () => ({ loyalty: getLoyalty(db), appearance: getAppearance(db), options: getOptions(db) }));

  r.put('/api/staff/settings/loyalty', { auth: 'admin' }, (ctx) => {
    const b = ctx.body;
    const cur = getLoyalty(db);
    if (!Array.isArray(b.tiers) || b.tiers.length < 1 || b.tiers.length > 8) throw bad('Jumlah level harus 1–8');
    const keys = new Set();
    const tiers = b.tiers.map((t, i) => {
      const name = v.str(t.name, `Nama level #${i + 1}`, { min: 2, max: 20 });
      let key = t.key ? v.str(t.key, 'Kode level', { max: 20, pattern: /^[a-z0-9-]+$/ }) : name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      while (keys.has(key)) key += '-2';
      keys.add(key);
      return {
        key, name,
        minSpend: v.int(t.minSpend, `Minimal belanja ${name}`, { min: 0, max: 1e10 }),
        multiplier: v.num(t.multiplier ?? 1, `Pengali poin ${name}`, { min: 0.5, max: 5 }),
        color: v.color(t.color || '#8A8F9C', `Warna ${name}`),
        benefits: (Array.isArray(t.benefits) ? t.benefits : []).slice(0, 6).map((x) => v.str(x, 'Benefit', { max: 80 })).filter(Boolean),
      };
    }).sort((a, b2) => a.minSpend - b2.minSpend);
    if (tiers[0].minSpend !== 0) throw bad('Level pertama harus mulai dari Rp0');
    if (new Set(tiers.map((t) => t.minSpend)).size !== tiers.length) throw bad('Minimal belanja tiap level harus berbeda');
    const next = {
      ...cur,
      rupiahPerPoint: v.int(b.rupiahPerPoint, 'Rupiah per poin', { min: 100, max: 10000000 }),
      inactiveDays: v.int(b.inactiveDays, 'Hari tidak aktif', { min: 1, max: 3650 }),
      tierBasis: v.oneOf(b.tierBasis || 'lifetime', 'Dasar level', ['lifetime', 'rolling365']),
      voucherValidDays: v.int(b.voucherValidDays ?? cur.voucherValidDays ?? 30, 'Masa berlaku voucher', { min: 1, max: 365 }),
      tiers,
    };
    setSetting(db, 'loyalty', next);
    S.audit(db, ctx.auth, 'ubah_aturan_loyalty', 'loyalty', { rupiahPerPoint: next.rupiahPerPoint, tiers: tiers.map((t) => `${t.name}≥${t.minSpend}`) }, ctx.ip);
    return next;
  });

  const SECTION_KEYS = DEFAULT_APPEARANCE.homeSections.map((s) => s.key);
  r.put('/api/staff/settings/appearance', { auth: 'admin' }, (ctx) => {
    const b = ctx.body;
    const colors = b.colors || {};
    const seen = new Set();
    const sections = (Array.isArray(b.homeSections) ? b.homeSections : [])
      .filter((s) => SECTION_KEYS.includes(s?.key) && !seen.has(s.key) && seen.add(s.key))
      .map((s) => ({ key: s.key, visible: !!s.visible }));
    for (const k of SECTION_KEYS) if (!seen.has(k)) sections.push({ key: k, visible: false });
    const banners = (Array.isArray(b.banners) ? b.banners : []).slice(0, 8).map((x, i) => ({
      id: v.str(x.id || 'b' + (i + 1), 'ID banner', { max: 20, pattern: /^[a-z0-9-]+$/i }),
      title: v.str(x.title, 'Judul banner', { min: 1, max: 60 }),
      subtitle: v.str(x.subtitle, 'Subjudul banner', { max: 120, required: false }) || '',
      color: v.color(x.color || '#1E2A5A', 'Warna banner'),
      image: imageField(x.image),
      active: x.active !== false,
    }));
    const next = {
      brandName: v.str(b.brandName, 'Nama brand', { min: 1, max: 40 }),
      tagline: v.str(b.tagline, 'Tagline', { max: 80, required: false }) || '',
      logoText: v.str(b.logoText, 'Teks logo', { min: 1, max: 3 }),
      logoImage: imageField(b.logoImage),
      theme: v.str(b.theme || 'custom', 'Tema', { max: 20, pattern: /^[a-z0-9-]+$/ }),
      colors: {
        primary: v.color(colors.primary, 'Warna utama'), accent: v.color(colors.accent, 'Warna aksen'),
        bg: v.color(colors.bg, 'Warna latar'), surface: v.color(colors.surface, 'Warna kartu'), text: v.color(colors.text, 'Warna teks'),
      },
      radius: v.oneOf(b.radius, 'Sudut', ['sharp', 'soft', 'round']),
      font: v.oneOf(b.font, 'Font', ['jakarta', 'system', 'serif']),
      menuLayout: v.oneOf(b.menuLayout, 'Tampilan menu', ['list', 'grid', 'large']),
      homeSections: sections,
      banners,
      orderingEnabled: !!b.orderingEnabled,
      pickupNote: v.str(b.pickupNote, 'Info pengambilan', { max: 120, required: false }) || '',
      announcement: v.str(b.announcement, 'Pengumuman', { max: 160, required: false }) || '',
    };
    setSetting(db, 'appearance', next);
    S.audit(db, ctx.auth, 'ubah_tampilan', 'appearance', { theme: next.theme, menuLayout: next.menuLayout }, ctx.ip);
    return next;
  });

  r.put('/api/staff/settings/options', { auth: 'admin' }, (ctx) => {
    const list = (x, name) => {
      if (!Array.isArray(x) || !x.length || x.length > 20) throw bad(`Daftar ${name} harus berisi 1–20 pilihan`);
      return [...new Set(x.map((s) => v.str(s, name, { max: 30 })))];
    };
    const next = { genders: list(ctx.body.genders, 'gender'), sources: list(ctx.body.sources, 'sumber'), payments: list(ctx.body.payments, 'metode bayar') };
    setSetting(db, 'options', next);
    S.audit(db, ctx.auth, 'ubah_pilihan', 'options', next, ctx.ip);
    return next;
  });

  // ---------- Upload gambar (admin) ----------
  r.post('/api/staff/upload', { auth: 'admin', limit: 2_200_000 }, (ctx) => {
    const m = String(ctx.body.dataUrl || '').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw bad('Format gambar harus PNG, JPG, atau WEBP');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 1_500_000) throw bad('Ukuran gambar maksimal 1,5 MB');
    const sig = buf.subarray(0, 12);
    const isPng = sig[0] === 0x89 && sig.toString('latin1', 1, 4) === 'PNG';
    const isJpg = sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff;
    const isWebp = sig.toString('latin1', 0, 4) === 'RIFF' && sig.toString('latin1', 8, 12) === 'WEBP';
    const ext = isPng ? 'png' : isJpg ? 'jpg' : isWebp ? 'webp' : null;
    if (!ext) throw bad('Isi file bukan gambar yang valid');
    const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(uploadsDir, name), buf, { mode: 0o644 });
    S.audit(db, ctx.auth, 'upload_gambar', name, { bytes: buf.length }, ctx.ip);
    return { url: '/uploads/' + name };
  });

  // ---------- Akun staf ----------
  const staffDto = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active, lastLoginAt: u.last_login_at, createdAt: u.created_at });
  r.get('/api/staff/users', { auth: 'admin' }, () => db.prepare('SELECT * FROM staff ORDER BY id').all().map(staffDto));
  r.post('/api/staff/users', { auth: 'admin' }, (ctx) => {
    const username = v.str(ctx.body.username, 'Username', { min: 3, max: 30, pattern: /^[a-z0-9_.]+$/ });
    if (db.prepare('SELECT 1 FROM staff WHERE username = ?').get(username)) throw conflict('Username sudah dipakai');
    const id = Number(db.prepare('INSERT INTO staff(username, name, role, password_hash, must_change_password) VALUES (?,?,?,?,1)')
      .run(username, v.str(ctx.body.name, 'Nama', { min: 2, max: 60 }), v.oneOf(ctx.body.role, 'Peran', ['admin', 'kasir']), hashPassword(v.password(ctx.body.password))).lastInsertRowid);
    S.audit(db, ctx.auth, 'tambah_staf', username, { role: ctx.body.role }, ctx.ip);
    return staffDto(db.prepare('SELECT * FROM staff WHERE id = ?').get(id));
  });
  r.patch('/api/staff/users/:id', { auth: 'admin' }, (ctx) => {
    const id = v.int(ctx.params.id, 'ID', { min: 1 });
    const u = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
    if (!u) throw notFound('Akun staf tidak ditemukan');
    const role = ctx.body.role !== undefined ? v.oneOf(ctx.body.role, 'Peran', ['admin', 'kasir']) : u.role;
    const active = ctx.body.active !== undefined ? (ctx.body.active ? 1 : 0) : u.active;
    const name = ctx.body.name !== undefined ? v.str(ctx.body.name, 'Nama', { min: 2, max: 60 }) : u.name;
    if (id === ctx.auth.id && (role !== 'admin' || !active)) throw bad('Anda tidak bisa menonaktifkan atau menurunkan akun sendiri');
    const admins = db.prepare("SELECT COUNT(*) n FROM staff WHERE role = 'admin' AND active = 1 AND id != ?").get(id).n;
    if (u.role === 'admin' && (role !== 'admin' || !active) && admins === 0) throw bad('Harus ada minimal satu admin aktif');
    let pw = '';
    const args = [name, role, active];
    if (ctx.body.password) { pw = ', password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL'; args.push(hashPassword(v.password(ctx.body.password))); }
    db.prepare(`UPDATE staff SET name = ?, role = ?, active = ?${pw} WHERE id = ?`).run(...args, id);
    if (!active || ctx.body.password) db.prepare("DELETE FROM sessions WHERE kind='staff' AND subject_id = ?").run(id);
    S.audit(db, ctx.auth, 'ubah_staf', u.username, { role, active: !!active, resetPassword: !!ctx.body.password }, ctx.ip);
    return staffDto(db.prepare('SELECT * FROM staff WHERE id = ?').get(id));
  });

  // ---------- Log aktivitas ----------
  r.get('/api/staff/audit', { auth: 'admin' }, () => db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300').all().map((a) => ({
    id: a.id, actorKind: a.actor_kind, actorName: a.actor_name, action: a.action, target: a.target,
    detail: a.detail ? JSON.parse(a.detail) : null, ip: a.ip, createdAt: a.created_at,
  })));

  // ---------- Ekspor CSV (bisa dibuka di Excel) ----------
  const csvCell = (x) => {
    let s = x === null || x === undefined ? '' : String(x);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // cegah CSV/formula injection
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const toCsv = (rows) => '﻿' + rows.map((r2) => r2.map(csvCell).join(',')).join('\r\n');
  const label = { aktif: 'AKTIF', tidak_aktif: 'TIDAK AKTIF', belum_beli: 'BELUM PERNAH BELI' };

  r.get('/api/staff/export/customers.csv', { auth: 'admin', raw: true }, (ctx) => {
    const rows = [['ID', 'NAMA CUSTOMER', 'NOMER WHATSAPP', 'DATE', 'GENDER', 'SOURCE', 'MENU FAVORITE', 'CATATAN', 'TOTAL KUNJUNGAN', 'TOTAL BELANJA', 'KUNJUNGAN TERAKHIR', 'LEVEL MEMBER', 'POIN', 'STATUS']];
    for (const c of S.listCustomers(db)) rows.push([c.memberCode, c.name, c.phone, c.joinedAt, c.gender, c.source, c.favoriteNote || c.stats.favoriteMenu, c.note, c.stats.visits, c.stats.totalSpend, c.stats.lastVisit, c.stats.tier.name.toUpperCase(), c.stats.points, label[c.stats.status]]);
    S.audit(db, ctx.auth, 'ekspor_customer', 'csv', null, ctx.ip);
    return { type: 'text/csv; charset=utf-8', filename: `customer-${S.today()}.csv`, body: toCsv(rows) };
  });
  r.get('/api/staff/export/transactions.csv', { auth: 'admin', raw: true }, (ctx) => {
    const rows = [['ID TRANSAKSI', 'TANGGAL', 'ID CUSTOMER', 'NAMA CUSTOMER', 'MENU', 'JUMLAH', 'TOTAL RP', 'DISKON', 'PAYMENT', 'POIN', 'STATUS', 'SUMBER']];
    for (const t of S.listTransactions(db, { limit: 100000 })) {
      rows.push([t.code, t.date, t.customer?.memberCode, t.customer?.name, t.items.map((i) => `${i.name} x${i.qty}`).join('; '), t.items.reduce((s, i) => s + i.qty, 0), t.total, t.discount, t.payment, t.pointsEarned, t.status === 'void' ? 'BATAL' : 'LUNAS', t.source]);
    }
    S.audit(db, ctx.auth, 'ekspor_transaksi', 'csv', null, ctx.ip);
    return { type: 'text/csv; charset=utf-8', filename: `transaksi-${S.today()}.csv`, body: toCsv(rows) };
  });

  return { router: r, loadAuth };
}
