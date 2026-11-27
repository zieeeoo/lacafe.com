<?php
// Semua endpoint API (padanan src/routes.js). Setiap route menyatakan level akses: null | any | customer | staff | admin.
declare(strict_types=1);

final class Router
{
    public array $routes = [];
    public function add(string $m, string $pattern, array $opts, callable $fn): void
    {
        $keys = [];
        $re = '#^' . preg_replace_callback('#:(\w+)#', function ($x) use (&$keys) { $keys[] = $x[1]; return '([^/]+)'; }, $pattern) . '$#';
        $this->routes[] = compact('m', 're', 'keys', 'opts', 'fn');
    }
    public function get(string $p, array $o, callable $f): void { $this->add('GET', $p, $o, $f); }
    public function post(string $p, array $o, callable $f): void { $this->add('POST', $p, $o, $f); }
    public function patch(string $p, array $o, callable $f): void { $this->add('PATCH', $p, $o, $f); }
    public function put(string $p, array $o, callable $f): void { $this->add('PUT', $p, $o, $f); }
    public function delete(string $p, array $o, callable $f): void { $this->add('DELETE', $p, $o, $f); }
    public function match(string $method, string $path): ?array
    {
        $pathMatched = false;
        foreach ($this->routes as $r) {
            if (!preg_match($r['re'], $path, $mm)) continue;
            $pathMatched = true;
            if ($r['m'] !== $method) continue;
            $params = [];
            foreach ($r['keys'] as $i => $k) $params[$k] = urldecode($mm[$i + 1]);
            return ['route' => $r, 'params' => $params];
        }
        return $pathMatched ? ['methodNotAllowed' => true] : null;
    }
}

const STAFF_SESSION_HOURS = 12;
const CUSTOMER_SESSION_DAYS = 30;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

function set_session_cookie(array $env, string $token, int $maxAge): void
{
    setcookie('lc_sid', $token, ['expires' => time() + $maxAge, 'path' => $env['cookiePath'], 'secure' => $env['https'], 'httponly' => true, 'samesite' => 'Strict']);
}
function clear_session_cookie(array $env): void
{
    setcookie('lc_sid', '', ['expires' => time() - 3600, 'path' => $env['cookiePath'], 'secure' => $env['https'], 'httponly' => true, 'samesite' => 'Strict']);
}

function start_session(DB $db, array $env, array $ctx, string $kind, int $subjectId): string
{
    $token = random_token(32);
    $csrf = random_token(24);
    $hours = $kind === 'staff' ? STAFF_SESSION_HOURS : CUSTOMER_SESSION_DAYS * 24;
    $db->run('INSERT INTO sessions(id, kind, subject_id, csrf, ip, ua, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)',
        [sha256($token), $kind, $subjectId, $csrf, $ctx['ip'], mb_substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 200), now_sql(), now_sql($hours * 3600)]);
    $keep = $db->q('SELECT id FROM sessions WHERE kind = ? AND subject_id = ? ORDER BY created_at DESC LIMIT 5', [$kind, $subjectId])->fetchAll(PDO::FETCH_COLUMN);
    if ($keep) $db->run('DELETE FROM sessions WHERE kind = ? AND subject_id = ? AND id NOT IN (' . in_marks($keep) . ')', array_merge([$kind, $subjectId], $keep));
    set_session_cookie($env, $token, $hours * 3600);
    return $csrf;
}

function load_auth(DB $db): ?array
{
    $token = $_COOKIE['lc_sid'] ?? '';
    if (!is_string($token) || $token === '' || strlen($token) > 100) return null;
    $s = $db->one('SELECT * FROM sessions WHERE id = ? AND expires_at > ?', [sha256($token), now_sql()]);
    if (!$s) return null;
    if ($s['kind'] === 'staff') {
        $u = $db->one('SELECT * FROM staff WHERE id = ? AND active = 1', [i($s['subject_id'])]);
        if (!$u) return null;
        return ['kind' => 'staff', 'id' => i($u['id']), 'name' => $u['name'], 'role' => $u['role'], 'username' => $u['username'], 'mustChange' => (bool)i($u['must_change_password']), 'csrf' => $s['csrf'], 'sessionId' => $s['id']];
    }
    $c = $db->one('SELECT * FROM customers WHERE id = ? AND active = 1', [i($s['subject_id'])]);
    if (!$c) return null;
    return ['kind' => 'customer', 'id' => i($c['id']), 'name' => $c['name'], 'role' => 'customer', 'memberCode' => $c['member_code'], 'csrf' => $s['csrf'], 'sessionId' => $s['id']];
}

function session_payload(?array $a): array
{
    if (!$a) return ['kind' => null];
    if ($a['kind'] === 'staff') return ['kind' => 'staff', 'csrf' => $a['csrf'], 'user' => ['id' => $a['id'], 'name' => $a['name'], 'role' => $a['role'], 'username' => $a['username'], 'mustChange' => $a['mustChange']]];
    return ['kind' => 'customer', 'csrf' => $a['csrf'], 'user' => ['id' => $a['id'], 'name' => $a['name'], 'memberCode' => $a['memberCode']]];
}

function register_routes(Router $r, DB $db, array $env): void
{
    $secret = $env['secret'];

    $checkLock = function (?array $row) {
        if ($row && $row['locked_until'] && $row['locked_until'] > now_sql()) throw new HttpError(423, 'Akun dikunci sementara karena terlalu banyak percobaan gagal. Coba lagi setelah ' . LOCK_MINUTES . ' menit', 'locked');
    };
    $registerFail = function (string $table, ?array $row) use ($db) {
        if (!$row) return;
        $n = i($row['failed_logins']) + 1;
        $db->run("UPDATE $table SET failed_logins = ?, locked_until = ? WHERE id = ?", [$n >= MAX_FAILED ? 0 : $n, $n >= MAX_FAILED ? now_sql(LOCK_MINUTES * 60) : null, i($row['id'])]);
    };
    $resetFail = fn(string $table, int $id) => $db->run("UPDATE $table SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?", [now_sql(), $id]);
    $findCustomer = function (mixed $ident) use ($db): ?array {
        $raw = V::str($ident, 'Nomor WhatsApp / ID member', 0, 40);
        if (preg_match('/^[A-Za-z]{1,4}\d{1,6}$/', $raw)) return $db->one('SELECT * FROM customers WHERE UPPER(member_code) = ?', [strtoupper($raw)]);
        try { $p = V::phone($raw); } catch (HttpError) { return null; }
        return $db->one('SELECT * FROM customers WHERE phone = ?', [$p]);
    };
    $custSession = fn(array $ctx, array $c) => ['kind' => 'customer', 'csrf' => start_session($db, $env, $ctx, 'customer', i($c['id'])), 'user' => ['id' => i($c['id']), 'name' => $c['name'], 'memberCode' => $c['member_code']]];

    // ============================== AUTH ==============================
    $r->get('/api/auth/session', ['auth' => null, 'allowMustChange' => true], fn($ctx) => session_payload($ctx['auth']));

    $r->post('/api/auth/staff/login', ['auth' => null, 'csrf' => false], function ($ctx) use ($db, $env, $checkLock, $registerFail, $resetFail) {
        rate_limit($db, 'login:' . $ctx['ip'], 600, 20);
        $username = strtolower(V::str($ctx['body']['username'] ?? null, 'Username', 0, 40));
        $u = $db->one('SELECT * FROM staff WHERE username = ?', [$username]);
        $checkLock($u);
        $ok = verify_password((string)($ctx['body']['password'] ?? ''), $u['password_hash'] ?? null);
        if (!$ok || !i($u['active'])) { $registerFail('staff', $u); audit($db, null, 'login_gagal', "staff:$username", null, $ctx['ip']); throw unauthorized('Username atau kata sandi salah'); }
        $resetFail('staff', i($u['id']));
        $csrf = start_session($db, $env, $ctx, 'staff', i($u['id']));
        audit($db, ['kind' => 'staff', 'id' => i($u['id']), 'name' => $u['name']], 'login', 'staff', null, $ctx['ip']);
        return ['kind' => 'staff', 'csrf' => $csrf, 'user' => ['id' => i($u['id']), 'name' => $u['name'], 'role' => $u['role'], 'username' => $u['username'], 'mustChange' => (bool)i($u['must_change_password'])]];
    });

    $r->post('/api/auth/customer/login', ['auth' => null, 'csrf' => false], function ($ctx) use ($db, $checkLock, $registerFail, $resetFail, $findCustomer, $custSession) {
        rate_limit($db, 'login:' . $ctx['ip'], 600, 20);
        $c = $findCustomer($ctx['body']['identifier'] ?? null);
        $checkLock($c);
        $ok = verify_password((string)($ctx['body']['password'] ?? ''), $c['password_hash'] ?? null);
        if (!$ok || !i($c['active'])) {
            $registerFail('customers', $c);
            if ($c && !$c['password_hash']) throw new HttpError(401, 'Akun member ini belum diaktifkan. Minta kode aktivasi ke kasir, lalu pilih "Aktifkan akun".', 'not_activated');
            throw unauthorized('Nomor/ID member atau kata sandi salah');
        }
        $resetFail('customers', i($c['id']));
        return $custSession($ctx, $c);
    });

    $r->post('/api/auth/customer/register', ['auth' => null, 'csrf' => false], function ($ctx) use ($db, $custSession) {
        rate_limit($db, 'register:' . $ctx['ip'], 600, 20);
        $b = $ctx['body'];
        $name = V::str($b['name'] ?? null, 'Nama', 2, 60);
        $phone = V::phone($b['phone'] ?? null);
        $password = V::password($b['password'] ?? null);
        $opts = get_options($db);
        $gender = !empty($b['gender']) ? V::oneOf($b['gender'], 'Gender', $opts['genders']) : null;
        $birthday = V::date($b['birthday'] ?? null, 'Tanggal lahir', false);
        $ex = $db->one('SELECT * FROM customers WHERE phone = ?', [$phone]);
        if ($ex && $ex['password_hash']) throw conflict('Nomor ini sudah terdaftar. Silakan masuk.');
        if ($ex) throw new HttpError(409, 'Nomor ini sudah tercatat sebagai member di kasir. Minta kode aktivasi ke kasir, lalu pilih "Aktifkan akun".', 'needs_activation');
        $c = $db->tx(function () use ($db, $name, $phone, $gender, $birthday, $password, $ctx) {
            $code = next_member_code($db);
            $id = $db->insert('INSERT INTO customers(member_code, name, phone, gender, birthday, source, joined_at, password_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
                [$code, $name, $phone, $gender, $birthday, 'Aplikasi', app_today(), hash_password($password), now_sql()]);
            audit($db, ['kind' => 'customer', 'id' => $id, 'name' => $name], 'daftar_member', $code, null, $ctx['ip']);
            return $db->one('SELECT * FROM customers WHERE id = ?', [$id]);
        });
        return $custSession($ctx, $c);
    });

    $r->post('/api/auth/customer/activate', ['auth' => null, 'csrf' => false], function ($ctx) use ($db, $checkLock, $registerFail, $resetFail, $findCustomer, $custSession) {
        rate_limit($db, 'activate:' . $ctx['ip'], 600, 20);
        $c = $findCustomer($ctx['body']['identifier'] ?? null);
        $code = preg_replace('/[^A-Z0-9]/', '', strtoupper((string)($ctx['body']['code'] ?? '')));
        $password = V::password($ctx['body']['password'] ?? null);
        $checkLock($c);
        $valid = $c && $c['activation_hash'] && $c['activation_expires'] > now_sql() && hash_equals((string)$c['activation_hash'], sha256($code));
        if (!$valid) { $registerFail('customers', $c); throw bad('Kode aktivasi salah atau sudah kedaluwarsa. Minta kode baru ke kasir.'); }
        $db->run('UPDATE customers SET password_hash = ?, activation_hash = NULL, activation_expires = NULL WHERE id = ?', [hash_password($password), i($c['id'])]);
        $db->run("DELETE FROM sessions WHERE kind = 'customer' AND subject_id = ?", [i($c['id'])]);
        $resetFail('customers', i($c['id']));
        audit($db, ['kind' => 'customer', 'id' => i($c['id']), 'name' => $c['name']], 'aktivasi_akun', $c['member_code'], null, $ctx['ip']);
        return $custSession($ctx, $c);
    });

    $r->post('/api/auth/logout', ['auth' => 'any', 'allowMustChange' => true], function ($ctx) use ($db, $env) {
        $db->run('DELETE FROM sessions WHERE id = ?', [$ctx['auth']['sessionId']]);
        clear_session_cookie($env);
        return ['ok' => true];
    });

    $r->post('/api/auth/password', ['auth' => 'any', 'allowMustChange' => true], function ($ctx) use ($db) {
        rate_limit($db, 'pw:' . $ctx['ip'], 600, 20);
        $table = $ctx['auth']['kind'] === 'staff' ? 'staff' : 'customers';
        $row = $db->one("SELECT * FROM $table WHERE id = ?", [$ctx['auth']['id']]);
        if (!verify_password((string)($ctx['body']['current'] ?? ''), $row['password_hash'])) throw bad('Kata sandi lama salah');
        $next = V::password($ctx['body']['next'] ?? null);
        if ($next === ($ctx['body']['current'] ?? null)) throw bad('Kata sandi baru harus berbeda');
        $db->run("UPDATE $table SET password_hash = ?" . ($table === 'staff' ? ', must_change_password = 0' : '') . ' WHERE id = ?', [hash_password($next), i($row['id'])]);
        $db->run('DELETE FROM sessions WHERE kind = ? AND subject_id = ? AND id != ?', [$ctx['auth']['kind'], i($row['id']), $ctx['auth']['sessionId']]);
        audit($db, $ctx['auth'], 'ganti_password', $table, null, $ctx['ip']);
        return ['ok' => true];
    });

    // ============================== PUBLIK ==============================
    $categories = fn(bool $all = false) => array_map(fn($c) => ['id' => i($c['id']), 'key' => $c['cat_key'], 'name' => $c['name'], 'sort' => i($c['sort']), 'active' => (bool)i($c['active'])],
        $db->all('SELECT * FROM categories ' . ($all ? '' : 'WHERE active = 1 ') . 'ORDER BY sort, id'));
    $menuDto = fn(array $m) => ['id' => i($m['id']), 'code' => $m['code'], 'name' => $m['name'], 'categoryId' => $m['category_id'] === null ? null : i($m['category_id']), 'price' => i($m['price']),
        'description' => $m['description'], 'image' => $m['image'], 'temp' => $m['temp'], 'featured' => (bool)i($m['featured']), 'available' => (bool)i($m['available']), 'sort' => i($m['sort'])];
    $menuAll = fn() => array_map($menuDto, $db->all('SELECT * FROM menu_items WHERE archived = 0 ORDER BY sort, id'));
    $rewardsAll = fn(bool $all = false) => array_map('reward_dto', $db->all('SELECT * FROM rewards WHERE archived = 0 ' . ($all ? '' : 'AND active = 1 ') . 'ORDER BY sort, points_cost'));

    $r->get('/api/public/bootstrap', ['auth' => null], function () use ($db, $categories, $menuAll, $rewardsAll) {
        $l = get_loyalty($db); $o = get_options($db);
        return ['appearance' => get_appearance($db), 'categories' => $categories(), 'menu' => $menuAll(), 'rewards' => $rewardsAll(),
            'loyalty' => ['rupiahPerPoint' => $l['rupiahPerPoint'], 'inactiveDays' => $l['inactiveDays'], 'tiers' => $l['tiers'], 'tierBasis' => $l['tierBasis'] ?? 'lifetime'],
            'options' => ['genders' => $o['genders'], 'payments' => $o['payments'], 'sources' => $o['sources']]];
    });

    // ============================== CUSTOMER ==============================
    $me = fn(int $id) => $db->one('SELECT * FROM customers WHERE id = ?', [$id]);
    $r->get('/api/me', ['auth' => 'customer'], function ($ctx) use ($db, $me) {
        $row = $me($ctx['auth']['id']);
        $d = customer_dto($row, stats_for($db, i($row['id'])), false);
        expire_vouchers($db);
        $d['activeVouchers'] = i($db->val("SELECT COUNT(*) FROM vouchers WHERE customer_id = ? AND status = 'active'", [i($row['id'])]));
        $d['activeOrders'] = array_map(fn($o) => order_dto($db, $o), $db->all("SELECT * FROM orders WHERE customer_id = ? AND status IN ('pending','processing','ready') ORDER BY id DESC", [i($row['id'])]));
        return $d;
    });
    $r->patch('/api/me', ['auth' => 'customer'], function ($ctx) use ($db, $me) {
        $b = $ctx['body']; $o = get_options($db); $row = $me($ctx['auth']['id']);
        $name = array_key_exists('name', $b) ? V::str($b['name'], 'Nama', 2, 60) : $row['name'];
        $gender = array_key_exists('gender', $b) ? ($b['gender'] ? V::oneOf($b['gender'], 'Gender', $o['genders']) : null) : $row['gender'];
        $birthday = array_key_exists('birthday', $b) ? V::date($b['birthday'], 'Tanggal lahir', false) : $row['birthday'];
        $db->run('UPDATE customers SET name = ?, gender = ?, birthday = ? WHERE id = ?', [$name, $gender, $birthday, i($row['id'])]);
        return customer_dto($me($ctx['auth']['id']), stats_for($db, $ctx['auth']['id']), false);
    });
    $r->get('/api/me/pass', ['auth' => 'customer'], fn($ctx) => ['memberCode' => $ctx['auth']['memberCode'], 'code' => member_pass_code($secret, $ctx['auth']['memberCode']), 'expiresIn' => pass_expires_in(), 'window' => PASS_WINDOW]);
    $r->get('/api/me/points', ['auth' => 'customer'], fn($ctx) => ledger_for($db, $ctx['auth']['id'], 200));
    $r->get('/api/me/transactions', ['auth' => 'customer'], fn($ctx) => array_map(function ($t) { unset($t['staffName']); return $t; }, list_transactions($db, ['customerId' => $ctx['auth']['id'], 'limit' => 100])));
    $r->get('/api/me/vouchers', ['auth' => 'customer'], function ($ctx) use ($db) {
        expire_vouchers($db);
        return array_map('voucher_dto', $db->all('SELECT * FROM vouchers WHERE customer_id = ? ORDER BY id DESC LIMIT 100', [$ctx['auth']['id']]));
    });
    $r->post('/api/me/redeem', ['auth' => 'customer'], function ($ctx) use ($db) {
        rate_limit($db, 'redeem:' . $ctx['auth']['id'], 60, 10);
        $v = redeem_reward($db, $ctx['auth']['id'], V::int($ctx['body']['rewardId'] ?? null, 'Reward', 1));
        audit($db, $ctx['auth'], 'tukar_poin', $v['code'], ['reward' => $v['name'], 'poin' => $v['pointsCost']], $ctx['ip']);
        return $v;
    });
    $r->get('/api/me/orders', ['auth' => 'customer'], fn($ctx) => array_map(fn($o) => order_dto($db, $o), $db->all('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 50', [$ctx['auth']['id']])));
    $r->post('/api/me/orders', ['auth' => 'customer'], function ($ctx) use ($db) {
        if (!get_appearance($db)['orderingEnabled']) throw bad('Pemesanan lewat aplikasi sedang ditutup');
        rate_limit($db, 'order:' . $ctx['auth']['id'], 600, 10);
        $b = $ctx['body'];
        $o = create_order($db, $ctx['auth']['id'], [
            'items' => $b['items'] ?? null,
            'paymentMethod' => V::oneOf($b['paymentMethod'] ?? null, 'Metode bayar', get_options($db)['payments']),
            'note' => V::str($b['note'] ?? null, 'Catatan', 0, 200, false),
            'voucherCode' => !empty($b['voucherCode']) ? V::str($b['voucherCode'], 'Voucher', 0, 20) : null,
        ]);
        audit($db, $ctx['auth'], 'pesanan_baru', $o['code'], ['total' => $o['total']], $ctx['ip']);
        return $o;
    });
    $r->post('/api/me/orders/:id/cancel', ['auth' => 'customer'], fn($ctx) => set_order_status($db, V::int($ctx['params']['id'], 'ID', 1), 'cancelled', ['byCustomer' => $ctx['auth']['id']]));

    // ============================== STAF ==============================
    $r->get('/api/staff/dashboard', ['auth' => 'staff'], fn() => dashboard($db));
    $r->get('/api/staff/customers', ['auth' => 'staff'], fn() => list_customers($db));

    $r->get('/api/staff/lookup', ['auth' => 'staff'], function ($ctx) use ($db, $secret) {
        rate_limit($db, 'lookup:' . $ctx['auth']['id'], 60, 30);
        $code = preg_replace('/\D/', '', (string)($ctx['query']['code'] ?? ''));
        if (strlen($code) !== 6) throw bad('Kode member harus 6 digit');
        $now = time();
        foreach ($db->all('SELECT * FROM customers WHERE active = 1') as $row) {
            if (hash_equals(member_pass_code($secret, $row['member_code'], $now), $code) || hash_equals(member_pass_code($secret, $row['member_code'], $now - PASS_WINDOW), $code)) {
                return customer_dto($row, stats_for($db, i($row['id'])));
            }
        }
        throw not_found('Kode tidak cocok atau sudah kedaluwarsa. Minta customer membuka ulang kode member.');
    });

    $customerInput = function (array $b, bool $isAdmin, bool $partial) use ($db): array {
        $o = get_options($db); $out = [];
        $has = fn($k) => array_key_exists($k, $b);
        if (!$partial || $has('name')) $out['name'] = V::str($b['name'] ?? null, 'Nama', 2, 60);
        if ($has('gender')) $out['gender'] = $b['gender'] ? V::oneOf($b['gender'], 'Gender', $o['genders']) : null;
        if ($has('source')) $out['source'] = $b['source'] ? V::oneOf($b['source'], 'Sumber', array_merge($o['sources'], ['Aplikasi'])) : null;
        if ($has('birthday')) $out['birthday'] = V::date($b['birthday'], 'Tanggal lahir', false);
        if ($has('note')) $out['note'] = V::str($b['note'], 'Catatan', 0, 300, false);
        if ($has('favoriteNote')) $out['favorite_note'] = V::str($b['favoriteNote'], 'Menu favorit', 0, 120, false);
        if ($has('phone')) { if ($partial && !$isAdmin) throw forbidden('Hanya admin yang bisa mengubah nomor WhatsApp'); $out['phone'] = V::phone($b['phone'], false); }
        if ($has('active')) { if (!$isAdmin) throw forbidden(); $out['active'] = $b['active'] ? 1 : 0; }
        return $out;
    };

    $r->post('/api/staff/customers', ['auth' => 'staff'], function ($ctx) use ($db, $customerInput) {
        $data = $customerInput($ctx['body'], $ctx['auth']['role'] === 'admin', false);
        if (!empty($data['phone']) && $db->val('SELECT 1 FROM customers WHERE phone = ?', [$data['phone']]) !== null) throw conflict('Nomor WhatsApp sudah dipakai member lain');
        $row = $db->tx(function () use ($db, $data, $ctx) {
            $code = next_member_code($db);
            $cols = array_merge(['member_code', 'joined_at', 'created_at'], array_keys($data));
            $id = $db->insert('INSERT INTO customers(' . implode(',', $cols) . ') VALUES (' . in_marks($cols) . ')', array_merge([$code, app_today(), now_sql()], array_values($data)));
            audit($db, $ctx['auth'], 'tambah_customer', $code, ['name' => $data['name']], $ctx['ip']);
            return $db->one('SELECT * FROM customers WHERE id = ?', [$id]);
        });
        return customer_dto($row, stats_for($db, i($row['id'])));
    });

    $r->get('/api/staff/customers/:id', ['auth' => 'staff'], function ($ctx) use ($db) {
        $id = V::int($ctx['params']['id'], 'ID', 1);
        $row = $db->one('SELECT * FROM customers WHERE id = ?', [$id]);
        if (!$row) throw not_found('Customer tidak ditemukan');
        expire_vouchers($db);
        return customer_dto($row, stats_for($db, $id)) + [
            'activationPending' => (bool)($row['activation_hash'] && $row['activation_expires'] > now_sql()),
            'transactions' => list_transactions($db, ['customerId' => $id, 'limit' => 100]),
            'ledger' => ledger_for($db, $id, 100),
            'vouchers' => array_map('voucher_dto', $db->all('SELECT * FROM vouchers WHERE customer_id = ? ORDER BY id DESC LIMIT 50', [$id])),
            'orders' => array_map(fn($o) => order_dto($db, $o), $db->all('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 20', [$id])),
        ];
    });

    $r->patch('/api/staff/customers/:id', ['auth' => 'staff'], function ($ctx) use ($db, $customerInput) {
        $id = V::int($ctx['params']['id'], 'ID', 1);
        $row = $db->one('SELECT * FROM customers WHERE id = ?', [$id]);
        if (!$row) throw not_found('Customer tidak ditemukan');
        $data = $customerInput($ctx['body'], $ctx['auth']['role'] === 'admin', true);
        if (!empty($data['phone']) && $db->val('SELECT 1 FROM customers WHERE phone = ? AND id != ?', [$data['phone'], $id]) !== null) throw conflict('Nomor WhatsApp sudah dipakai member lain');
        if (!$data) throw bad('Tidak ada perubahan');
        $db->run('UPDATE customers SET ' . implode(', ', array_map(fn($k) => "$k = ?", array_keys($data))) . ' WHERE id = ?', array_merge(array_values($data), [$id]));
        if (($data['active'] ?? 1) === 0) $db->run("DELETE FROM sessions WHERE kind = 'customer' AND subject_id = ?", [$id]);
        audit($db, $ctx['auth'], 'ubah_customer', $row['member_code'], $data, $ctx['ip']);
        return customer_dto($db->one('SELECT * FROM customers WHERE id = ?', [$id]), stats_for($db, $id));
    });

    $r->post('/api/staff/customers/:id/activation', ['auth' => 'staff'], function ($ctx) use ($db) {
        $id = V::int($ctx['params']['id'], 'ID', 1);
        $row = $db->one('SELECT * FROM customers WHERE id = ?', [$id]);
        if (!$row) throw not_found('Customer tidak ditemukan');
        $code = activation_code();
        $db->run('UPDATE customers SET activation_hash = ?, activation_expires = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', [sha256(str_replace('-', '', $code)), now_sql(72 * 3600), $id]);
        audit($db, $ctx['auth'], $row['password_hash'] ? 'reset_akses_customer' : 'buat_kode_aktivasi', $row['member_code'], null, $ctx['ip']);
        return ['code' => $code, 'expiresInHours' => 72, 'memberCode' => $row['member_code'], 'phone' => $row['phone'], 'reset' => (bool)$row['password_hash']];
    });

    $r->post('/api/staff/customers/:id/adjust-points', ['auth' => 'admin'], function ($ctx) use ($db) {
        $id = V::int($ctx['params']['id'], 'ID', 1);
        $delta = V::int($ctx['body']['delta'] ?? null, 'Jumlah poin', -100000, 100000);
        if ($delta === 0) throw bad('Jumlah poin tidak boleh 0');
        $reason = V::str($ctx['body']['reason'] ?? null, 'Alasan', 3, 200);
        return $db->tx(function () use ($db, $id, $delta, $reason, $ctx) {
            $row = $db->one('SELECT * FROM customers WHERE id = ?', [$id]);
            if (!$row) throw not_found('Customer tidak ditemukan');
            $db->lockCustomer($id);
            $bal = points_balance($db, $id);
            if ($bal + $delta < 0) throw bad("Saldo poin tidak cukup (saldo $bal)");
            $after = add_ledger($db, $id, $delta, 'adjust', null, null, null, $reason, $ctx['auth']['id']);
            audit($db, $ctx['auth'], 'koreksi_poin', $row['member_code'], ['delta' => $delta, 'reason' => $reason, 'saldo' => $after], $ctx['ip']);
            return ['balance' => $after];
        });
    });

    // ---------- Transaksi ----------
    $r->get('/api/staff/transactions', ['auth' => 'staff'], fn($ctx) => list_transactions($db, [
        'from' => $ctx['query']['from'] ?? null, 'to' => $ctx['query']['to'] ?? null, 'q' => mb_substr((string)($ctx['query']['q'] ?? ''), 0, 40) ?: null,
        'limit' => min(1000, (int)($ctx['query']['limit'] ?? 300) ?: 300),
    ]));

    $r->post('/api/staff/transactions', ['auth' => 'staff'], function ($ctx) use ($db) {
        $b = $ctx['body'];
        $customerId = !empty($b['customerId']) ? V::int($b['customerId'], 'Customer', 1) : null;
        if ($customerId && $db->val('SELECT 1 FROM customers WHERE id = ? AND active = 1', [$customerId]) === null) throw not_found('Customer tidak ditemukan / nonaktif');
        $payment = V::oneOf($b['payment'] ?? null, 'Metode bayar', get_options($db)['payments']);
        $date = null;
        if (!empty($b['date']) && $b['date'] !== app_today()) {
            if ($ctx['auth']['role'] !== 'admin') throw forbidden('Hanya admin yang bisa mencatat transaksi tanggal lain');
            $date = V::date($b['date'], 'Tanggal');
            if ($date > app_today()) throw bad('Tanggal tidak boleh di masa depan');
        }
        $sale = $db->tx(function () use ($db, $b, $customerId, $payment, $date, $ctx) {
            [$lines, $subtotal] = price_lines($db, $b['items'] ?? null, true);
            return create_sale($db, ['customerId' => $customerId, 'lines' => $lines, 'subtotal' => $subtotal, 'payment' => $payment, 'voucherCode' => $b['voucherCode'] ?? null, 'date' => $date, 'staffId' => $ctx['auth']['id'], 'source' => 'pos']);
        });
        audit($db, $ctx['auth'], 'transaksi', $sale['code'], ['total' => $sale['total'], 'poin' => $sale['pointsEarned'], 'customer' => $sale['customer']['memberCode'] ?? null], $ctx['ip']);
        return $sale;
    });

    $r->post('/api/staff/transactions/:id/void', ['auth' => 'admin'], function ($ctx) use ($db) {
        $reason = V::str($ctx['body']['reason'] ?? null, 'Alasan pembatalan', 3, 200);
        $t = void_transaction($db, V::int($ctx['params']['id'], 'ID', 1), $reason, $ctx['auth']['id']);
        audit($db, $ctx['auth'], 'batal_transaksi', $t['code'], ['reason' => $reason, 'poinDitarik' => $t['pointsEarned']], $ctx['ip']);
        return $t;
    });

    $r->get('/api/staff/vouchers/:code', ['auth' => 'staff'], function ($ctx) use ($db) {
        expire_vouchers($db);
        $row = $db->one('SELECT v.*, c.name customer_name, c.member_code FROM vouchers v JOIN customers c ON c.id = v.customer_id WHERE v.code = ?', [strtoupper(substr($ctx['params']['code'], 0, 20))]);
        if (!$row) throw not_found('Voucher tidak ditemukan');
        return voucher_dto($row) + ['customer' => ['id' => i($row['customer_id']), 'name' => $row['customer_name'], 'memberCode' => $row['member_code']]];
    });

    // ---------- Pesanan ----------
    $r->get('/api/staff/orders', ['auth' => 'staff'], function ($ctx) use ($db) {
        $where = ($ctx['query']['scope'] ?? 'active') === 'active' ? "WHERE status IN ('pending','processing','ready')" : '';
        return array_map(fn($o) => order_dto($db, $o), $db->all("SELECT * FROM orders $where ORDER BY id DESC LIMIT 200"));
    });
    $r->post('/api/staff/orders/:id/status', ['auth' => 'staff'], function ($ctx) use ($db) {
        $b = $ctx['body'];
        $next = V::oneOf($b['status'] ?? null, 'Status', ['processing', 'ready', 'completed', 'cancelled']);
        $payment = !empty($b['payment']) ? V::oneOf($b['payment'], 'Metode bayar', get_options($db)['payments']) : null;
        $reason = V::str($b['reason'] ?? null, 'Alasan', 0, 200, false);
        $o = set_order_status($db, V::int($ctx['params']['id'], 'ID', 1), $next, ['payment' => $payment, 'reason' => $reason, 'staffId' => $ctx['auth']['id']]);
        audit($db, $ctx['auth'], 'status_pesanan', $o['code'], ['status' => $next], $ctx['ip']);
        return $o;
    });

    // ---------- Menu & kategori ----------
    $r->get('/api/staff/menu', ['auth' => 'staff'], fn() => ['categories' => $categories(true), 'menu' => $menuAll()]);

    $imageField = function (mixed $x): ?string {
        if ($x === null || $x === '') return null;
        if (!is_string($x) || !preg_match('#^/?uploads/[a-f0-9]{32}\.(png|jpg|webp)$#', $x)) throw bad('Gambar tidak valid');
        return $x;
    };
    $menuInput = function (array $b, bool $partial) use ($db, $imageField): array {
        $out = []; $has = fn($k) => array_key_exists($k, $b);
        if (!$partial || $has('name')) $out['name'] = V::str($b['name'] ?? null, 'Nama menu', 2, 60);
        if (!$partial || $has('price')) $out['price'] = V::int($b['price'] ?? null, 'Harga', 0, 10000000);
        if (!$partial || $has('categoryId')) {
            $out['category_id'] = V::int($b['categoryId'] ?? null, 'Kategori', 1);
            if ($db->val('SELECT 1 FROM categories WHERE id = ?', [$out['category_id']]) === null) throw bad('Kategori tidak ditemukan');
        }
        if ($has('description')) $out['description'] = V::str($b['description'], 'Deskripsi', 0, 240, false);
        if ($has('image')) $out['image'] = $imageField($b['image']);
        if ($has('temp')) $out['temp'] = V::oneOf($b['temp'] ?: null, 'Suhu', ['hot', 'cold', null]);
        if ($has('featured')) $out['featured'] = $b['featured'] ? 1 : 0;
        if ($has('available')) $out['available'] = $b['available'] ? 1 : 0;
        if ($has('sort')) $out['sort'] = V::int($b['sort'], 'Urutan', 0, 100000);
        return $out;
    };

    $r->post('/api/staff/menu', ['auth' => 'admin'], function ($ctx) use ($db, $menuInput, $menuDto) {
        $data = $menuInput($ctx['body'], false);
        $base = trim(preg_replace('/\s+/', ' ', preg_replace('/[^A-Z0-9 ]/', '', strtoupper($data['name'])) ?? '')) ?: 'MENU';
        $code = $base;
        for ($k = 2; $db->val('SELECT 1 FROM menu_items WHERE code = ?', [$code]) !== null; $k++) $code = "$base $k";
        $data['code'] = $code;
        $data['sort'] ??= i($db->val('SELECT COALESCE(MAX(sort),0) FROM menu_items')) + 1;
        $data['created_at'] = $data['updated_at'] = now_sql();
        $id = $db->insert('INSERT INTO menu_items(' . implode(',', array_keys($data)) . ') VALUES (' . in_marks($data) . ')', array_values($data));
        audit($db, $ctx['auth'], 'tambah_menu', $data['name'], ['price' => $data['price']], $ctx['ip']);
        return $menuDto($db->one('SELECT * FROM menu_items WHERE id = ?', [$id]));
    });

    $r->patch('/api/staff/menu/:id', ['auth' => 'staff'], function ($ctx) use ($db, $menuInput, $menuDto) {
        $id = V::int($ctx['params']['id'], 'ID', 1);
        $row = $db->one('SELECT * FROM menu_items WHERE id = ? AND archived = 0', [$id]);
        if (!$row) throw not_found('Menu tidak ditemukan');
        if ($ctx['auth']['role'] !== 'admin' && array_diff(array_keys($ctx['body']), ['available'])) throw forbidden('Kasir hanya bisa mengubah status stok (tersedia/habis)');
        $data = $menuInput($ctx['body'], true);
        if (!$data) throw bad('Tidak ada perubahan');
        $data['updated_at'] = now_sql();
        $db->run('UPDATE menu_items SET ' . implode(', ', array_map(fn($k) => "$k = ?", array_keys($data))) . ' WHERE id = ?', array_merge(array_values($data), [$id]));
        audit($db, $ctx['auth'], 'ubah_menu', $row['name'], $data, $ctx['ip']);
        return $menuDto($db->one('SELECT * FROM menu_items WHERE id = ?', [$id]));
    });

    $r->delete('/api/staff/menu/:id', ['auth' => 'admin'], function ($ctx) use ($db) {
        $id = V::int($ctx['params']['id'], 'ID', 1);
        $row = $db->one('SELECT * FROM menu_items WHERE id = ?', [$id]);
        if (!$row) throw not_found('Menu tidak ditemukan');
        $db->run('UPDATE menu_items SET archived = 1, featured = 0, updated_at = ? WHERE id = ?', [now_sql(), $id]);
        audit($db, $ctx['auth'], 'hapus_menu', $row['name'], null, $ctx['ip']);
        return ['ok' => true];
    });

    $r->post('/api/staff/categories', ['auth' => 'admin'], function ($ctx) use ($db, $categories) {
        $name = V::str($ctx['body']['name'] ?? null, 'Nama kategori', 2, 30);
        $base = trim(preg_replace('/[^a-z0-9]+/', '-', strtolower($name)) ?? '', '-') ?: 'kategori';
        $key = $base;
        for ($k = 2; $db->val('SELECT 1 FROM categories WHERE cat_key = ?', [$key]) !== null; $k++) $key = "$base-$k";
        $db->run('INSERT INTO categories(cat_key, name, sort) VALUES (?,?,?)', [$key, $name, i($db->val('SELECT COALESCE(MAX(sort),0) FROM categories')) + 1]);
        audit($db, $ctx['auth'], 'tambah_kategori', $name, null, $ctx['ip']);
        return $categories(true);
    });
    $r->patch('/api/staff/categories/:id', ['auth' => 'admin'], function ($ctx) use ($db, $categories) {
        $id = V::int($ctx['params']['id'], 'ID', 1);
        $row = $db->one('SELECT * FROM categories WHERE id = ?', [$id]);
        if (!$row) throw not_found('Kategori tidak ditemukan');
        $b = $ctx['body'];
        $name = array_key_exists('name', $b) ? V::str($b['name'], 'Nama kategori', 2, 30) : $row['name'];
        $sort = array_key_exists('sort', $b) ? V::int($b['sort'], 'Urutan', 0, 1000) : i($row['sort']);
        $active = array_key_exists('active', $b) ? ($b['active'] ? 1 : 0) : i($row['active']);
        $db->run('UPDATE categories SET name = ?, sort = ?, active = ? WHERE id = ?', [$name, $sort, $active, $id]);
        audit($db, $ctx['auth'], 'ubah_kategori', $name, ['sort' => $sort, 'active' => $active], $ctx['ip']);
        return $categories(true);
    });
    $r->delete('/api/staff/categories/:id', ['auth' => 'admin'], function ($ctx) use ($db, $categories) {
        $id = V::int($ctx['params']['id'], 'ID', 1);
        if ($db->val('SELECT 1 FROM menu_items WHERE category_id = ? AND archived = 0', [$id]) !== null) throw conflict('Kategori masih berisi menu. Pindahkan atau hapus menunya dulu.');
        $db->run('DELETE FROM categories WHERE id = ?', [$id]);
        audit($db, $ctx['auth'], 'hapus_kategori', (string)$id, null, $ctx['ip']);
        return $categories(true);
    });

    // ---------- Rewards ----------
    $r->get('/api/staff/rewards', ['auth' => 'staff'], fn() => $rewardsAll(true));
    $rewardInput = function (array $b, bool $partial) use ($db, $imageField): array {
        $l = get_loyalty($db); $out = []; $has = fn($k) => array_key_exists($k, $b);
        if (!$partial || $has('name')) $out['name'] = V::str($b['name'] ?? null, 'Nama reward', 2, 60);
        if ($has('description')) $out['description'] = V::str($b['description'], 'Deskripsi', 0, 200, false);
        if (!$partial || $has('pointsCost')) $out['points_cost'] = V::int($b['pointsCost'] ?? null, 'Harga poin', 1, 1000000);
        if ($has('minTier')) $out['min_tier'] = $b['minTier'] ? V::oneOf($b['minTier'], 'Minimal level', array_column($l['tiers'], 'key')) : null;
        if ($has('stock')) $out['stock'] = ($b['stock'] === null || $b['stock'] === '') ? null : V::int($b['stock'], 'Stok', 0, 1000000);
        if (!$partial || $has('type')) $out['type'] = V::oneOf($b['type'] ?? null, 'Jenis reward', ['free_item', 'discount_amount', 'discount_percent']);
        if ($has('value')) $out['value'] = V::int($b['value'] ?? 0, 'Nilai', 0, 10000000);
        if ($has('menuItemId')) $out['menu_item_id'] = $b['menuItemId'] ? V::int($b['menuItemId'], 'Menu', 1) : null;
        if ($has('validDays')) $out['valid_days'] = V::int($b['validDays'], 'Masa berlaku', 1, 365);
        if ($has('image')) $out['image'] = $imageField($b['image']);
        if ($has('active')) $out['active'] = $b['active'] ? 1 : 0;
        if ($has('sort')) $out['sort'] = V::int($b['sort'], 'Urutan', 0, 100000);
        $t = $out['type'] ?? null;
        if ($t === 'free_item' && empty($out['menu_item_id']) && !$partial) throw bad('Pilih menu yang digratiskan');
        if ($t === 'discount_percent' && ($out['value'] ?? 0) > 100) throw bad('Diskon persen maksimal 100');
        if ($t && $t !== 'free_item' && !$partial && empty($out['value'])) throw bad('Isi nilai diskon');
        return $out;
    };
    $r->post('/api/staff/rewards', ['auth' => 'admin'], function ($ctx) use ($db, $rewardInput) {
        $data = $rewardInput($ctx['body'], false);
        $data['created_at'] = now_sql();
        $id = $db->insert('INSERT INTO rewards(' . implode(',', array_keys($data)) . ') VALUES (' . in_marks($data) . ')', array_values($data));
        audit($db, $ctx['auth'], 'tambah_reward', $data['name'], ['poin' => $data['points_cost']], $ctx['ip']);
        return reward_dto($db->one('SELECT * FROM rewards WHERE id = ?', [$id]));
    });
    $r->patch('/api/staff/rewards/:id', ['auth' => 'admin'], function ($ctx) use ($db, $rewardInput) {
        $id = V::int($ctx['params']['id'], 'ID', 1);
        if ($db->val('SELECT 1 FROM rewards WHERE id = ? AND archived = 0', [$id]) === null) throw not_found('Reward tidak ditemukan');
        $data = $rewardInput($ctx['body'], true);
        if (!$data) throw bad('Tidak ada perubahan');
        $db->run('UPDATE rewards SET ' . implode(', ', array_map(fn($k) => "$k = ?", array_keys($data))) . ' WHERE id = ?', array_merge(array_values($data), [$id]));
        audit($db, $ctx['auth'], 'ubah_reward', (string)$id, $data, $ctx['ip']);
        return reward_dto($db->one('SELECT * FROM rewards WHERE id = ?', [$id]));
    });
    $r->delete('/api/staff/rewards/:id', ['auth' => 'admin'], function ($ctx) use ($db) {
        $id = V::int($ctx['params']['id'], 'ID', 1);
        $db->run('UPDATE rewards SET archived = 1, active = 0 WHERE id = ?', [$id]);
        audit($db, $ctx['auth'], 'hapus_reward', (string)$id, null, $ctx['ip']);
        return ['ok' => true];
    });

    // ---------- Pengaturan ----------
    $r->get('/api/staff/settings', ['auth' => 'staff'], fn() => ['loyalty' => get_loyalty($db), 'appearance' => get_appearance($db), 'options' => get_options($db)]);

    $r->put('/api/staff/settings/loyalty', ['auth' => 'admin'], function ($ctx) use ($db) {
        $b = $ctx['body']; $cur = get_loyalty($db);
        if (!is_array($b['tiers'] ?? null) || count($b['tiers']) < 1 || count($b['tiers']) > 8) throw bad('Jumlah level harus 1–8');
        $keys = []; $tiers = [];
        foreach (array_values($b['tiers']) as $n => $t) {
            if (!is_array($t)) throw bad('Data level tidak valid');
            $name = V::str($t['name'] ?? null, 'Nama level #' . ($n + 1), 2, 20);
            $key = !empty($t['key']) ? V::str($t['key'], 'Kode level', 0, 20, true, '/^[a-z0-9-]+$/') : trim(preg_replace('/[^a-z0-9]+/', '-', strtolower($name)) ?? '', '-');
            while (in_array($key, $keys, true)) $key .= '-2';
            $keys[] = $key;
            $benefits = [];
            foreach (array_slice(is_array($t['benefits'] ?? null) ? $t['benefits'] : [], 0, 6) as $x) if ($x !== '' && $x !== null) $benefits[] = V::str($x, 'Benefit', 0, 80);
            $tiers[] = ['key' => $key, 'name' => $name, 'minSpend' => V::int($t['minSpend'] ?? null, "Minimal belanja $name", 0, 10000000000),
                'multiplier' => V::num($t['multiplier'] ?? 1, "Pengali poin $name", 0.5, 5), 'color' => V::color($t['color'] ?? '#8A8F9C', "Warna $name"), 'benefits' => $benefits];
        }
        $tiers = sorted_tiers($tiers);
        if ($tiers[0]['minSpend'] !== 0) throw bad('Level pertama harus mulai dari Rp0');
        if (count(array_unique(array_column($tiers, 'minSpend'))) !== count($tiers)) throw bad('Minimal belanja tiap level harus berbeda');
        $next = array_replace($cur, [
            'rupiahPerPoint' => V::int($b['rupiahPerPoint'] ?? null, 'Rupiah per poin', 100, 10000000),
            'inactiveDays' => V::int($b['inactiveDays'] ?? null, 'Hari tidak aktif', 1, 3650),
            'tierBasis' => V::oneOf($b['tierBasis'] ?? 'lifetime', 'Dasar level', ['lifetime', 'rolling365']),
            'voucherValidDays' => V::int($b['voucherValidDays'] ?? ($cur['voucherValidDays'] ?? 30), 'Masa berlaku voucher', 1, 365),
            'tiers' => $tiers,
        ]);
        set_setting($db, 'loyalty', $next);
        audit($db, $ctx['auth'], 'ubah_aturan_loyalty', 'loyalty', ['rupiahPerPoint' => $next['rupiahPerPoint'], 'tiers' => array_map(fn($t) => $t['name'] . '>=' . $t['minSpend'], $tiers)], $ctx['ip']);
        return $next;
    });

    $r->put('/api/staff/settings/appearance', ['auth' => 'admin'], function ($ctx) use ($db, $imageField) {
        $b = $ctx['body'];
        $allowed = array_column(default_appearance()['homeSections'], 'key');
        $seen = []; $sections = [];
        foreach (is_array($b['homeSections'] ?? null) ? $b['homeSections'] : [] as $s) {
            $k = is_array($s) ? ($s['key'] ?? null) : null;
            if (!in_array($k, $allowed, true) || in_array($k, $seen, true)) continue;
            $seen[] = $k; $sections[] = ['key' => $k, 'visible' => !empty($s['visible'])];
        }
        foreach ($allowed as $k) if (!in_array($k, $seen, true)) $sections[] = ['key' => $k, 'visible' => false];
        $banners = [];
        foreach (array_slice(is_array($b['banners'] ?? null) ? $b['banners'] : [], 0, 8) as $n => $x) {
            if (!is_array($x)) continue;
            $banners[] = ['id' => V::str($x['id'] ?? ('b' . ($n + 1)), 'ID banner', 0, 20, true, '/^[a-z0-9-]+$/i'), 'title' => V::str($x['title'] ?? null, 'Judul banner', 1, 60),
                'subtitle' => V::str($x['subtitle'] ?? null, 'Subjudul banner', 0, 120, false) ?? '', 'color' => V::color($x['color'] ?? '#1E2A5A', 'Warna banner'),
                'image' => $imageField($x['image'] ?? null), 'active' => ($x['active'] ?? true) !== false];
        }
        $c = is_array($b['colors'] ?? null) ? $b['colors'] : [];
        $next = [
            'brandName' => V::str($b['brandName'] ?? null, 'Nama brand', 1, 40), 'tagline' => V::str($b['tagline'] ?? null, 'Tagline', 0, 80, false) ?? '',
            'logoText' => V::str($b['logoText'] ?? null, 'Teks logo', 1, 3), 'logoImage' => $imageField($b['logoImage'] ?? null),
            'theme' => V::str($b['theme'] ?? 'custom', 'Tema', 0, 20, true, '/^[a-z0-9-]+$/'),
            'colors' => ['primary' => V::color($c['primary'] ?? null, 'Warna utama'), 'accent' => V::color($c['accent'] ?? null, 'Warna aksen'), 'bg' => V::color($c['bg'] ?? null, 'Warna latar'),
                'surface' => V::color($c['surface'] ?? null, 'Warna kartu'), 'text' => V::color($c['text'] ?? null, 'Warna teks')],
            'radius' => V::oneOf($b['radius'] ?? null, 'Sudut', ['sharp', 'soft', 'round']), 'font' => V::oneOf($b['font'] ?? null, 'Font', ['jakarta', 'system', 'serif']),
            'menuLayout' => V::oneOf($b['menuLayout'] ?? null, 'Tampilan menu', ['list', 'grid', 'large']),
            'homeSections' => $sections, 'banners' => $banners, 'orderingEnabled' => !empty($b['orderingEnabled']),
            'pickupNote' => V::str($b['pickupNote'] ?? null, 'Info pengambilan', 0, 120, false) ?? '', 'announcement' => V::str($b['announcement'] ?? null, 'Pengumuman', 0, 160, false) ?? '',
        ];
        set_setting($db, 'appearance', $next);
        audit($db, $ctx['auth'], 'ubah_tampilan', 'appearance', ['theme' => $next['theme'], 'menuLayout' => $next['menuLayout']], $ctx['ip']);
        return $next;
    });

    $r->put('/api/staff/settings/options', ['auth' => 'admin'], function ($ctx) use ($db) {
        $list = function (mixed $x, string $name) {
            if (!is_array($x) || !$x || count($x) > 20) throw bad("Daftar $name harus berisi 1–20 pilihan");
            return array_values(array_unique(array_map(fn($s) => V::str($s, $name, 0, 30), $x)));
        };
        $next = ['genders' => $list($ctx['body']['genders'] ?? null, 'gender'), 'sources' => $list($ctx['body']['sources'] ?? null, 'sumber'), 'payments' => $list($ctx['body']['payments'] ?? null, 'metode bayar')];
        set_setting($db, 'options', $next);
        audit($db, $ctx['auth'], 'ubah_pilihan', 'options', $next, $ctx['ip']);
        return $next;
    });

    // ---------- Upload gambar ----------
    $r->post('/api/staff/upload', ['auth' => 'admin', 'limit' => 2200000], function ($ctx) use ($db, $env) {
        if (!preg_match('#^data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$#', (string)($ctx['body']['dataUrl'] ?? ''), $m)) throw bad('Format gambar harus PNG, JPG, atau WEBP');
        $buf = base64_decode($m[2], true);
        if ($buf === false || strlen($buf) > 1500000) throw bad('Ukuran gambar maksimal 1,5 MB');
        $ext = str_starts_with($buf, "\x89PNG") ? 'png' : (str_starts_with($buf, "\xFF\xD8\xFF") ? 'jpg' : ((substr($buf, 0, 4) === 'RIFF' && substr($buf, 8, 4) === 'WEBP') ? 'webp' : null));
        if (!$ext || @getimagesizefromstring($buf) === false) throw bad('Isi file bukan gambar yang valid');
        $name = bin2hex(random_bytes(16)) . ".$ext";
        if (!is_dir($env['uploadsDir'])) @mkdir($env['uploadsDir'], 0755, true);
        if (file_put_contents($env['uploadsDir'] . '/' . $name, $buf) === false) throw new HttpError(500, 'Gagal menyimpan gambar. Periksa izin folder uploads.', 'server_error');
        audit($db, $ctx['auth'], 'upload_gambar', $name, ['bytes' => strlen($buf)], $ctx['ip']);
        return ['url' => 'uploads/' . $name];
    });

    // ---------- Akun staf ----------
    $staffDto = fn(array $u) => ['id' => i($u['id']), 'username' => $u['username'], 'name' => $u['name'], 'role' => $u['role'], 'active' => (bool)i($u['active']), 'lastLoginAt' => $u['last_login_at'], 'createdAt' => $u['created_at']];
    $r->get('/api/staff/users', ['auth' => 'admin'], fn() => array_map($staffDto, $db->all('SELECT * FROM staff ORDER BY id')));
    $r->post('/api/staff/users', ['auth' => 'admin'], function ($ctx) use ($db, $staffDto) {
        $b = $ctx['body'];
        $username = V::str($b['username'] ?? null, 'Username', 3, 30, true, '/^[a-z0-9_.]+$/');
        if ($db->val('SELECT 1 FROM staff WHERE username = ?', [$username]) !== null) throw conflict('Username sudah dipakai');
        $id = $db->insert('INSERT INTO staff(username, name, role, password_hash, must_change_password, created_at) VALUES (?,?,?,?,1,?)',
            [$username, V::str($b['name'] ?? null, 'Nama', 2, 60), V::oneOf($b['role'] ?? null, 'Peran', ['admin', 'kasir']), hash_password(V::password($b['password'] ?? null)), now_sql()]);
        audit($db, $ctx['auth'], 'tambah_staf', $username, ['role' => $b['role']], $ctx['ip']);
        return $staffDto($db->one('SELECT * FROM staff WHERE id = ?', [$id]));
    });
    $r->patch('/api/staff/users/:id', ['auth' => 'admin'], function ($ctx) use ($db, $staffDto) {
        $id = V::int($ctx['params']['id'], 'ID', 1);
        $u = $db->one('SELECT * FROM staff WHERE id = ?', [$id]);
        if (!$u) throw not_found('Akun staf tidak ditemukan');
        $b = $ctx['body'];
        $role = array_key_exists('role', $b) ? V::oneOf($b['role'], 'Peran', ['admin', 'kasir']) : $u['role'];
        $active = array_key_exists('active', $b) ? ($b['active'] ? 1 : 0) : i($u['active']);
        $name = array_key_exists('name', $b) ? V::str($b['name'], 'Nama', 2, 60) : $u['name'];
        if ($id === $ctx['auth']['id'] && ($role !== 'admin' || !$active)) throw bad('Anda tidak bisa menonaktifkan atau menurunkan akun sendiri');
        $admins = i($db->val("SELECT COUNT(*) FROM staff WHERE role = 'admin' AND active = 1 AND id != ?", [$id]));
        if ($u['role'] === 'admin' && ($role !== 'admin' || !$active) && $admins === 0) throw bad('Harus ada minimal satu admin aktif');
        $sql = 'UPDATE staff SET name = ?, role = ?, active = ?'; $args = [$name, $role, $active];
        if (!empty($b['password'])) { $sql .= ', password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL'; $args[] = hash_password(V::password($b['password'])); }
        $db->run("$sql WHERE id = ?", array_merge($args, [$id]));
        if (!$active || !empty($b['password'])) $db->run("DELETE FROM sessions WHERE kind = 'staff' AND subject_id = ?", [$id]);
        audit($db, $ctx['auth'], 'ubah_staf', $u['username'], ['role' => $role, 'active' => (bool)$active, 'resetPassword' => !empty($b['password'])], $ctx['ip']);
        return $staffDto($db->one('SELECT * FROM staff WHERE id = ?', [$id]));
    });

    // ---------- Log aktivitas ----------
    $r->get('/api/staff/audit', ['auth' => 'admin'], fn() => array_map(fn($a) => ['id' => i($a['id']), 'actorKind' => $a['actor_kind'], 'actorName' => $a['actor_name'], 'action' => $a['action'],
        'target' => $a['target'], 'detail' => $a['detail'] ? json_decode($a['detail'], true) : null, 'ip' => $a['ip'], 'createdAt' => $a['created_at']], $db->all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300')));

    // ---------- Ekspor CSV ----------
    $csvCell = function (mixed $x): string {
        $s = $x === null ? '' : (string)$x;
        if (preg_match('/^[=+\-@\t\r]/', $s)) $s = "'" . $s;
        return preg_match('/[",;\n]/', $s) ? '"' . str_replace('"', '""', $s) . '"' : $s;
    };
    $toCsv = fn(array $rows) => "\xEF\xBB\xBF" . implode("\r\n", array_map(fn($r2) => implode(',', array_map($csvCell, $r2)), $rows));
    $label = ['aktif' => 'AKTIF', 'tidak_aktif' => 'TIDAK AKTIF', 'belum_beli' => 'BELUM PERNAH BELI'];
    $r->get('/api/staff/export/customers.csv', ['auth' => 'admin', 'raw' => true], function ($ctx) use ($db, $toCsv, $label) {
        $rows = [['ID', 'NAMA CUSTOMER', 'NOMER WHATSAPP', 'DATE', 'GENDER', 'SOURCE', 'MENU FAVORITE', 'CATATAN', 'TOTAL KUNJUNGAN', 'TOTAL BELANJA', 'KUNJUNGAN TERAKHIR', 'LEVEL MEMBER', 'POIN', 'STATUS']];
        foreach (list_customers($db) as $c) $rows[] = [$c['memberCode'], $c['name'], $c['phone'], $c['joinedAt'], $c['gender'], $c['source'], $c['favoriteNote'] ?: $c['stats']['favoriteMenu'], $c['note'],
            $c['stats']['visits'], $c['stats']['totalSpend'], $c['stats']['lastVisit'], strtoupper($c['stats']['tier']['name']), $c['stats']['points'], $label[$c['stats']['status']]];
        audit($db, $ctx['auth'], 'ekspor_customer', 'csv', null, $ctx['ip']);
        return ['type' => 'text/csv; charset=utf-8', 'filename' => 'customer-' . app_today() . '.csv', 'body' => $toCsv($rows)];
    });
    $r->get('/api/staff/export/transactions.csv', ['auth' => 'admin', 'raw' => true], function ($ctx) use ($db, $toCsv) {
        $rows = [['ID TRANSAKSI', 'TANGGAL', 'ID CUSTOMER', 'NAMA CUSTOMER', 'MENU', 'JUMLAH', 'TOTAL RP', 'DISKON', 'PAYMENT', 'POIN', 'STATUS', 'SUMBER']];
        foreach (list_transactions($db, ['limit' => 100000]) as $t) $rows[] = [$t['code'], $t['date'], $t['customer']['memberCode'] ?? null, $t['customer']['name'] ?? null,
            implode('; ', array_map(fn($x) => "{$x['name']} x{$x['qty']}", $t['items'])), array_sum(array_column($t['items'], 'qty')), $t['total'], $t['discount'], $t['payment'], $t['pointsEarned'], $t['status'] === 'void' ? 'BATAL' : 'LUNAS', $t['source']];
        audit($db, $ctx['auth'], 'ekspor_transaksi', 'csv', null, $ctx['ip']);
        return ['type' => 'text/csv; charset=utf-8', 'filename' => 'transaksi-' . app_today() . '.csv', 'body' => $toCsv($rows)];
    });
}
