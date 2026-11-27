// Mengisi database pertama kali dari data/seed.json (hasil tools/import_excel.py).
import fs from 'node:fs';
import { tx, setSetting, DEFAULT_CATEGORIES, DEFAULT_APPEARANCE, DEFAULT_OPTIONS } from './db.js';
import { DEFAULT_LOYALTY } from '../public/assets/js/loyalty.js';
import { hashPassword, randomToken } from './security.js';
import { createSale, audit } from './services.js';

const ACRONYM = new Set(['BCA', 'QR', 'QRIS', 'BNI', 'BRI', 'OVO', 'ATM']);
function nice(s, titleAll = false) {
  if (!s) return s;
  const words = String(s).trim().split(/\s+/);
  return words.map((w, i) => (ACRONYM.has(w.toUpperCase()) ? w.toUpperCase()
    : i === 0 || titleAll ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
      : w.toLowerCase())).join(' ').replace(/\/(\w)/g, (m, c) => '/' + c.toLowerCase());
}
const GENDER = { male: 'Laki-laki', female: 'Perempuan', 'laki-laki': 'Laki-laki', perempuan: 'Perempuan' };

export function isEmpty(db) {
  return !db.prepare('SELECT 1 FROM staff LIMIT 1').get();
}

export function seed(db, seedFile, log = console.log) {
  const data = fs.existsSync(seedFile) ? JSON.parse(fs.readFileSync(seedFile, 'utf8')) : { menu: [], customers: [], transactions: [] };
  let adminPassword = process.env.ADMIN_PASSWORD;
  const generated = !adminPassword;
  if (generated) adminPassword = randomToken(9).replace(/[-_]/g, 'x') + '7a';

  tx(db, () => {
    // Pengaturan
    const loyalty = structuredClone(DEFAULT_LOYALTY);
    if (data.settings) {
      loyalty.rupiahPerPoint = data.settings.rupiahPerPoint || loyalty.rupiahPerPoint;
      loyalty.inactiveDays = data.settings.inactiveDays || loyalty.inactiveDays;
      for (const t of data.settings.tiers || []) {
        const cur = loyalty.tiers.find((x) => x.key === t.key);
        if (cur) cur.minSpend = t.minSpend;
      }
    }
    loyalty.memberPrefix = 'LC';
    loyalty.trxPrefix = 'TL';
    setSetting(db, 'loyalty', loyalty);
    setSetting(db, 'appearance', DEFAULT_APPEARANCE);
    const opts = structuredClone(DEFAULT_OPTIONS);
    if (data.options?.payments?.length) opts.payments = [...new Set([...data.options.payments.map((x) => nice(x, true)), 'QRIS'])];
    if (data.options?.sources?.length) opts.sources = data.options.sources.map(nice);
    setSetting(db, 'options', opts);

    // Kategori & menu
    const catId = {};
    for (const c of DEFAULT_CATEGORIES) {
      catId[c.key] = Number(db.prepare('INSERT INTO categories(key,name,sort) VALUES (?,?,?)').run(c.key, c.name, c.sort).lastInsertRowid);
    }
    const menuByCode = {};
    const featured = new Set(['KOPI SUSU MALAKA', 'BUTTERSCOTCH LATTE COLD', 'V60', 'YUZU COFFEE', 'CROISSANT']);
    data.menu.forEach((m, i) => {
      const id = Number(db.prepare('INSERT INTO menu_items(code,name,category_id,price,temp,featured,sort) VALUES (?,?,?,?,?,?,?)')
        .run(m.code, m.name, catId[m.category] || catId.kopi, m.price, m.temp, featured.has(m.code) ? 1 : 0, i + 1).lastInsertRowid);
      menuByCode[m.code] = { id, ...m };
    });

    // Rewards contoh (bisa diubah di Admin > Rewards)
    const R = db.prepare('INSERT INTO rewards(name,description,points_cost,min_tier,type,value,menu_item_id,valid_days,sort) VALUES (?,?,?,?,?,?,?,?,?)');
    R.run('Potongan Rp10.000', 'Berlaku untuk semua menu', 20, null, 'discount_amount', 10000, null, 30, 1);
    if (menuByCode['KOPI SUSU MALAKA']) R.run('Gratis Kopi Susu Malaka', 'Satu cup Kopi Susu Malaka', 30, null, 'free_item', 0, menuByCode['KOPI SUSU MALAKA'].id, 30, 2);
    if (menuByCode.CROISSANT) R.run('Gratis Croissant', 'Teman ngopi paling pas', 25, null, 'free_item', 0, menuByCode.CROISSANT.id, 30, 3);
    R.run('Diskon 25%', 'Khusus member Silver ke atas', 40, 'silver', 'discount_percent', 25, null, 14, 4);
    if (menuByCode['MIX PLATTER']) R.run('Gratis Mix Platter', 'Khusus member Gold', 60, 'gold', 'free_item', 0, menuByCode['MIX PLATTER'].id, 30, 5);

    // Customer dari Excel
    const custId = {};
    for (const c of data.customers) {
      custId[c.memberCode] = Number(db.prepare(`INSERT INTO customers(member_code,name,phone,gender,source,favorite_note,note,joined_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(c.memberCode, c.name, c.phone || null, GENDER[String(c.gender || '').toLowerCase()] || null,
        nice(c.source) || null, c.favoriteNote || null, c.note || null, c.joinedAt || new Date().toISOString().slice(0, 10)).lastInsertRowid);
    }

    // Transaksi dari Excel (urut tanggal → poin dihitung persis seperti rumus Excel)
    const sorted = [...data.transactions].sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.code.localeCompare(b.code));
    for (const t of sorted) {
      const cid = custId[t.memberCode];
      if (!cid) { log(`! Transaksi ${t.code} dilewati: customer ${t.memberCode} tidak ada`); continue; }
      const qtyAll = t.items.reduce((s, i) => s + i.qty, 0) || 1;
      const lines = t.items.map((i) => {
        const m = menuByCode[i.code];
        const price = t.items.length === 1 ? Math.round(t.total / qtyAll) : (m?.price || 0);
        return { menuItemId: m?.id ?? null, name: m?.name || i.code, price, qty: i.qty, lineTotal: price * i.qty };
      });
      const subtotal = t.total;
      createSale(db, { customerId: cid, lines, subtotal, payment: nice(t.payment, true), date: t.date, source: 'import', code: t.code });
    }

    db.prepare('INSERT INTO staff(username,name,role,password_hash,must_change_password) VALUES (?,?,?,?,?)')
      .run('admin', 'Pemilik', 'admin', hashPassword(adminPassword), generated ? 1 : 0);
    audit(db, null, 'seed', data.source || 'seed.json', { customers: data.customers.length, transactions: data.transactions.length, menu: data.menu.length });
  });

  log(`✓ Database dibuat: ${data.customers.length} customer, ${data.transactions.length} transaksi, ${data.menu.length} menu`);
  if (generated) {
    log('\n┌──────────────────────────────────────────────┐');
    log('│  AKUN ADMIN AWAL (catat sekarang, tampil 1x)  │');
    log(`│  Username : admin                             │`);
    log(`│  Password : ${adminPassword.padEnd(34)}│`);
    log('│  Anda akan diminta mengganti password.        │');
    log('└──────────────────────────────────────────────┘\n');
  }
}
