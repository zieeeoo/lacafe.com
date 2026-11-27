<?php
// Koneksi database (SQLite atau MySQL lewat PDO), skema, dan pengaturan default.
declare(strict_types=1);

final class DB
{
    public PDO $pdo;
    public string $driver;
    private int $depth = 0;

    public function __construct(array $cfg)
    {
        $this->driver = $cfg['driver'];
        if ($this->driver === 'sqlite') {
            $this->pdo = new PDO('sqlite:' . $cfg['path'], null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
            $this->pdo->exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 8000;');
        } else {
            $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $cfg['host'], (int)($cfg['port'] ?? 3306), $cfg['name']);
            $this->pdo = new PDO($dsn, $cfg['user'], $cfg['pass'], [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false,
            ]);
            $this->pdo->exec("SET time_zone = '+00:00', sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'");
        }
    }

    public function q(string $sql, array $args = []): PDOStatement
    {
        $st = $this->pdo->prepare($sql);
        $st->execute(array_values($args));
        return $st;
    }
    public function all(string $sql, array $args = []): array { return $this->q($sql, $args)->fetchAll(); }
    public function one(string $sql, array $args = []): ?array { $r = $this->q($sql, $args)->fetch(); return $r === false ? null : $r; }
    public function val(string $sql, array $args = []): mixed { $r = $this->q($sql, $args)->fetchColumn(); return $r === false ? null : $r; }
    public function run(string $sql, array $args = []): int { return $this->q($sql, $args)->rowCount(); }
    public function insert(string $sql, array $args = []): int { $this->q($sql, $args); return (int)$this->pdo->lastInsertId(); }

    /** Transaksi atomik. SQLite: BEGIN IMMEDIATE (menulis berurutan). MySQL: InnoDB + kunci baris lewat lock(). */
    public function tx(callable $fn): mixed
    {
        if ($this->depth > 0) { $this->depth++; try { return $fn(); } finally { $this->depth--; } }
        if ($this->driver === 'sqlite') $this->pdo->exec('BEGIN IMMEDIATE'); else $this->pdo->beginTransaction();
        $this->depth = 1;
        try {
            $r = $fn();
            if ($this->driver === 'sqlite') $this->pdo->exec('COMMIT'); else $this->pdo->commit();
            return $r;
        } catch (Throwable $e) {
            try { if ($this->driver === 'sqlite') $this->pdo->exec('ROLLBACK'); else $this->pdo->rollBack(); } catch (Throwable) {}
            throw $e;
        } finally {
            $this->depth = 0;
        }
    }

    /** Kunci baris customer selama transaksi (MySQL). Di SQLite, BEGIN IMMEDIATE sudah mengunci penulisan. */
    public function lockCustomer(int $id): void
    {
        if ($this->driver === 'mysql') $this->q('SELECT id FROM customers WHERE id = ? FOR UPDATE', [$id]);
    }
}

function now_sql(int $offsetSec = 0): string { return gmdate('Y-m-d H:i:s', time() + $offsetSec); }

function schema_statements(string $driver): array
{
    $my = $driver === 'mysql';
    $PK = $my ? 'INT AUTO_INCREMENT PRIMARY KEY' : 'INTEGER PRIMARY KEY';
    $E = $my ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' : '';
    $IF = $my ? '' : 'IF NOT EXISTS ';
    $T = 'VARCHAR(19)'; // waktu UTC 'YYYY-MM-DD HH:MM:SS'
    $s = [];
    $s[] = "CREATE TABLE IF NOT EXISTS meta (name VARCHAR(50) PRIMARY KEY, value VARCHAR(255))$E";
    $s[] = "CREATE TABLE IF NOT EXISTS staff (id $PK, username VARCHAR(40) NOT NULL UNIQUE, name VARCHAR(80) NOT NULL,
        role VARCHAR(10) NOT NULL CHECK (role IN ('admin','kasir')), password_hash VARCHAR(255) NOT NULL, active TINYINT NOT NULL DEFAULT 1,
        must_change_password TINYINT NOT NULL DEFAULT 0, failed_logins INT NOT NULL DEFAULT 0, locked_until $T NULL, last_login_at $T NULL, created_at $T NOT NULL)$E";
    $s[] = "CREATE TABLE IF NOT EXISTS customers (id $PK, member_code VARCHAR(20) NOT NULL UNIQUE, name VARCHAR(80) NOT NULL, phone VARCHAR(20) NULL UNIQUE,
        gender VARCHAR(30) NULL, source VARCHAR(40) NULL, birthday VARCHAR(10) NULL, favorite_note VARCHAR(200) NULL, note TEXT NULL, joined_at VARCHAR(10) NOT NULL,
        password_hash VARCHAR(255) NULL, activation_hash VARCHAR(64) NULL, activation_expires $T NULL, failed_logins INT NOT NULL DEFAULT 0, locked_until $T NULL,
        active TINYINT NOT NULL DEFAULT 1, last_login_at $T NULL, created_at $T NOT NULL)$E";
    $s[] = "CREATE TABLE IF NOT EXISTS sessions (id VARCHAR(64) PRIMARY KEY, kind VARCHAR(10) NOT NULL, subject_id INT NOT NULL, csrf VARCHAR(64) NOT NULL,
        ip VARCHAR(64) NULL, ua VARCHAR(200) NULL, created_at $T NOT NULL, expires_at $T NOT NULL)$E";
    $s[] = "CREATE INDEX {$IF}idx_sessions_subject ON sessions(kind, subject_id)";
    $s[] = "CREATE TABLE IF NOT EXISTS rate_hits (k VARCHAR(120) NOT NULL, ts INT NOT NULL)$E";
    $s[] = "CREATE INDEX {$IF}idx_rate ON rate_hits(k, ts)";
    $s[] = "CREATE TABLE IF NOT EXISTS categories (id $PK, cat_key VARCHAR(40) NOT NULL UNIQUE, name VARCHAR(40) NOT NULL, sort INT NOT NULL DEFAULT 0, active TINYINT NOT NULL DEFAULT 1)$E";
    $s[] = "CREATE TABLE IF NOT EXISTS menu_items (id $PK, code VARCHAR(80) NOT NULL UNIQUE, name VARCHAR(80) NOT NULL, category_id INT NULL, price INT NOT NULL CHECK (price >= 0),
        description VARCHAR(255) NULL, image VARCHAR(120) NULL, temp VARCHAR(10) NULL, featured TINYINT NOT NULL DEFAULT 0, available TINYINT NOT NULL DEFAULT 1,
        archived TINYINT NOT NULL DEFAULT 0, sort INT NOT NULL DEFAULT 0, created_at $T NOT NULL, updated_at $T NOT NULL)$E";
    $s[] = "CREATE TABLE IF NOT EXISTS transactions (id $PK, code VARCHAR(20) NOT NULL UNIQUE, customer_id INT NULL, date VARCHAR(10) NOT NULL, subtotal INT NOT NULL,
        discount INT NOT NULL DEFAULT 0, total INT NOT NULL CHECK (total >= 0), payment VARCHAR(40) NULL, source VARCHAR(10) NOT NULL DEFAULT 'pos',
        order_id INT NULL, voucher_id INT NULL, staff_id INT NULL, status VARCHAR(10) NOT NULL DEFAULT 'paid', void_reason VARCHAR(255) NULL,
        points_earned INT NOT NULL DEFAULT 0, created_at $T NOT NULL)$E";
    $s[] = "CREATE INDEX {$IF}idx_trx_customer ON transactions(customer_id, status, date)";
    $s[] = "CREATE INDEX {$IF}idx_trx_date ON transactions(date)";
    $s[] = "CREATE TABLE IF NOT EXISTS transaction_items (id $PK, transaction_id INT NOT NULL, menu_item_id INT NULL, name VARCHAR(80) NOT NULL, price INT NOT NULL,
        qty INT NOT NULL CHECK (qty > 0), line_total INT NOT NULL)$E";
    $s[] = "CREATE INDEX {$IF}idx_trx_items ON transaction_items(transaction_id)";
    $s[] = "CREATE TABLE IF NOT EXISTS points_ledger (id $PK, customer_id INT NOT NULL, delta INT NOT NULL, balance_after INT NOT NULL,
        type VARCHAR(10) NOT NULL CHECK (type IN ('earn','redeem','adjust','void','refund')), ref_type VARCHAR(20) NULL, ref_id INT NULL, ref_code VARCHAR(30) NULL,
        note VARCHAR(255) NULL, staff_id INT NULL, created_at $T NOT NULL)$E";
    $s[] = "CREATE INDEX {$IF}idx_ledger_customer ON points_ledger(customer_id, id)";
    $s[] = "CREATE TABLE IF NOT EXISTS rewards (id $PK, name VARCHAR(80) NOT NULL, description VARCHAR(255) NULL, points_cost INT NOT NULL CHECK (points_cost > 0),
        min_tier VARCHAR(30) NULL, stock INT NULL, type VARCHAR(20) NOT NULL, value INT NOT NULL DEFAULT 0, menu_item_id INT NULL, valid_days INT NOT NULL DEFAULT 30,
        image VARCHAR(120) NULL, active TINYINT NOT NULL DEFAULT 1, archived TINYINT NOT NULL DEFAULT 0, sort INT NOT NULL DEFAULT 0, created_at $T NOT NULL)$E";
    $s[] = "CREATE TABLE IF NOT EXISTS vouchers (id $PK, code VARCHAR(20) NOT NULL UNIQUE, customer_id INT NOT NULL, reward_id INT NULL, name VARCHAR(80) NOT NULL,
        points_cost INT NOT NULL, type VARCHAR(20) NOT NULL, value INT NOT NULL, menu_item_id INT NULL, status VARCHAR(10) NOT NULL DEFAULT 'active',
        order_id INT NULL, transaction_id INT NULL, created_at $T NOT NULL, expires_at $T NOT NULL, used_at $T NULL)$E";
    $s[] = "CREATE INDEX {$IF}idx_vouchers_customer ON vouchers(customer_id, status)";
    $s[] = "CREATE TABLE IF NOT EXISTS orders (id $PK, code VARCHAR(20) NOT NULL UNIQUE, customer_id INT NOT NULL, status VARCHAR(12) NOT NULL DEFAULT 'pending',
        queue_no INT NULL, subtotal INT NOT NULL, discount INT NOT NULL DEFAULT 0, total INT NOT NULL, payment_method VARCHAR(40) NULL, voucher_id INT NULL,
        note VARCHAR(255) NULL, transaction_id INT NULL, cancel_reason VARCHAR(255) NULL, created_at $T NOT NULL, updated_at $T NOT NULL)$E";
    $s[] = "CREATE INDEX {$IF}idx_orders_status ON orders(status, created_at)";
    $s[] = "CREATE INDEX {$IF}idx_orders_customer ON orders(customer_id, created_at)";
    $s[] = "CREATE TABLE IF NOT EXISTS order_items (id $PK, order_id INT NOT NULL, menu_item_id INT NULL, name VARCHAR(80) NOT NULL, price INT NOT NULL,
        qty INT NOT NULL CHECK (qty > 0), note VARCHAR(200) NULL, line_total INT NOT NULL)$E";
    $s[] = "CREATE INDEX {$IF}idx_order_items ON order_items(order_id)";
    $s[] = "CREATE TABLE IF NOT EXISTS settings (name VARCHAR(50) PRIMARY KEY, value TEXT NOT NULL, updated_at $T NOT NULL)$E";
    $s[] = "CREATE TABLE IF NOT EXISTS audit_log (id $PK, actor_kind VARCHAR(10) NULL, actor_id INT NULL, actor_name VARCHAR(80) NULL, action VARCHAR(40) NOT NULL,
        target VARCHAR(120) NULL, detail TEXT NULL, ip VARCHAR(64) NULL, created_at $T NOT NULL)$E";
    $s[] = "CREATE INDEX {$IF}idx_audit_created ON audit_log(created_at)";
    return $s;
}

/** Trigger agar buku besar poin tidak bisa diubah/dihapus. Best-effort di MySQL (butuh hak TRIGGER). */
function ledger_triggers(string $driver): array
{
    if ($driver === 'sqlite') return [
        "CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON points_ledger BEGIN SELECT RAISE(ABORT, 'points_ledger bersifat append-only'); END",
        "CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON points_ledger BEGIN SELECT RAISE(ABORT, 'points_ledger bersifat append-only'); END",
    ];
    return [
        "CREATE TRIGGER ledger_no_update BEFORE UPDATE ON points_ledger FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'points_ledger bersifat append-only'",
        "CREATE TRIGGER ledger_no_delete BEFORE DELETE ON points_ledger FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'points_ledger bersifat append-only'",
    ];
}

const DEFAULT_CATEGORIES = [['kopi', 'Kopi', 1], ['non-kopi', 'Non-kopi', 2], ['teh', 'Teh & segar', 3], ['makanan', 'Makanan', 4]];

function default_appearance(): array
{
    return [
        'brandName' => 'LaCafe', 'tagline' => 'Kopi tetangga, poin setiap cangkir', 'logoText' => 'LC', 'logoImage' => null, 'theme' => 'indigo',
        'colors' => ['primary' => '#1E2A5A', 'accent' => '#E0A43A', 'bg' => '#F4F5F9', 'surface' => '#FFFFFF', 'text' => '#161A2B'],
        'radius' => 'soft', 'font' => 'jakarta', 'menuLayout' => 'list',
        'homeSections' => array_map(fn($k) => ['key' => $k, 'visible' => true], ['member', 'actions', 'banners', 'featured', 'categories', 'rewards']),
        'banners' => [
            ['id' => 'b1', 'title' => 'Kopi Susu Malaka', 'subtitle' => 'Gula aren asli, favorit pelanggan kami', 'color' => '#1E2A5A', 'image' => null, 'active' => true],
            ['id' => 'b2', 'title' => 'Poin dobel setiap Jumat', 'subtitle' => 'Atur promo ini dari menu Tampilan', 'color' => '#8A4B1F', 'image' => null, 'active' => true],
        ],
        'orderingEnabled' => true, 'pickupNote' => 'Ambil pesanan di kasir LaCafe', 'announcement' => '',
    ];
}

function default_options(): array
{
    return [
        'genders' => ['Laki-laki', 'Perempuan'],
        'sources' => ['Walk in', 'Instagram', 'TikTok', 'Teman/keluarga', 'Google', 'Lainnya'],
        'payments' => ['Cash', 'BCA QR', 'QRIS', 'Union Pay', 'Debit'],
    ];
}

function get_setting(DB $db, string $name, array $fallback): array
{
    $v = $db->val('SELECT value FROM settings WHERE name = ?', [$name]);
    if ($v === null) return $fallback;
    $parsed = json_decode((string)$v, true);
    return is_array($parsed) ? array_replace($fallback, $parsed) : $fallback;
}

function set_setting(DB $db, string $name, array $value): void
{
    $json = json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($db->run('UPDATE settings SET value = ?, updated_at = ? WHERE name = ?', [$json, now_sql(), $name]) === 0
        && $db->val('SELECT 1 FROM settings WHERE name = ?', [$name]) === null) {
        $db->run('INSERT INTO settings(name, value, updated_at) VALUES (?,?,?)', [$name, $json, now_sql()]);
    }
}

function get_loyalty(DB $db): array { return get_setting($db, 'loyalty', DEFAULT_LOYALTY); }
function get_appearance(DB $db): array { return get_setting($db, 'appearance', default_appearance()); }
function get_options(DB $db): array { return get_setting($db, 'options', default_options()); }
