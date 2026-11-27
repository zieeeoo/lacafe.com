// Logika bisnis: statistik member, poin, transaksi, pesanan, rewards.
// Semua perhitungan harga & poin terjadi DI SINI (server), tidak pernah dipercaya dari browser.
import { bad, conflict, notFound } from './http.js';
import { tx, getLoyalty } from './db.js';
import { voucherCode as genVoucherCode } from './security.js';
import {
  buildStats, tierFor, tierRank, pointsForPurchase, voucherDiscount, todayIn, daysBetween,
} from '../public/assets/js/loyalty.js';

export const TZ = process.env.APP_TZ || 'Asia/Jakarta';
export const today = () => todayIn(TZ);
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function shiftDate(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- Kode berurutan (LC005, TL005, ...) ----------
function nextSeq(db, table, column, prefix, width = 3) {
  const row = db.prepare(`SELECT MAX(CAST(SUBSTR(${column}, ?) AS INTEGER)) m FROM ${table} WHERE ${column} GLOB ?`)
    .get(prefix.length + 1, prefix + '[0-9]*');
  return prefix + String((row?.m || 0) + 1).padStart(width, '0');
}
export const nextMemberCode = (db) => nextSeq(db, 'customers', 'member_code', getLoyalty(db).memberPrefix || 'LC');
export const nextTrxCode = (db) => nextSeq(db, 'transactions', 'code', getLoyalty(db).trxPrefix || 'TL');
export const nextOrderCode = (db) => nextSeq(db, 'orders', 'code', 'OR', 4);

// ---------- Audit ----------
export function audit(db, actor, action, target, detail, ip) {
  db.prepare('INSERT INTO audit_log(actor_kind, actor_id, actor_name, action, target, detail, ip) VALUES (?,?,?,?,?,?,?)')
    .run(actor?.kind || 'system', actor?.id ?? null, actor?.name || 'Sistem', action, target || null, detail ? JSON.stringify(detail) : null, ip || null);
}

// ---------- Statistik member ----------
export function rawStats(db, customerId = null) {
  const loyalty = getLoyalty(db);
  const since = loyalty.tierBasis === 'rolling365' ? shiftDate(today(), -365) : '0000-00-00';
  const where = customerId ? 'AND customer_id = ?' : '';
  const args = customerId ? [customerId] : [];
  const map = new Map();
  const get = (id) => {
    if (!map.has(id)) map.set(id, { totalSpend: 0, tierSpend: 0, visits: 0, lastVisit: null, firstVisit: null, points: 0, favoriteMenu: null });
    return map.get(id);
  };
  for (const r of db.prepare(`SELECT customer_id id, SUM(total) spend, SUM(CASE WHEN date >= ? THEN total ELSE 0 END) tspend,
      COUNT(DISTINCT date) visits, MAX(date) last, MIN(date) first
      FROM transactions WHERE status='paid' AND customer_id IS NOT NULL ${where} GROUP BY customer_id`).all(since, ...args)) {
    Object.assign(get(r.id), { totalSpend: r.spend, tierSpend: r.tspend, visits: r.visits, lastVisit: r.last, firstVisit: r.first });
  }
  for (const r of db.prepare(`SELECT customer_id id, SUM(delta) pts FROM points_ledger WHERE 1=1 ${where} GROUP BY customer_id`).all(...args)) {
    get(r.id).points = r.pts;
  }
  const fav = new Map();
  for (const r of db.prepare(`SELECT t.customer_id id, ti.name, SUM(ti.qty) q FROM transaction_items ti
      JOIN transactions t ON t.id = ti.transaction_id WHERE t.status='paid' AND t.customer_id IS NOT NULL ${customerId ? 'AND t.customer_id = ?' : ''}
      GROUP BY t.customer_id, ti.name`).all(...args)) {
    const cur = fav.get(r.id);
    if (!cur || r.q > cur.q) fav.set(r.id, r);
  }
  for (const [id, r] of fav) get(id).favoriteMenu = r.name;
  return map;
}

export function statsFor(db, customerId) {
  const raw = rawStats(db, customerId).get(customerId) || {};
  return buildStats(raw, getLoyalty(db), today());
}

export function pointsBalance(db, customerId) {
  return db.prepare('SELECT COALESCE(SUM(delta),0) b FROM points_ledger WHERE customer_id = ?').get(customerId).b;
}

export function customerDto(row, stats, { includePrivate = true } = {}) {
  const dto = {
    id: row.id,
    memberCode: row.member_code,
    name: row.name,
    phone: row.phone,
    gender: row.gender,
    birthday: row.birthday,
    joinedAt: row.joined_at,
    hasAccount: !!row.password_hash,
    active: !!row.active,
    stats,
  };
  if (includePrivate) Object.assign(dto, { source: row.source, favoriteNote: row.favorite_note, note: row.note, lastLoginAt: row.last_login_at });
  return dto;
}

export function listCustomers(db) {
  const loyalty = getLoyalty(db);
  const t = today();
  const stats = rawStats(db);
  return db.prepare('SELECT * FROM customers ORDER BY member_code').all()
    .map((row) => customerDto(row, buildStats(stats.get(row.id) || {}, loyalty, t)));
}

// ---------- Buku besar poin ----------
export function addLedger(db, { customerId, delta, type, refType = null, refId = null, refCode = null, note = null, staffId = null, at = null }) {
  const balance = pointsBalance(db, customerId) + delta;
  db.prepare(`INSERT INTO points_ledger(customer_id, delta, balance_after, type, ref_type, ref_id, ref_code, note, staff_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?, COALESCE(?, datetime('now')))`)
    .run(customerId, delta, balance, type, refType, refId, refCode, note, staffId, at);
  return balance;
}

export function ledgerFor(db, customerId, limit = 100) {
  return db.prepare(`SELECT l.*, s.name staff_name FROM points_ledger l LEFT JOIN staff s ON s.id = l.staff_id
    WHERE l.customer_id = ? ORDER BY l.id DESC LIMIT ?`).all(customerId, limit).map((r) => ({
    id: r.id, delta: r.delta, balanceAfter: r.balance_after, type: r.type, note: r.note,
    refType: r.ref_type, refCode: r.ref_code, createdAt: r.created_at, staffName: r.staff_name,
  }));
}

// ---------- Harga dari menu (server-side) ----------
export function priceLines(db, items, { allowUnavailable = false } = {}) {
  if (!Array.isArray(items) || !items.length) throw bad('Keranjang masih kosong');
  if (items.length > 40) throw bad('Terlalu banyak item dalam satu transaksi');
  const get = db.prepare('SELECT * FROM menu_items WHERE id = ? AND archived = 0');
  const merged = new Map();
  for (const it of items) {
    const id = Number(it?.menuItemId);
    const qty = Number(it?.qty);
    if (!Number.isInteger(id) || id <= 0) throw bad('Item menu tidak valid');
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) throw bad('Jumlah item harus 1–100');
    const note = typeof it.note === 'string' ? it.note.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120) : '';
    const key = id + '|' + note;
    const m = get.get(id);
    if (!m) throw bad('Ada menu yang sudah tidak tersedia, muat ulang halaman');
    if (!m.available && !allowUnavailable) throw bad(`${m.name} sedang habis`);
    const prev = merged.get(key);
    if (prev) { prev.qty += qty; prev.lineTotal = prev.qty * prev.price; }
    else merged.set(key, { menuItemId: m.id, name: m.name, price: m.price, qty, note: note || null, lineTotal: m.price * qty });
  }
  const lines = [...merged.values()];
  return { lines, subtotal: lines.reduce((s, l) => s + l.lineTotal, 0) };
}

// ---------- Voucher ----------
export function expireVouchers(db) {
  db.prepare("UPDATE vouchers SET status='expired' WHERE status='active' AND expires_at < datetime('now')").run();
}

function voucherRow(db, code) {
  expireVouchers(db);
  return db.prepare('SELECT * FROM vouchers WHERE code = ?').get(String(code || '').trim().toUpperCase());
}

export function voucherDto(r) {
  return { id: r.id, code: r.code, rewardId: r.reward_id, name: r.name, pointsCost: r.points_cost, type: r.type, value: r.value,
    menuItemId: r.menu_item_id, status: r.status, createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at };
}

function checkVoucher(db, code, customerId, lines, subtotal, { orderId = null } = {}) {
  const vch = voucherRow(db, code);
  if (!vch) throw bad('Kode voucher tidak ditemukan');
  if (!customerId || vch.customer_id !== customerId) throw bad('Voucher ini milik member lain');
  const okReserved = vch.status === 'reserved' && orderId && vch.order_id === orderId;
  if (vch.status !== 'active' && !okReserved) throw bad(`Voucher sudah ${vch.status === 'used' ? 'dipakai' : vch.status === 'expired' ? 'kedaluwarsa' : 'tidak berlaku'}`);
  const discount = voucherDiscount({ type: vch.type, value: vch.value, menuItemId: vch.menu_item_id }, lines, subtotal);
  if (discount < 0) throw bad('Tambahkan item gratis voucher ke keranjang terlebih dahulu');
  return { vch, discount };
}

// ---------- Transaksi penjualan ----------
export function createSale(db, { customerId = null, lines, subtotal, payment, voucherCode = null, date = null, staffId = null, source = 'pos', orderId = null, code = null }) {
  const loyalty = getLoyalty(db);
  let discount = 0;
  let vch = null;
  if (voucherCode) ({ vch, discount } = checkVoucher(db, voucherCode, customerId, lines, subtotal, { orderId }));
  const total = Math.max(0, subtotal - discount);
  const saleDate = date || today();

  let points = 0;
  if (customerId) {
    const raw = rawStats(db, customerId).get(customerId) || { totalSpend: 0, tierSpend: 0 };
    const tierBefore = tierFor(raw.tierSpend || 0, loyalty.tiers);
    points = pointsForPurchase(raw.totalSpend || 0, total, loyalty, tierBefore);
  }
  const trxCode = code || nextTrxCode(db);
  const info = db.prepare(`INSERT INTO transactions(code, customer_id, date, subtotal, discount, total, payment, source, order_id, voucher_id, staff_id, points_earned)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(trxCode, customerId, saleDate, subtotal, discount, total, payment || null, source, orderId, vch?.id ?? null, staffId, points);
  const trxId = Number(info.lastInsertRowid);
  const ins = db.prepare('INSERT INTO transaction_items(transaction_id, menu_item_id, name, price, qty, line_total) VALUES (?,?,?,?,?,?)');
  for (const l of lines) ins.run(trxId, l.menuItemId ?? null, l.name, l.price, l.qty, l.lineTotal);
  if (points > 0) addLedger(db, { customerId, delta: points, type: 'earn', refType: 'transaction', refId: trxId, refCode: trxCode, note: `Belanja ${trxCode}`, staffId, at: date ? date + ' 12:00:00' : null });
  if (vch) db.prepare("UPDATE vouchers SET status='used', used_at=datetime('now'), transaction_id=? WHERE id=?").run(trxId, vch.id);
  return getTransaction(db, trxId);
}

export function transactionDto(r, items) {
  return {
    id: r.id, code: r.code, date: r.date, createdAt: r.created_at,
    customer: r.customer_id ? { id: r.customer_id, name: r.customer_name, memberCode: r.member_code } : null,
    items: items.map((i) => ({ menuItemId: i.menu_item_id, name: i.name, price: i.price, qty: i.qty, lineTotal: i.line_total })),
    subtotal: r.subtotal, discount: r.discount, total: r.total, payment: r.payment, source: r.source, status: r.status,
    voidReason: r.void_reason, pointsEarned: r.points_earned, voucherCode: r.voucher_code || null, staffName: r.staff_name || null,
  };
}

const TRX_SELECT = `SELECT t.*, c.name customer_name, c.member_code, s.name staff_name, v.code voucher_code
  FROM transactions t LEFT JOIN customers c ON c.id = t.customer_id LEFT JOIN staff s ON s.id = t.staff_id LEFT JOIN vouchers v ON v.id = t.voucher_id`;

export function getTransaction(db, id) {
  const r = db.prepare(`${TRX_SELECT} WHERE t.id = ?`).get(id);
  if (!r) throw notFound('Transaksi tidak ditemukan');
  return transactionDto(r, db.prepare('SELECT * FROM transaction_items WHERE transaction_id = ? ORDER BY id').all(id));
}

export function listTransactions(db, { customerId = null, from = null, to = null, q = null, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (customerId) { where.push('t.customer_id = ?'); args.push(customerId); }
  if (from) { where.push('t.date >= ?'); args.push(from); }
  if (to) { where.push('t.date <= ?'); args.push(to); }
  if (q) { where.push('(t.code LIKE ? OR c.name LIKE ? OR c.member_code LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(`${TRX_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.date DESC, t.id DESC LIMIT ?`).all(...args, limit);
  if (!rows.length) return [];
  const items = db.prepare(`SELECT * FROM transaction_items WHERE transaction_id IN (${rows.map(() => '?').join(',')}) ORDER BY id`).all(...rows.map((r) => r.id));
  const by = new Map();
  for (const i of items) { if (!by.has(i.transaction_id)) by.set(i.transaction_id, []); by.get(i.transaction_id).push(i); }
  return rows.map((r) => transactionDto(r, by.get(r.id) || []));
}

export function voidTransaction(db, id, reason, staffId) {
  return tx(db, () => {
    const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!t) throw notFound('Transaksi tidak ditemukan');
    if (t.status === 'void') throw conflict('Transaksi sudah dibatalkan');
    db.prepare("UPDATE transactions SET status='void', void_reason=? WHERE id=?").run(reason, id);
    if (t.customer_id && t.points_earned > 0) {
      addLedger(db, { customerId: t.customer_id, delta: -t.points_earned, type: 'void', refType: 'transaction', refId: id, refCode: t.code, note: `Pembatalan ${t.code}: ${reason}`, staffId });
    }
    if (t.voucher_id) db.prepare("UPDATE vouchers SET status = CASE WHEN expires_at < datetime('now') THEN 'expired' ELSE 'active' END, used_at=NULL, transaction_id=NULL WHERE id=?").run(t.voucher_id);
    return getTransaction(db, id);
  });
}

// ---------- Rewards ----------
export function rewardDto(r) {
  return { id: r.id, name: r.name, description: r.description, pointsCost: r.points_cost, minTier: r.min_tier, stock: r.stock,
    type: r.type, value: r.value, menuItemId: r.menu_item_id, validDays: r.valid_days, image: r.image, active: !!r.active, sort: r.sort };
}

export function redeemReward(db, customerId, rewardId) {
  return tx(db, () => {
    const loyalty = getLoyalty(db);
    const reward = db.prepare('SELECT * FROM rewards WHERE id = ? AND active = 1 AND archived = 0').get(rewardId);
    if (!reward) throw notFound('Reward tidak tersedia');
    if (reward.stock !== null && reward.stock <= 0) throw conflict('Stok reward sudah habis');
    const stats = statsFor(db, customerId);
    if (reward.min_tier && tierRank(stats.tier.key, loyalty.tiers) < tierRank(reward.min_tier, loyalty.tiers)) {
      const t = loyalty.tiers.find((x) => x.key === reward.min_tier);
      throw bad(`Reward ini khusus member ${t?.name || reward.min_tier} ke atas`);
    }
    const balance = pointsBalance(db, customerId);
    if (balance < reward.points_cost) throw bad(`Poin belum cukup. Butuh ${reward.points_cost - balance} poin lagi`);
    let code;
    for (let i = 0; i < 5; i++) {
      code = genVoucherCode();
      if (!db.prepare('SELECT 1 FROM vouchers WHERE code = ?').get(code)) break;
    }
    const days = reward.valid_days || loyalty.voucherValidDays || 30;
    const info = db.prepare(`INSERT INTO vouchers(code, customer_id, reward_id, name, points_cost, type, value, menu_item_id, expires_at)
      VALUES (?,?,?,?,?,?,?,?, datetime('now', ?))`).run(code, customerId, reward.id, reward.name, reward.points_cost, reward.type, reward.value, reward.menu_item_id, `+${days} days`);
    const vid = Number(info.lastInsertRowid);
    addLedger(db, { customerId, delta: -reward.points_cost, type: 'redeem', refType: 'voucher', refId: vid, refCode: code, note: `Tukar: ${reward.name}` });
    if (reward.stock !== null) db.prepare('UPDATE rewards SET stock = stock - 1 WHERE id = ?').run(reward.id);
    return voucherDto(db.prepare('SELECT * FROM vouchers WHERE id = ?').get(vid));
  });
}

// ---------- Pesanan online ----------
export const ORDER_FLOW = {
  pending: ['processing', 'cancelled'],
  processing: ['ready', 'cancelled'],
  ready: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function orderDto(db, r) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(r.id);
  const c = db.prepare('SELECT id, name, member_code, phone FROM customers WHERE id = ?').get(r.customer_id);
  const t = r.transaction_id ? db.prepare('SELECT code, points_earned FROM transactions WHERE id = ?').get(r.transaction_id) : null;
  const vch = r.voucher_id ? db.prepare('SELECT code, name FROM vouchers WHERE id = ?').get(r.voucher_id) : null;
  return {
    id: r.id, code: r.code, queueNo: r.queue_no, status: r.status,
    items: items.map((i) => ({ menuItemId: i.menu_item_id, name: i.name, price: i.price, qty: i.qty, note: i.note, lineTotal: i.line_total })),
    subtotal: r.subtotal, discount: r.discount, total: r.total, paymentMethod: r.payment_method, note: r.note,
    voucher: vch ? { code: vch.code, name: vch.name } : null,
    customer: c ? { id: c.id, name: c.name, memberCode: c.member_code, phone: c.phone } : null,
    transactionCode: t?.code || null, pointsEarned: t?.points_earned || 0, cancelReason: r.cancel_reason,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function createOrder(db, customerId, { items, paymentMethod, note, voucherCode }) {
  return tx(db, () => {
    const active = db.prepare("SELECT COUNT(*) n FROM orders WHERE customer_id = ? AND status IN ('pending','processing','ready')").get(customerId).n;
    if (active >= 3) throw bad('Anda masih punya 3 pesanan berjalan. Selesaikan dulu sebelum memesan lagi');
    const { lines, subtotal } = priceLines(db, items);
    let discount = 0;
    let vch = null;
    if (voucherCode) ({ vch, discount } = checkVoucher(db, voucherCode, customerId, lines, subtotal));
    const code = nextOrderCode(db);
    const queue = db.prepare("SELECT COUNT(*) n FROM orders WHERE date(created_at, '+7 hours') = date('now', '+7 hours')").get().n + 1;
    const info = db.prepare('INSERT INTO orders(code, customer_id, queue_no, subtotal, discount, total, payment_method, voucher_id, note) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(code, customerId, queue, subtotal, discount, subtotal - discount, paymentMethod, vch?.id ?? null, note);
    const oid = Number(info.lastInsertRowid);
    const ins = db.prepare('INSERT INTO order_items(order_id, menu_item_id, name, price, qty, note, line_total) VALUES (?,?,?,?,?,?,?)');
    for (const l of lines) ins.run(oid, l.menuItemId, l.name, l.price, l.qty, l.note, l.lineTotal);
    if (vch) db.prepare("UPDATE vouchers SET status='reserved', order_id=? WHERE id=?").run(oid, vch.id);
    return orderDto(db, db.prepare('SELECT * FROM orders WHERE id = ?').get(oid));
  });
}

export function setOrderStatus(db, orderId, next, { payment = null, reason = null, staffId = null, byCustomer = null } = {}) {
  return tx(db, () => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o) throw notFound('Pesanan tidak ditemukan');
    if (byCustomer && o.customer_id !== byCustomer) throw notFound('Pesanan tidak ditemukan');
    if (byCustomer && !(o.status === 'pending' && next === 'cancelled')) throw bad('Pesanan yang sudah diproses tidak bisa dibatalkan dari aplikasi. Hubungi kasir.');
    if (!ORDER_FLOW[o.status].includes(next)) throw conflict(`Status tidak bisa diubah dari ${o.status} ke ${next}`);
    let trxId = null;
    if (next === 'completed') {
      const lines = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId)
        .map((i) => ({ menuItemId: i.menu_item_id, name: i.name, price: i.price, qty: i.qty, lineTotal: i.line_total }));
      const vcode = o.voucher_id ? db.prepare('SELECT code FROM vouchers WHERE id = ?').get(o.voucher_id)?.code : null;
      const sale = createSale(db, { customerId: o.customer_id, lines, subtotal: o.subtotal, payment: payment || o.payment_method, voucherCode: vcode, staffId, source: 'order', orderId });
      trxId = sale.id;
    }
    if (next === 'cancelled' && o.voucher_id) {
      db.prepare("UPDATE vouchers SET status = CASE WHEN expires_at < datetime('now') THEN 'expired' ELSE 'active' END, order_id=NULL WHERE id=? AND status='reserved'").run(o.voucher_id);
    }
    db.prepare("UPDATE orders SET status=?, transaction_id=COALESCE(?, transaction_id), cancel_reason=COALESCE(?, cancel_reason), payment_method=COALESCE(?, payment_method), updated_at=datetime('now') WHERE id=?")
      .run(next, trxId, next === 'cancelled' ? (reason || (byCustomer ? 'Dibatalkan customer' : 'Dibatalkan kasir')) : null, payment, orderId);
    return orderDto(db, db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
  });
}

// ---------- Dashboard ----------
export function dashboard(db) {
  const loyalty = getLoyalty(db);
  const t = today();
  const monthStart = t.slice(0, 8) + '01';
  const customers = listCustomers(db);
  const sum = (from, to = t) => db.prepare("SELECT COALESCE(SUM(total),0) s, COUNT(*) n FROM transactions WHERE status='paid' AND date BETWEEN ? AND ?").get(from, to);
  const todayAgg = sum(t);
  const monthAgg = sum(monthStart);
  const allAgg = db.prepare("SELECT COALESCE(SUM(total),0) s, COUNT(*) n FROM transactions WHERE status='paid'").get();
  const daily = [];
  const dailyRows = new Map(db.prepare("SELECT date, SUM(total) s, COUNT(*) n FROM transactions WHERE status='paid' AND date >= ? GROUP BY date").all(shiftDate(t, -13)).map((r) => [r.date, r]));
  for (let i = 13; i >= 0; i--) {
    const d = shiftDate(t, -i);
    const r = dailyRows.get(d);
    daily.push({ date: d, total: r?.s || 0, count: r?.n || 0 });
  }
  const tiers = [...loyalty.tiers].sort((a, b) => a.minSpend - b.minSpend).map((tr) => ({ key: tr.key, name: tr.name, color: tr.color, count: customers.filter((c) => c.stats.tier.key === tr.key).length }));
  const status = ['aktif', 'tidak_aktif', 'belum_beli'].map((s) => ({ key: s, count: customers.filter((c) => c.stats.status === s).length }));
  const topMenu = db.prepare(`SELECT ti.name, SUM(ti.qty) qty, SUM(ti.line_total) revenue FROM transaction_items ti JOIN transactions tr ON tr.id = ti.transaction_id
    WHERE tr.status='paid' GROUP BY ti.name ORDER BY qty DESC LIMIT 6`).all();
  const topCustomers = [...customers].sort((a, b) => b.stats.totalSpend - a.stats.totalSpend).slice(0, 5)
    .map((c) => ({ id: c.id, name: c.name, memberCode: c.memberCode, totalSpend: c.stats.totalSpend, tier: c.stats.tier, points: c.stats.points }));
  const pointsOutstanding = db.prepare('SELECT COALESCE(SUM(delta),0) s FROM points_ledger').get().s;
  const pendingOrders = db.prepare("SELECT COUNT(*) n FROM orders WHERE status IN ('pending','processing','ready')").get().n;
  const newMembers = customers.filter((c) => c.joinedAt && daysBetween(c.joinedAt, t) <= 30).length;
  return {
    today: t,
    kpis: {
      members: customers.length,
      activeMembers: status[0].count,
      newMembers30: newMembers,
      revenueToday: todayAgg.s, trxToday: todayAgg.n,
      revenueMonth: monthAgg.s, trxMonth: monthAgg.n,
      revenueAll: allAgg.s, trxAll: allAgg.n,
      avgTicket: allAgg.n ? Math.round(allAgg.s / allAgg.n) : 0,
      pointsOutstanding, pendingOrders,
    },
    tiers, status, daily, topMenu, topCustomers,
    recent: listTransactions(db, { limit: 6 }),
  };
}
