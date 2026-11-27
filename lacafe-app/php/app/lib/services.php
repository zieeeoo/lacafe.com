<?php
// Logika bisnis (padanan src/services.js). Harga & poin SELALU dihitung di sini, bukan di browser.
declare(strict_types=1);

function app_today(): string { return today_in($GLOBALS['LACAFE_TZ'] ?? 'Asia/Jakarta'); }
function i(mixed $x): int { return (int)$x; }
function in_marks(array $a): string { return implode(',', array_fill(0, count($a), '?')); }

function next_seq(DB $db, string $table, string $column, string $prefix, int $width = 3): string
{
    $max = 0;
    foreach ($db->q("SELECT $column FROM $table WHERE $column LIKE ?", [$prefix . '%'])->fetchAll(PDO::FETCH_COLUMN) as $c) {
        $rest = substr((string)$c, strlen($prefix));
        if (ctype_digit($rest)) $max = max($max, (int)$rest);
    }
    return $prefix . str_pad((string)($max + 1), $width, '0', STR_PAD_LEFT);
}
function next_member_code(DB $db): string { return next_seq($db, 'customers', 'member_code', get_loyalty($db)['memberPrefix'] ?? 'LC'); }
function next_trx_code(DB $db): string { return next_seq($db, 'transactions', 'code', get_loyalty($db)['trxPrefix'] ?? 'TL'); }
function next_order_code(DB $db): string { return next_seq($db, 'orders', 'code', 'OR', 4); }

function audit(DB $db, ?array $actor, string $action, ?string $target = null, ?array $detail = null, ?string $ip = null): void
{
    $db->run('INSERT INTO audit_log(actor_kind, actor_id, actor_name, action, target, detail, ip, created_at) VALUES (?,?,?,?,?,?,?,?)', [
        $actor['kind'] ?? 'system', $actor['id'] ?? null, $actor['name'] ?? 'Sistem', $action, $target,
        $detail === null ? null : json_encode($detail, JSON_UNESCAPED_UNICODE), $ip, now_sql(),
    ]);
}

// ---------------- Statistik member ----------------
function raw_stats(DB $db, ?int $customerId = null): array
{
    $loyalty = get_loyalty($db);
    $since = ($loyalty['tierBasis'] ?? 'lifetime') === 'rolling365' ? shift_date(app_today(), -365) : '0000-00-00';
    $w = $customerId ? 'AND customer_id = ?' : '';
    $a = $customerId ? [$customerId] : [];
    $map = [];
    $blank = ['totalSpend' => 0, 'tierSpend' => 0, 'visits' => 0, 'lastVisit' => null, 'firstVisit' => null, 'points' => 0, 'favoriteMenu' => null];
    foreach ($db->all("SELECT customer_id id, SUM(total) spend, SUM(CASE WHEN date >= ? THEN total ELSE 0 END) tspend, COUNT(DISTINCT date) visits, MAX(date) last_d, MIN(date) first_d
        FROM transactions WHERE status = 'paid' AND customer_id IS NOT NULL $w GROUP BY customer_id", array_merge([$since], $a)) as $r) {
        $map[i($r['id'])] = array_merge($blank, ['totalSpend' => i($r['spend']), 'tierSpend' => i($r['tspend']), 'visits' => i($r['visits']), 'lastVisit' => $r['last_d'], 'firstVisit' => $r['first_d']]);
    }
    foreach ($db->all("SELECT customer_id id, SUM(delta) pts FROM points_ledger WHERE 1=1 $w GROUP BY customer_id", $a) as $r) {
        $map[i($r['id'])] ??= $blank;
        $map[i($r['id'])]['points'] = i($r['pts']);
    }
    $fav = [];
    foreach ($db->all("SELECT t.customer_id id, ti.name, SUM(ti.qty) q FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
        WHERE t.status = 'paid' AND t.customer_id IS NOT NULL " . ($customerId ? 'AND t.customer_id = ?' : '') . ' GROUP BY t.customer_id, ti.name', $a) as $r) {
        $id = i($r['id']);
        if (!isset($fav[$id]) || i($r['q']) > $fav[$id][1]) $fav[$id] = [$r['name'], i($r['q'])];
    }
    foreach ($fav as $id => [$name]) { $map[$id] ??= $blank; $map[$id]['favoriteMenu'] = $name; }
    return $map;
}

function stats_for(DB $db, int $customerId): array
{
    return build_stats(raw_stats($db, $customerId)[$customerId] ?? [], get_loyalty($db), app_today());
}

function points_balance(DB $db, int $customerId): int
{
    return i($db->val('SELECT COALESCE(SUM(delta), 0) FROM points_ledger WHERE customer_id = ?', [$customerId]));
}

function customer_dto(array $r, array $stats, bool $private = true): array
{
    $d = [
        'id' => i($r['id']), 'memberCode' => $r['member_code'], 'name' => $r['name'], 'phone' => $r['phone'], 'gender' => $r['gender'],
        'birthday' => $r['birthday'], 'joinedAt' => $r['joined_at'], 'hasAccount' => !empty($r['password_hash']), 'active' => (bool)i($r['active']), 'stats' => $stats,
    ];
    if ($private) $d += ['source' => $r['source'], 'favoriteNote' => $r['favorite_note'], 'note' => $r['note'], 'lastLoginAt' => $r['last_login_at']];
    return $d;
}

function list_customers(DB $db): array
{
    $loyalty = get_loyalty($db);
    $t = app_today();
    $stats = raw_stats($db);
    return array_map(fn($r) => customer_dto($r, build_stats($stats[i($r['id'])] ?? [], $loyalty, $t)), $db->all('SELECT * FROM customers ORDER BY member_code'));
}

// ---------------- Buku besar poin ----------------
function add_ledger(DB $db, int $customerId, int $delta, string $type, ?string $refType = null, ?int $refId = null, ?string $refCode = null, ?string $note = null, ?int $staffId = null, ?string $at = null): int
{
    $bal = points_balance($db, $customerId) + $delta;
    $db->run('INSERT INTO points_ledger(customer_id, delta, balance_after, type, ref_type, ref_id, ref_code, note, staff_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [$customerId, $delta, $bal, $type, $refType, $refId, $refCode, $note, $staffId, $at ?? now_sql()]);
    return $bal;
}

function ledger_for(DB $db, int $customerId, int $limit = 100): array
{
    $rows = $db->all('SELECT l.*, s.name staff_name FROM points_ledger l LEFT JOIN staff s ON s.id = l.staff_id WHERE l.customer_id = ? ORDER BY l.id DESC LIMIT ' . (int)$limit, [$customerId]);
    return array_map(fn($r) => ['id' => i($r['id']), 'delta' => i($r['delta']), 'balanceAfter' => i($r['balance_after']), 'type' => $r['type'], 'note' => $r['note'],
        'refType' => $r['ref_type'], 'refCode' => $r['ref_code'], 'createdAt' => $r['created_at'], 'staffName' => $r['staff_name']], $rows);
}

// ---------------- Harga dari menu ----------------
function price_lines(DB $db, mixed $items, bool $allowUnavailable = false): array
{
    if (!is_array($items) || !$items) throw bad('Keranjang masih kosong');
    if (count($items) > 40) throw bad('Terlalu banyak item dalam satu transaksi');
    $merged = [];
    foreach ($items as $it) {
        $id = is_array($it) ? ($it['menuItemId'] ?? null) : null;
        $qty = is_array($it) ? ($it['qty'] ?? null) : null;
        if (!is_int($id) || $id <= 0) throw bad('Item menu tidak valid');
        if (!is_int($qty) || $qty < 1 || $qty > 100) throw bad('Jumlah item harus 1–100');
        $note = is_string($it['note'] ?? null) ? mb_substr(trim(preg_replace('/[\x00-\x1F]/u', '', $it['note']) ?? ''), 0, 120) : '';
        $m = $db->one('SELECT * FROM menu_items WHERE id = ? AND archived = 0', [$id]);
        if (!$m) throw bad('Ada menu yang sudah tidak tersedia, muat ulang halaman');
        if (!i($m['available']) && !$allowUnavailable) throw bad($m['name'] . ' sedang habis');
        $key = $id . '|' . $note;
        if (isset($merged[$key])) { $merged[$key]['qty'] += $qty; $merged[$key]['lineTotal'] = $merged[$key]['qty'] * $merged[$key]['price']; }
        else $merged[$key] = ['menuItemId' => i($m['id']), 'name' => $m['name'], 'price' => i($m['price']), 'qty' => $qty, 'note' => $note ?: null, 'lineTotal' => i($m['price']) * $qty];
    }
    $lines = array_values($merged);
    return [$lines, array_sum(array_column($lines, 'lineTotal'))];
}

// ---------------- Voucher ----------------
function expire_vouchers(DB $db): void
{
    $db->run("UPDATE vouchers SET status = 'expired' WHERE status = 'active' AND expires_at < ?", [now_sql()]);
}

function voucher_dto(array $r): array
{
    return ['id' => i($r['id']), 'code' => $r['code'], 'rewardId' => $r['reward_id'] === null ? null : i($r['reward_id']), 'name' => $r['name'], 'pointsCost' => i($r['points_cost']),
        'type' => $r['type'], 'value' => i($r['value']), 'menuItemId' => $r['menu_item_id'] === null ? null : i($r['menu_item_id']), 'status' => $r['status'],
        'createdAt' => $r['created_at'], 'expiresAt' => $r['expires_at'], 'usedAt' => $r['used_at']];
}

function check_voucher(DB $db, string $code, ?int $customerId, array $lines, int $subtotal, ?int $orderId = null): array
{
    expire_vouchers($db);
    $v = $db->one('SELECT * FROM vouchers WHERE code = ?', [strtoupper(trim($code))]);
    if (!$v) throw bad('Kode voucher tidak ditemukan');
    if (!$customerId || i($v['customer_id']) !== $customerId) throw bad('Voucher ini milik member lain');
    $okReserved = $v['status'] === 'reserved' && $orderId && i($v['order_id']) === $orderId;
    if ($v['status'] !== 'active' && !$okReserved) throw bad('Voucher sudah ' . ($v['status'] === 'used' ? 'dipakai' : ($v['status'] === 'expired' ? 'kedaluwarsa' : 'tidak berlaku')));
    $d = voucher_discount(['type' => $v['type'], 'value' => i($v['value']), 'menuItemId' => $v['menu_item_id']], $lines, $subtotal);
    if ($d < 0) throw bad('Tambahkan item gratis voucher ke keranjang terlebih dahulu');
    return [$v, $d];
}

// ---------------- Transaksi ----------------
function create_sale(DB $db, array $o): array
{
    $loyalty = get_loyalty($db);
    $customerId = $o['customerId'] ?? null;
    $lines = $o['lines'];
    $subtotal = (int)$o['subtotal'];
    $discount = 0;
    $v = null;
    if ($customerId) $db->lockCustomer($customerId);
    if (!empty($o['voucherCode'])) [$v, $discount] = check_voucher($db, $o['voucherCode'], $customerId, $lines, $subtotal, $o['orderId'] ?? null);
    $total = max(0, $subtotal - $discount);
    $date = $o['date'] ?? null;
    $points = 0;
    if ($customerId) {
        $raw = raw_stats($db, $customerId)[$customerId] ?? ['totalSpend' => 0, 'tierSpend' => 0];
        $points = points_for_purchase((int)$raw['totalSpend'], $total, $loyalty, tier_for((int)$raw['tierSpend'], $loyalty['tiers']));
    }
    $code = $o['code'] ?? next_trx_code($db);
    $trxId = $db->insert('INSERT INTO transactions(code, customer_id, date, subtotal, discount, total, payment, source, order_id, voucher_id, staff_id, points_earned, status, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [$code, $customerId, $date ?? app_today(), $subtotal, $discount, $total, $o['payment'] ?? null, $o['source'] ?? 'pos',
        $o['orderId'] ?? null, $v ? i($v['id']) : null, $o['staffId'] ?? null, $points, 'paid', now_sql()]);
    foreach ($lines as $l) {
        $db->run('INSERT INTO transaction_items(transaction_id, menu_item_id, name, price, qty, line_total) VALUES (?,?,?,?,?,?)', [$trxId, $l['menuItemId'] ?? null, $l['name'], $l['price'], $l['qty'], $l['lineTotal']]);
    }
    if ($points > 0) add_ledger($db, $customerId, $points, 'earn', 'transaction', $trxId, $code, "Belanja $code", $o['staffId'] ?? null, $date ? "$date 12:00:00" : null);
    if ($v) $db->run("UPDATE vouchers SET status = 'used', used_at = ?, transaction_id = ? WHERE id = ?", [now_sql(), $trxId, i($v['id'])]);
    return get_transaction($db, $trxId);
}

const TRX_SELECT = 'SELECT t.*, c.name customer_name, c.member_code, s.name staff_name, v.code voucher_code FROM transactions t
    LEFT JOIN customers c ON c.id = t.customer_id LEFT JOIN staff s ON s.id = t.staff_id LEFT JOIN vouchers v ON v.id = t.voucher_id';

function transaction_dto(array $r, array $items): array
{
    return [
        'id' => i($r['id']), 'code' => $r['code'], 'date' => $r['date'], 'createdAt' => $r['created_at'],
        'customer' => $r['customer_id'] ? ['id' => i($r['customer_id']), 'name' => $r['customer_name'], 'memberCode' => $r['member_code']] : null,
        'items' => array_map(fn($x) => ['menuItemId' => $x['menu_item_id'] === null ? null : i($x['menu_item_id']), 'name' => $x['name'], 'price' => i($x['price']), 'qty' => i($x['qty']), 'lineTotal' => i($x['line_total'])], $items),
        'subtotal' => i($r['subtotal']), 'discount' => i($r['discount']), 'total' => i($r['total']), 'payment' => $r['payment'], 'source' => $r['source'], 'status' => $r['status'],
        'voidReason' => $r['void_reason'], 'pointsEarned' => i($r['points_earned']), 'voucherCode' => $r['voucher_code'], 'staffName' => $r['staff_name'],
    ];
}

function get_transaction(DB $db, int $id): array
{
    $r = $db->one(TRX_SELECT . ' WHERE t.id = ?', [$id]);
    if (!$r) throw not_found('Transaksi tidak ditemukan');
    return transaction_dto($r, $db->all('SELECT * FROM transaction_items WHERE transaction_id = ? ORDER BY id', [$id]));
}

function list_transactions(DB $db, array $f = []): array
{
    $w = []; $a = [];
    if (!empty($f['customerId'])) { $w[] = 't.customer_id = ?'; $a[] = $f['customerId']; }
    if (!empty($f['from'])) { $w[] = 't.date >= ?'; $a[] = $f['from']; }
    if (!empty($f['to'])) { $w[] = 't.date <= ?'; $a[] = $f['to']; }
    if (!empty($f['q'])) { $w[] = '(t.code LIKE ? OR c.name LIKE ? OR c.member_code LIKE ?)'; array_push($a, "%{$f['q']}%", "%{$f['q']}%", "%{$f['q']}%"); }
    $limit = (int)($f['limit'] ?? 200);
    $rows = $db->all(TRX_SELECT . ($w ? ' WHERE ' . implode(' AND ', $w) : '') . " ORDER BY t.date DESC, t.id DESC LIMIT $limit", $a);
    if (!$rows) return [];
    $ids = array_map(fn($r) => i($r['id']), $rows);
    $by = [];
    foreach ($db->all('SELECT * FROM transaction_items WHERE transaction_id IN (' . in_marks($ids) . ') ORDER BY id', $ids) as $it) $by[i($it['transaction_id'])][] = $it;
    return array_map(fn($r) => transaction_dto($r, $by[i($r['id'])] ?? []), $rows);
}

function void_transaction(DB $db, int $id, string $reason, int $staffId): array
{
    return $db->tx(function () use ($db, $id, $reason, $staffId) {
        $t = $db->one('SELECT * FROM transactions WHERE id = ?', [$id]);
        if (!$t) throw not_found('Transaksi tidak ditemukan');
        if ($t['status'] === 'void') throw conflict('Transaksi sudah dibatalkan');
        if ($t['customer_id']) $db->lockCustomer(i($t['customer_id']));
        $db->run("UPDATE transactions SET status = 'void', void_reason = ? WHERE id = ?", [$reason, $id]);
        if ($t['customer_id'] && i($t['points_earned']) > 0) add_ledger($db, i($t['customer_id']), -i($t['points_earned']), 'void', 'transaction', $id, $t['code'], "Pembatalan {$t['code']}: $reason", $staffId);
        if ($t['voucher_id']) $db->run("UPDATE vouchers SET status = CASE WHEN expires_at < ? THEN 'expired' ELSE 'active' END, used_at = NULL, transaction_id = NULL WHERE id = ?", [now_sql(), i($t['voucher_id'])]);
        return get_transaction($db, $id);
    });
}

// ---------------- Rewards ----------------
function reward_dto(array $r): array
{
    return ['id' => i($r['id']), 'name' => $r['name'], 'description' => $r['description'], 'pointsCost' => i($r['points_cost']), 'minTier' => $r['min_tier'],
        'stock' => $r['stock'] === null ? null : i($r['stock']), 'type' => $r['type'], 'value' => i($r['value']), 'menuItemId' => $r['menu_item_id'] === null ? null : i($r['menu_item_id']),
        'validDays' => i($r['valid_days']), 'image' => $r['image'], 'active' => (bool)i($r['active']), 'sort' => i($r['sort'])];
}

function redeem_reward(DB $db, int $customerId, int $rewardId): array
{
    return $db->tx(function () use ($db, $customerId, $rewardId) {
        $db->lockCustomer($customerId);
        $loyalty = get_loyalty($db);
        $r = $db->one('SELECT * FROM rewards WHERE id = ? AND active = 1 AND archived = 0', [$rewardId]);
        if (!$r) throw not_found('Reward tidak tersedia');
        if ($r['stock'] !== null && i($r['stock']) <= 0) throw conflict('Stok reward sudah habis');
        $stats = stats_for($db, $customerId);
        if ($r['min_tier'] && tier_rank($stats['tier']['key'], $loyalty['tiers']) < tier_rank($r['min_tier'], $loyalty['tiers'])) {
            $name = $r['min_tier'];
            foreach ($loyalty['tiers'] as $t) if ($t['key'] === $r['min_tier']) $name = $t['name'];
            throw bad("Reward ini khusus member $name ke atas");
        }
        $bal = points_balance($db, $customerId);
        if ($bal < i($r['points_cost'])) throw bad('Poin belum cukup. Butuh ' . (i($r['points_cost']) - $bal) . ' poin lagi');
        do { $code = voucher_code(); } while ($db->val('SELECT 1 FROM vouchers WHERE code = ?', [$code]) !== null);
        $days = i($r['valid_days']) ?: (int)($loyalty['voucherValidDays'] ?? 30);
        $vid = $db->insert('INSERT INTO vouchers(code, customer_id, reward_id, name, points_cost, type, value, menu_item_id, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            [$code, $customerId, i($r['id']), $r['name'], i($r['points_cost']), $r['type'], i($r['value']), $r['menu_item_id'], 'active', now_sql(), now_sql($days * 86400)]);
        add_ledger($db, $customerId, -i($r['points_cost']), 'redeem', 'voucher', $vid, $code, 'Tukar: ' . $r['name']);
        if ($r['stock'] !== null) $db->run('UPDATE rewards SET stock = stock - 1 WHERE id = ?', [i($r['id'])]);
        return voucher_dto($db->one('SELECT * FROM vouchers WHERE id = ?', [$vid]));
    });
}

// ---------------- Pesanan online ----------------
const ORDER_FLOW = ['pending' => ['processing', 'cancelled'], 'processing' => ['ready', 'cancelled'], 'ready' => ['completed', 'cancelled'], 'completed' => [], 'cancelled' => []];

function order_dto(DB $db, array $r): array
{
    $items = $db->all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [i($r['id'])]);
    $c = $db->one('SELECT id, name, member_code, phone FROM customers WHERE id = ?', [i($r['customer_id'])]);
    $t = $r['transaction_id'] ? $db->one('SELECT code, points_earned FROM transactions WHERE id = ?', [i($r['transaction_id'])]) : null;
    $v = $r['voucher_id'] ? $db->one('SELECT code, name FROM vouchers WHERE id = ?', [i($r['voucher_id'])]) : null;
    return [
        'id' => i($r['id']), 'code' => $r['code'], 'queueNo' => i($r['queue_no']), 'status' => $r['status'],
        'items' => array_map(fn($x) => ['menuItemId' => $x['menu_item_id'] === null ? null : i($x['menu_item_id']), 'name' => $x['name'], 'price' => i($x['price']), 'qty' => i($x['qty']), 'note' => $x['note'], 'lineTotal' => i($x['line_total'])], $items),
        'subtotal' => i($r['subtotal']), 'discount' => i($r['discount']), 'total' => i($r['total']), 'paymentMethod' => $r['payment_method'], 'note' => $r['note'],
        'voucher' => $v ? ['code' => $v['code'], 'name' => $v['name']] : null,
        'customer' => $c ? ['id' => i($c['id']), 'name' => $c['name'], 'memberCode' => $c['member_code'], 'phone' => $c['phone']] : null,
        'transactionCode' => $t['code'] ?? null, 'pointsEarned' => i($t['points_earned'] ?? 0), 'cancelReason' => $r['cancel_reason'],
        'createdAt' => $r['created_at'], 'updatedAt' => $r['updated_at'],
    ];
}

function local_day_start_utc(): string
{
    $tz = new DateTimeZone($GLOBALS['LACAFE_TZ'] ?? 'Asia/Jakarta');
    return (new DateTimeImmutable('today', $tz))->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s');
}

function create_order(DB $db, int $customerId, array $o): array
{
    return $db->tx(function () use ($db, $customerId, $o) {
        $db->lockCustomer($customerId);
        $active = i($db->val("SELECT COUNT(*) FROM orders WHERE customer_id = ? AND status IN ('pending','processing','ready')", [$customerId]));
        if ($active >= 3) throw bad('Anda masih punya 3 pesanan berjalan. Selesaikan dulu sebelum memesan lagi');
        [$lines, $subtotal] = price_lines($db, $o['items']);
        $discount = 0; $v = null;
        if (!empty($o['voucherCode'])) [$v, $discount] = check_voucher($db, $o['voucherCode'], $customerId, $lines, $subtotal);
        $code = next_order_code($db);
        $queue = i($db->val('SELECT COUNT(*) FROM orders WHERE created_at >= ?', [local_day_start_utc()])) + 1;
        $oid = $db->insert('INSERT INTO orders(code, customer_id, status, queue_no, subtotal, discount, total, payment_method, voucher_id, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            [$code, $customerId, 'pending', $queue, $subtotal, $discount, $subtotal - $discount, $o['paymentMethod'], $v ? i($v['id']) : null, $o['note'], now_sql(), now_sql()]);
        foreach ($lines as $l) $db->run('INSERT INTO order_items(order_id, menu_item_id, name, price, qty, note, line_total) VALUES (?,?,?,?,?,?,?)', [$oid, $l['menuItemId'], $l['name'], $l['price'], $l['qty'], $l['note'], $l['lineTotal']]);
        if ($v) $db->run("UPDATE vouchers SET status = 'reserved', order_id = ? WHERE id = ?", [$oid, i($v['id'])]);
        return order_dto($db, $db->one('SELECT * FROM orders WHERE id = ?', [$oid]));
    });
}

function set_order_status(DB $db, int $orderId, string $next, array $opt = []): array
{
    return $db->tx(function () use ($db, $orderId, $next, $opt) {
        $o = $db->one('SELECT * FROM orders WHERE id = ?', [$orderId]);
        $byCustomer = $opt['byCustomer'] ?? null;
        if (!$o || ($byCustomer && i($o['customer_id']) !== $byCustomer)) throw not_found('Pesanan tidak ditemukan');
        if ($byCustomer && !($o['status'] === 'pending' && $next === 'cancelled')) throw bad('Pesanan yang sudah diproses tidak bisa dibatalkan dari aplikasi. Hubungi kasir.');
        if (!in_array($next, ORDER_FLOW[$o['status']] ?? [], true)) throw conflict("Status tidak bisa diubah dari {$o['status']} ke $next");
        $trxId = null;
        $payment = $opt['payment'] ?? null;
        if ($next === 'completed') {
            $lines = array_map(fn($x) => ['menuItemId' => $x['menu_item_id'] === null ? null : i($x['menu_item_id']), 'name' => $x['name'], 'price' => i($x['price']), 'qty' => i($x['qty']), 'lineTotal' => i($x['line_total'])],
                $db->all('SELECT * FROM order_items WHERE order_id = ?', [$orderId]));
            $vcode = $o['voucher_id'] ? $db->val('SELECT code FROM vouchers WHERE id = ?', [i($o['voucher_id'])]) : null;
            $sale = create_sale($db, ['customerId' => i($o['customer_id']), 'lines' => $lines, 'subtotal' => i($o['subtotal']), 'payment' => $payment ?: $o['payment_method'],
                'voucherCode' => $vcode, 'staffId' => $opt['staffId'] ?? null, 'source' => 'order', 'orderId' => $orderId]);
            $trxId = $sale['id'];
        }
        if ($next === 'cancelled' && $o['voucher_id']) {
            $db->run("UPDATE vouchers SET status = CASE WHEN expires_at < ? THEN 'expired' ELSE 'active' END, order_id = NULL WHERE id = ? AND status = 'reserved'", [now_sql(), i($o['voucher_id'])]);
        }
        $reason = $next === 'cancelled' ? (($opt['reason'] ?? null) ?: ($byCustomer ? 'Dibatalkan customer' : 'Dibatalkan kasir')) : $o['cancel_reason'];
        $db->run('UPDATE orders SET status = ?, transaction_id = COALESCE(?, transaction_id), cancel_reason = ?, payment_method = COALESCE(?, payment_method), updated_at = ? WHERE id = ?',
            [$next, $trxId, $reason, $payment, now_sql(), $orderId]);
        return order_dto($db, $db->one('SELECT * FROM orders WHERE id = ?', [$orderId]));
    });
}

// ---------------- Dashboard ----------------
function dashboard(DB $db): array
{
    $loyalty = get_loyalty($db);
    $t = app_today();
    $monthStart = substr($t, 0, 8) . '01';
    $customers = list_customers($db);
    $sum = fn($from, $to) => $db->one("SELECT COALESCE(SUM(total),0) s, COUNT(*) n FROM transactions WHERE status = 'paid' AND date BETWEEN ? AND ?", [$from, $to]);
    $today = $sum($t, $t); $month = $sum($monthStart, $t);
    $all = $db->one("SELECT COALESCE(SUM(total),0) s, COUNT(*) n FROM transactions WHERE status = 'paid'");
    $rows = [];
    foreach ($db->all("SELECT date, SUM(total) s, COUNT(*) n FROM transactions WHERE status = 'paid' AND date >= ? GROUP BY date", [shift_date($t, -13)]) as $r) $rows[$r['date']] = $r;
    $daily = [];
    for ($k = 13; $k >= 0; $k--) { $d = shift_date($t, -$k); $daily[] = ['date' => $d, 'total' => i($rows[$d]['s'] ?? 0), 'count' => i($rows[$d]['n'] ?? 0)]; }
    $count = fn($fn) => count(array_filter($customers, $fn));
    $tiers = array_map(fn($tr) => ['key' => $tr['key'], 'name' => $tr['name'], 'color' => $tr['color'], 'count' => $count(fn($c) => $c['stats']['tier']['key'] === $tr['key'])], sorted_tiers($loyalty['tiers']));
    $status = array_map(fn($s) => ['key' => $s, 'count' => $count(fn($c) => $c['stats']['status'] === $s)], ['aktif', 'tidak_aktif', 'belum_beli']);
    $top = array_map(fn($r) => ['name' => $r['name'], 'qty' => i($r['qty']), 'revenue' => i($r['revenue'])], $db->all("SELECT ti.name, SUM(ti.qty) qty, SUM(ti.line_total) revenue FROM transaction_items ti
        JOIN transactions tr ON tr.id = ti.transaction_id WHERE tr.status = 'paid' GROUP BY ti.name ORDER BY qty DESC LIMIT 6"));
    $sorted = $customers;
    usort($sorted, fn($a, $b) => $b['stats']['totalSpend'] <=> $a['stats']['totalSpend']);
    return [
        'today' => $t,
        'kpis' => [
            'members' => count($customers), 'activeMembers' => $status[0]['count'], 'newMembers30' => $count(fn($c) => $c['joinedAt'] && days_between($c['joinedAt'], $t) <= 30),
            'revenueToday' => i($today['s']), 'trxToday' => i($today['n']), 'revenueMonth' => i($month['s']), 'trxMonth' => i($month['n']),
            'revenueAll' => i($all['s']), 'trxAll' => i($all['n']), 'avgTicket' => i($all['n']) ? (int)round(i($all['s']) / i($all['n'])) : 0,
            'pointsOutstanding' => i($db->val('SELECT COALESCE(SUM(delta),0) FROM points_ledger')),
            'pendingOrders' => i($db->val("SELECT COUNT(*) FROM orders WHERE status IN ('pending','processing','ready')")),
        ],
        'tiers' => $tiers, 'status' => $status, 'daily' => $daily, 'topMenu' => $top,
        'topCustomers' => array_map(fn($c) => ['id' => $c['id'], 'name' => $c['name'], 'memberCode' => $c['memberCode'], 'totalSpend' => $c['stats']['totalSpend'], 'tier' => $c['stats']['tier'], 'points' => $c['stats']['points']], array_slice($sorted, 0, 5)),
        'recent' => list_transactions($db, ['limit' => 6]),
    ];
}
