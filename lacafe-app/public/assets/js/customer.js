// Aplikasi customer (tampilan HP): beranda, menu, keranjang, rewards, pesanan, akun.
import { html, raw, mount, on, $, $$, icon, rupiah, num, fdate, fdatetime, ago, greeting, firstName, toast, sheet, confirmDialog, formData, busy, menuThumb, readableOn } from './core.js';
import { get, post, patch, setCsrf } from './api.js';
import { STATUS_LABEL, voucherDiscount, sortedTiers } from './loyalty.js';

const ORDER_STEPS = ['pending', 'processing', 'ready', 'completed'];
const ORDER_LABEL = { pending: 'Diterima', processing: 'Dibuat', ready: 'Siap diambil', completed: 'Selesai', cancelled: 'Dibatalkan' };
const LEDGER_LABEL = { earn: 'Poin belanja', redeem: 'Tukar reward', adjust: 'Koreksi admin', void: 'Transaksi dibatalkan', refund: 'Pengembalian' };

export const ringsSvg = (stroke = 'currentColor') => raw(`<svg class="rings" viewBox="0 0 200 200" fill="none" stroke="${stroke}" stroke-width="1.2" aria-hidden="true">${[95, 80, 66, 53, 41, 30, 20].map((r) => `<circle cx="100" cy="100" r="${r}"/>`).join('')}</svg>`);

// ======================================================================
// Komponen yang juga dipakai pratinjau di Admin > Tampilan
// ======================================================================
export function logoEl(app) {
  return app.logoImage ? html`<span class="logo"><img src="${app.logoImage}" alt=""></span>` : html`<span class="logo">${app.logoText || 'LC'}</span>`;
}

export function memberCard(me, cfg, { preview = false } = {}) {
  const tiers = sortedTiers(cfg.loyalty.tiers);
  if (!me) {
    return html`<section class="mcard mcard-guest">${ringsSvg()}
      <div class="mcard-top"><span class="mcard-tier">${icon('star', 15)} Member ${cfg.appearance.brandName}</span></div>
      <b>Kumpulkan poin dari setiap cangkir</b>
      <p class="small" style="opacity:.85">Daftar gratis, langsung dapat ID member. Poin bisa ditukar minuman & diskon.</p>
      <div class="mcard-actions"><button data-go="#/register">${icon('user', 17)} Daftar</button><button data-go="#/login">Masuk</button></div></section>`;
  }
  const s = me.stats;
  const isBase = s.tier.key === tiers[0]?.key;
  const mc = isBase ? cfg.appearance.colors.primary : s.tier.color;
  const ink = readableOn(mc, isBase ? 0.42 : 0.28); // kartu metal (silver/gold) memakai teks gelap agar terbaca
  const pct = Math.round(s.progress * 100);
  return html`<section class="mcard ${isBase ? '' : 'metal'}" style="--mc:${mc};--mc-ink:${ink}" aria-label="Kartu member">
    ${ringsSvg()}
    <div class="mcard-top">
      <span class="mcard-tier">${icon('star', 15)} ${s.tier.name}</span>
      <span class="mcard-code">${me.memberCode}</span>
    </div>
    <div class="mcard-points"><b data-count="${s.points}">${num(s.points)}</b><span>poin</span></div>
    <div class="mcard-name">${me.name}</div>
    <div class="mcard-progress">
      <div class="mcard-track" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Progres ke level berikutnya"><i style="width:${pct}%"></i></div>
      <div class="mcard-next">${s.nextTier
        ? html`<span>Belanja ${rupiah(s.toNext)} lagi untuk ${s.nextTier.name}</span><span>${pct}%</span>`
        : html`<span>Level tertinggi tercapai</span><span>${icon('check', 14)}</span>`}</div>
    </div>
    ${preview ? '' : html`<div class="mcard-actions"><button data-act="pass">${icon('scan', 17)} Kode member</button><button data-go="#/rewards">${icon('gift', 17)} Tukar poin</button></div>`}
  </section>`;
}

function catKeyOf(cfg, item) { return cfg.categories.find((c) => c.id === item.categoryId)?.key || ''; }
const tempTag = (t) => (t === 'hot' ? html`<span class="temp-tag temp-hot">Panas</span>` : t === 'cold' ? html`<span class="temp-tag temp-cold">Dingin</span>` : '');

function productCard(cfg, m) {
  return html`<button class="pcard" data-item="${m.id}">
    <div class="thumb">${menuThumb(m, catKeyOf(cfg, m))}${m.available ? html`<span class="add add-btn" aria-hidden="true">${icon('plus', 18)}</span>` : html`<span class="soldout">Habis</span>`}</div>
    <h5>${m.name}</h5><div class="price">${rupiah(m.price)}</div></button>`;
}

const SECTION = {
  member: (st) => memberCard(st.me, st.config, { preview: st.preview }),
  actions: (st) => html`<nav class="quick" aria-label="Aksi cepat">
      <button data-go="#/menu"><span class="qi">${icon('cup')}</span>Pesan</button>
      <button data-act="pass"><span class="qi">${icon('scan')}</span>Kode member</button>
      <button data-go="#/rewards"><span class="qi">${icon('gift')}</span>Rewards${st.me?.activeVouchers ? html`<span class="dot">${st.me.activeVouchers}</span>` : ''}</button>
      <button data-go="#/orders"><span class="qi">${icon('receipt')}</span>Pesanan${st.me?.activeOrders?.length ? html`<span class="dot">${st.me.activeOrders.length}</span>` : ''}</button></nav>`,
  banners: (st) => {
    const list = (st.config.appearance.banners || []).filter((b) => b.active);
    if (!list.length) return '';
    return html`<div class="c-section"><div class="hscroll">${list.map((b) => html`<article class="banner ${b.image ? 'has-img' : ''}" style="--bc:${b.color}">
      ${b.image ? html`<img src="${b.image}" alt="">` : raw(ringsSvg('#fff').toString().replace('class="rings"', 'class="ring-deco"'))}
      <div><h4>${b.title}</h4>${b.subtitle ? html`<p>${b.subtitle}</p>` : ''}</div></article>`)}</div></div>`;
  },
  featured: (st) => {
    const items = st.config.menu.filter((m) => m.featured).slice(0, 10);
    if (!items.length) return '';
    return html`<div class="c-section"><div class="c-section-head"><h3>Pilihan barista</h3><a class="link" href="#/menu">Semua menu ${icon('right', 16)}</a></div>
      <div class="hscroll">${items.map((m) => productCard(st.config, m))}</div></div>`;
  },
  categories: (st) => {
    const cats = st.config.categories.filter((c) => st.config.menu.some((m) => m.categoryId === c.id));
    if (!cats.length) return '';
    return html`<div class="c-section"><div class="c-section-head"><h3>Kategori</h3></div><div class="cat-tiles">${cats.slice(0, 8).map((c) => {
      const sample = st.config.menu.find((m) => m.categoryId === c.id);
      return html`<button data-go="#/menu?c=${c.key}"><span class="ct">${menuThumb(sample, c.key)}</span>${c.name}</button>`;
    })}</div></div>`;
  },
  rewards: (st) => {
    const list = st.config.rewards.slice(0, 6);
    if (!list.length) return '';
    return html`<div class="c-section"><div class="c-section-head"><h3>Tukar poin</h3><a class="link" href="#/rewards">Lihat semua ${icon('right', 16)}</a></div>
      <div class="hscroll">${list.map((r) => html`<button class="rw-mini" data-go="#/rewards"><span class="pts">${icon('coin', 16)} ${num(r.pointsCost)} poin</span><h5>${r.name}</h5><span class="small muted">${r.description || ''}</span></button>`)}</div></div>`;
  },
};

function activeOrderStrip(st) {
  const o = st.me?.activeOrders?.[0];
  if (!o || st.preview) return '';
  return html`<div class="c-section"><button class="order-card" style="width:100%;text-align:left" data-go="#/orders">
    <div class="row"><span class="badge badge-primary badge-dot">${ORDER_LABEL[o.status]}</span><span class="spacer"></span><span class="small muted">Antrean</span><b class="tnum">A-${String(o.queueNo).padStart(2, '0')}</b></div>
    ${orderSteps(o)}</button></div>`;
}

export function homeView(st) {
  const app = st.config.appearance;
  const sections = app.homeSections.filter((s) => s.visible && SECTION[s.key]);
  return html`<header class="c-top">${logoEl(app)}<div><div class="brand">${app.brandName}</div>
      <div class="hello">${st.me ? `${greeting()}, ${firstName(st.me.name)}` : app.tagline}</div></div>
      <span class="spacer"></span>${st.me ? html`<button class="icon-btn" data-act="pass" aria-label="Kode member">${icon('scan', 22)}</button>` : html`<a class="btn btn-sm btn-soft" href="#/login">Masuk</a>`}</header>
    ${app.announcement ? html`<div class="announce">${icon('bell', 17)} ${app.announcement}</div>` : ''}
    ${sections.map((s, i) => html`${SECTION[s.key](st)}${s.key === 'member' || (i === 0 && !sections.some((x) => x.key === 'member')) ? activeOrderStrip(st) : ''}`)}
    <div style="height:12px"></div>`;
}

export function menuView(st) {
      const cfg = st.config;
      const layout = cfg.appearance.menuLayout || 'list';
      const q = (st.menuSearch || '').toLowerCase();
      const cats = cfg.categories.map((c) => ({ ...c, items: cfg.menu.filter((m) => m.categoryId === c.id && (!q || m.name.toLowerCase().includes(q))) })).filter((c) => c.items.length);
      const itemEl = (m, catKey) => {
        const add = m.available ? html`<span class="add-btn" aria-hidden="true">${icon('plus', 18)}</span>` : '';
        if (layout === 'list') return html`<button class="m-item" data-item="${m.id}"><div class="thumb">${menuThumb(m, catKey)}${m.available ? '' : html`<span class="soldout">Habis</span>`}</div>
          <div class="info"><h4>${m.name}${tempTag(m.temp)}</h4>${m.description ? html`<p class="desc">${m.description}</p>` : ''}<div class="price">${rupiah(m.price)}</div></div>${add}</button>`;
        return html`<button class="m-item" data-item="${m.id}"><div class="thumb">${menuThumb(m, catKey)}${m.available ? '' : html`<span class="soldout">Habis</span>`}</div>
          <div class="info"><h4>${m.name}${tempTag(m.temp)}</h4>${layout === 'large' && m.description ? html`<p class="desc">${m.description}</p>` : ''}<div class="row"><span class="price">${rupiah(m.price)}</span>${add}</div></div></button>`;
      };
      return html`<div class="c-pagehead"><h1>Menu</h1>
        <label class="input-icon">${icon('search', 18)}<span class="sr-only">Cari menu</span><input type="search" id="menu-q" placeholder="Cari kopi, teh, makanan" value="${st.menuSearch || ''}" autocomplete="off"></label>
        <div class="chips" role="group" aria-label="Kategori">${cats.map((c, i) => html`<button class="chip" data-cat="${c.key}" aria-pressed="${i === 0}">${c.name}</button>`)}</div></div>
        ${cats.length ? cats.map((c) => html`<section class="m-cat" id="cat-${c.key}"><h3>${c.name}</h3><div class="m-${layout}">${c.items.map((m) => itemEl(m, c.key))}</div></section>`)
          : html`<div class="empty">${icon('search')}<h4>Menu tidak ditemukan</h4><p>Coba kata lain, misalnya "latte".</p></div>`}`;
    }

function orderSteps(o) {
  const idx = ORDER_STEPS.indexOf(o.status);
  return html`<div class="steps">${ORDER_STEPS.map((s, i) => html`<div class="${i <= idx ? 'on' : ''}"></div>`)}</div>
    <div class="steps-label">${ORDER_STEPS.map((s, i) => html`<span class="${i <= idx ? 'on' : ''}">${ORDER_LABEL[s]}</span>`)}</div>`;
}

// ======================================================================
// Aplikasi customer
// ======================================================================
export function createCustomerApp(root, store) {
  const st = store.state;
  let pollTimer = null;
  let lastStatuses = new Map();

  const cart = {
    load() { try { return JSON.parse(localStorage.getItem('lacafe_cart') || '[]').filter((l) => Number.isInteger(l.menuItemId) && l.qty > 0); } catch { return []; } },
    save() { try { localStorage.setItem('lacafe_cart', JSON.stringify(st.cart)); } catch {} },
    count() { return st.cart.reduce((s, l) => s + l.qty, 0); },
    lines() { return st.cart.map((l) => ({ ...l, item: st.config.menu.find((m) => m.id === l.menuItemId) })).filter((l) => l.item); },
    subtotal() { return this.lines().reduce((s, l) => s + l.item.price * l.qty, 0); },
    add(menuItemId, qty, note) {
      const ex = st.cart.find((l) => l.menuItemId === menuItemId && (l.note || '') === (note || ''));
      if (ex) ex.qty = Math.min(50, ex.qty + qty); else st.cart.push({ menuItemId, qty, note: note || '' });
      this.save();
    },
  };
  st.cart = cart.load();

  async function refreshMe() {
    if (!st.session?.kind) { st.me = null; return; }
    try { st.me = await get('/api/me'); } catch (e) { if (e.status === 401) { st.session = { kind: null }; st.me = null; } }
    for (const o of st.me?.activeOrders || []) {
      const prev = lastStatuses.get(o.id);
      if (prev && prev !== o.status && o.status === 'ready') toast(`Pesanan A-${String(o.queueNo).padStart(2, '0')} siap diambil`, 'ok');
      lastStatuses.set(o.id, o.status);
    }
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (document.hidden || !st.me?.activeOrders?.length) return;
      await refreshMe();
      if (['', '/', '/orders'].includes(currentPath())) render();
    }, 15000);
  }

  const currentPath = () => (location.hash.slice(1).split('?')[0] || '/');
  const query = () => new URLSearchParams(location.hash.split('?')[1] || '');

  // ---------------- Layout ----------------
  function shell(content, active) {
    const n = cart.count();
    const tabs = [['/', 'home', 'Beranda'], ['/menu', 'cup', 'Menu'], ['/rewards', 'gift', 'Rewards'], ['/orders', 'receipt', 'Pesanan'], ['/account', 'user', 'Akun']];
    return html`<div class="c-shell"><div class="c-app" id="c-app">${content}
      ${n && active !== '/auth' ? html`<div class="cartbar"><div><div class="cnt">${n} item di keranjang</div><b class="tnum">${rupiah(cart.subtotal())}</b></div><span class="spacer"></span><button class="btn" data-act="cart">${icon('bag', 18)} Keranjang</button></div>` : ''}
      ${active === '/auth' ? '' : html`<nav class="bnav" aria-label="Navigasi utama">${tabs.map(([p, ic, l]) => html`<a href="#${p}" ${active === p ? raw('aria-current="page"') : ''}>${icon(ic, 22)}${l}${p === '/orders' && st.me?.activeOrders?.length ? html`<span class="dot"></span>` : ''}</a>`)}</nav>`}
    </div></div>`;
  }

  function needLogin(title) {
    return html`<div class="c-pagehead"><h1>${title}</h1></div><div class="c-section"><div class="card pad empty">${icon('user')}
      <h4>Masuk untuk melanjutkan</h4><p>Lihat poin, tukar rewards, dan lacak pesanan dengan akun member.</p>
      <div class="row" style="justify-content:center;margin-top:16px"><a class="btn btn-primary" href="#/login">Masuk</a><a class="btn btn-ghost" href="#/register">Daftar</a></div></div></div>`;
  }

  // ---------------- Halaman ----------------
  const pages = {
    '/': () => homeView(st),

    '/menu': () => menuView(st),

    '/rewards': () => {
      if (!st.me) return needLogin('Rewards');
      const tab = st.rewardTab || 'katalog';
      const s = st.me.stats;
      const tiers = sortedTiers(st.config.loyalty.tiers);
      const rank = (k) => tiers.findIndex((t) => t.key === k);
      return html`<div class="c-pagehead"><h1>Rewards</h1></div>
        <div class="pts-hero"><span class="coin">${icon('coin', 26)}</span><div><div class="small muted">Poin kamu</div><b>${num(s.points)}</b></div><span class="spacer"></span>
          <span class="tier-chip" style="--tc:${s.tier.color}"><i></i>${s.tier.name}</span></div>
        <div class="tabs" role="tablist"><button role="tab" data-rtab="katalog" aria-selected="${tab === 'katalog'}">Tukar poin</button><button role="tab" data-rtab="voucher" aria-selected="${tab === 'voucher'}">Voucher saya${st.me.activeVouchers ? ` (${st.me.activeVouchers})` : ''}</button></div>
        <div class="c-section" style="margin-top:16px">${tab === 'katalog'
          ? (st.config.rewards.length ? html`<div class="rw-list">${st.config.rewards.map((r) => {
            const tierLock = r.minTier && rank(s.tier.key) < rank(r.minTier);
            const short = r.pointsCost - s.points;
            const soldOut = r.stock !== null && r.stock <= 0;
            const reason = soldOut ? 'Stok habis' : tierLock ? `Khusus ${tiers.find((t) => t.key === r.minTier)?.name || r.minTier} ke atas` : short > 0 ? `Kurang ${num(short)} poin` : '';
            const item = r.menuItemId && st.config.menu.find((m) => m.id === r.menuItemId);
            return html`<article class="rw ${reason ? 'locked' : ''}"><div class="thumb">${item ? menuThumb(item, catKeyOf(st.config, item)) : icon(r.type === 'discount_percent' ? 'ticket' : 'gift', 28)}</div>
              <div class="info"><h4>${r.name}</h4><div class="meta">${r.description || ''}${r.stock !== null && !soldOut ? ` Sisa ${r.stock}.` : ''}</div><div class="cost">${icon('coin', 15)} ${num(r.pointsCost)} poin</div></div>
              ${reason ? html`<span class="small muted" style="max-width:90px;text-align:right">${reason}</span>` : html`<button class="btn btn-sm btn-primary" data-redeem="${r.id}">Tukar</button>`}</article>`;
          })}</div>` : html`<div class="empty">${icon('gift')}<h4>Belum ada reward</h4><p>Reward akan muncul di sini.</p></div>`)
          : html`<div id="vouchers"><div class="skeleton" style="height:80px"></div></div>`}</div>`;
    },

    '/orders': () => {
      if (!st.me) return needLogin('Pesanan');
      const tab = st.orderTab || 'berjalan';
      return html`<div class="c-pagehead"><h1>Pesanan</h1></div>
        <div class="tabs" role="tablist" style="margin-top:0"><button role="tab" data-otab="berjalan" aria-selected="${tab === 'berjalan'}">Berjalan</button><button role="tab" data-otab="riwayat" aria-selected="${tab === 'riwayat'}">Riwayat belanja</button></div>
        <div class="c-section" style="margin-top:16px">${tab === 'berjalan'
          ? (st.me.activeOrders.length ? st.me.activeOrders.map((o) => html`<article class="order-card">
              <div class="row"><div><div class="small muted">Nomor antrean</div><div class="queue">A-${String(o.queueNo).padStart(2, '0')}</div></div><span class="spacer"></span><span class="badge badge-primary badge-dot">${ORDER_LABEL[o.status]}</span></div>
              ${orderSteps(o)}
              <div class="divider"></div>
              ${o.items.map((i) => html`<div class="kv"><span>${i.qty}x ${i.name}</span><span class="tnum">${rupiah(i.lineTotal)}</span></div>`)}
              ${o.discount ? html`<div class="kv"><span>Voucher</span><span class="tnum plus">-${rupiah(o.discount)}</span></div>` : ''}
              <div class="kv total"><span>Total</span><span class="tnum">${rupiah(o.total)}</span></div>
              <p class="small muted" style="margin-top:8px">${o.status === 'ready' ? st.config.appearance.pickupNote : `Bayar di kasir (${o.paymentMethod}). Poin masuk setelah pesanan selesai.`}</p>
              ${o.status === 'pending' ? html`<button class="btn btn-sm btn-danger-ghost btn-ghost" style="margin-top:12px" data-cancel="${o.id}">Batalkan pesanan</button>` : ''}
            </article>`) : html`<div class="empty">${icon('bag')}<h4>Tidak ada pesanan berjalan</h4><p>Pesan dari menu, ambil di kasir tanpa antre lama.</p><a class="btn btn-primary" style="margin-top:14px" href="#/menu">Lihat menu</a></div>`)
          : html`<div id="history"><div class="skeleton" style="height:60px;margin-bottom:8px"></div><div class="skeleton" style="height:60px"></div></div>`}</div>`;
    },

    '/account': () => {
      if (!st.me) return needLogin('Akun');
      const s = st.me.stats;
      const tiers = sortedTiers(st.config.loyalty.tiers);
      return html`<div class="acct-head"><span class="avatar">${(st.me.name || '?').charAt(0).toUpperCase()}</span><div><h2 style="font-size:20px">${st.me.name}</h2>
        <div class="small muted">${st.me.memberCode}${st.me.phone ? ` / ${st.me.phone}` : ''}</div></div></div>
        <div class="c-section" style="margin-top:14px"><div class="d-stats">
          <div><small>Kunjungan</small><b>${num(s.visits)}x</b></div><div><small>Total belanja</small><b>${rupiah(s.totalSpend)}</b></div><div><small>Status</small><b style="font-size:14px">${STATUS_LABEL[s.status]}</b></div></div></div>
        <div class="c-section" style="margin-top:8px"><div class="c-section-head"><h3>Level member</h3></div>
          <div class="ladder">${tiers.map((t) => html`<div class="ladder-step ${t.key === s.tier.key ? 'current' : ''}" style="--tc:${t.color}"><span class="medal"></span>
            <div style="flex:1"><div class="row"><b>${t.name}</b><span class="spacer"></span><span class="small muted">${t.minSpend ? `Belanja ${rupiah(t.minSpend)}` : 'Mulai dari daftar'}</span></div>
            ${t.benefits?.length ? html`<ul>${t.benefits.map((b) => html`<li>${b}</li>`)}</ul>` : ''}</div></div>`)}</div>
          <p class="small muted" style="margin-top:10px">${st.config.loyalty.tierBasis === 'rolling365' ? 'Level dihitung dari total belanja 12 bulan terakhir.' : 'Level dihitung dari total belanja sejak menjadi member.'} 1 poin untuk setiap ${rupiah(st.config.loyalty.rupiahPerPoint)}.</p></div>
        <div class="c-section"><div class="menu-list">
          <button data-act="ledger">${icon('history')} Riwayat poin ${icon('right', 18)}</button>
          <button data-act="profile">${icon('edit')} Ubah profil ${icon('right', 18)}</button>
          <button data-act="password">${icon('key')} Ganti kata sandi ${icon('right', 18)}</button>
          <button data-act="logout" style="color:var(--danger)">${icon('logout')} Keluar</button></div></div>`;
    },

    '/login': () => authView('login'),
    '/register': () => authView('register'),
    '/activate': () => authView('activate'),
  };

  function authView(mode) {
    const app = st.config.appearance;
    const pw = (name, label, auto = 'current-password') => html`<label class="field"><span>${label}</span><div class="pw-wrap"><input type="password" name="${name}" required autocomplete="${auto}" minlength="${mode === 'login' ? 1 : 8}"><button type="button" class="icon-btn" data-act="pw-toggle" aria-label="Tampilkan kata sandi">${icon('eye', 18)}</button></div>${mode !== 'login' ? html`<small>Minimal 8 karakter, berisi huruf dan angka</small>` : ''}</label>`;
    const forms = {
      login: html`<form data-form="login" novalidate>
        <label class="field"><span>Nomor WhatsApp atau ID member</span><input name="identifier" required autocomplete="username" placeholder="0812xxxxxxx atau LC001" inputmode="text"></label>
        ${pw('password', 'Kata sandi')}<div class="form-err hide"></div><button class="btn btn-primary btn-block">Masuk</button></form>`,
      register: html`<form data-form="register" novalidate>
        <label class="field"><span>Nama lengkap</span><input name="name" required autocomplete="name" maxlength="60"></label>
        <label class="field"><span>Nomor WhatsApp</span><input name="phone" required autocomplete="tel" inputmode="tel" placeholder="0812xxxxxxx"></label>
        <div class="row-2"><label class="field"><span>Gender</span><select name="gender"><option value="">Pilih</option>${st.config.options.genders.map((g) => html`<option>${g}</option>`)}</select></label>
        <label class="field"><span>Tanggal lahir</span><input type="date" name="birthday"></label></div>
        ${pw('password', 'Buat kata sandi', 'new-password')}<div class="form-err hide"></div><button class="btn btn-primary btn-block">Daftar jadi member</button></form>`,
      activate: html`<form data-form="activate" novalidate><div class="notice">${icon('shield', 18)}<span>Sudah pernah belanja dan tercatat di kasir? Minta <b>kode aktivasi</b> ke kasir, lalu buat kata sandi di sini. Poin lama Anda tetap aman.</span></div>
        <label class="field"><span>Nomor WhatsApp atau ID member</span><input name="identifier" required placeholder="0812xxxxxxx atau LC001"></label>
        <label class="field"><span>Kode aktivasi dari kasir</span><input name="code" required placeholder="XXXX-XXXX" autocomplete="one-time-code" style="text-transform:uppercase;letter-spacing:.1em"></label>
        ${pw('password', 'Buat kata sandi', 'new-password')}<div class="form-err hide"></div><button class="btn btn-primary btn-block">Aktifkan akun</button></form>`,
    };
    return html`<div class="auth"><div class="auth-hero">${ringsSvg()}<div class="row">${logoEl(app)}<b>${app.brandName}</b><span class="spacer"></span><a class="btn btn-sm" style="background:color-mix(in srgb,var(--on-primary) 14%,transparent);color:inherit" href="#/">Lihat menu</a></div>
      <h1>${mode === 'register' ? 'Jadi member, kumpulkan poin' : mode === 'activate' ? 'Aktifkan akun member' : 'Selamat datang kembali'}</h1><p>${app.tagline}</p></div>
      <div class="auth-card"><div class="tabs" role="tablist"><button role="tab" data-go="#/login" aria-selected="${mode === 'login'}">Masuk</button><button role="tab" data-go="#/register" aria-selected="${mode === 'register'}">Daftar</button><button role="tab" data-go="#/activate" aria-selected="${mode === 'activate'}">Aktifkan akun</button></div>
      ${forms[mode]}</div>
      <p class="auth-foot">Staf toko? <a class="link" href="#/admin">Masuk ke panel admin</a></p></div>`;
  }

  // ---------------- Render ----------------
  async function render() {
    const path = currentPath();
    const view = pages[path] || pages['/'];
    const isAuth = ['/login', '/register', '/activate'].includes(path);
    if (isAuth && st.me) { location.hash = '#/'; return; }
    const scrollY = window.scrollY;
    mount(root, shell(view(), isAuth ? '/auth' : path));
    if (path === st.lastPath) window.scrollTo(0, scrollY); else window.scrollTo(0, 0);
    st.lastPath = path;
    if (path === '/menu') afterMenu();
    if (path === '/rewards' && st.me && (st.rewardTab || 'katalog') === 'voucher') loadVouchers();
    if (path === '/orders' && st.me && st.orderTab === 'riwayat') loadHistory();
  }

  function afterMenu() {
    const c = query().get('c');
    if (c) setTimeout(() => document.getElementById('cat-' + c)?.scrollIntoView({ behavior: 'smooth' }), 50);
    const input = $('#menu-q', root);
    input?.addEventListener('input', () => {
      st.menuSearch = input.value;
      const pos = input.selectionStart;
      render().then(() => { const i = $('#menu-q', root); i.focus(); i.setSelectionRange(pos, pos); });
    });
    // tandai chip kategori sesuai posisi scroll
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) {
        const key = e.target.id.slice(4);
        $$('.chip', root).forEach((ch) => ch.setAttribute('aria-pressed', String(ch.dataset.cat === key)));
      }
    }, { rootMargin: '-160px 0px -60% 0px' });
    $$('.m-cat', root).forEach((s) => io.observe(s));
  }

  async function loadVouchers() {
    const box = $('#vouchers', root);
    try {
      const list = await get('/api/me/vouchers');
      const label = { active: 'Aktif', reserved: 'Dipakai di pesanan', used: 'Sudah dipakai', expired: 'Kedaluwarsa', cancelled: 'Dibatalkan' };
      mount(box, list.length ? html`<div class="rw-list">${list.map((v) => html`<button class="voucher ${v.status === 'active' ? '' : 'used'}" style="text-align:left" data-voucher="${v.code}" data-vname="${v.name}">
        <div class="vl"><b>${v.name}</b><div class="small muted">${v.status === 'active' ? `Berlaku sampai ${fdatetime(v.expiresAt)}` : label[v.status]}</div></div><div class="vr">${v.code.slice(0, 5)}</div></button>`)}</div>`
        : html`<div class="empty">${icon('ticket')}<h4>Belum punya voucher</h4><p>Tukar poin di tab sebelah untuk mendapatkan voucher.</p></div>`);
    } catch (e) { mount(box, html`<p class="muted">${e.message}</p>`); }
  }

  async function loadHistory() {
    const box = $('#history', root);
    try {
      const list = await get('/api/me/transactions');
      mount(box, list.length ? list.map((t) => html`<div class="trx-row"><span class="ti">${icon('receipt', 19)}</span><div class="info"><h5>${t.items.map((i) => `${i.qty}x ${i.name}`).join(', ')}</h5>
        <div class="small muted">${fdate(t.date)}${t.status === 'void' ? ' (dibatalkan)' : ''}</div></div><div class="amt"><div>${rupiah(t.total)}</div>${t.pointsEarned ? html`<div class="small plus">+${num(t.pointsEarned)} poin</div>` : ''}</div></div>`)
        : html`<div class="empty">${icon('receipt')}<h4>Belum ada transaksi</h4><p>Transaksi di kasir maupun lewat aplikasi akan tercatat di sini.</p></div>`);
    } catch (e) { mount(box, html`<p class="muted">${e.message}</p>`); }
  }

  // ---------------- Sheet & aksi ----------------
  function openItem(id) {
    const m = st.config.menu.find((x) => x.id === Number(id));
    if (!m) return;
    let qty = 1;
    const s = sheet(html`<div class="item-hero">${menuThumb(m, catKeyOf(st.config, m))}</div>
      <h2 style="font-size:22px">${m.name}${tempTag(m.temp)}</h2>${m.description ? html`<p class="muted" style="margin-top:6px">${m.description}</p>` : ''}
      <div class="row" style="margin:16px 0"><b style="font-size:20px" class="tnum">${rupiah(m.price)}</b><span class="spacer"></span>
      ${m.available ? html`<div class="qty"><button data-q="-1" aria-label="Kurangi">${icon('minus', 16)}</button><b id="iq">1</b><button data-q="1" aria-label="Tambah">${icon('plus', 16)}</button></div>` : html`<span class="badge badge-danger">Sedang habis</span>`}</div>
      ${m.available ? html`<label class="field"><span>Catatan untuk barista (opsional)</span><input id="inote" maxlength="120" placeholder="Contoh: less sugar, es sedikit"></label>
      <button class="btn btn-primary btn-block" id="iadd">Tambah ke keranjang <span class="tnum" id="itot">${rupiah(m.price)}</span></button>` : ''}`, { className: 'item-sheet' });
    on(s.el, 'click', '[data-q]', (e, b) => { qty = Math.max(1, Math.min(50, qty + Number(b.dataset.q))); $('#iq', s.el).textContent = qty; $('#itot', s.el).textContent = rupiah(qty * m.price); });
    $('#iadd', s.el)?.addEventListener('click', () => { cart.add(m.id, qty, $('#inote', s.el).value.trim()); s.close(); toast(`${m.name} ditambahkan`); render(); });
  }

  async function openCart() {
    if (!st.config.appearance.orderingEnabled) { toast('Pemesanan lewat aplikasi sedang ditutup', 'error'); return; }
    let vouchers = [];
    if (st.me) { try { vouchers = (await get('/api/me/vouchers')).filter((v) => v.status === 'active'); } catch {} }
    const s = sheet('', { title: 'Keranjang' });
    let voucherCode = '';
    const draw = () => {
      const lines = cart.lines();
      if (!lines.length) { mount(s.el, html`<div class="empty">${icon('bag')}<h4>Keranjang kosong</h4><p>Pilih menu favoritmu dulu.</p></div>`); return; }
      const subtotal = cart.subtotal();
      const v = vouchers.find((x) => x.code === voucherCode);
      const disc = v ? voucherDiscount(v, lines.map((l) => ({ menuItemId: l.menuItemId, price: l.item.price })), subtotal) : 0;
      mount(s.el, html`${lines.map((l, i) => html`<div class="cart-line"><div class="thumb">${menuThumb(l.item, catKeyOf(st.config, l.item))}</div>
          <div class="info"><h5>${l.item.name}</h5>${l.note ? html`<div class="small muted">${l.note}</div>` : ''}<div class="small tnum">${rupiah(l.item.price * l.qty)}</div></div>
          <div class="qty"><button data-cq="${i}" data-d="-1" aria-label="Kurangi">${icon(l.qty === 1 ? 'trash' : 'minus', 15)}</button><b>${l.qty}</b><button data-cq="${i}" data-d="1" aria-label="Tambah">${icon('plus', 15)}</button></div></div>`)}
        <div style="margin-top:16px">
        ${st.me && vouchers.length ? html`<label class="field"><span>Pakai voucher</span><select id="cv"><option value="">Tanpa voucher</option>${vouchers.map((x) => html`<option value="${x.code}" ${x.code === voucherCode ? raw('selected') : ''}>${x.name}</option>`)}</select>
          ${disc < 0 ? html`<small style="color:var(--danger)">Tambahkan item gratisnya ke keranjang dulu.</small>` : ''}</label>` : ''}
        <div class="field"><span class="small" style="font-weight:600;color:var(--muted)">Bayar di kasir dengan</span><div class="pay-opts">${st.config.options.payments.map((p, i) => html`<label class="pay-opt"><input type="radio" name="pay" value="${p}" ${i === 0 ? raw('checked') : ''}>${p}</label>`)}</div></div>
        <label class="field"><span>Catatan pesanan (opsional)</span><input id="cnote" maxlength="200" placeholder="Contoh: diambil 10 menit lagi"></label>
        <div class="kv"><span>Subtotal</span><span class="tnum">${rupiah(subtotal)}</span></div>
        ${disc > 0 ? html`<div class="kv"><span>Voucher</span><span class="tnum plus">-${rupiah(disc)}</span></div>` : ''}
        <div class="kv total"><span>Total</span><span class="tnum">${rupiah(subtotal - Math.max(0, disc))}</span></div>
        <p class="small muted" style="margin:6px 0 14px">${st.me ? 'Harga final dihitung ulang oleh kasir. Poin masuk otomatis setelah pesanan selesai.' : 'Masuk dulu agar pesanan tercatat dan dapat poin.'}</p>
        <button class="btn btn-primary btn-block" id="checkout" ${disc < 0 ? raw('disabled') : ''}>${st.me ? 'Pesan sekarang' : 'Masuk untuk memesan'}</button></div>`);
    };
    draw();
    on(s.el, 'click', '[data-cq]', (e, b) => {
      const l = st.cart[Number(b.dataset.cq)];
      l.qty += Number(b.dataset.d);
      if (l.qty <= 0) st.cart.splice(Number(b.dataset.cq), 1);
      cart.save(); draw(); render();
    });
    on(s.el, 'change', '#cv', (e, sel) => { voucherCode = sel.value; draw(); });
    on(s.el, 'click', '#checkout', async (e, btn) => {
      if (!st.me) { s.close(); location.hash = '#/login'; return; }
      busy(btn);
      try {
        const order = await post('/api/me/orders', {
          items: st.cart.map((l) => ({ menuItemId: l.menuItemId, qty: l.qty, note: l.note })),
          paymentMethod: $('input[name=pay]:checked', s.el)?.value, note: $('#cnote', s.el).value.trim(), voucherCode: voucherCode || null,
        });
        st.cart = []; cart.save();
        s.close();
        await refreshMe();
        st.orderTab = 'berjalan';
        location.hash = '#/orders';
        render();
        sheet(html`<div class="pass"><div class="small muted">Pesanan diterima</div><div class="queue" style="font-size:56px;margin:6px 0">A-${String(order.queueNo).padStart(2, '0')}</div>
          <p class="muted">Tunjukkan nomor ini di kasir dan bayar ${rupiah(order.total)} (${order.paymentMethod}). Kami kabari saat pesanan siap.</p>
          <button class="btn btn-primary btn-block" style="margin-top:18px" data-close>Oke</button></div>`);
      } catch (err) { busy(btn, false); toast(err.message, 'error'); }
    });
  }

  async function openPass() {
    if (!st.me) { location.hash = '#/login'; return; }
    let timer;
    const s = sheet(html`<div class="pass" id="pass"><div class="skeleton" style="height:140px"></div></div>`, { title: 'Kode member', onClose: () => clearInterval(timer) });
    const load = async () => {
      try {
        const p = await get('/api/me/pass');
        let left = p.expiresIn;
        const C = 2 * Math.PI * 28;
        mount($('#pass', s.el), html`<p class="muted">Sebutkan atau tunjukkan 6 digit ini ke kasir untuk mencatat poin.</p>
          <div class="digits" aria-live="polite">${p.code.slice(0, 3)} ${p.code.slice(3)}</div>
          <svg class="ring" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="28" fill="none" stroke="var(--line)" stroke-width="5"/><circle id="arc" cx="32" cy="32" r="28" fill="none" stroke="var(--primary)" stroke-width="5" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="0" transform="rotate(-90 32 32)"/><text id="sec" x="32" y="37" text-anchor="middle" font-size="15" font-weight="700" fill="currentColor">${left}</text></svg>
          <div class="small muted">Kode berganti otomatis setiap ${p.window} detik</div><div class="member">${p.memberCode}</div>`);
        clearInterval(timer);
        timer = setInterval(() => {
          left -= 1;
          if (left <= 0) { clearInterval(timer); load(); return; }
          const arc = $('#arc', s.el); const sec = $('#sec', s.el);
          if (arc) arc.setAttribute('stroke-dashoffset', String(C * (1 - left / p.window)));
          if (sec) sec.textContent = left;
        }, 1000);
      } catch (e) { mount($('#pass', s.el), html`<p class="muted">${e.message}</p>`); }
    };
    load();
  }

  async function openLedger() {
    const s = sheet(html`<div class="skeleton" style="height:120px"></div>`, { title: 'Riwayat poin' });
    try {
      const list = await get('/api/me/points');
      mount(s.el, list.length ? list.map((l) => html`<div class="trx-row"><span class="ti">${icon(l.delta > 0 ? 'plus' : 'minus', 18)}</span>
        <div class="info"><h5>${LEDGER_LABEL[l.type] || l.type}</h5><div class="small muted">${l.note || ''} ${fdatetime(l.createdAt)}</div></div>
        <div class="amt"><div class="${l.delta > 0 ? 'plus' : 'minus'}">${l.delta > 0 ? '+' : ''}${num(l.delta)}</div><div class="small muted">saldo ${num(l.balanceAfter)}</div></div></div>`)
        : html`<div class="empty">${icon('coin')}<h4>Belum ada poin</h4><p>Belanja untuk mulai mengumpulkan poin.</p></div>`);
    } catch (e) { mount(s.el, html`<p class="muted">${e.message}</p>`); }
  }

  function openProfile() {
    const me = st.me;
    const s = sheet(html`<form data-form="profile"><label class="field"><span>Nama</span><input name="name" value="${me.name}" required maxlength="60"></label>
      <label class="field"><span>Nomor WhatsApp</span><input value="${me.phone || '-'}" disabled><small>Untuk mengganti nomor, hubungi kasir.</small></label>
      <div class="row-2"><label class="field"><span>Gender</span><select name="gender"><option value="">Pilih</option>${st.config.options.genders.map((g) => html`<option ${g === me.gender ? raw('selected') : ''}>${g}</option>`)}</select></label>
      <label class="field"><span>Tanggal lahir</span><input type="date" name="birthday" value="${me.birthday || ''}"></label></div>
      <button class="btn btn-primary btn-block">Simpan profil</button></form>`, { title: 'Ubah profil' });
    on(s.el, 'submit', 'form', async (e, f) => {
      e.preventDefault();
      const btn = $('button', f); busy(btn);
      try { await patch('/api/me', formData(f)); await refreshMe(); s.close(); toast('Profil disimpan', 'ok'); render(); } catch (err) { busy(btn, false); toast(err.message, 'error'); }
    });
  }

  function openPassword() {
    const s = sheet(html`<form><label class="field"><span>Kata sandi lama</span><input type="password" name="current" required autocomplete="current-password"></label>
      <label class="field"><span>Kata sandi baru</span><input type="password" name="next" required minlength="8" autocomplete="new-password"><small>Minimal 8 karakter, berisi huruf dan angka</small></label>
      <button class="btn btn-primary btn-block">Ganti kata sandi</button></form>`, { title: 'Ganti kata sandi' });
    on(s.el, 'submit', 'form', async (e, f) => {
      e.preventDefault();
      const btn = $('button', f); busy(btn);
      try { await post('/api/auth/password', formData(f)); s.close(); toast('Kata sandi diganti. Perangkat lain otomatis keluar.', 'ok'); } catch (err) { busy(btn, false); toast(err.message, 'error'); }
    });
  }

  async function submitAuth(form) {
    const mode = form.dataset.form;
    const err = $('.form-err', form);
    const btn = $('button.btn-primary', form);
    err.classList.add('hide');
    busy(btn);
    try {
      const body = formData(form);
      const res = await post(`/api/auth/customer/${mode}`, body);
      setCsrf(res.csrf);
      st.session = res;
      await refreshMe();
      toast(mode === 'register' ? `Selamat bergabung! ID member kamu ${res.user.memberCode}` : `Halo, ${firstName(res.user.name)}`, 'ok');
      location.hash = '#/';
    } catch (e) {
      busy(btn, false);
      err.textContent = e.message;
      err.classList.remove('hide');
      if (e.code === 'not_activated' || e.code === 'needs_activation') {
        const a = document.createElement('a'); a.href = '#/activate'; a.className = 'link'; a.textContent = ' Aktifkan sekarang'; err.append(a);
      }
    }
  }

  // ---------------- Event (delegasi) ----------------
  on(root, 'click', '[data-go]', (e, el) => { e.preventDefault(); location.hash = el.dataset.go; });
  on(root, 'click', '[data-item]', (e, el) => openItem(el.dataset.item));
  on(root, 'click', '[data-cat]', (e, el) => document.getElementById('cat-' + el.dataset.cat)?.scrollIntoView({ behavior: 'smooth' }));
  on(root, 'click', '[data-rtab]', (e, el) => { st.rewardTab = el.dataset.rtab; render(); });
  on(root, 'click', '[data-otab]', (e, el) => { st.orderTab = el.dataset.otab; render(); });
  on(root, 'click', '[data-voucher]', (e, el) => sheet(html`<div class="pass"><div class="small muted">${el.dataset.vname}</div><div class="digits" style="font-size:30px">${el.dataset.voucher}</div><p class="muted">Tunjukkan kode ini ke kasir, atau pilih voucher saat checkout di aplikasi.</p></div>`, { title: 'Voucher' }));
  on(root, 'click', '[data-redeem]', async (e, el) => {
    const r = st.config.rewards.find((x) => x.id === Number(el.dataset.redeem));
    if (!(await confirmDialog(`Tukar ${num(r.pointsCost)} poin dengan "${r.name}"? Poin langsung terpotong dan voucher berlaku ${r.validDays} hari.`, { title: 'Tukar poin', confirmText: 'Tukar sekarang' }))) return;
    busy(el);
    try {
      const v = await post('/api/me/redeem', { rewardId: r.id });
      await refreshMe();
      st.config.rewards = (await get('/api/public/bootstrap')).rewards;
      render();
      sheet(html`<div class="pass">${icon('gift', 36)}<h3 style="margin-top:8px">${v.name}</h3><div class="digits" style="font-size:30px">${v.code}</div>
        <p class="muted">Voucher tersimpan di Rewards, tab Voucher saya. Berlaku sampai ${fdatetime(v.expiresAt)}.</p><button class="btn btn-primary btn-block" style="margin-top:16px" data-close>Sip</button></div>`);
    } catch (err) { busy(el, false); toast(err.message, 'error'); }
  });
  on(root, 'click', '[data-cancel]', async (e, el) => {
    if (!(await confirmDialog('Batalkan pesanan ini?', { danger: true, confirmText: 'Batalkan' }))) return;
    try { await post(`/api/me/orders/${el.dataset.cancel}/cancel`, {}); await refreshMe(); render(); toast('Pesanan dibatalkan'); } catch (err) { toast(err.message, 'error'); }
  });
  on(root, 'click', '[data-act]', async (e, el) => {
    const a = el.dataset.act;
    if (a === 'pass') openPass();
    else if (a === 'cart') openCart();
    else if (a === 'ledger') openLedger();
    else if (a === 'profile') openProfile();
    else if (a === 'password') openPassword();
    else if (a === 'pw-toggle') { const i = el.previousElementSibling; i.type = i.type === 'password' ? 'text' : 'password'; mount(el, icon(i.type === 'password' ? 'eye' : 'eyeOff', 18)); }
    else if (a === 'logout') {
      if (!(await confirmDialog('Keluar dari akun member?', { confirmText: 'Keluar' }))) return;
      try { await post('/api/auth/logout', {}); } catch {}
      setCsrf(null); st.session = { kind: null }; st.me = null; location.hash = '#/'; render();
    }
  });
  on(root, 'submit', 'form[data-form]', (e, f) => { e.preventDefault(); if (['login', 'register', 'activate'].includes(f.dataset.form)) submitAuth(f); });

  return {
    async start() { await refreshMe(); startPolling(); await render(); },
    render,
    stop() { clearInterval(pollTimer); },
  };
}
