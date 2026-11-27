// Backend TIRUAN untuk pratinjau (artifact). Meniru API server di browser memakai localStorage.
// Hanya untuk demo tampilan — keamanan sesungguhnya ada di server.js (Node + SQLite).
import { DEFAULT_LOYALTY, buildStats, tierFor, tierRank, pointsForPurchase, voucherDiscount, todayIn, daysBetween, sortedTiers } from '../public/assets/js/loyalty.js';

const KEY = 'lacafe_demo_v1';
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const plusDays = (d) => new Date(Date.now() + d * 86400000).toISOString().replace('T', ' ').slice(0, 19);
const shift = (iso, days) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const clone = (x) => JSON.parse(JSON.stringify(x));
class E extends Error { constructor(status, msg, code = 'error') { super(msg); this.status = status; this.code = code; } }
const bad = (m) => new E(400, m, 'invalid');

const APPEARANCE = {
  brandName: 'LaCafe', tagline: 'Kopi tetangga, poin setiap cangkir', logoText: 'LC', logoImage: null, theme: 'indigo',
  colors: { primary: '#1E2A5A', accent: '#E0A43A', bg: '#F4F5F9', surface: '#FFFFFF', text: '#161A2B' }, radius: 'soft', font: 'jakarta', menuLayout: 'list',
  homeSections: ['member', 'actions', 'banners', 'featured', 'categories', 'rewards'].map((key) => ({ key, visible: true })),
  banners: [
    { id: 'b1', title: 'Kopi Susu Malaka', subtitle: 'Gula aren asli, favorit pelanggan kami', color: '#1E2A5A', image: null, active: true },
    { id: 'b2', title: 'Poin dobel setiap Jumat', subtitle: 'Atur promo ini dari menu Tampilan', color: '#8A4B1F', image: null, active: true },
  ],
  orderingEnabled: true, pickupNote: 'Ambil pesanan di kasir LaCafe', announcement: '',
};
const ACR = new Set(['BCA', 'QR', 'QRIS']);
const nice = (s, all) => s && s.trim().split(/\s+/).map((w, i) => ACR.has(w.toUpperCase()) ? w.toUpperCase() : (i === 0 || all) ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()).join(' ');

function seedDb(seed) {
  const db = { seq: {}, settings: {}, categories: [], menu: [], customers: [], transactions: [], ledger: [], rewards: [], vouchers: [], orders: [], staff: [], audit: [], session: null };
  const id = (t) => (db.seq[t] = (db.seq[t] || 0) + 1);
  const loyalty = clone(DEFAULT_LOYALTY);
  loyalty.rupiahPerPoint = seed.settings.rupiahPerPoint; loyalty.inactiveDays = seed.settings.inactiveDays;
  for (const t of seed.settings.tiers) { const c = loyalty.tiers.find((x) => x.key === t.key); if (c) c.minSpend = t.minSpend; }
  db.settings = { loyalty, appearance: clone(APPEARANCE), options: { genders: ['Laki-laki', 'Perempuan'], sources: seed.options.sources.map((s) => nice(s)), payments: [...new Set([...seed.options.payments.map((p) => nice(p, true)), 'QRIS'])] } };
  [['kopi', 'Kopi'], ['non-kopi', 'Non-kopi'], ['teh', 'Teh & segar'], ['makanan', 'Makanan']].forEach(([key, name], i) => db.categories.push({ id: id('cat'), key, name, sort: i + 1, active: true }));
  const feat = new Set(['KOPI SUSU MALAKA', 'BUTTERSCOTCH LATTE COLD', 'V60', 'YUZU COFFEE', 'CROISSANT']);
  const byCode = {};
  seed.menu.forEach((m, i) => { const it = { id: id('menu'), code: m.code, name: m.name, categoryId: db.categories.find((c) => c.key === m.category).id, price: m.price, description: null, image: null, temp: m.temp, featured: feat.has(m.code), available: true, archived: false, sort: i + 1 }; db.menu.push(it); byCode[m.code] = it; });
  const R = (name, description, pointsCost, minTier, type, value, menuCode, validDays) => db.rewards.push({ id: id('reward'), name, description, pointsCost, minTier, stock: null, type, value, menuItemId: menuCode ? byCode[menuCode]?.id : null, validDays, image: null, active: true, archived: false, sort: db.rewards.length + 1 });
  R('Potongan Rp10.000', 'Berlaku untuk semua menu', 20, null, 'discount_amount', 10000, null, 30);
  R('Gratis Kopi Susu Malaka', 'Satu cup Kopi Susu Malaka', 30, null, 'free_item', 0, 'KOPI SUSU MALAKA', 30);
  R('Gratis Croissant', 'Teman ngopi paling pas', 25, null, 'free_item', 0, 'CROISSANT', 30);
  R('Diskon 25%', 'Khusus member Silver ke atas', 40, 'silver', 'discount_percent', 25, null, 14);
  R('Gratis Mix Platter', 'Khusus member Gold', 60, 'gold', 'free_item', 0, 'MIX PLATTER', 30);
  const G = { male: 'Laki-laki', female: 'Perempuan' };
  for (const c of seed.customers) db.customers.push({ id: id('cust'), memberCode: c.memberCode, name: c.name, phone: c.phone, gender: G[c.gender] || null, source: nice(c.source) || null, birthday: null, favoriteNote: c.favoriteNote, note: c.note, joinedAt: c.joinedAt, password: c.memberCode === 'LC004' ? 'demo1234' : null, activation: null, active: true, failed: 0, lastLoginAt: null });
  db.staff.push({ id: id('staff'), username: 'admin', name: 'Pemilik', role: 'admin', password: 'demo1234', active: true, mustChange: false, lastLoginAt: null, createdAt: now() });
  const api = makeApi(db, () => {});
  for (const t of [...seed.transactions].sort((a, b) => a.date.localeCompare(b.date))) {
    const cust = db.customers.find((c) => c.memberCode === t.memberCode);
    const qty = t.items.reduce((s, i) => s + i.qty, 0);
    const lines = t.items.map((i) => { const m = byCode[i.code]; const price = Math.round(t.total / qty); return { menuItemId: m?.id ?? null, name: m?.name || i.code, price, qty: i.qty, lineTotal: price * i.qty }; });
    api._sale({ customerId: cust.id, lines, subtotal: t.total, payment: nice(t.payment, true), date: t.date, source: 'import', code: t.code });
  }
  db.audit.push({ id: id('audit'), actorKind: 'system', actorName: 'Sistem', action: 'seed', target: seed.source, detail: { customers: seed.customers.length }, ip: 'demo', createdAt: now() });
  return db;
}

function makeApi(db, save) {
  const id = (t) => (db.seq[t] = (db.seq[t] || 0) + 1);
  const L = () => db.settings.loyalty;
  const today = () => todayIn();
  const audit = (action, target, detail) => db.audit.push({ id: id('audit'), actorKind: db.session?.kind || 'system', actorName: actor()?.name || 'Sistem', action, target, detail, ip: 'demo', createdAt: now() });
  const actor = () => db.session ? (db.session.kind === 'staff' ? db.staff.find((s) => s.id === db.session.id) : db.customers.find((c) => c.id === db.session.id)) : null;
  const nextCode = (list, prefix, w = 3) => prefix + String(Math.max(0, ...list.map((x) => (String(x).startsWith(prefix) ? parseInt(String(x).slice(prefix.length), 10) || 0 : 0))) + 1).padStart(w, '0');

  function raw(cid) {
    const loyalty = L();
    const since = loyalty.tierBasis === 'rolling365' ? shift(today(), -365) : '0000';
    const trx = db.transactions.filter((t) => t.customerId === cid && t.status === 'paid');
    const fav = {};
    trx.forEach((t) => t.items.forEach((i) => { fav[i.name] = (fav[i.name] || 0) + i.qty; }));
    const dates = new Set(trx.map((t) => t.date));
    return {
      totalSpend: trx.reduce((s, t) => s + t.total, 0), tierSpend: trx.filter((t) => t.date >= since).reduce((s, t) => s + t.total, 0),
      visits: dates.size, lastVisit: [...dates].sort().pop() || null, firstVisit: [...dates].sort()[0] || null,
      points: db.ledger.filter((l) => l.customerId === cid).reduce((s, l) => s + l.delta, 0),
      favoriteMenu: Object.entries(fav).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    };
  }
  const stats = (cid) => buildStats(raw(cid), L(), today());
  const balance = (cid) => db.ledger.filter((l) => l.customerId === cid).reduce((s, l) => s + l.delta, 0);
  const custDto = (c, priv = true) => ({ id: c.id, memberCode: c.memberCode, name: c.name, phone: c.phone, gender: c.gender, birthday: c.birthday, joinedAt: c.joinedAt, hasAccount: !!c.password, active: c.active, stats: stats(c.id), ...(priv ? { source: c.source, favoriteNote: c.favoriteNote, note: c.note, lastLoginAt: c.lastLoginAt } : {}) });
  const ledger = (cid, delta, type, refCode, note) => { const b = balance(cid) + delta; db.ledger.push({ id: id('ledger'), customerId: cid, delta, balanceAfter: b, type, refCode, note, staffId: db.session?.kind === 'staff' ? db.session.id : null, createdAt: now() }); return b; };
  const ledgerDto = (cid) => db.ledger.filter((l) => l.customerId === cid).slice().reverse().map((l) => ({ ...l, staffName: db.staff.find((s) => s.id === l.staffId)?.name || null }));
  const trxDto = (t) => { const c = db.customers.find((x) => x.id === t.customerId); return { ...t, customer: c ? { id: c.id, name: c.name, memberCode: c.memberCode } : null, voucherCode: db.vouchers.find((v) => v.id === t.voucherId)?.code || null, staffName: db.staff.find((s) => s.id === t.staffId)?.name || null }; };
  const expire = () => db.vouchers.forEach((v) => { if (v.status === 'active' && v.expiresAt < now()) v.status = 'expired'; });
  const orderDto = (o) => { const c = db.customers.find((x) => x.id === o.customerId); const t = db.transactions.find((x) => x.id === o.transactionId); const v = db.vouchers.find((x) => x.id === o.voucherId); return { ...o, customer: c ? { id: c.id, name: c.name, memberCode: c.memberCode, phone: c.phone } : null, transactionCode: t?.code || null, pointsEarned: t?.pointsEarned || 0, voucher: v ? { code: v.code, name: v.name } : null }; };
  const menuLive = () => db.menu.filter((m) => !m.archived).sort((a, b) => a.sort - b.sort);
  const cats = (all) => db.categories.filter((c) => all || c.active).sort((a, b) => a.sort - b.sort);
  const rewardsLive = (all) => db.rewards.filter((r) => !r.archived && (all || r.active)).sort((a, b) => a.sort - b.sort);

  function priceLines(items, allowUnavailable) {
    if (!Array.isArray(items) || !items.length) throw bad('Keranjang masih kosong');
    const lines = [];
    for (const it of items) {
      const m = db.menu.find((x) => x.id === Number(it.menuItemId) && !x.archived);
      if (!m) throw bad('Ada menu yang sudah tidak tersedia');
      if (!m.available && !allowUnavailable) throw bad(`${m.name} sedang habis`);
      const qty = Number(it.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 100) throw bad('Jumlah item harus 1–100');
      lines.push({ menuItemId: m.id, name: m.name, price: m.price, qty, note: it.note || null, lineTotal: m.price * qty });
    }
    return { lines, subtotal: lines.reduce((s, l) => s + l.lineTotal, 0) };
  }
  function checkVoucher(code, cid, lines, subtotal, orderId) {
    expire();
    const v = db.vouchers.find((x) => x.code === String(code).toUpperCase());
    if (!v) throw bad('Kode voucher tidak ditemukan');
    if (v.customerId !== cid) throw bad('Voucher ini milik member lain');
    if (v.status !== 'active' && !(v.status === 'reserved' && v.orderId === orderId)) throw bad('Voucher sudah tidak berlaku');
    const d = voucherDiscount(v, lines, subtotal);
    if (d < 0) throw bad('Tambahkan item gratis voucher ke keranjang terlebih dahulu');
    return { v, d };
  }
  function sale({ customerId = null, lines, subtotal, payment, voucherCode = null, date = null, source = 'pos', orderId = null, code = null }) {
    let v = null, discount = 0;
    if (voucherCode) ({ v, d: discount } = checkVoucher(voucherCode, customerId, lines, subtotal, orderId));
    const total = subtotal - discount;
    let pts = 0;
    if (customerId) { const r = raw(customerId); pts = pointsForPurchase(r.totalSpend, total, L(), tierFor(r.tierSpend, L().tiers)); }
    const t = { id: id('trx'), code: code || nextCode(db.transactions.map((x) => x.code), 'TL'), customerId, date: date || today(), createdAt: now(), items: lines.map(({ note, ...l }) => l), subtotal, discount, total, payment, source, orderId, voucherId: v?.id || null, staffId: db.session?.kind === 'staff' ? db.session.id : null, status: 'paid', voidReason: null, pointsEarned: pts };
    db.transactions.push(t);
    if (pts) ledger(customerId, pts, 'earn', t.code, `Belanja ${t.code}`);
    if (v) { v.status = 'used'; v.usedAt = now(); }
    return trxDto(t);
  }

  const me = () => { if (db.session?.kind !== 'customer') throw new E(401, 'Silakan masuk terlebih dahulu', 'unauthorized'); return db.customers.find((c) => c.id === db.session.id); };
  const staff = (admin) => { if (db.session?.kind !== 'staff') throw new E(db.session ? 403 : 401, 'Anda tidak punya akses', 'forbidden'); const s = db.staff.find((x) => x.id === db.session.id); if (admin && s.role !== 'admin') throw new E(403, 'Hanya admin yang bisa melakukan ini', 'forbidden'); return s; };
  const sessionPayload = () => { const a = actor(); if (!a) return { kind: null }; return db.session.kind === 'staff' ? { kind: 'staff', csrf: 'demo', user: { id: a.id, name: a.name, role: a.role, username: a.username, mustChange: a.mustChange } } : { kind: 'customer', csrf: 'demo', user: { id: a.id, name: a.name, memberCode: a.memberCode } }; };
  const findCust = (ident) => { const s = String(ident || '').trim(); if (/^[a-z]{1,4}\d+$/i.test(s)) return db.customers.find((c) => c.memberCode === s.toUpperCase()); let d = s.replace(/\D/g, ''); if (d.startsWith('62')) d = '0' + d.slice(2); return db.customers.find((c) => c.phone && c.phone === d); };
  const pw = (p) => { if (typeof p !== 'string' || p.length < 8 || !/[A-Za-z]/.test(p) || !/\d/.test(p)) throw bad('Kata sandi minimal 8 karakter, berisi huruf dan angka'); return p; };
  const phone = (p) => { if (!p) return null; let d = String(p).replace(/\D/g, ''); if (d.startsWith('62')) d = '0' + d.slice(2); else if (!d.startsWith('0')) d = '0' + d; if (!/^08\d{7,12}$/.test(d)) throw bad('Nomor WhatsApp tidak valid (contoh: 0812xxxxxxx)'); return d; };
  const passCode = (code, at = Date.now()) => { let h = 2166136261; for (const ch of code + ':' + Math.floor(at / 60000)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return String(Math.abs(h) % 1000000).padStart(6, '0'); };
  const ORDER_FLOW = { pending: ['processing', 'cancelled'], processing: ['ready', 'cancelled'], ready: ['completed', 'cancelled'], completed: [], cancelled: [] };

  function setOrder(o, next, { payment, reason, byCustomer } = {}) {
    if (byCustomer && !(o.status === 'pending' && next === 'cancelled')) throw bad('Pesanan yang sudah diproses tidak bisa dibatalkan dari aplikasi. Hubungi kasir.');
    if (!ORDER_FLOW[o.status].includes(next)) throw new E(409, `Status tidak bisa diubah dari ${o.status} ke ${next}`);
    if (next === 'completed') { const v = db.vouchers.find((x) => x.id === o.voucherId); o.transactionId = sale({ customerId: o.customerId, lines: o.items, subtotal: o.subtotal, payment: payment || o.paymentMethod, voucherCode: v?.code, source: 'order', orderId: o.id }).id; }
    if (next === 'cancelled') { o.cancelReason = reason || 'Dibatalkan'; const v = db.vouchers.find((x) => x.id === o.voucherId && x.status === 'reserved'); if (v) { v.status = 'active'; v.orderId = null; } }
    if (payment) o.paymentMethod = payment;
    o.status = next; o.updatedAt = now();
    return orderDto(o);
  }

  const routes = [
    ['GET', '/api/auth/session', () => sessionPayload()],
    ['POST', '/api/auth/staff/login', (b) => { const s = db.staff.find((x) => x.username === String(b.username).toLowerCase()); if (!s || s.password !== b.password || !s.active) throw new E(401, 'Username atau kata sandi salah'); db.session = { kind: 'staff', id: s.id }; s.lastLoginAt = now(); audit('login', 'staff'); return sessionPayload(); }],
    ['POST', '/api/auth/customer/login', (b) => { const c = findCust(b.identifier); if (c && !c.password) throw new E(401, 'Akun member ini belum diaktifkan. Minta kode aktivasi ke kasir, lalu pilih "Aktifkan akun".', 'not_activated'); if (!c || c.password !== b.password || !c.active) throw new E(401, 'Nomor/ID member atau kata sandi salah'); db.session = { kind: 'customer', id: c.id }; c.lastLoginAt = now(); return sessionPayload(); }],
    ['POST', '/api/auth/customer/register', (b) => {
      if (!b.name || b.name.trim().length < 2) throw bad('Nama minimal 2 karakter');
      const p = phone(b.phone); if (!p) throw bad('Nomor WhatsApp wajib diisi'); pw(b.password);
      const ex = db.customers.find((c) => c.phone === p);
      if (ex?.password) throw new E(409, 'Nomor ini sudah terdaftar. Silakan masuk.');
      if (ex) throw new E(409, 'Nomor ini sudah tercatat sebagai member di kasir. Minta kode aktivasi ke kasir, lalu pilih "Aktifkan akun".', 'needs_activation');
      const c = { id: id('cust'), memberCode: nextCode(db.customers.map((x) => x.memberCode), 'LC'), name: b.name.trim(), phone: p, gender: b.gender || null, source: 'Aplikasi', birthday: b.birthday || null, favoriteNote: null, note: null, joinedAt: today(), password: b.password, activation: null, active: true, lastLoginAt: now() };
      db.customers.push(c); db.session = { kind: 'customer', id: c.id }; audit('daftar_member', c.memberCode); return sessionPayload();
    }],
    ['POST', '/api/auth/customer/activate', (b) => { const c = findCust(b.identifier); const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); pw(b.password); if (!c || !c.activation || c.activation !== code) throw bad('Kode aktivasi salah atau sudah kedaluwarsa. Minta kode baru ke kasir.'); c.password = b.password; c.activation = null; db.session = { kind: 'customer', id: c.id }; audit('aktivasi_akun', c.memberCode); return sessionPayload(); }],
    ['POST', '/api/auth/logout', () => { db.session = null; return { ok: true }; }],
    ['POST', '/api/auth/password', (b) => { const a = actor(); if (!a) throw new E(401, 'Silakan masuk'); if (a.password !== b.current) throw bad('Kata sandi lama salah'); pw(b.next); a.password = b.next; if ('mustChange' in a) a.mustChange = false; audit('ganti_password', db.session.kind); return { ok: true }; }],
    ['GET', '/api/public/bootstrap', () => ({ appearance: db.settings.appearance, categories: cats(), menu: menuLive(), rewards: rewardsLive(), loyalty: L(), options: db.settings.options })],

    ['GET', '/api/me', () => { const c = me(); expire(); return { ...custDto(c, false), activeVouchers: db.vouchers.filter((v) => v.customerId === c.id && v.status === 'active').length, activeOrders: db.orders.filter((o) => o.customerId === c.id && ['pending', 'processing', 'ready'].includes(o.status)).reverse().map(orderDto) }; }],
    ['PATCH', '/api/me', (b) => { const c = me(); if (b.name !== undefined) { if (b.name.trim().length < 2) throw bad('Nama minimal 2 karakter'); c.name = b.name.trim(); } if (b.gender !== undefined) c.gender = b.gender || null; if (b.birthday !== undefined) c.birthday = b.birthday || null; return custDto(c, false); }],
    ['GET', '/api/me/pass', () => { const c = me(); return { memberCode: c.memberCode, code: passCode(c.memberCode), expiresIn: 60 - (Math.floor(Date.now() / 1000) % 60), window: 60 }; }],
    ['GET', '/api/me/points', () => ledgerDto(me().id)],
    ['GET', '/api/me/transactions', () => { const c = me(); return db.transactions.filter((t) => t.customerId === c.id).slice().reverse().map(trxDto); }],
    ['GET', '/api/me/vouchers', () => { const c = me(); expire(); return db.vouchers.filter((v) => v.customerId === c.id).slice().reverse(); }],
    ['POST', '/api/me/redeem', (b) => {
      const c = me(); const r = db.rewards.find((x) => x.id === Number(b.rewardId) && x.active && !x.archived);
      if (!r) throw new E(404, 'Reward tidak tersedia');
      if (r.stock !== null && r.stock <= 0) throw new E(409, 'Stok reward sudah habis');
      const s = stats(c.id);
      if (r.minTier && tierRank(s.tier.key, L().tiers) < tierRank(r.minTier, L().tiers)) throw bad('Reward ini khusus level yang lebih tinggi');
      if (balance(c.id) < r.pointsCost) throw bad(`Poin belum cukup. Butuh ${r.pointsCost - balance(c.id)} poin lagi`);
      const v = { id: id('voucher'), code: 'V' + Math.random().toString(36).slice(2, 12).toUpperCase(), customerId: c.id, rewardId: r.id, name: r.name, pointsCost: r.pointsCost, type: r.type, value: r.value, menuItemId: r.menuItemId, status: 'active', orderId: null, createdAt: now(), expiresAt: plusDays(r.validDays || 30), usedAt: null };
      db.vouchers.push(v); ledger(c.id, -r.pointsCost, 'redeem', v.code, `Tukar: ${r.name}`); if (r.stock !== null) r.stock -= 1; audit('tukar_poin', v.code, { reward: r.name }); return v;
    }],
    ['GET', '/api/me/orders', () => { const c = me(); return db.orders.filter((o) => o.customerId === c.id).slice().reverse().map(orderDto); }],
    ['POST', '/api/me/orders', (b) => {
      const c = me(); if (!db.settings.appearance.orderingEnabled) throw bad('Pemesanan lewat aplikasi sedang ditutup');
      if (db.orders.filter((o) => o.customerId === c.id && ['pending', 'processing', 'ready'].includes(o.status)).length >= 3) throw bad('Anda masih punya 3 pesanan berjalan');
      const { lines, subtotal } = priceLines(b.items);
      let v = null, d = 0;
      if (b.voucherCode) ({ v, d } = checkVoucher(b.voucherCode, c.id, lines, subtotal));
      const o = { id: id('order'), code: nextCode(db.orders.map((x) => x.code), 'OR', 4), customerId: c.id, status: 'pending', queueNo: db.orders.filter((x) => x.createdAt.slice(0, 10) === now().slice(0, 10)).length + 1, items: lines, subtotal, discount: d, total: subtotal - d, paymentMethod: b.paymentMethod, voucherId: v?.id || null, note: b.note || null, transactionId: null, cancelReason: null, createdAt: now(), updatedAt: now() };
      if (v) { v.status = 'reserved'; v.orderId = o.id; }
      db.orders.push(o); audit('pesanan_baru', o.code, { total: o.total }); return orderDto(o);
    }],
    ['POST', '/api/me/orders/:id/cancel', (b, p) => { const c = me(); const o = db.orders.find((x) => x.id === Number(p.id) && x.customerId === c.id); if (!o) throw new E(404, 'Pesanan tidak ditemukan'); return setOrder(o, 'cancelled', { byCustomer: true, reason: 'Dibatalkan customer' }); }],

    ['GET', '/api/staff/dashboard', () => {
      staff(); const t = today(); const month = t.slice(0, 8) + '01';
      const paid = db.transactions.filter((x) => x.status === 'paid');
      const sum = (f) => { const l = paid.filter(f); return { s: l.reduce((a, x) => a + x.total, 0), n: l.length }; };
      const custs = db.customers.map((c) => custDto(c));
      const daily = Array.from({ length: 14 }, (_, i) => { const d = shift(t, i - 13); const a = sum((x) => x.date === d); return { date: d, total: a.s, count: a.n }; });
      const top = {}; paid.forEach((x) => x.items.forEach((i) => { top[i.name] = top[i.name] || { name: i.name, qty: 0, revenue: 0 }; top[i.name].qty += i.qty; top[i.name].revenue += i.lineTotal; }));
      const all = sum(() => true);
      return {
        today: t, kpis: { members: custs.length, activeMembers: custs.filter((c) => c.stats.status === 'aktif').length, newMembers30: custs.filter((c) => daysBetween(c.joinedAt, t) <= 30).length, revenueToday: sum((x) => x.date === t).s, trxToday: sum((x) => x.date === t).n, revenueMonth: sum((x) => x.date >= month).s, trxMonth: sum((x) => x.date >= month).n, revenueAll: all.s, trxAll: all.n, avgTicket: all.n ? Math.round(all.s / all.n) : 0, pointsOutstanding: db.ledger.reduce((a, l) => a + l.delta, 0), pendingOrders: db.orders.filter((o) => ['pending', 'processing', 'ready'].includes(o.status)).length },
        tiers: sortedTiers(L().tiers).map((tr) => ({ ...tr, count: custs.filter((c) => c.stats.tier.key === tr.key).length })),
        status: ['aktif', 'tidak_aktif', 'belum_beli'].map((k) => ({ key: k, count: custs.filter((c) => c.stats.status === k).length })),
        daily, topMenu: Object.values(top).sort((a, b) => b.qty - a.qty).slice(0, 6),
        topCustomers: custs.sort((a, b) => b.stats.totalSpend - a.stats.totalSpend).slice(0, 5).map((c) => ({ id: c.id, name: c.name, memberCode: c.memberCode, totalSpend: c.stats.totalSpend, tier: c.stats.tier, points: c.stats.points })),
        recent: db.transactions.slice().sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id).slice(0, 6).map(trxDto),
      };
    }],
    ['GET', '/api/staff/customers', () => { staff(); return db.customers.map((c) => custDto(c)); }],
    ['GET', '/api/staff/lookup', (b, p, q) => { staff(); const code = String(q.get('code') || '').replace(/\D/g, ''); const c = db.customers.find((x) => x.active && (passCode(x.memberCode) === code || passCode(x.memberCode, Date.now() - 60000) === code)); if (!c) throw new E(404, 'Kode tidak cocok atau sudah kedaluwarsa'); return custDto(c); }],
    ['POST', '/api/staff/customers', (b) => { staff(); if (!b.name || b.name.trim().length < 2) throw bad('Nama minimal 2 karakter'); const p = phone(b.phone); if (p && db.customers.some((c) => c.phone === p)) throw new E(409, 'Nomor WhatsApp sudah dipakai member lain'); const c = { id: id('cust'), memberCode: nextCode(db.customers.map((x) => x.memberCode), 'LC'), name: b.name.trim(), phone: p, gender: b.gender || null, source: b.source || null, birthday: b.birthday || null, favoriteNote: b.favoriteNote || null, note: b.note || null, joinedAt: today(), password: null, activation: null, active: true }; db.customers.push(c); audit('tambah_customer', c.memberCode); return custDto(c); }],
    ['GET', '/api/staff/customers/:id', (b, p) => { staff(); expire(); const c = db.customers.find((x) => x.id === Number(p.id)); if (!c) throw new E(404, 'Customer tidak ditemukan'); return { ...custDto(c), activationPending: !!c.activation, transactions: db.transactions.filter((t) => t.customerId === c.id).slice().reverse().map(trxDto), ledger: ledgerDto(c.id), vouchers: db.vouchers.filter((v) => v.customerId === c.id).slice().reverse(), orders: db.orders.filter((o) => o.customerId === c.id).slice().reverse().map(orderDto) }; }],
    ['PATCH', '/api/staff/customers/:id', (b, p) => { const s = staff(); const c = db.customers.find((x) => x.id === Number(p.id)); for (const k of ['name', 'gender', 'source', 'birthday', 'note', 'favoriteNote']) if (b[k] !== undefined) c[k] = b[k] || null; if (b.phone !== undefined) { if (s.role !== 'admin') throw new E(403, 'Hanya admin yang bisa mengubah nomor WhatsApp'); c.phone = phone(b.phone); } if (b.active !== undefined) c.active = !!b.active; audit('ubah_customer', c.memberCode); return custDto(c); }],
    ['POST', '/api/staff/customers/:id/activation', (b, p) => { staff(); const c = db.customers.find((x) => x.id === Number(p.id)); const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 8; i++) s += a[Math.floor(Math.random() * a.length)]; c.activation = s; audit(c.password ? 'reset_akses_customer' : 'buat_kode_aktivasi', c.memberCode); return { code: s.slice(0, 4) + '-' + s.slice(4), expiresInHours: 72, memberCode: c.memberCode, phone: c.phone, reset: !!c.password }; }],
    ['POST', '/api/staff/customers/:id/adjust-points', (b, p) => { staff(true); const c = db.customers.find((x) => x.id === Number(p.id)); const d = Number(b.delta); if (!Number.isInteger(d) || !d) throw bad('Jumlah poin tidak valid'); if (!b.reason || b.reason.length < 3) throw bad('Alasan minimal 3 karakter'); if (balance(c.id) + d < 0) throw bad(`Saldo poin tidak cukup (saldo ${balance(c.id)})`); const nb = ledger(c.id, d, 'adjust', null, b.reason); audit('koreksi_poin', c.memberCode, { delta: d, reason: b.reason }); return { balance: nb }; }],
    ['GET', '/api/staff/transactions', (b, p, q) => { staff(); const from = q.get('from'), to = q.get('to'), s = (q.get('q') || '').toLowerCase(); return db.transactions.map(trxDto).filter((t) => (!from || t.date >= from) && (!to || t.date <= to) && (!s || t.code.toLowerCase().includes(s) || (t.customer && (t.customer.name.toLowerCase().includes(s) || t.customer.memberCode.toLowerCase().includes(s))))).sort((a, b2) => b2.date.localeCompare(a.date) || b2.id - a.id); }],
    ['POST', '/api/staff/transactions', (b) => { const s = staff(); if (b.date && b.date !== today() && s.role !== 'admin') throw new E(403, 'Hanya admin yang bisa mencatat transaksi tanggal lain'); const { lines, subtotal } = priceLines(b.items, true); const r = sale({ customerId: b.customerId || null, lines, subtotal, payment: b.payment, voucherCode: b.voucherCode, date: b.date || null }); audit('transaksi', r.code, { total: r.total, poin: r.pointsEarned }); return r; }],
    ['POST', '/api/staff/transactions/:id/void', (b, p) => { staff(true); const t = db.transactions.find((x) => x.id === Number(p.id)); if (t.status === 'void') throw new E(409, 'Transaksi sudah dibatalkan'); if (!b.reason || b.reason.length < 3) throw bad('Alasan minimal 3 karakter'); t.status = 'void'; t.voidReason = b.reason; if (t.customerId && t.pointsEarned) ledger(t.customerId, -t.pointsEarned, 'void', t.code, `Pembatalan ${t.code}: ${b.reason}`); const v = db.vouchers.find((x) => x.id === t.voucherId); if (v) { v.status = 'active'; v.usedAt = null; } audit('batal_transaksi', t.code, { reason: b.reason }); return trxDto(t); }],
    ['GET', '/api/staff/vouchers/:code', (b, p) => { staff(); expire(); const v = db.vouchers.find((x) => x.code === p.code.toUpperCase()); if (!v) throw new E(404, 'Voucher tidak ditemukan'); const c = db.customers.find((x) => x.id === v.customerId); return { ...v, customer: { id: c.id, name: c.name, memberCode: c.memberCode } }; }],
    ['GET', '/api/staff/orders', (b, p, q) => { staff(); return db.orders.filter((o) => q.get('scope') !== 'active' || ['pending', 'processing', 'ready'].includes(o.status)).slice().reverse().map(orderDto); }],
    ['POST', '/api/staff/orders/:id/status', (b, p) => { staff(); const o = db.orders.find((x) => x.id === Number(p.id)); const r = setOrder(o, b.status, { payment: b.payment, reason: b.reason }); audit('status_pesanan', o.code, { status: b.status }); return r; }],
    ['GET', '/api/staff/menu', () => { staff(); return { categories: cats(true), menu: menuLive() }; }],
    ['POST', '/api/staff/menu', (b) => { staff(true); if (!b.name || b.name.length < 2) throw bad('Nama menu minimal 2 karakter'); if (!Number.isInteger(b.price) || b.price < 0) throw bad('Harga harus bilangan bulat'); const m = { id: id('menu'), code: b.name.toUpperCase(), name: b.name, categoryId: b.categoryId, price: b.price, description: b.description || null, image: b.image || null, temp: b.temp || null, featured: !!b.featured, available: b.available !== false, archived: false, sort: db.menu.length + 1 }; db.menu.push(m); audit('tambah_menu', m.name); return m; }],
    ['PATCH', '/api/staff/menu/:id', (b, p) => { const s = staff(); if (s.role !== 'admin' && Object.keys(b).some((k) => k !== 'available')) throw new E(403, 'Kasir hanya bisa mengubah status stok'); const m = db.menu.find((x) => x.id === Number(p.id)); for (const k of ['name', 'price', 'categoryId', 'description', 'image', 'temp', 'featured', 'available', 'sort']) if (b[k] !== undefined) m[k] = b[k]; audit('ubah_menu', m.name); return m; }],
    ['DELETE', '/api/staff/menu/:id', (b, p) => { staff(true); const m = db.menu.find((x) => x.id === Number(p.id)); m.archived = true; m.featured = false; audit('hapus_menu', m.name); return { ok: true }; }],
    ['POST', '/api/staff/categories', (b) => { staff(true); db.categories.push({ id: id('cat'), key: b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + db.seq.cat, name: b.name, sort: db.categories.length + 1, active: true }); return cats(true); }],
    ['PATCH', '/api/staff/categories/:id', (b, p) => { staff(true); const c = db.categories.find((x) => x.id === Number(p.id)); for (const k of ['name', 'sort', 'active']) if (b[k] !== undefined) c[k] = b[k]; return cats(true); }],
    ['DELETE', '/api/staff/categories/:id', (b, p) => { staff(true); if (db.menu.some((m) => m.categoryId === Number(p.id) && !m.archived)) throw new E(409, 'Kategori masih berisi menu'); db.categories = db.categories.filter((c) => c.id !== Number(p.id)); return cats(true); }],
    ['GET', '/api/staff/rewards', () => { staff(); return rewardsLive(true); }],
    ['POST', '/api/staff/rewards', (b) => { staff(true); const r = { id: id('reward'), archived: false, sort: db.rewards.length + 1, image: null, ...b, stock: b.stock === '' || b.stock === null || b.stock === undefined ? null : Number(b.stock) }; db.rewards.push(r); audit('tambah_reward', r.name); return r; }],
    ['PATCH', '/api/staff/rewards/:id', (b, p) => { staff(true); const r = db.rewards.find((x) => x.id === Number(p.id)); Object.assign(r, b); if (b.stock !== undefined) r.stock = b.stock === '' || b.stock === null ? null : Number(b.stock); return r; }],
    ['DELETE', '/api/staff/rewards/:id', (b, p) => { staff(true); const r = db.rewards.find((x) => x.id === Number(p.id)); r.archived = true; r.active = false; return { ok: true }; }],
    ['GET', '/api/staff/settings', () => { staff(); return clone(db.settings); }],
    ['PUT', '/api/staff/settings/loyalty', (b) => { staff(true); const tiers = b.tiers.map((t) => ({ ...t, key: t.key || t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') })).sort((a, c) => a.minSpend - c.minSpend); if (tiers[0].minSpend !== 0) throw bad('Level pertama harus mulai dari Rp0'); db.settings.loyalty = { ...L(), ...b, tiers }; audit('ubah_aturan_loyalty', 'loyalty'); return db.settings.loyalty; }],
    ['PUT', '/api/staff/settings/appearance', (b) => { staff(true); db.settings.appearance = clone(b); audit('ubah_tampilan', 'appearance'); return db.settings.appearance; }],
    ['PUT', '/api/staff/settings/options', (b) => { staff(true); db.settings.options = clone(b); return db.settings.options; }],
    ['POST', '/api/staff/upload', (b) => { staff(true); if (!/^data:image\/(png|jpeg|webp);base64,/.test(b.dataUrl || '')) throw bad('Format gambar harus PNG, JPG, atau WEBP'); if (b.dataUrl.length > 700000) throw bad('Di mode demo, gambar maksimal ±500 KB'); return { url: b.dataUrl }; }],
    ['GET', '/api/staff/users', () => { staff(true); return db.staff.map(({ password, ...s }) => s); }],
    ['POST', '/api/staff/users', (b) => { staff(true); if (db.staff.some((s) => s.username === b.username)) throw new E(409, 'Username sudah dipakai'); pw(b.password); const s = { id: id('staff'), username: b.username, name: b.name, role: b.role, password: b.password, active: true, mustChange: true, lastLoginAt: null, createdAt: now() }; db.staff.push(s); audit('tambah_staf', s.username); const { password, ...rest } = s; return rest; }],
    ['PATCH', '/api/staff/users/:id', (b, p) => { const me2 = staff(true); const s = db.staff.find((x) => x.id === Number(p.id)); if (s.id === me2.id && (b.role === 'kasir' || b.active === false)) throw bad('Anda tidak bisa menonaktifkan atau menurunkan akun sendiri'); for (const k of ['name', 'role', 'active']) if (b[k] !== undefined) s[k] = b[k]; if (b.password) { pw(b.password); s.password = b.password; s.mustChange = true; } const { password, ...rest } = s; return rest; }],
    ['GET', '/api/staff/audit', () => { staff(true); return db.audit.slice().reverse().slice(0, 300); }],
  ];

  async function handle(method, path, body) {
    const [p, qs] = path.split('?');
    const q = new URLSearchParams(qs || '');
    for (const [m, pattern, fn] of routes) {
      if (m !== method) continue;
      const keys = [];
      const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
      const mm = p.match(re);
      if (!mm) continue;
      const params = {}; keys.forEach((k, i) => { params[k] = decodeURIComponent(mm[i + 1]); });
      await new Promise((r) => setTimeout(r, 90)); // terasa seperti jaringan
      try { const data = clone(fn(body || {}, params, q)); save(); return { status: 200, data }; } catch (e) { return { status: e.status || 500, data: { error: e.message, code: e.code } }; }
    }
    return { status: 404, data: { error: 'Endpoint tidak ditemukan (demo)' } };
  }
  return { handle, _sale: sale, db };
}

export function createDemo(seed) {
  let db = null;
  try { db = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
  if (!db || db.version !== 1) { db = seedDb(seed); db.version = 1; }
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} };
  persist();
  let api = makeApi(db, persist);
  return {
    handle: (m, p, b) => api.handle(m, p, b),
    async loginAs(kind) {
      if (kind === 'admin') return api.handle('POST', '/api/auth/staff/login', { username: 'admin', password: 'demo1234' });
      if (kind === 'customer') return api.handle('POST', '/api/auth/customer/login', { identifier: 'LC004', password: 'demo1234' });
      return api.handle('POST', '/api/auth/logout', {});
    },
    reset() { try { localStorage.removeItem(KEY); } catch {} db = seedDb(seed); db.version = 1; api = makeApi(db, persist); persist(); },
    csv(path) {
      const cell = (x) => { const s = x === null || x === undefined ? '' : String(x); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const lbl = { aktif: 'AKTIF', tidak_aktif: 'TIDAK AKTIF', belum_beli: 'BELUM PERNAH BELI' };
      if (path.includes('customers')) {
        return [['ID', 'NAMA CUSTOMER', 'NOMER WHATSAPP', 'DATE', 'TOTAL KUNJUNGAN', 'TOTAL BELANJA', 'KUNJUNGAN TERAKHIR', 'LEVEL MEMBER', 'POIN', 'STATUS'],
          ...db.customers.map((c) => { const s = buildStats((() => { const t = db.transactions.filter((x) => x.customerId === c.id && x.status === 'paid'); const d = [...new Set(t.map((x) => x.date))].sort(); return { totalSpend: t.reduce((a, x) => a + x.total, 0), visits: d.length, lastVisit: d.pop() || null, points: db.ledger.filter((l) => l.customerId === c.id).reduce((a, l) => a + l.delta, 0) }; })(), db.settings.loyalty, todayIn()); return [c.memberCode, c.name, c.phone, c.joinedAt, s.visits, s.totalSpend, s.lastVisit, s.tier.name.toUpperCase(), s.points, lbl[s.status]]; })].map((r) => r.map(cell).join(',')).join('\n');
      }
      return [['ID TRANSAKSI', 'TANGGAL', 'ID CUSTOMER', 'MENU', 'TOTAL RP', 'PAYMENT', 'POIN', 'STATUS'], ...db.transactions.map((t) => [t.code, t.date, db.customers.find((c) => c.id === t.customerId)?.memberCode, t.items.map((i) => `${i.name} x${i.qty}`).join('; '), t.total, t.payment, t.pointsEarned, t.status === 'void' ? 'BATAL' : 'LUNAS'])].map((r) => r.map(cell).join(',')).join('\n');
    },
  };
}
