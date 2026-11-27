<?php
// Mengisi database baru dari data/seed.json (hasil konversi Excel). Dipanggil oleh install.php.
declare(strict_types=1);

function nice_label(?string $s, bool $titleAll = false): ?string
{
    if ($s === null || trim($s) === '') return null;
    $acr = ['BCA', 'QR', 'QRIS', 'BNI', 'BRI', 'OVO', 'ATM'];
    $words = preg_split('/\s+/', trim($s));
    foreach ($words as $n => $w) {
        if (in_array(strtoupper($w), $acr, true)) $words[$n] = strtoupper($w);
        elseif ($n === 0 || $titleAll) $words[$n] = mb_strtoupper(mb_substr($w, 0, 1)) . mb_strtolower(mb_substr($w, 1));
        else $words[$n] = mb_strtolower($w);
    }
    return implode(' ', $words);
}

function create_schema(DB $db): array
{
    foreach (schema_statements($db->driver) as $sql) $db->pdo->exec($sql);
    $warnings = [];
    foreach (ledger_triggers($db->driver) as $sql) {
        try { $db->pdo->exec($sql); } catch (Throwable $e) { $warnings[] = 'Trigger pengaman buku besar poin tidak bisa dibuat (' . $e->getMessage() . '). Aplikasi tetap aman karena kode tidak pernah mengubah riwayat poin.'; break; }
    }
    $db->run("INSERT INTO meta(name, value) VALUES ('schema_version', '1')");
    return $warnings;
}

function seed_database(DB $db, ?string $seedFile, string $adminPassword, bool $mustChange): array
{
    $data = ($seedFile && is_file($seedFile)) ? json_decode((string)file_get_contents($seedFile), true) : null;
    $data = is_array($data) ? $data : ['menu' => [], 'customers' => [], 'transactions' => []];
    return $db->tx(function () use ($db, $data, $adminPassword, $mustChange) {
        $loyalty = DEFAULT_LOYALTY;
        if (!empty($data['settings'])) {
            $loyalty['rupiahPerPoint'] = (int)($data['settings']['rupiahPerPoint'] ?? 10000);
            $loyalty['inactiveDays'] = (int)($data['settings']['inactiveDays'] ?? 30);
            foreach ($data['settings']['tiers'] ?? [] as $t) foreach ($loyalty['tiers'] as &$cur) if ($cur['key'] === $t['key']) $cur['minSpend'] = (int)$t['minSpend'];
            unset($cur);
        }
        set_setting($db, 'loyalty', $loyalty);
        set_setting($db, 'appearance', default_appearance());
        $opts = default_options();
        if (!empty($data['options']['payments'])) $opts['payments'] = array_values(array_unique(array_merge(array_map(fn($p) => nice_label($p, true), $data['options']['payments']), ['QRIS'])));
        if (!empty($data['options']['sources'])) $opts['sources'] = array_values(array_map(fn($p) => nice_label($p), $data['options']['sources']));
        set_setting($db, 'options', $opts);

        $catId = [];
        foreach (DEFAULT_CATEGORIES as [$key, $name, $sort]) $catId[$key] = $db->insert('INSERT INTO categories(cat_key, name, sort) VALUES (?,?,?)', [$key, $name, $sort]);
        $featured = ['KOPI SUSU MALAKA', 'BUTTERSCOTCH LATTE COLD', 'V60', 'YUZU COFFEE', 'CROISSANT'];
        $byCode = [];
        foreach ($data['menu'] as $n => $m) {
            $id = $db->insert('INSERT INTO menu_items(code, name, category_id, price, temp, featured, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
                [$m['code'], $m['name'], $catId[$m['category']] ?? $catId['kopi'], (int)$m['price'], $m['temp'] ?? null, in_array($m['code'], $featured, true) ? 1 : 0, $n + 1, now_sql(), now_sql()]);
            $byCode[$m['code']] = ['id' => $id] + $m;
        }
        $R = fn($name, $desc, $cost, $tier, $type, $value, $menuCode, $days, $sort) => $db->run('INSERT INTO rewards(name, description, points_cost, min_tier, type, value, menu_item_id, valid_days, sort, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [$name, $desc, $cost, $tier, $type, $value, $menuCode ? ($byCode[$menuCode]['id'] ?? null) : null, $days, $sort, now_sql()]);
        $R('Potongan Rp10.000', 'Berlaku untuk semua menu', 20, null, 'discount_amount', 10000, null, 30, 1);
        if (isset($byCode['KOPI SUSU MALAKA'])) $R('Gratis Kopi Susu Malaka', 'Satu cup Kopi Susu Malaka', 30, null, 'free_item', 0, 'KOPI SUSU MALAKA', 30, 2);
        if (isset($byCode['CROISSANT'])) $R('Gratis Croissant', 'Teman ngopi paling pas', 25, null, 'free_item', 0, 'CROISSANT', 30, 3);
        $R('Diskon 25%', 'Khusus member Silver ke atas', 40, 'silver', 'discount_percent', 25, null, 14, 4);
        if (isset($byCode['MIX PLATTER'])) $R('Gratis Mix Platter', 'Khusus member Gold', 60, 'gold', 'free_item', 0, 'MIX PLATTER', 30, 5);

        $gender = ['male' => 'Laki-laki', 'female' => 'Perempuan', 'laki-laki' => 'Laki-laki', 'perempuan' => 'Perempuan'];
        $custId = [];
        foreach ($data['customers'] as $c) {
            $custId[$c['memberCode']] = $db->insert('INSERT INTO customers(member_code, name, phone, gender, source, favorite_note, note, joined_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
                [$c['memberCode'], $c['name'], $c['phone'] ?: null, $gender[strtolower((string)($c['gender'] ?? ''))] ?? null, nice_label($c['source'] ?? null), $c['favoriteNote'] ?? null, $c['note'] ?? null, $c['joinedAt'] ?: app_today(), now_sql()]);
        }
        $trx = $data['transactions'];
        usort($trx, fn($a, $b) => strcmp($a['date'] ?? '', $b['date'] ?? '') ?: strcmp($a['code'], $b['code']));
        foreach ($trx as $t) {
            $cid = $custId[$t['memberCode']] ?? null;
            if (!$cid) continue;
            $qtyAll = max(1, array_sum(array_column($t['items'], 'qty')));
            $lines = array_map(function ($it) use ($byCode, $t, $qtyAll) {
                $m = $byCode[$it['code']] ?? null;
                $price = count($t['items']) === 1 ? (int)round($t['total'] / $qtyAll) : (int)($m['price'] ?? 0);
                return ['menuItemId' => $m['id'] ?? null, 'name' => $m['name'] ?? $it['code'], 'price' => $price, 'qty' => (int)$it['qty'], 'lineTotal' => $price * (int)$it['qty']];
            }, $t['items']);
            create_sale($db, ['customerId' => $cid, 'lines' => $lines, 'subtotal' => (int)$t['total'], 'payment' => nice_label($t['payment'] ?? null, true), 'date' => $t['date'], 'source' => 'import', 'code' => $t['code']]);
        }
        $db->run('INSERT INTO staff(username, name, role, password_hash, must_change_password, created_at) VALUES (?,?,?,?,?,?)', ['admin', 'Pemilik', 'admin', hash_password($adminPassword), $mustChange ? 1 : 0, now_sql()]);
        audit($db, null, 'seed', $data['source'] ?? 'seed.json', ['customers' => count($data['customers']), 'transactions' => count($data['transactions']), 'menu' => count($data['menu'])]);
        return ['customers' => count($data['customers']), 'transactions' => count($data['transactions']), 'menu' => count($data['menu'])];
    });
}
