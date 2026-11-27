import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LOYALTY } from '../public/assets/js/loyalty.js';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','kasir')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  member_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  gender TEXT,
  source TEXT,
  birthday TEXT,
  favorite_note TEXT,
  note TEXT,
  joined_at TEXT NOT NULL,
  password_hash TEXT,
  activation_hash TEXT,
  activation_expires TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,               -- sha256(token); token asli hanya ada di cookie
  kind TEXT NOT NULL CHECK (kind IN ('staff','customer')),
  subject_id INTEGER NOT NULL,
  csrf TEXT NOT NULL,
  ip TEXT, ua TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_subject ON sessions(kind, subject_id);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  price INTEGER NOT NULL CHECK (price >= 0),
  description TEXT,
  image TEXT,
  temp TEXT,
  featured INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  customer_id INTEGER REFERENCES customers(id),
  date TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL CHECK (total >= 0),
  payment TEXT,
  source TEXT NOT NULL DEFAULT 'pos' CHECK (source IN ('pos','order','import')),
  order_id INTEGER,
  voucher_id INTEGER,
  staff_id INTEGER,
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','void')),
  void_reason TEXT,
  points_earned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trx_customer ON transactions(customer_id, status, date);
CREATE INDEX IF NOT EXISTS idx_trx_date ON transactions(date);

CREATE TABLE IF NOT EXISTS transaction_items (
  id INTEGER PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  menu_item_id INTEGER,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  line_total INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trx_items ON transaction_items(transaction_id);

-- Buku besar poin: SATU-SATUNYA sumber saldo poin. Tidak pernah di-UPDATE/DELETE.
CREATE TABLE IF NOT EXISTS points_ledger (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('earn','redeem','adjust','void','refund')),
  ref_type TEXT, ref_id INTEGER, ref_code TEXT,
  note TEXT,
  staff_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_customer ON points_ledger(customer_id, id);
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON points_ledger
BEGIN SELECT RAISE(ABORT, 'points_ledger bersifat append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON points_ledger
BEGIN SELECT RAISE(ABORT, 'points_ledger bersifat append-only'); END;

CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  points_cost INTEGER NOT NULL CHECK (points_cost > 0),
  min_tier TEXT,
  stock INTEGER,
  type TEXT NOT NULL CHECK (type IN ('free_item','discount_amount','discount_percent')),
  value INTEGER NOT NULL DEFAULT 0,
  menu_item_id INTEGER,
  valid_days INTEGER NOT NULL DEFAULT 30,
  image TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  reward_id INTEGER REFERENCES rewards(id),
  name TEXT NOT NULL,
  points_cost INTEGER NOT NULL,
  type TEXT NOT NULL,
  value INTEGER NOT NULL,
  menu_item_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','reserved','used','expired','cancelled')),
  order_id INTEGER,
  transaction_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_vouchers_customer ON vouchers(customer_id, status);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','ready','completed','cancelled')),
  queue_no INTEGER,
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  payment_method TEXT,
  voucher_id INTEGER,
  note TEXT,
  transaction_id INTEGER,
  cancel_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id, created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  note TEXT,
  line_total INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  actor_kind TEXT, actor_id INTEGER, actor_name TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`;

export const DEFAULT_CATEGORIES = [
  { key: 'kopi', name: 'Kopi', sort: 1 },
  { key: 'non-kopi', name: 'Non-kopi', sort: 2 },
  { key: 'teh', name: 'Teh & segar', sort: 3 },
  { key: 'makanan', name: 'Makanan', sort: 4 },
];

export const DEFAULT_APPEARANCE = {
  brandName: 'LaCafe',
  tagline: 'Kopi tetangga, poin setiap cangkir',
  logoText: 'LC',
  logoImage: null,
  theme: 'indigo',
  colors: { primary: '#1E2A5A', accent: '#E0A43A', bg: '#F4F5F9', surface: '#FFFFFF', text: '#161A2B' },
  radius: 'soft',
  font: 'jakarta',
  menuLayout: 'list',
  homeSections: [
    { key: 'member', visible: true },
    { key: 'actions', visible: true },
    { key: 'banners', visible: true },
    { key: 'featured', visible: true },
    { key: 'categories', visible: true },
    { key: 'rewards', visible: true },
  ],
  banners: [
    { id: 'b1', title: 'Kopi Susu Malaka', subtitle: 'Gula aren asli, favorit pelanggan kami', color: '#1E2A5A', image: null, active: true },
    { id: 'b2', title: 'Poin dobel setiap Jumat', subtitle: 'Atur promo ini dari menu Tampilan', color: '#8A4B1F', image: null, active: true },
  ],
  orderingEnabled: true,
  pickupNote: 'Ambil pesanan di kasir LaCafe',
  announcement: '',
};

export const DEFAULT_OPTIONS = {
  genders: ['Laki-laki', 'Perempuan'],
  sources: ['Walk in', 'Instagram', 'TikTok', 'Teman/keluarga', 'Google', 'Lainnya'],
  payments: ['Cash', 'BCA QR', 'QRIS', 'Union Pay', 'Debit'],
};

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
  return db;
}

// Transaksi atomik: semua query di dalam fn berhasil semua atau dibatalkan semua.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return structuredClone(fallback);
  try { return { ...structuredClone(fallback), ...JSON.parse(row.value) }; } catch { return structuredClone(fallback); }
}

export function setSetting(db, key, value) {
  db.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .run(key, JSON.stringify(value));
}

export const getLoyalty = (db) => getSetting(db, 'loyalty', DEFAULT_LOYALTY);
export const getAppearance = (db) => getSetting(db, 'appearance', DEFAULT_APPEARANCE);
export const getOptions = (db) => getSetting(db, 'options', DEFAULT_OPTIONS);
