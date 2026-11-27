// Aturan loyalty yang dipakai bersama oleh server dan aplikasi.
// Server SELALU menghitung ulang; tampilan di browser hanya untuk display.
// Rumus mengikuti file Excel "DATA BASE CUSTOMER LACAFE 2026":
//   POIN   = INT(total belanja / rupiah per poin)
//   LEVEL  = total belanja >= minimum tier tertinggi yang tercapai
//   STATUS = AKTIF jika kunjungan terakhir <= N hari, selain itu TIDAK AKTIF

export const DEFAULT_LOYALTY = {
  rupiahPerPoint: 10000,
  inactiveDays: 30,
  tierBasis: 'lifetime', // 'lifetime' | 'rolling365'
  voucherValidDays: 30,
  tiers: [
    { key: 'reguler', name: 'Reguler', minSpend: 0, multiplier: 1, color: '#8A8F9C', benefits: ['1 poin setiap Rp10.000', 'Akses katalog rewards'] },
    { key: 'silver', name: 'Silver', minSpend: 500000, multiplier: 1, color: '#9BA7B4', benefits: ['Semua benefit Reguler', 'Rewards khusus Silver'] },
    { key: 'gold', name: 'Gold', minSpend: 1500000, multiplier: 1, color: '#C9A227', benefits: ['Semua benefit Silver', 'Rewards khusus Gold', 'Prioritas promo'] },
  ],
};

export function sortedTiers(tiers) {
  return [...(tiers || [])].sort((a, b) => a.minSpend - b.minSpend);
}

export function tierFor(spend, tiers) {
  const list = sortedTiers(tiers);
  let current = list[0] || { key: 'reguler', name: 'Reguler', minSpend: 0, multiplier: 1 };
  for (const t of list) if (spend >= t.minSpend) current = t;
  return current;
}

export function nextTierFor(spend, tiers) {
  return sortedTiers(tiers).find((t) => t.minSpend > spend) || null;
}

export function tierRank(key, tiers) {
  return sortedTiers(tiers).findIndex((t) => t.key === key);
}

// Poin dihitung kumulatif agar sisa rupiah tidak hangus antar transaksi:
// total poin dari belanja = INT(total belanja seumur hidup / rupiahPerPoint) — identik dengan Excel.
export function pointsForPurchase(spendBefore, amount, loyalty, tierAtPurchase) {
  const rate = Math.max(1, Number(loyalty.rupiahPerPoint) || 10000);
  const base = Math.floor((spendBefore + amount) / rate) - Math.floor(spendBefore / rate);
  const mult = Number(tierAtPurchase?.multiplier) || 1;
  return Math.max(0, Math.floor(base * mult));
}

export function daysBetween(fromISO, toISO) {
  const a = Date.UTC(...fromISO.split('-').map((n, i) => (i === 1 ? n - 1 : +n)));
  const b = Date.UTC(...toISO.split('-').map((n, i) => (i === 1 ? n - 1 : +n)));
  return Math.round((b - a) / 86400000);
}

export function statusFor(lastVisit, today, inactiveDays) {
  if (!lastVisit) return 'belum_beli';
  return daysBetween(lastVisit, today) <= inactiveDays ? 'aktif' : 'tidak_aktif';
}

export const STATUS_LABEL = { aktif: 'Aktif', tidak_aktif: 'Tidak aktif', belum_beli: 'Belum pernah beli' };

// raw: { totalSpend, tierSpend, visits, lastVisit, firstVisit, points, favoriteMenu }
export function buildStats(raw, loyalty, today) {
  const tierSpend = raw.tierSpend ?? raw.totalSpend ?? 0;
  const tier = tierFor(tierSpend, loyalty.tiers);
  const next = nextTierFor(tierSpend, loyalty.tiers);
  const toNext = next ? next.minSpend - tierSpend : 0;
  const span = next ? next.minSpend - tier.minSpend : 1;
  const progress = next ? Math.min(1, Math.max(0, (tierSpend - tier.minSpend) / span)) : 1;
  return {
    totalSpend: raw.totalSpend || 0,
    tierSpend,
    visits: raw.visits || 0,
    lastVisit: raw.lastVisit || null,
    firstVisit: raw.firstVisit || null,
    points: raw.points || 0,
    favoriteMenu: raw.favoriteMenu || null,
    tier,
    nextTier: next,
    toNext,
    progress,
    status: statusFor(raw.lastVisit, today, loyalty.inactiveDays),
  };
}

export function voucherDiscount(voucher, items, subtotal) {
  if (!voucher) return 0;
  if (voucher.type === 'discount_amount') return Math.min(subtotal, Math.max(0, voucher.value | 0));
  if (voucher.type === 'discount_percent') return Math.min(subtotal, Math.floor((subtotal * Math.min(100, Math.max(0, voucher.value | 0))) / 100));
  if (voucher.type === 'free_item') {
    const line = items.find((it) => it.menuItemId === voucher.menuItemId);
    return line ? Math.min(subtotal, line.price) : -1; // -1 = item gratis tidak ada di keranjang
  }
  return 0;
}

export function nextCode(prefix, existing, width = 3) {
  let max = 0;
  for (const c of existing) {
    const m = String(c || '').match(new RegExp('^' + prefix + '(\\d+)$'));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return prefix + String(max + 1).padStart(width, '0');
}

export function rupiah(n) {
  return 'Rp' + Math.round(Number(n) || 0).toLocaleString('id-ID');
}

export function todayIn(tz = 'Asia/Jakarta', d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
