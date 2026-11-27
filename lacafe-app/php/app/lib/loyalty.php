<?php
// Rumus loyalty (padanan public/assets/js/loyalty.js). Sama dengan rumus Excel:
//   POIN = INT(total belanja / rupiah per poin), LEVEL dari total belanja, STATUS aktif jika kunjungan terakhir <= N hari.
declare(strict_types=1);

const DEFAULT_LOYALTY = [
    'rupiahPerPoint' => 10000,
    'inactiveDays' => 30,
    'tierBasis' => 'lifetime',
    'voucherValidDays' => 30,
    'memberPrefix' => 'LC',
    'trxPrefix' => 'TL',
    'tiers' => [
        ['key' => 'reguler', 'name' => 'Reguler', 'minSpend' => 0, 'multiplier' => 1, 'color' => '#8A8F9C', 'benefits' => ['1 poin setiap Rp10.000', 'Akses katalog rewards']],
        ['key' => 'silver', 'name' => 'Silver', 'minSpend' => 500000, 'multiplier' => 1, 'color' => '#9BA7B4', 'benefits' => ['Semua benefit Reguler', 'Rewards khusus Silver']],
        ['key' => 'gold', 'name' => 'Gold', 'minSpend' => 1500000, 'multiplier' => 1, 'color' => '#C9A227', 'benefits' => ['Semua benefit Silver', 'Rewards khusus Gold', 'Prioritas promo']],
    ],
];

function sorted_tiers(array $tiers): array
{
    usort($tiers, fn($a, $b) => $a['minSpend'] <=> $b['minSpend']);
    return $tiers;
}

function tier_for(int $spend, array $tiers): array
{
    $list = sorted_tiers($tiers);
    $cur = $list[0] ?? ['key' => 'reguler', 'name' => 'Reguler', 'minSpend' => 0, 'multiplier' => 1, 'color' => '#8A8F9C', 'benefits' => []];
    foreach ($list as $t) if ($spend >= $t['minSpend']) $cur = $t;
    return $cur;
}

function next_tier_for(int $spend, array $tiers): ?array
{
    foreach (sorted_tiers($tiers) as $t) if ($t['minSpend'] > $spend) return $t;
    return null;
}

function tier_rank(?string $key, array $tiers): int
{
    foreach (array_values(sorted_tiers($tiers)) as $i => $t) if ($t['key'] === $key) return $i;
    return -1;
}

/** Poin kumulatif: sisa rupiah tidak hangus antar transaksi (total = INT(total belanja / rate), sama dengan Excel). */
function points_for_purchase(int $spendBefore, int $amount, array $loyalty, ?array $tierAtPurchase): int
{
    $rate = max(1, (int)($loyalty['rupiahPerPoint'] ?? 10000));
    $base = intdiv($spendBefore + $amount, $rate) - intdiv($spendBefore, $rate);
    $mult = (float)($tierAtPurchase['multiplier'] ?? 1) ?: 1.0;
    return max(0, (int)floor($base * $mult));
}

function days_between(string $from, string $to): int
{
    return (int)round((strtotime($to . ' 00:00:00 UTC') - strtotime($from . ' 00:00:00 UTC')) / 86400);
}

function status_for(?string $lastVisit, string $today, int $inactiveDays): string
{
    if (!$lastVisit) return 'belum_beli';
    return days_between($lastVisit, $today) <= $inactiveDays ? 'aktif' : 'tidak_aktif';
}

function build_stats(array $raw, array $loyalty, string $today): array
{
    $tierSpend = (int)($raw['tierSpend'] ?? $raw['totalSpend'] ?? 0);
    $tier = tier_for($tierSpend, $loyalty['tiers']);
    $next = next_tier_for($tierSpend, $loyalty['tiers']);
    $toNext = $next ? $next['minSpend'] - $tierSpend : 0;
    $span = $next ? max(1, $next['minSpend'] - $tier['minSpend']) : 1;
    $progress = $next ? min(1, max(0, ($tierSpend - $tier['minSpend']) / $span)) : 1;
    return [
        'totalSpend' => (int)($raw['totalSpend'] ?? 0),
        'tierSpend' => $tierSpend,
        'visits' => (int)($raw['visits'] ?? 0),
        'lastVisit' => $raw['lastVisit'] ?? null,
        'firstVisit' => $raw['firstVisit'] ?? null,
        'points' => (int)($raw['points'] ?? 0),
        'favoriteMenu' => $raw['favoriteMenu'] ?? null,
        'tier' => $tier,
        'nextTier' => $next,
        'toNext' => $toNext,
        'progress' => $progress,
        'status' => status_for($raw['lastVisit'] ?? null, $today, (int)$loyalty['inactiveDays']),
    ];
}

/** Potongan voucher. -1 berarti item gratis belum ada di keranjang. */
function voucher_discount(array $v, array $lines, int $subtotal): int
{
    $val = (int)($v['value'] ?? 0);
    if ($v['type'] === 'discount_amount') return min($subtotal, max(0, $val));
    if ($v['type'] === 'discount_percent') return min($subtotal, intdiv($subtotal * min(100, max(0, $val)), 100));
    if ($v['type'] === 'free_item') {
        foreach ($lines as $l) if ((int)$l['menuItemId'] === (int)$v['menuItemId']) return min($subtotal, (int)$l['price']);
        return -1;
    }
    return 0;
}

function today_in(string $tz): string
{
    return (new DateTimeImmutable('now', new DateTimeZone($tz)))->format('Y-m-d');
}

function shift_date(string $iso, int $days): string
{
    return gmdate('Y-m-d', strtotime($iso . ' 00:00:00 UTC') + $days * 86400);
}
