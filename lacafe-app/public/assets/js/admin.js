// Panel admin & kasir: ringkasan, kasir (POS), pesanan, customer, transaksi, menu, rewards, tampilan, pengaturan, staf, log.
import { html, raw, mount, on, $, $$, icon, rupiah, num, fdate, fdatetime, ago, toast, sheet, confirmDialog, formData, busy, menuThumb, applyTheme, THEMES, esc } from './core.js';
import { get, post, patch, put, del, setCsrf, download } from './api.js';
import { STATUS_LABEL, buildStats, pointsForPurchase, tierFor, voucherDiscount, sortedTiers, todayIn } from './loyalty.js';
import { homeView, menuView, logoEl } from './customer.js';

const STATUS_BADGE = { aktif: 'badge-ok', tidak_aktif: 'badge-warn', belum_beli: '' };
const ORDER_LABEL = { pending: 'Baru', processing: 'Dibuat', ready: 'Siap diambil', completed: 'Selesai', cancelled: 'Dibatalkan' };
const LEDGER_LABEL = { earn: 'Belanja', redeem: 'Tukar reward', adjust: 'Koreksi', void: 'Pembatalan', refund: 'Refund' };
const SECTION_LABEL = { member: 'Kartu member & poin', actions: 'Tombol aksi cepat', banners: 'Banner promo', featured: 'Pilihan barista', categories: 'Kategori menu', rewards: 'Katalog tukar poin' };
const REWARD_TYPE = { free_item: 'Gratis menu', discount_amount: 'Potongan Rupiah', discount_percent: 'Diskon persen' };
const SRC_LABEL = { pos: 'Kasir', order: 'Aplikasi', import: 'Import Excel' };
const tierChip = (t) => html`<span class="tier-chip" style="--tc:${t.color}"><i></i>${t.name}</span>`;
const statusBadge = (s) => html`<span class="badge badge-dot ${STATUS_BADGE[s]}">${STATUS_LABEL[s]}</span>`;
const q2 = (n) => 'A-' + String(n).padStart(2, '0');

export function createAdminApp(root, store) {
  const st = store.state;
  const A = { actions: {}, customers: null, poll: null, badge: 0, cleanup: [] };
  const isAdmin = () => st.session?.user?.role === 'admin';
  const NAV = [
    { grp: 'Operasional' },
    { p: '', label: 'Ringkasan', ic: 'chart', admin: true },
    { p: 'pos', label: 'Kasir', ic: 'register' },
    { p: 'orders', label: 'Pesanan online', ic: 'bag', badge: true },
    { p: 'customers', label: 'Customer', ic: 'users' },
    { p: 'transactions', label: 'Transaksi', ic: 'receipt' },
    { grp: 'Katalog' },
    { p: 'menu', label: 'Menu', ic: 'cup' },
    { p: 'rewards', label: 'Rewards', ic: 'gift', admin: true },
    { grp: 'Toko', admin: true },
    { p: 'layout', label: 'Tampilan aplikasi', ic: 'layout', admin: true },
    { p: 'settings', label: 'Aturan & pengaturan', ic: 'settings', admin: true },
    { p: 'staff', label: 'Akun staf', ic: 'shield', admin: true },
    { p: 'audit', label: 'Log aktivitas', ic: 'history', admin: true },
  ];
  const sub = () => (location.hash.slice(1).split('?')[0].replace(/^\/admin\/?/, '').split('/')[0]);

  // ======================================================================
  // Shell
  // ======================================================================
  function shell() {
    const app = st.config.appearance;
    const u = st.session.user;
    const cur = sub();
    return html`<div class="a-shell" id="a-shell">
      <aside class="a-side" aria-label="Navigasi admin">
        <div class="a-brand">${logoEl(app)}<div><b>${app.brandName}</b><small>Panel ${isAdmin() ? 'admin' : 'kasir'}</small></div></div>
        <nav class="a-nav">${NAV.filter((n) => !n.admin || isAdmin()).map((n) => n.grp ? html`<div class="grp">${n.grp}</div>`
          : html`<a href="#/admin${n.p ? '/' + n.p : ''}" ${cur === n.p ? raw('aria-current="page"') : ''}>${icon(n.ic, 19)} ${n.label}${n.badge ? html`<span class="count ${A.badge ? '' : 'hide'}" id="order-badge">${A.badge}</span>` : ''}</a>`)}
          <div class="grp">Lainnya</div><a href="#/" target="_blank" rel="noopener">${icon('eye', 19)} Lihat aplikasi customer</a></nav>
        <div class="a-user"><span class="avatar">${u.name.charAt(0).toUpperCase()}</span><div style="min-width:0;flex:1"><b>${u.name}</b><small>${u.role === 'admin' ? 'Admin' : 'Kasir'} / ${u.username}</small></div>
          <button class="icon-btn" data-a="logout" aria-label="Keluar" title="Keluar">${icon('logout', 19)}</button></div>
      </aside>
      <div style="min-width:0"><div class="a-mobilebar"><button class="icon-btn" data-a="nav" aria-label="Buka menu">${icon('menu', 22)}</button>${logoEl(app)}<b>${app.brandName}</b></div>
      <main class="a-main" id="a-main"></main></div></div>`;
  }
  const main = () => $('#a-main', root);
  const loading = () => mount(main(), html`<div class="skeleton" style="height:36px;width:240px;margin-bottom:20px"></div><div class="kpis">${[1, 2, 3, 4].map(() => html`<div class="skeleton" style="height:96px"></div>`)}</div><div class="skeleton" style="height:320px"></div>`);
  const head = (title, desc, actions = '') => html`<header class="a-head"><div><h1>${title}</h1>${desc ? html`<p>${desc}</p>` : ''}</div><div class="actions">${actions}</div></header>`;
  const errorBox = (e) => html`<div class="card pad empty">${icon('x')}<h4>Gagal memuat data</h4><p>${e.message}</p><button class="btn btn-ghost" style="margin-top:12px" data-a="reload">Coba lagi</button></div>`;

  async function loadCustomers(force = false) {
    if (!A.customers || force) A.customers = await get('/api/staff/customers');
    return A.customers;
  }

  async function pollBadge() {
    try {
      const list = await get('/api/staff/orders?scope=active');
      const n = list.filter((o) => o.status === 'pending').length;
      if (n > A.badge && A.badge !== null && A.started) toast(`${n - A.badge} pesanan online baru masuk`, 'ok');
      A.badge = n;
      const b = $('#order-badge', root);
      if (b) { b.textContent = n; b.classList.toggle('hide', !n); }
      if (sub() === 'orders' && A.onOrders) A.onOrders(list);
    } catch {}
  }

  // ======================================================================
  // Router halaman
  // ======================================================================
  const PAGES = { '': pageDashboard, pos: pagePos, orders: pageOrders, customers: pageCustomers, transactions: pageTransactions, menu: pageMenu, rewards: pageRewards, layout: pageLayout, settings: pageSettings, staff: pageStaff, audit: pageAudit };
  async function render() {
    let p = sub();
    const navItem = NAV.find((n) => n.p === p && !n.grp);
    if (!PAGES[p] || (navItem?.admin && !isAdmin())) { location.hash = isAdmin() ? '#/admin' : '#/admin/pos'; return; }
    A.cleanup.forEach((f) => f()); A.cleanup = [];
    A.actions = {}; A.onOrders = null;
    mount(root, shell());
    $('#a-shell', root).classList.remove('nav-open');
    window.scrollTo(0, 0);
    loading();
    try { await PAGES[p](); } catch (e) { mount(main(), errorBox(e)); }
  }

  // Delegasi event global untuk halaman admin
  on(root, 'click', '[data-a]', (e, el) => {
    const a = el.dataset.a;
    if (a === 'nav') { $('#a-shell', root).classList.toggle('nav-open'); return; }
    if (a === 'reload') { render(); return; }
    if (a === 'logout') { logout(); return; }
    A.actions[a]?.(el, e);
  });
  on(root, 'click', '.a-shell', (e) => { if (e.target.id === 'a-shell') $('#a-shell', root).classList.remove('nav-open'); });

  async function logout() {
    if (!(await confirmDialog('Keluar dari panel?', { confirmText: 'Keluar' }))) return;
    try { await post('/api/auth/logout', {}); } catch {}
    setCsrf(null); st.session = { kind: null }; store.route();
  }

  // ======================================================================
  // RINGKASAN
  // ======================================================================
  async function pageDashboard() {
    const d = await get('/api/staff/dashboard');
    const k = d.kpis;
    const maxDay = Math.max(1, ...d.daily.map((x) => x.total));
    const W = 640, H = 200, pad = 26, bw = (W - pad) / d.daily.length;
    const ticks = [0, 0.5, 1].map((f) => Math.round(maxDay * f));
    const chart = raw(`<svg viewBox="0 0 ${W} ${H + 24}" role="img" aria-label="Omzet harian 14 hari terakhir">
      ${ticks.map((t) => { const y = H - (t / maxDay) * (H - 10); return `<line class="grid" x1="${pad}" x2="${W}" y1="${y}" y2="${y}"/><text x="0" y="${y + 3}">${t >= 1e6 ? (t / 1e6).toFixed(1) + 'jt' : t >= 1e3 ? Math.round(t / 1e3) + 'rb' : t}</text>`; }).join('')}
      ${d.daily.map((x, i) => { const h = Math.max(x.total ? 3 : 0, (x.total / maxDay) * (H - 10)); const X = pad + i * bw + 2; const w = bw - 4; const r = Math.min(4, w / 2, h);
        const path = h ? `M${X},${H} V${H - h + r} Q${X},${H - h} ${X + r},${H - h} H${X + w - r} Q${X + w},${H - h} ${X + w},${H - h + r} V${H} Z` : '';
        return `<path class="bar ${x.date === d.today ? 'today' : ''}" d="${path}" data-tip="${esc(fdate(x.date, false))}: ${esc(rupiah(x.total))} (${x.count} transaksi)"/><rect x="${X}" y="0" width="${w}" height="${H}" fill="transparent" data-tip="${esc(fdate(x.date, false))}: ${esc(rupiah(x.total))} (${x.count} transaksi)"/>${i % 2 === 0 || i === d.daily.length - 1 ? `<text x="${X + w / 2}" y="${H + 16}" text-anchor="middle">${esc(fdate(x.date, false))}</text>` : ''}`; }).join('')}</svg>`);
    const tierMax = Math.max(1, ...d.tiers.map((t) => t.count));
    const topMax = Math.max(1, ...d.topMenu.map((t) => t.qty));
    mount(main(), html`${head('Ringkasan', `Data per ${fdate(d.today)}`, html`<a class="btn btn-primary" href="#/admin/pos">${icon('register', 18)} Buka kasir</a>`)}
      <div class="kpis">
        <div class="kpi hero"><div class="lbl">${icon('coin', 16)} Omzet bulan ini</div><div class="val">${rupiah(k.revenueMonth)}</div><div class="sub">${num(k.trxMonth)} transaksi</div></div>
        <div class="kpi"><div class="lbl">${icon('clock', 16)} Omzet hari ini</div><div class="val">${rupiah(k.revenueToday)}</div><div class="sub">${num(k.trxToday)} transaksi</div></div>
        <div class="kpi"><div class="lbl">${icon('users', 16)} Member</div><div class="val">${num(k.members)}</div><div class="sub">${num(k.activeMembers)} aktif, ${num(k.newMembers30)} baru 30 hari</div></div>
        <div class="kpi"><div class="lbl">${icon('receipt', 16)} Rata-rata belanja</div><div class="val">${rupiah(k.avgTicket)}</div><div class="sub">dari ${num(k.trxAll)} transaksi</div></div>
        <div class="kpi"><div class="lbl">${icon('gift', 16)} Poin beredar</div><div class="val">${num(k.pointsOutstanding)}</div><div class="sub">belum ditukar member</div></div>
      </div>
      <div class="grid-2">
        <section class="card"><div class="card-head"><h3>Omzet 14 hari terakhir</h3><span class="spacer"></span><span class="small muted">Batang kuning = hari ini</span></div><div class="chart" id="chart">${chart}</div></section>
        <section class="card"><div class="card-head"><h3>Member per level</h3></div><div class="hbar">${d.tiers.map((t) => html`<div class="hbar-row" style="--hc:${t.color}"><span>${t.name}</span><b class="tnum">${num(t.count)}</b><div class="t"><i style="width:${(t.count / tierMax) * 100}%"></i></div></div>`)}
          <div class="divider" style="margin:4px 0"></div>${d.status.map((s) => html`<div class="kv" style="padding:2px 0"><span>${statusBadge(s.key)}</span><b class="tnum">${num(s.count)}</b></div>`)}</div></section>
      </div>
      <div class="grid-2e" style="margin-top:16px">
        <section class="card"><div class="card-head"><h3>Menu terlaris</h3></div><div class="hbar">${d.topMenu.length ? d.topMenu.map((t) => html`<div class="hbar-row"><span>${t.name}</span><span class="tnum muted">${num(t.qty)} terjual</span><div class="t"><i style="width:${(t.qty / topMax) * 100}%"></i></div></div>`) : html`<p class="muted">Belum ada penjualan.</p>`}</div></section>
        <section class="card"><div class="card-head"><h3>Customer teratas</h3><span class="spacer"></span><a class="link small" href="#/admin/customers">Semua customer</a></div>
          <div style="padding:8px 18px 14px">${d.topCustomers.map((c) => html`<div class="kv" style="align-items:center"><span class="row" style="gap:10px"><b style="color:var(--text)">${c.name}</b>${tierChip(c.tier)}</span><span class="tnum">${rupiah(c.totalSpend)}</span></div>`)}</div></section>
      </div>
      <section class="card" style="margin-top:16px"><div class="card-head"><h3>Transaksi terbaru</h3><span class="spacer"></span><a class="link small" href="#/admin/transactions">Semua transaksi</a></div>
        <div style="padding:10px 0 0">${trxTable(d.recent, { compact: true })}</div></section>`);
    chartTips($('#chart', root));
  }

  function chartTips(box) {
    if (!box) return;
    const tip = document.createElement('div');
    tip.className = 'badge'; tip.style.cssText = 'position:fixed;pointer-events:none;z-index:90;background:var(--text);color:var(--bg);display:none';
    document.body.append(tip);
    A.cleanup.push(() => tip.remove());
    box.addEventListener('mousemove', (e) => {
      const t = e.target.closest('[data-tip]');
      if (!t) { tip.style.display = 'none'; return; }
      tip.textContent = t.dataset.tip; tip.style.display = 'block';
      tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY - 30 + 'px';
    });
    box.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  }

  function trxTable(list, { compact = false } = {}) {
    if (!list.length) return html`<div class="empty">${icon('receipt')}<h4>Belum ada transaksi</h4><p>Transaksi dari kasir dan aplikasi akan muncul di sini.</p></div>`;
    return html`<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Kode</th><th>Tanggal</th><th>Customer</th><th>Item</th><th class="r">Total</th>${compact ? '' : html`<th>Bayar</th>`}<th class="r">Poin</th>${compact ? '' : html`<th>Sumber</th><th></th>`}</tr></thead><tbody>
      ${list.map((t) => html`<tr class="${t.status === 'void' ? 'void' : ''}"><td class="tnum"><b>${t.code}</b></td><td class="nw">${fdate(t.date)}</td>
        <td class="who">${t.customer ? html`<b>${t.customer.name}</b><small>${t.customer.memberCode}</small>` : html`<span class="muted">Non-member</span>`}</td>
        <td style="max-width:260px">${t.items.map((i) => `${i.qty}x ${i.name}`).join(', ')}${t.voucherCode ? html`<div class="small muted">Voucher ${t.voucherCode}</div>` : ''}</td>
        <td class="r nw"><b>${rupiah(t.total)}</b>${t.discount ? html`<div class="small muted">-${rupiah(t.discount)}</div>` : ''}</td>${compact ? '' : html`<td>${t.payment || '-'}</td>`}
        <td class="r">${t.pointsEarned ? `+${num(t.pointsEarned)}` : '-'}</td>
        ${compact ? '' : html`<td>${t.status === 'void' ? html`<span class="badge badge-danger" title="${t.voidReason || ''}">Dibatalkan</span>` : html`<span class="badge">${SRC_LABEL[t.source]}</span>`}</td>
        <td>${isAdmin() && t.status === 'paid' ? html`<button class="btn btn-sm btn-ghost" data-a="void" data-id="${t.id}" data-code="${t.code}">Batalkan</button>` : ''}</td>`}</tr>`)}
      </tbody></table></div>`;
  }

  // ======================================================================
  // KASIR (POS)
  // ======================================================================
  async function pagePos() {
    const [menuRes, customers] = await Promise.all([get('/api/staff/menu'), loadCustomers(true)]);
    const P = A.pos || (A.pos = { lines: [], customer: null, voucher: '', payment: st.config.options.payments[0], cat: 'all', q: '', date: '' });
    if (P.customer) P.customer = customers.find((c) => c.id === P.customer.id) || null;
    const cats = menuRes.categories.filter((c) => c.active);
    const menu = menuRes.menu;
    const catKey = (m) => cats.find((c) => c.id === m.categoryId)?.key;
    const loyalty = st.config.loyalty;

    mount(main(), html`${head('Kasir', 'Catat transaksi di toko. Harga & poin dihitung otomatis oleh server.')}
      <div class="pos"><div>
        <div class="toolbar"><label class="input-icon">${icon('search', 18)}<input type="search" id="pos-q" placeholder="Cari menu" value="${P.q}" autocomplete="off"></label></div>
        <div class="chips" style="margin:0 0 14px;padding:0" id="pos-cats"><button class="chip" data-a="pcat" data-k="all" aria-pressed="${P.cat === 'all'}">Semua</button>${cats.map((c) => html`<button class="chip" data-a="pcat" data-k="${c.key}" aria-pressed="${P.cat === c.key}">${c.name}</button>`)}</div>
        <div class="pos-grid" id="pos-grid"></div></div>
        <aside class="ticket" id="ticket"></aside></div>`);

    const drawGrid = () => {
      const q = P.q.toLowerCase();
      const list = menu.filter((m) => (P.cat === 'all' || catKey(m) === P.cat) && (!q || m.name.toLowerCase().includes(q)));
      mount($('#pos-grid', root), list.length ? list.map((m) => {
        const inCart = P.lines.find((l) => l.menuItemId === m.id);
        return html`<button class="pos-item" data-a="padd" data-id="${m.id}" title="${m.name}"><div class="thumb">${menuThumb(m, catKey(m))}${m.available ? '' : html`<span class="soldout">Habis</span>`}</div>${inCart ? html`<span class="q">${inCart.qty}</span>` : ''}<div class="info"><b>${m.name}</b><span>${rupiah(m.price)}</span></div></button>`;
      }) : html`<p class="muted">Menu tidak ditemukan.</p>`);
    };
    const drawTicket = () => {
      const lines = P.lines.map((l) => ({ ...l, item: menu.find((m) => m.id === l.menuItemId) })).filter((l) => l.item);
      const subtotal = lines.reduce((s, l) => s + l.item.price * l.qty, 0);
      const c = P.customer;
      const v = P.voucherInfo;
      let disc = 0;
      if (v && c && v.customer?.id === c.id && v.status === 'active') disc = voucherDiscount(v, lines.map((l) => ({ menuItemId: l.menuItemId, price: l.item.price })), subtotal);
      const total = subtotal - Math.max(0, disc);
      const pts = c ? pointsForPurchase(c.stats.totalSpend, total, loyalty, tierFor(c.stats.tierSpend, loyalty.tiers)) : 0;
      mount($('#ticket', root), html`<div class="ticket-head">
          ${c ? html`<div class="cust-pick">${tierChip(c.stats.tier)}<div class="who"><b>${c.name}</b><small>${c.memberCode} / ${num(c.stats.points)} poin</small></div><button class="icon-btn" data-a="pcust-clear" aria-label="Hapus member">${icon('x', 18)}</button></div>`
          : html`<button class="btn btn-soft btn-block" data-a="pcust">${icon('user', 18)} Pilih member (opsional)</button>`}</div>
        <div class="ticket-body">${lines.length ? lines.map((l) => html`<div class="t-line"><div><b>${l.item.name}</b><br><small>${rupiah(l.item.price)}</small></div>
            <div class="qty"><button data-a="pq" data-id="${l.menuItemId}" data-d="-1" aria-label="Kurangi">${icon(l.qty === 1 ? 'trash' : 'minus', 14)}</button><b>${l.qty}</b><button data-a="pq" data-id="${l.menuItemId}" data-d="1" aria-label="Tambah">${icon('plus', 14)}</button></div></div>`)
          : html`<div class="empty" style="padding:30px 0">${icon('bag')}<p>Ketuk menu di kiri untuk menambah item.</p></div>`}</div>
        <div class="ticket-foot">
          <div class="row-2"><label class="field" style="margin-bottom:10px"><span>Metode bayar</span><select id="p-pay">${st.config.options.payments.map((p) => html`<option ${p === P.payment ? raw('selected') : ''}>${p}</option>`)}</select></label>
          <label class="field" style="margin-bottom:10px"><span>Voucher</span><input id="p-voucher" placeholder="Kode" value="${P.voucher}" ${c ? '' : raw('disabled title="Pilih member dulu"')} style="text-transform:uppercase"></label></div>
          ${v && P.voucher ? html`<p class="small" style="margin:-4px 0 8px;color:${disc < 0 || v.status !== 'active' || v.customer?.id !== c?.id ? 'var(--danger)' : 'var(--ok)'}">${v.customer?.id !== c?.id ? 'Voucher milik member lain' : v.status !== 'active' ? 'Voucher tidak aktif' : disc < 0 ? 'Item gratis belum ada di keranjang' : `${v.name} dipakai`}</p>` : ''}
          ${isAdmin() ? html`<label class="field" style="margin-bottom:10px"><span>Tanggal transaksi</span><input type="date" id="p-date" value="${P.date || todayIn()}" max="${todayIn()}"></label>` : ''}
          <div class="kv"><span>Subtotal</span><span class="tnum">${rupiah(subtotal)}</span></div>
          ${disc > 0 ? html`<div class="kv"><span>Diskon voucher</span><span class="tnum plus">-${rupiah(disc)}</span></div>` : ''}
          <div class="kv total"><span>Total</span><span class="tnum">${rupiah(total)}</span></div>
          ${c ? html`<p class="small muted" style="margin:4px 0 10px">${c.name} akan mendapat sekitar <b style="color:var(--text)">+${num(pts)} poin</b></p>` : html`<p class="small muted" style="margin:4px 0 10px">Transaksi tanpa member tidak mendapat poin.</p>`}
          <button class="btn btn-primary btn-block" data-a="psave" ${lines.length ? '' : raw('disabled')}>Simpan transaksi</button></div>`);
    };
    drawGrid(); drawTicket();

    const qIn = $('#pos-q', root);
    qIn.addEventListener('input', () => { P.q = qIn.value; drawGrid(); });
    on(main(), 'change', '#p-pay', (e, el) => { P.payment = el.value; });
    on(main(), 'change', '#p-date', (e, el) => { P.date = el.value; });
    on(main(), 'change', '#p-voucher', async (e, el) => {
      P.voucher = el.value.trim().toUpperCase(); P.voucherInfo = null;
      if (P.voucher) { try { P.voucherInfo = await get('/api/staff/vouchers/' + encodeURIComponent(P.voucher)); } catch (err) { toast(err.message, 'error'); } }
      drawTicket();
    });
    A.actions.pcat = (el) => { P.cat = el.dataset.k; $$('#pos-cats .chip', root).forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.k === P.cat))); drawGrid(); };
    A.actions.padd = (el) => {
      const id = Number(el.dataset.id);
      const m = menu.find((x) => x.id === id);
      if (!m.available) toast(`${m.name} ditandai habis, tetap ditambahkan`);
      const l = P.lines.find((x) => x.menuItemId === id);
      if (l) l.qty = Math.min(100, l.qty + 1); else P.lines.push({ menuItemId: id, qty: 1 });
      drawGrid(); drawTicket();
    };
    A.actions.pq = (el) => {
      const l = P.lines.find((x) => x.menuItemId === Number(el.dataset.id));
      l.qty += Number(el.dataset.d);
      if (l.qty <= 0) P.lines = P.lines.filter((x) => x !== l);
      drawGrid(); drawTicket();
    };
    A.actions['pcust-clear'] = () => { P.customer = null; P.voucher = ''; P.voucherInfo = null; drawTicket(); };
    A.actions.pcust = () => pickCustomer(A.customers, (c) => { P.customer = c; drawTicket(); });
    A.actions.psave = async (el) => {
      busy(el);
      try {
        const sale = await post('/api/staff/transactions', {
          customerId: P.customer?.id || null, items: P.lines, payment: P.payment, voucherCode: P.voucher || null, date: P.date && P.date !== todayIn() ? P.date : null,
        });
        const before = P.customer;
        A.pos = null;
        await loadCustomers(true);
        const after = before ? A.customers.find((c) => c.id === before.id) : null;
        sheet(html`<div class="pass">${icon('check', 40)}<h3 style="margin:6px 0 2px">Transaksi tersimpan</h3><div class="muted tnum">${sale.code} / ${fdate(sale.date)}</div>
          <div class="queue" style="margin:12px 0 4px">${rupiah(sale.total)}</div><div class="muted">${sale.payment}</div>
          ${after ? html`<div class="code-box" style="margin-top:16px"><div class="small muted">${after.name} mendapat</div><b style="letter-spacing:0">+${num(sale.pointsEarned)} poin</b><div class="small muted">Saldo sekarang ${num(after.stats.points)} poin, level ${after.stats.tier.name}</div></div>` : ''}
          <button class="btn btn-primary btn-block" data-close style="margin-top:12px">Transaksi berikutnya</button></div>`);
        pagePos();
      } catch (err) { busy(el, false); toast(err.message, 'error'); }
    };
  }

  function pickCustomer(customers, onPick) {
    let tab = 'cari';
    const s = sheet('', { title: 'Pilih member' });
    const draw = (q = '') => {
      const qq = q.toLowerCase();
      const list = customers.filter((c) => c.active && (!qq || c.name.toLowerCase().includes(qq) || c.memberCode.toLowerCase().includes(qq) || (c.phone || '').includes(qq))).slice(0, 60);
      mount(s.el, html`<div class="seg" style="margin-bottom:14px"><button data-t="cari" aria-pressed="${tab === 'cari'}">Cari</button><button data-t="kode" aria-pressed="${tab === 'kode'}">Kode 6 digit</button><button data-t="baru" aria-pressed="${tab === 'baru'}">Member baru</button></div>
        ${tab === 'cari' ? html`<label class="input-icon">${icon('search', 18)}<input id="pc-q" placeholder="Nama, ID member, atau nomor WA" value="${q}" autofocus autocomplete="off"></label>
          <div class="pick-list">${list.map((c) => html`<button data-pick="${c.id}"><span class="avatar" style="width:36px;height:36px;font-size:14px">${c.name.charAt(0)}</span><div style="flex:1"><b>${c.name}</b><div class="small muted">${c.memberCode}${c.phone ? ' / ' + c.phone : ''}</div></div>${tierChip(c.stats.tier)}</button>`)}
          ${list.length ? '' : html`<p class="muted" style="padding:14px 0">Tidak ditemukan. Daftarkan sebagai member baru.</p>`}</div>`
        : tab === 'kode' ? html`<p class="muted small" style="margin-bottom:12px">Minta customer membuka aplikasi, ketuk <b>Kode member</b>, lalu ketik 6 digit yang tampil.</p>
          <form id="pc-code" class="row"><input name="code" inputmode="numeric" maxlength="7" placeholder="123 456" autofocus style="font-size:22px;letter-spacing:.15em;text-align:center"><button class="btn btn-primary">Cari</button></form>`
        : html`<form id="pc-new"><label class="field"><span>Nama</span><input name="name" required maxlength="60" autofocus></label>
          <label class="field"><span>Nomor WhatsApp (opsional)</span><input name="phone" inputmode="tel" placeholder="0812xxxxxxx"></label>
          <div class="row-2"><label class="field"><span>Gender</span><select name="gender"><option value="">-</option>${st.config.options.genders.map((g) => html`<option>${g}</option>`)}</select></label>
          <label class="field"><span>Tahu dari mana</span><select name="source"><option value="">-</option>${(A.options?.sources || st.config.options.sources || []).map((g) => html`<option>${g}</option>`)}</select></label></div>
          <button class="btn btn-primary btn-block">Daftarkan & pilih</button></form>`}`);
      $('#pc-q', s.el)?.addEventListener('input', (e) => { const pos = e.target.selectionStart; draw(e.target.value); const i = $('#pc-q', s.el); i.focus(); i.setSelectionRange(pos, pos); });
    };
    draw();
    on(s.el, 'click', '[data-t]', (e, b) => { tab = b.dataset.t; draw(); });
    on(s.el, 'click', '[data-pick]', (e, b) => { onPick(customers.find((c) => c.id === Number(b.dataset.pick))); s.close(); });
    on(s.el, 'submit', '#pc-code', async (e, f) => {
      e.preventDefault();
      try { const c = await get('/api/staff/lookup?code=' + encodeURIComponent(f.code.value.replace(/\D/g, ''))); onPick(c); s.close(); toast(`Member ditemukan: ${c.name}`, 'ok'); } catch (err) { toast(err.message, 'error'); }
    });
    on(s.el, 'submit', '#pc-new', async (e, f) => {
      e.preventDefault();
      const body = formData(f);
      for (const k of ['phone', 'gender', 'source']) if (!body[k]) delete body[k];
      try { const c = await post('/api/staff/customers', body); customers.push(c); onPick(c); s.close(); toast(`Member baru ${c.memberCode} dibuat`, 'ok'); } catch (err) { toast(err.message, 'error'); }
    });
  }

  // ======================================================================
  // PESANAN ONLINE
  // ======================================================================
  async function pageOrders() {
    let scope = 'active';
    const drawList = (list) => {
      if (scope !== 'active') {
        mount($('#orders-box', root), list.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Pesanan</th><th>Waktu</th><th>Customer</th><th>Item</th><th class="r">Total</th><th>Status</th></tr></thead><tbody>
          ${list.map((o) => html`<tr><td><b>${q2(o.queueNo)}</b><div class="small muted">${o.code}</div></td><td>${fdatetime(o.createdAt)}</td><td class="who"><b>${o.customer?.name}</b><small>${o.customer?.memberCode}</small></td>
            <td>${o.items.map((i) => `${i.qty}x ${i.name}`).join(', ')}</td><td class="r">${rupiah(o.total)}</td><td><span class="badge ${o.status === 'completed' ? 'badge-ok' : o.status === 'cancelled' ? 'badge-danger' : 'badge-primary'}">${ORDER_LABEL[o.status]}</span>${o.transactionCode ? html`<div class="small muted">${o.transactionCode}</div>` : ''}</td></tr>`)}</tbody></table></div>`
          : html`<div class="card empty">${icon('bag')}<h4>Belum ada riwayat pesanan</h4></div>`);
        return;
      }
      const col = (status, title) => {
        const items = list.filter((o) => o.status === status);
        return html`<section class="kcol"><h3>${title}<span class="badge">${items.length}</span></h3>${items.length ? items.map((o) => html`<article class="kcard">
          <div class="row"><b style="font-size:20px" class="tnum">${q2(o.queueNo)}</b><span class="spacer"></span><span class="small muted">${ago(o.createdAt)}</span></div>
          <div class="small"><b>${o.customer?.name}</b> <span class="muted">${o.customer?.memberCode}</span></div>
          <ul>${o.items.map((i) => html`<li><span>${i.qty}x ${i.name}${i.note ? html`<br><small class="muted">${i.note}</small>` : ''}</span><span class="tnum">${rupiah(i.lineTotal)}</span></li>`)}</ul>
          ${o.note ? html`<p class="small" style="background:var(--accent-soft);padding:6px 8px;border-radius:6px;margin-bottom:8px">${o.note}</p>` : ''}
          ${o.voucher ? html`<p class="small muted">Voucher: ${o.voucher.name} (-${rupiah(o.discount)})</p>` : ''}
          <div class="kv" style="padding:4px 0"><span>${o.paymentMethod}</span><b class="tnum">${rupiah(o.total)}</b></div>
          <div class="row" style="margin-top:8px">
            ${status === 'pending' ? html`<button class="btn btn-sm btn-primary" data-a="ost" data-id="${o.id}" data-s="processing">Mulai buat</button>` : ''}
            ${status === 'processing' ? html`<button class="btn btn-sm btn-primary" data-a="ost" data-id="${o.id}" data-s="ready">Tandai siap</button>` : ''}
            ${status === 'ready' ? html`<button class="btn btn-sm btn-primary" data-a="ocomplete" data-id="${o.id}">Sudah bayar & diambil</button>` : ''}
            <span class="spacer"></span><button class="btn btn-sm btn-ghost" data-a="ocancel" data-id="${o.id}">Batalkan</button></div></article>`)
          : html`<p class="small muted" style="padding:6px">Kosong</p>`}</section>`;
      };
      mount($('#orders-box', root), html`<div class="kanban">${col('pending', 'Pesanan baru')}${col('processing', 'Sedang dibuat')}${col('ready', 'Siap diambil')}</div>`);
      A.lastOrders = list;
    };
    const load = async () => drawList(await get('/api/staff/orders?scope=' + scope));
    mount(main(), html`${head('Pesanan online', 'Pesanan dari aplikasi customer. Halaman ini diperbarui otomatis.', html`<div class="seg"><button data-a="oscope" data-s="active" aria-pressed="true">Berjalan</button><button data-a="oscope" data-s="all" aria-pressed="false">Riwayat</button></div>`)}
      <div class="notice">${icon('shield', 18)}<span>Poin member baru masuk saat pesanan ditandai <b>Sudah bayar & diambil</b>, jadi poin hanya diberikan untuk pesanan yang benar-benar dibayar.</span></div>
      <div id="orders-box"><div class="skeleton" style="height:240px"></div></div>`);
    await load();
    A.onOrders = (list) => { if (scope === 'active') drawList(list); };
    A.actions.oscope = (el) => { scope = el.dataset.s; $$('[data-a=oscope]', root).forEach((b) => b.setAttribute('aria-pressed', String(b === el))); load(); };
    A.actions.ost = async (el) => { busy(el); try { await post(`/api/staff/orders/${el.dataset.id}/status`, { status: el.dataset.s }); await load(); pollBadge(); } catch (e) { busy(el, false); toast(e.message, 'error'); } };
    A.actions.ocancel = async (el) => {
      const reason = await confirmDialog('Pesanan akan dibatalkan dan voucher (jika ada) dikembalikan ke customer.', { title: 'Batalkan pesanan', danger: true, confirmText: 'Batalkan pesanan', input: { label: 'Alasan', placeholder: 'Contoh: stok habis', min: 3 } });
      if (!reason) return;
      try { await post(`/api/staff/orders/${el.dataset.id}/status`, { status: 'cancelled', reason }); await load(); pollBadge(); toast('Pesanan dibatalkan'); } catch (e) { toast(e.message, 'error'); }
    };
    A.actions.ocomplete = (el) => {
      const o = A.lastOrders.find((x) => x.id === Number(el.dataset.id));
      const s = sheet(html`<p class="muted" style="margin-bottom:14px">Pastikan customer sudah membayar <b style="color:var(--text)">${rupiah(o.total)}</b>. Transaksi akan tercatat dan poin masuk ke akun ${o.customer?.name}.</p>
        <label class="field"><span>Dibayar dengan</span><select id="oc-pay">${st.config.options.payments.map((p) => html`<option ${p === o.paymentMethod ? raw('selected') : ''}>${p}</option>`)}</select></label>
        <button class="btn btn-primary btn-block" id="oc-ok">Selesaikan pesanan</button>`, { title: `Selesaikan ${q2(o.queueNo)}` });
      on(s.el, 'click', '#oc-ok', async (e, b) => {
        busy(b);
        try { const r = await post(`/api/staff/orders/${o.id}/status`, { status: 'completed', payment: $('#oc-pay', s.el).value }); s.close(); toast(`Selesai. ${r.transactionCode}, +${r.pointsEarned} poin untuk ${o.customer?.name}`, 'ok'); await load(); pollBadge(); } catch (err) { busy(b, false); toast(err.message, 'error'); }
      });
    };
    const t = setInterval(() => { if (!document.hidden && scope === 'active') pollBadge(); }, 10000);
    A.cleanup.push(() => clearInterval(t));
  }

  // ======================================================================
  // CUSTOMER
  // ======================================================================
  async function pageCustomers() {
    const customers = await loadCustomers(true);
    const F = A.custFilter || (A.custFilter = { q: '', tier: '', status: '', sort: 'memberCode', dir: 1 });
    const tiers = sortedTiers(st.config.loyalty.tiers);
    mount(main(), html`${head('Customer', `${num(customers.length)} member terdaftar. Kolom sama dengan sheet DASHBOARD di Excel.`, html`
        ${isAdmin() ? html`<button class="btn btn-ghost" data-a="exportc">${icon('download', 18)} Ekspor CSV</button>` : ''}
        <button class="btn btn-primary" data-a="newc">${icon('plus', 18)} Tambah customer</button>`)}
      <div class="toolbar"><label class="input-icon">${icon('search', 18)}<input type="search" id="c-q" placeholder="Cari nama, ID, atau nomor WA" value="${F.q}"></label>
        <select id="c-tier"><option value="">Semua level</option>${tiers.map((t) => html`<option value="${t.key}" ${F.tier === t.key ? raw('selected') : ''}>${t.name}</option>`)}</select>
        <select id="c-status"><option value="">Semua status</option>${Object.entries(STATUS_LABEL).map(([k, l]) => html`<option value="${k}" ${F.status === k ? raw('selected') : ''}>${l}</option>`)}</select></div>
      <div class="tbl-wrap" id="c-table"></div>`);
    const cols = [['memberCode', 'ID'], ['name', 'Nama'], ['joinedAt', 'Daftar'], ['visits', 'Kunjungan', 'r'], ['totalSpend', 'Total belanja', 'r'], ['lastVisit', 'Terakhir'], ['tier', 'Level'], ['points', 'Poin', 'r'], ['status', 'Status'], ['hasAccount', 'Akun aplikasi']];
    const val = (c, k) => ({ visits: c.stats.visits, totalSpend: c.stats.totalSpend, lastVisit: c.stats.lastVisit || '', tier: c.stats.tierSpend, points: c.stats.points, status: c.stats.status, hasAccount: c.hasAccount ? 1 : 0 }[k] ?? (c[k] || ''));
    const draw = () => {
      const q = F.q.toLowerCase();
      const list = customers.filter((c) => (!q || c.name.toLowerCase().includes(q) || c.memberCode.toLowerCase().includes(q) || (c.phone || '').includes(q))
        && (!F.tier || c.stats.tier.key === F.tier) && (!F.status || c.stats.status === F.status))
        .sort((a, b) => { const x = val(a, F.sort), y = val(b, F.sort); return (x > y ? 1 : x < y ? -1 : 0) * F.dir; });
      mount($('#c-table', root), list.length ? html`<table class="tbl"><thead><tr>${cols.map(([k, l, cls]) => html`<th class="${cls || ''}"><button data-a="csort" data-k="${k}">${l}${F.sort === k ? icon(F.dir > 0 ? 'up' : 'down', 13) : ''}</button></th>`)}</tr></thead><tbody>
        ${list.map((c) => html`<tr class="click" data-a="copen" data-id="${c.id}"><td class="tnum"><b>${c.memberCode}</b></td><td class="who"><b>${c.name}</b><small>${c.phone || 'Tanpa nomor'}</small></td><td class="nw">${fdate(c.joinedAt)}</td>
          <td class="r">${num(c.stats.visits)}</td><td class="r">${rupiah(c.stats.totalSpend)}</td><td class="nw">${fdate(c.stats.lastVisit)}</td><td>${tierChip(c.stats.tier)}</td><td class="r"><b>${num(c.stats.points)}</b></td>
          <td>${statusBadge(c.stats.status)}</td><td>${!c.active ? html`<span class="badge badge-danger">Nonaktif</span>` : c.hasAccount ? html`<span class="badge badge-ok">Aktif</span>` : html`<span class="badge">Belum aktivasi</span>`}</td></tr>`)}
        </tbody></table>` : html`<div class="empty">${icon('users')}<h4>Tidak ada customer yang cocok</h4><p>Ubah filter atau kata pencarian.</p></div>`);
    };
    draw();
    $('#c-q', root).addEventListener('input', (e) => { F.q = e.target.value; draw(); });
    $('#c-tier', root).addEventListener('change', (e) => { F.tier = e.target.value; draw(); });
    $('#c-status', root).addEventListener('change', (e) => { F.status = e.target.value; draw(); });
    A.actions.csort = (el) => { const k = el.dataset.k; F.dir = F.sort === k ? -F.dir : 1; F.sort = k; draw(); };
    A.actions.copen = (el) => openCustomer(Number(el.dataset.id), async () => { await loadCustomers(true); pageCustomers(); });
    A.actions.newc = () => customerForm(null, async () => { await loadCustomers(true); pageCustomers(); });
    A.actions.exportc = () => download('/api/staff/export/customers.csv');
  }

  function customerForm(c, done) {
    const o = A.options || st.config.options;
    const s = sheet(html`<form><label class="field"><span>Nama</span><input name="name" required maxlength="60" value="${c?.name || ''}"></label>
      <label class="field"><span>Nomor WhatsApp</span><input name="phone" inputmode="tel" value="${c?.phone || ''}" placeholder="0812xxxxxxx" ${c && !isAdmin() ? raw('disabled') : ''}>${c && !isAdmin() ? html`<small>Hanya admin yang bisa mengganti nomor.</small>` : ''}</label>
      <div class="row-2"><label class="field"><span>Gender</span><select name="gender"><option value="">-</option>${o.genders.map((g) => html`<option ${g === c?.gender ? raw('selected') : ''}>${g}</option>`)}</select></label>
      <label class="field"><span>Tanggal lahir</span><input type="date" name="birthday" value="${c?.birthday || ''}"></label></div>
      <label class="field"><span>Sumber (tahu dari mana)</span><select name="source"><option value="">-</option>${[...(o.sources || []), 'Aplikasi'].map((g) => html`<option ${g === c?.source ? raw('selected') : ''}>${g}</option>`)}</select></label>
      <label class="field"><span>Menu favorit (catatan)</span><input name="favoriteNote" maxlength="120" value="${c?.favoriteNote || ''}"></label>
      <label class="field"><span>Catatan</span><textarea name="note" maxlength="300">${c?.note || ''}</textarea></label>
      ${c && isAdmin() ? html`<label class="check" style="margin-bottom:16px"><span class="switch"><input type="checkbox" name="active" ${c.active ? raw('checked') : ''}><i></i></span> Member aktif (nonaktif = tidak bisa login & tidak bisa dipilih di kasir)</label>` : ''}
      <button class="btn btn-primary btn-block">${c ? 'Simpan perubahan' : 'Tambah customer'}</button></form>`, { title: c ? `Ubah ${c.name}` : 'Customer baru' });
    on(s.el, 'submit', 'form', async (e, f) => {
      e.preventDefault();
      const body = formData(f);
      for (const k of Object.keys(body)) if (body[k] === '' && k !== 'note' && k !== 'favoriteNote') body[k] = null;
      if (!c) for (const k of Object.keys(body)) if (body[k] === null || body[k] === '') delete body[k];
      const btn = $('button.btn-primary', f); busy(btn);
      try {
        const r = c ? await patch('/api/staff/customers/' + c.id, body) : await post('/api/staff/customers', body);
        s.close(); toast(c ? 'Data customer disimpan' : `Customer ${r.memberCode} ditambahkan`, 'ok'); done?.(r);
      } catch (err) { busy(btn, false); toast(err.message, 'error'); }
    });
  }

  async function openCustomer(id, onChange) {
    const s = sheet(html`<div class="skeleton" style="height:300px"></div>`, { className: 'drawer', title: 'Detail customer' });
    let tab = 'trx';
    const load = async () => {
      const c = await get('/api/staff/customers/' + id);
      const st2 = c.stats;
      mount(s.el, html`<div class="d-hero"><span class="avatar">${c.name.charAt(0).toUpperCase()}</span><div style="flex:1;min-width:0"><h2 style="font-size:20px">${c.name}</h2>
          <div class="small muted">${c.memberCode} / ${c.phone || 'tanpa nomor'} / daftar ${fdate(c.joinedAt)}</div><div class="row" style="gap:6px;margin-top:6px">${tierChip(st2.tier)}${statusBadge(st2.status)}${c.active ? '' : html`<span class="badge badge-danger">Nonaktif</span>`}</div></div></div>
        <div class="d-stats"><div><small>Poin</small><b>${num(st2.points)}</b></div><div><small>Total belanja</small><b>${rupiah(st2.totalSpend)}</b></div><div><small>Kunjungan</small><b>${num(st2.visits)}x</b></div></div>
        ${st2.nextTier ? html`<p class="small muted" style="margin:-6px 0 14px">Butuh ${rupiah(st2.toNext)} lagi untuk naik ke ${st2.nextTier.name}. Kunjungan terakhir ${fdate(st2.lastVisit)}.</p>` : ''}
        <div class="row" style="flex-wrap:wrap;gap:8px;margin-bottom:6px">
          <button class="btn btn-sm btn-soft" data-x="edit">${icon('edit', 16)} Ubah data</button>
          <button class="btn btn-sm btn-soft" data-x="activation">${icon('key', 16)} ${c.hasAccount ? 'Reset akses aplikasi' : 'Buat kode aktivasi'}</button>
          ${isAdmin() ? html`<button class="btn btn-sm btn-soft" data-x="adjust">${icon('coin', 16)} Koreksi poin</button>` : ''}</div>
        <p class="small muted">${c.hasAccount ? 'Sudah punya akun aplikasi.' : 'Belum mengaktifkan akun aplikasi.'}${c.activationPending ? ' Kode aktivasi aktif sedang menunggu dipakai.' : ''}${st2.favoriteMenu ? ` Paling sering pesan ${st2.favoriteMenu}.` : ''}${c.favoriteNote ? ` Catatan favorit: ${c.favoriteNote}.` : ''}</p>
        ${c.note ? html`<div class="notice" style="margin-top:10px">${c.note}</div>` : ''}
        <div class="tabs" style="padding:0" role="tablist">${[['trx', 'Transaksi'], ['ledger', 'Riwayat poin'], ['voucher', 'Voucher']].map(([k, l]) => html`<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${l}</button>`)}</div>
        <div style="padding-top:6px">${tab === 'trx' ? (c.transactions.length ? c.transactions.map((t) => html`<div class="trx-row"><span class="ti">${icon('receipt', 18)}</span><div class="info"><h5>${t.items.map((i) => `${i.qty}x ${i.name}`).join(', ')}</h5><div class="small muted">${t.code} / ${fdate(t.date)} / ${t.payment || '-'}${t.status === 'void' ? ' / DIBATALKAN' : ''}</div></div><div class="amt"><div>${rupiah(t.total)}</div>${t.pointsEarned ? html`<div class="small plus">+${t.pointsEarned}</div>` : ''}</div></div>`) : html`<p class="muted" style="padding:16px 0">Belum ada transaksi.</p>`)
          : tab === 'ledger' ? (c.ledger.length ? c.ledger.map((l) => html`<div class="trx-row"><span class="ti">${icon(l.delta > 0 ? 'plus' : 'minus', 18)}</span><div class="info"><h5>${LEDGER_LABEL[l.type]}${l.refCode ? ` ${l.refCode}` : ''}</h5><div class="small muted">${l.note || ''} / ${fdatetime(l.createdAt)}${l.staffName ? ` / oleh ${l.staffName}` : ''}</div></div><div class="amt"><div class="${l.delta > 0 ? 'plus' : 'minus'}">${l.delta > 0 ? '+' : ''}${num(l.delta)}</div><div class="small muted">saldo ${num(l.balanceAfter)}</div></div></div>`) : html`<p class="muted" style="padding:16px 0">Belum ada pergerakan poin.</p>`)
          : (c.vouchers.length ? c.vouchers.map((v) => html`<div class="trx-row"><span class="ti">${icon('ticket', 18)}</span><div class="info"><h5>${v.name}</h5><div class="small muted">${v.code} / ${v.status} / s.d. ${fdatetime(v.expiresAt)}</div></div><div class="amt small">-${num(v.pointsCost)} poin</div></div>`) : html`<p class="muted" style="padding:16px 0">Belum pernah tukar poin.</p>`)}</div>`);
      s.c = c;
    };
    on(s.el, 'click', '[data-tab]', (e, b) => { tab = b.dataset.tab; load(); });
    on(s.el, 'click', '[data-x]', async (e, b) => {
      const c = s.c;
      const x = b.dataset.x;
      if (x === 'edit') customerForm(c, async () => { await load(); onChange?.(); });
      if (x === 'activation') {
        if (c.hasAccount && !(await confirmDialog(`${c.name} sudah punya akun. Buat kode reset agar ia bisa membuat kata sandi baru? Kata sandi lama tetap berlaku sampai kode dipakai.`, { confirmText: 'Buat kode reset' }))) return;
        try {
          const r = await post(`/api/staff/customers/${c.id}/activation`, {});
          const msg = `Halo ${c.name}, ini kode ${r.reset ? 'reset akun' : 'aktivasi'} member ${st.config.appearance.brandName} kamu: ${r.code} (berlaku ${r.expiresInHours} jam). Buka aplikasi, pilih "Aktifkan akun", masukkan ID ${r.memberCode} atau nomor WA, lalu kode ini. Jangan bagikan ke siapa pun.`;
          const wa = c.phone ? 'https://wa.me/62' + c.phone.replace(/^0/, '') + '?text=' + encodeURIComponent(msg) : null;
          const s2 = sheet(html`<p class="muted">Berikan kode ini langsung ke ${c.name}. Kode hanya tampil sekali dan berlaku ${r.expiresInHours} jam.</p>
            <div class="code-box"><b>${r.code}</b></div><textarea readonly style="font-size:13px">${msg}</textarea>
            <div class="row" style="margin-top:12px"><button class="btn btn-ghost" id="cp">${icon('copy', 17)} Salin pesan</button>${wa ? html`<a class="btn btn-primary" href="${wa}" target="_blank" rel="noopener noreferrer">Kirim via WhatsApp</a>` : ''}</div>`, { title: r.reset ? 'Kode reset akses' : 'Kode aktivasi' });
          $('#cp', s2.el).addEventListener('click', () => navigator.clipboard?.writeText(msg).then(() => toast('Pesan disalin', 'ok'), () => toast('Salin manual dari kotak teks')));
          load();
        } catch (err) { toast(err.message, 'error'); }
      }
      if (x === 'adjust') {
        const s3 = sheet(html`<form><div class="notice warn">${icon('shield', 18)}<span>Koreksi poin tercatat permanen di riwayat poin dan log aktivitas, beserta nama Anda.</span></div>
          <div class="seg" style="margin-bottom:14px"><button type="button" data-sign="1" aria-pressed="true">Tambah poin</button><button type="button" data-sign="-1" aria-pressed="false">Kurangi poin</button></div>
          <label class="field"><span>Jumlah poin</span><input type="number" name="amount" min="1" max="100000" required></label>
          <label class="field"><span>Alasan</span><input name="reason" required minlength="3" maxlength="200" placeholder="Contoh: kompensasi pesanan salah"></label>
          <button class="btn btn-primary btn-block">Simpan koreksi</button></form>`, { title: `Koreksi poin ${c.name}` });
        let sign = 1;
        on(s3.el, 'click', '[data-sign]', (e2, sb) => { sign = Number(sb.dataset.sign); $$('[data-sign]', s3.el).forEach((z) => z.setAttribute('aria-pressed', String(z === sb))); });
        on(s3.el, 'submit', 'form', async (e2, f) => {
          e2.preventDefault();
          try { const r = await post(`/api/staff/customers/${c.id}/adjust-points`, { delta: sign * Number(f.amount.value), reason: f.reason.value }); s3.close(); toast(`Saldo baru ${num(r.balance)} poin`, 'ok'); load(); onChange?.(); } catch (err) { toast(err.message, 'error'); }
        });
      }
    });
    try { await load(); } catch (e) { mount(s.el, html`<p class="muted">${e.message}</p>`); }
  }

  // ======================================================================
  // TRANSAKSI
  // ======================================================================
  async function pageTransactions() {
    const F = A.trxFilter || (A.trxFilter = { from: todayIn().slice(0, 8) + '01', to: todayIn(), q: '' });
    const load = async () => {
      const list = await get(`/api/staff/transactions?from=${F.from}&to=${F.to}&q=${encodeURIComponent(F.q)}`);
      const paid = list.filter((t) => t.status === 'paid');
      mount($('#trx-sum', root), html`<div class="kpi"><div class="lbl">Omzet periode ini</div><div class="val">${rupiah(paid.reduce((s, t) => s + t.total, 0))}</div><div class="sub">${num(paid.length)} transaksi lunas</div></div>
        <div class="kpi"><div class="lbl">Poin diberikan</div><div class="val">${num(paid.reduce((s, t) => s + t.pointsEarned, 0))}</div><div class="sub">ke ${num(new Set(paid.filter((t) => t.customer).map((t) => t.customer.id)).size)} member</div></div>
        <div class="kpi"><div class="lbl">Dibatalkan</div><div class="val">${num(list.length - paid.length)}</div><div class="sub">poinnya otomatis ditarik</div></div>`);
      mount($('#trx-box', root), html`<div class="tbl-wrap">${trxTable(list)}</div>`);
    };
    mount(main(), html`${head('Transaksi', 'Semua penjualan dari kasir, aplikasi, dan import Excel.', html`${isAdmin() ? html`<button class="btn btn-ghost" data-a="exportt">${icon('download', 18)} Ekspor CSV</button>` : ''}<a class="btn btn-primary" href="#/admin/pos">${icon('plus', 18)} Transaksi baru</a>`)}
      <div class="toolbar"><label class="input-icon">${icon('search', 18)}<input type="search" id="t-q" placeholder="Kode transaksi, nama, ID member" value="${F.q}"></label>
        <label class="row small" style="gap:6px">Dari <input type="date" id="t-from" value="${F.from}" style="width:auto"></label><label class="row small" style="gap:6px">sampai <input type="date" id="t-to" value="${F.to}" style="width:auto"></label></div>
      <div class="kpis" id="trx-sum"></div><div id="trx-box"><div class="skeleton" style="height:200px"></div></div>`);
    await load();
    let t;
    $('#t-q', root).addEventListener('input', (e) => { F.q = e.target.value; clearTimeout(t); t = setTimeout(load, 300); });
    $('#t-from', root).addEventListener('change', (e) => { F.from = e.target.value; load(); });
    $('#t-to', root).addEventListener('change', (e) => { F.to = e.target.value; load(); });
    A.actions.exportt = () => download('/api/staff/export/transactions.csv');
    A.actions.void = voidAction(load);
  }
  const voidAction = (after) => async (el) => {
    const reason = await confirmDialog(`Transaksi ${el.dataset.code} akan ditandai batal dan poin yang sudah diberikan ditarik kembali. Data tidak dihapus.`, { title: 'Batalkan transaksi', danger: true, confirmText: 'Batalkan transaksi', input: { label: 'Alasan pembatalan', min: 3, placeholder: 'Contoh: salah input' } });
    if (!reason) return;
    try { await post(`/api/staff/transactions/${el.dataset.id}/void`, { reason }); toast('Transaksi dibatalkan, poin ditarik', 'ok'); after(); } catch (e) { toast(e.message, 'error'); }
  };

  // ======================================================================
  // MENU
  // ======================================================================
  async function pageMenu() {
    const res = await get('/api/staff/menu');
    const F = A.menuFilter || (A.menuFilter = { q: '', cat: '' });
    const catName = (id) => res.categories.find((c) => c.id === id)?.name || '-';
    const catKey = (id) => res.categories.find((c) => c.id === id)?.key;
    mount(main(), html`${head('Menu', isAdmin() ? `${res.menu.length} menu. Menu yang ditambahkan langsung muncul di aplikasi customer.` : 'Tandai menu yang habis agar tidak bisa dipesan.', isAdmin() ? html`<button class="btn btn-ghost" data-a="cats">${icon('list', 18)} Kelola kategori</button><button class="btn btn-primary" data-a="newm">${icon('plus', 18)} Tambah menu</button>` : '')}
      <div class="toolbar"><label class="input-icon">${icon('search', 18)}<input type="search" id="m-q" placeholder="Cari menu" value="${F.q}"></label>
      <select id="m-cat"><option value="">Semua kategori</option>${res.categories.map((c) => html`<option value="${c.id}" ${String(c.id) === F.cat ? raw('selected') : ''}>${c.name}${c.active ? '' : ' (disembunyikan)'}</option>`)}</select></div>
      <div class="tbl-wrap adm-menu" id="m-table"></div>`);
    const draw = () => {
      const q = F.q.toLowerCase();
      const list = res.menu.filter((m) => (!q || m.name.toLowerCase().includes(q)) && (!F.cat || String(m.categoryId) === F.cat));
      mount($('#m-table', root), html`<table class="tbl"><thead><tr><th></th><th>Menu</th><th>Kategori</th><th class="r">Harga</th>${isAdmin() ? html`<th>Pilihan barista</th>` : ''}<th>Tersedia</th>${isAdmin() ? html`<th></th>` : ''}</tr></thead><tbody>
        ${list.map((m) => html`<tr><td style="width:60px"><div class="thumb">${menuThumb(m, catKey(m.categoryId))}</div></td><td class="who"><b>${m.name}</b><small>${m.temp === 'hot' ? 'Panas' : m.temp === 'cold' ? 'Dingin' : ''}${m.description ? ` ${m.description}` : ''}</small></td>
          <td>${catName(m.categoryId)}</td><td class="r"><b>${rupiah(m.price)}</b></td>
          ${isAdmin() ? html`<td><button class="icon-btn" data-a="mfeat" data-id="${m.id}" aria-pressed="${m.featured}" aria-label="Pilihan barista" style="color:${m.featured ? 'var(--accent)' : 'var(--faint)'}">${raw(icon('star', 20).toString().replace('fill="none"', m.featured ? 'fill="currentColor"' : 'fill="none"'))}</button></td>` : ''}
          <td><label class="switch"><input type="checkbox" data-avail="${m.id}" ${m.available ? raw('checked') : ''} aria-label="Tersedia"><i></i></label></td>
          ${isAdmin() ? html`<td class="r" style="white-space:nowrap"><button class="icon-btn" data-a="editm" data-id="${m.id}" aria-label="Ubah">${icon('edit', 18)}</button><button class="icon-btn" data-a="delm" data-id="${m.id}" aria-label="Hapus">${icon('trash', 18)}</button></td>` : ''}</tr>`)}
        </tbody></table>${list.length ? '' : html`<div class="empty">${icon('cup')}<h4>Belum ada menu</h4></div>`}`);
    };
    draw();
    $('#m-q', root).addEventListener('input', (e) => { F.q = e.target.value; draw(); });
    $('#m-cat', root).addEventListener('change', (e) => { F.cat = e.target.value; draw(); });
    on(main(), 'change', '[data-avail]', async (e, el) => {
      try { const r = await patch('/api/staff/menu/' + el.dataset.avail, { available: el.checked }); Object.assign(res.menu.find((m) => m.id === r.id), r); toast(r.available ? `${r.name} tersedia lagi` : `${r.name} ditandai habis`); await store.reloadConfig(); } catch (err) { el.checked = !el.checked; toast(err.message, 'error'); }
    });
    A.actions.mfeat = async (el) => { const m = res.menu.find((x) => x.id === Number(el.dataset.id)); try { Object.assign(m, await patch('/api/staff/menu/' + m.id, { featured: !m.featured })); draw(); store.reloadConfig(); } catch (e) { toast(e.message, 'error'); } };
    A.actions.newm = () => menuForm(null, res.categories, () => pageMenu());
    A.actions.editm = (el) => menuForm(res.menu.find((x) => x.id === Number(el.dataset.id)), res.categories, () => pageMenu());
    A.actions.delm = async (el) => {
      const m = res.menu.find((x) => x.id === Number(el.dataset.id));
      if (!(await confirmDialog(`Hapus "${m.name}" dari menu? Riwayat transaksi yang memuat menu ini tetap tersimpan.`, { danger: true, confirmText: 'Hapus menu' }))) return;
      try { await del('/api/staff/menu/' + m.id); toast('Menu dihapus'); await store.reloadConfig(); pageMenu(); } catch (e) { toast(e.message, 'error'); }
    };
    A.actions.cats = () => categoryManager(res.categories, () => pageMenu());
  }

  async function uploadImage(file) {
    if (!file) return null;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Pilih gambar PNG, JPG, atau WEBP');
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Gambar tidak bisa dibaca')); i.src = URL.createObjectURL(file); });
    const max = 900;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    let dataUrl = c.toDataURL('image/webp', 0.85);
    if (!dataUrl.startsWith('data:image/webp')) dataUrl = c.toDataURL('image/jpeg', 0.85);
    return (await post('/api/staff/upload', { dataUrl })).url;
  }

  function imagePicker(name, current, fallbackHtml) {
    return html`<div class="img-pick" data-imgpick="${name}"><div class="thumb">${current ? html`<img class="art" src="${current}" alt="">` : fallbackHtml}</div>
      <div><input type="hidden" name="${name}" value="${current || ''}"><label class="btn btn-sm btn-ghost">${icon('image', 16)} ${current ? 'Ganti foto' : 'Unggah foto'}<input type="file" accept="image/png,image/jpeg,image/webp" class="sr-only" data-upload="${name}"></label>
      ${current ? html`<button type="button" class="btn btn-sm btn-ghost" data-clearimg="${name}">Hapus</button>` : ''}<div class="small muted" style="margin-top:4px">PNG/JPG/WEBP, otomatis diperkecil</div></div></div>`;
  }
  function bindImagePicker(container, onChange) {
    on(container, 'change', '[data-upload]', async (e, input) => {
      const name = input.dataset.upload;
      const box = $(`[data-imgpick="${name}"]`, container);
      try {
        toast('Mengunggah gambar...');
        const url = await uploadImage(input.files[0]);
        $(`input[name="${name}"]`, box).value = url;
        mount($('.thumb', box), html`<img class="art" src="${url}" alt="">`);
        onChange?.(name, url);
        toast('Gambar terunggah', 'ok');
      } catch (err) { toast(err.message, 'error'); }
    });
    on(container, 'click', '[data-clearimg]', (e, b) => {
      const name = b.dataset.clearimg;
      const box = $(`[data-imgpick="${name}"]`, container);
      $(`input[name="${name}"]`, box).value = '';
      mount($('.thumb', box), html`<div class="art" style="background:var(--sunken)"></div>`);
      onChange?.(name, null);
    });
  }

  function menuForm(m, categories, done) {
    const s = sheet(html`<form>
      ${imagePicker('image', m?.image, m ? menuThumb({ ...m, image: null }, categories.find((c) => c.id === m.categoryId)?.key) : html`<div class="art" style="background:var(--sunken)"></div>`)}
      <div style="height:14px"></div>
      <label class="field"><span>Nama menu</span><input name="name" required maxlength="60" value="${m?.name || ''}" placeholder="Contoh: Es Kopi Gula Aren"></label>
      <div class="row-2"><label class="field"><span>Kategori</span><select name="categoryId" required>${categories.map((c) => html`<option value="${c.id}" ${c.id === m?.categoryId ? raw('selected') : ''}>${c.name}</option>`)}</select></label>
      <label class="field"><span>Harga (Rp)</span><input type="number" name="price" min="0" step="500" required value="${m?.price ?? ''}" placeholder="25000"></label></div>
      <label class="field"><span>Deskripsi singkat (opsional)</span><textarea name="description" maxlength="240" placeholder="Espresso, susu segar, gula aren">${m?.description || ''}</textarea></label>
      <label class="field"><span>Penyajian</span><select name="temp"><option value="">Tidak ditampilkan</option><option value="hot" ${m?.temp === 'hot' ? raw('selected') : ''}>Panas</option><option value="cold" ${m?.temp === 'cold' ? raw('selected') : ''}>Dingin</option></select></label>
      <label class="check" style="margin-bottom:10px"><span class="switch"><input type="checkbox" name="featured" ${m?.featured ? raw('checked') : ''}><i></i></span> Tampilkan di "Pilihan barista" (beranda)</label>
      <label class="check" style="margin-bottom:18px"><span class="switch"><input type="checkbox" name="available" ${!m || m.available ? raw('checked') : ''}><i></i></span> Tersedia untuk dipesan</label>
      <button class="btn btn-primary btn-block">${m ? 'Simpan perubahan' : 'Tambah menu'}</button></form>`, { title: m ? 'Ubah menu' : 'Menu baru' });
    bindImagePicker(s.el);
    on(s.el, 'submit', 'form', async (e, f) => {
      e.preventDefault();
      const b = formData(f);
      b.categoryId = Number(b.categoryId);
      b.image = b.image || null; b.temp = b.temp || null;
      const btn = $('button.btn-primary', f); busy(btn);
      try { m ? await patch('/api/staff/menu/' + m.id, b) : await post('/api/staff/menu', b); s.close(); toast(m ? 'Menu disimpan' : 'Menu ditambahkan', 'ok'); await store.reloadConfig(); done(); } catch (err) { busy(btn, false); toast(err.message, 'error'); }
    });
  }

  function categoryManager(categories, done) {
    let cats = [...categories];
    const s = sheet('', { title: 'Kategori menu', onClose: done });
    const draw = () => mount(s.el, html`<p class="muted small" style="margin-bottom:12px">Urutan kategori di sini = urutan di aplikasi customer.</p><div class="sec-list">${cats.map((c, i) => html`<div class="sec-item">
        <input value="${c.name}" data-rename="${c.id}" maxlength="30" style="min-height:36px;flex:1">
        <button class="icon-btn" data-mv="${i}" data-d="-1" aria-label="Naik" ${i === 0 ? raw('disabled') : ''}>${icon('up', 18)}</button><button class="icon-btn" data-mv="${i}" data-d="1" aria-label="Turun" ${i === cats.length - 1 ? raw('disabled') : ''}>${icon('down', 18)}</button>
        <label class="switch" title="Tampilkan"><input type="checkbox" data-cact="${c.id}" ${c.active ? raw('checked') : ''} aria-label="Tampilkan"><i></i></label>
        <button class="icon-btn" data-cdel="${c.id}" aria-label="Hapus">${icon('trash', 17)}</button></div>`)}</div>
      <form class="row" style="margin-top:14px" id="cnew"><input name="name" placeholder="Nama kategori baru" maxlength="30" required><button class="btn btn-primary">${icon('plus', 18)} Tambah</button></form>`);
    draw();
    const save = async (id, body) => { try { cats = await patch('/api/staff/categories/' + id, body); draw(); } catch (e) { toast(e.message, 'error'); } };
    on(s.el, 'change', '[data-rename]', (e, el) => save(el.dataset.rename, { name: el.value }));
    on(s.el, 'change', '[data-cact]', (e, el) => save(el.dataset.cact, { active: el.checked }));
    on(s.el, 'click', '[data-mv]', async (e, b) => {
      const i = Number(b.dataset.mv), j = i + Number(b.dataset.d);
      [cats[i], cats[j]] = [cats[j], cats[i]];
      for (let k = 0; k < cats.length; k++) if (cats[k].sort !== k + 1) { try { cats = await patch('/api/staff/categories/' + cats[k].id, { sort: k + 1 }); } catch (err) { toast(err.message, 'error'); } }
      cats.sort((a, b2) => a.sort - b2.sort); draw();
    });
    on(s.el, 'click', '[data-cdel]', async (e, b) => {
      if (!(await confirmDialog('Hapus kategori ini? Kategori harus kosong.', { danger: true, confirmText: 'Hapus' }))) return;
      try { cats = await del('/api/staff/categories/' + b.dataset.cdel); draw(); } catch (err) { toast(err.message, 'error'); }
    });
    on(s.el, 'submit', '#cnew', async (e, f) => { e.preventDefault(); try { cats = await post('/api/staff/categories', { name: f.name.value }); draw(); toast('Kategori ditambahkan', 'ok'); } catch (err) { toast(err.message, 'error'); } });
  }

  // ======================================================================
  // REWARDS
  // ======================================================================
  async function pageRewards() {
    const [rewards, menuRes] = await Promise.all([get('/api/staff/rewards'), get('/api/staff/menu')]);
    const tiers = sortedTiers(st.config.loyalty.tiers);
    const desc = (r) => r.type === 'free_item' ? `Gratis ${menuRes.menu.find((m) => m.id === r.menuItemId)?.name || 'menu'}` : r.type === 'discount_amount' ? `Potongan ${rupiah(r.value)}` : `Diskon ${r.value}%`;
    mount(main(), html`${head('Rewards', 'Katalog penukaran poin. Poin dipotong saat customer menukar, voucher dipakai di kasir atau saat pesan di aplikasi.', html`<button class="btn btn-primary" data-a="newr">${icon('plus', 18)} Tambah reward</button>`)}
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Reward</th><th>Isi</th><th class="r">Harga poin</th><th>Minimal level</th><th class="r">Stok</th><th>Berlaku</th><th>Aktif</th><th></th></tr></thead><tbody>
      ${rewards.map((r) => html`<tr><td class="who"><b>${r.name}</b><small>${r.description || ''}</small></td><td>${desc(r)}</td><td class="r"><b>${num(r.pointsCost)}</b></td>
        <td>${r.minTier ? tierChip(tiers.find((t) => t.key === r.minTier) || { name: r.minTier, color: '#999' }) : html`<span class="muted">Semua</span>`}</td><td class="r">${r.stock === null ? html`<span class="muted">Tanpa batas</span>` : num(r.stock)}</td><td>${r.validDays} hari</td>
        <td><label class="switch"><input type="checkbox" data-ract="${r.id}" ${r.active ? raw('checked') : ''} aria-label="Aktif"><i></i></label></td>
        <td class="r" style="white-space:nowrap"><button class="icon-btn" data-a="editr" data-id="${r.id}" aria-label="Ubah">${icon('edit', 18)}</button><button class="icon-btn" data-a="delr" data-id="${r.id}" aria-label="Hapus">${icon('trash', 18)}</button></td></tr>`)}
      </tbody></table>${rewards.length ? '' : html`<div class="empty">${icon('gift')}<h4>Belum ada reward</h4><p>Tambahkan reward pertama agar poin member bisa ditukar.</p></div>`}</div>`);
    on(main(), 'change', '[data-ract]', async (e, el) => { try { await patch('/api/staff/rewards/' + el.dataset.ract, { active: el.checked }); store.reloadConfig(); } catch (err) { el.checked = !el.checked; toast(err.message, 'error'); } });
    A.actions.newr = () => rewardForm(null, menuRes.menu, tiers);
    A.actions.editr = (el) => rewardForm(rewards.find((r) => r.id === Number(el.dataset.id)), menuRes.menu, tiers);
    A.actions.delr = async (el) => {
      if (!(await confirmDialog('Hapus reward ini? Voucher yang sudah ditukar tetap berlaku.', { danger: true, confirmText: 'Hapus reward' }))) return;
      try { await del('/api/staff/rewards/' + el.dataset.id); await store.reloadConfig(); pageRewards(); } catch (e) { toast(e.message, 'error'); }
    };
  }

  function rewardForm(r, menu, tiers) {
    const s = sheet(html`<form>
      <label class="field"><span>Nama reward</span><input name="name" required maxlength="60" value="${r?.name || ''}" placeholder="Contoh: Gratis Americano"></label>
      <label class="field"><span>Deskripsi (opsional)</span><input name="description" maxlength="200" value="${r?.description || ''}"></label>
      <div class="row-2"><label class="field"><span>Jenis</span><select name="type" id="rtype">${Object.entries(REWARD_TYPE).map(([k, l]) => html`<option value="${k}" ${(r?.type || 'free_item') === k ? raw('selected') : ''}>${l}</option>`)}</select></label>
      <label class="field"><span>Harga (poin)</span><input type="number" name="pointsCost" min="1" required value="${r?.pointsCost ?? ''}"></label></div>
      <label class="field" id="r-menu"><span>Menu yang digratiskan</span><select name="menuItemId"><option value="">Pilih menu</option>${menu.map((m) => html`<option value="${m.id}" ${m.id === r?.menuItemId ? raw('selected') : ''}>${m.name} (${rupiah(m.price)})</option>`)}</select></label>
      <label class="field" id="r-value"><span id="r-value-l">Nilai</span><input type="number" name="value" min="0" value="${r?.value ?? ''}"></label>
      <div class="row-3"><label class="field"><span>Minimal level</span><select name="minTier"><option value="">Semua level</option>${tiers.map((t) => html`<option value="${t.key}" ${t.key === r?.minTier ? raw('selected') : ''}>${t.name}</option>`)}</select></label>
      <label class="field"><span>Stok</span><input type="number" name="stock" min="0" value="${r?.stock ?? ''}" placeholder="Tanpa batas"></label>
      <label class="field"><span>Berlaku (hari)</span><input type="number" name="validDays" min="1" max="365" value="${r?.validDays ?? 30}"></label></div>
      <label class="check" style="margin-bottom:18px"><span class="switch"><input type="checkbox" name="active" ${!r || r.active ? raw('checked') : ''}><i></i></span> Aktif (tampil di aplikasi)</label>
      <button class="btn btn-primary btn-block">${r ? 'Simpan reward' : 'Tambah reward'}</button></form>`, { title: r ? 'Ubah reward' : 'Reward baru' });
    const sync = () => {
      const t = $('#rtype', s.el).value;
      $('#r-menu', s.el).classList.toggle('hide', t !== 'free_item');
      $('#r-value', s.el).classList.toggle('hide', t === 'free_item');
      $('#r-value-l', s.el).textContent = t === 'discount_percent' ? 'Diskon (%)' : 'Potongan (Rp)';
    };
    sync();
    $('#rtype', s.el).addEventListener('change', sync);
    on(s.el, 'submit', 'form', async (e, f) => {
      e.preventDefault();
      const b = formData(f);
      b.menuItemId = b.type === 'free_item' ? Number(b.menuItemId) || null : null;
      b.value = b.type === 'free_item' ? 0 : b.value;
      b.minTier = b.minTier || null;
      const btn = $('button.btn-primary', f); busy(btn);
      try { r ? await patch('/api/staff/rewards/' + r.id, b) : await post('/api/staff/rewards', b); s.close(); toast('Reward disimpan', 'ok'); await store.reloadConfig(); pageRewards(); } catch (err) { busy(btn, false); toast(err.message, 'error'); }
    });
  }

  // ======================================================================
  // TAMPILAN (layout builder dengan pratinjau langsung)
  // ======================================================================
  async function pageLayout() {
    const draft = structuredClone(st.config.appearance);
    let previewPage = 'home';
    let dirty = false;
    const sampleMe = { name: 'Nadia Putri', memberCode: 'LC012', phone: '', activeVouchers: 1, activeOrders: [],
      stats: buildStats({ totalSpend: 870000, tierSpend: 870000, points: 87, visits: 6, lastVisit: todayIn() }, st.config.loyalty, todayIn()) };

    mount(main(), html`${head('Tampilan aplikasi', 'Ubah warna, susunan beranda, banner, dan tampilan menu. Pratinjau di kanan berubah langsung.')}
      <div class="builder"><div id="b-controls"></div>
      <div class="preview-col"><div class="row" style="justify-content:center;margin-bottom:12px"><div class="seg"><button data-a="pv" data-p="home" aria-pressed="true">Beranda</button><button data-a="pv" data-p="menu" aria-pressed="false">Menu</button><button data-a="pv" data-p="guest" aria-pressed="false">Tamu</button></div></div>
        <div class="phone"><div class="phone-screen" id="pv" inert></div></div></div></div>`);

    const preview = () => {
      const el = $('#pv', root);
      applyTheme(draft, el);
      const cfg = { ...st.config, appearance: draft };
      const pst = { config: cfg, me: previewPage === 'guest' ? null : sampleMe, preview: true, menuSearch: '' };
      mount(el, html`<div class="c-app">${previewPage === 'menu' ? menuView(pst) : homeView(pst)}
        <nav class="bnav">${[['home', 'Beranda'], ['cup', 'Menu'], ['gift', 'Rewards'], ['receipt', 'Pesanan'], ['user', 'Akun']].map(([ic, l], i) => html`<a ${(previewPage === 'menu' ? i === 1 : i === 0) ? raw('aria-current="page"') : ''}>${icon(ic, 22)}${l}</a>`)}</nav></div>`);
    };
    const markDirty = () => { dirty = true; $('#b-save', root)?.removeAttribute('disabled'); preview(); };

    const controls = () => html`
      <section class="card"><div class="card-head"><h3>Identitas toko</h3></div><div class="sec-body">
        <div class="row-2"><label class="field"><span>Nama toko</span><input data-k="brandName" value="${draft.brandName}" maxlength="40"></label>
        <label class="field"><span>Teks logo (maks. 3 huruf)</span><input data-k="logoText" value="${draft.logoText}" maxlength="3"></label></div>
        <label class="field"><span>Tagline</span><input data-k="tagline" value="${draft.tagline}" maxlength="80"></label>
        <div class="field"><span>Logo gambar (opsional, menggantikan teks logo)</span>${imagePicker('logoImage', draft.logoImage, html`<span class="logo" style="width:100%;height:100%;border-radius:0">${draft.logoText}</span>`)}</div></div></section>

      <section class="card"><div class="card-head"><h3>Tema warna</h3></div><div class="sec-body">
        <div class="theme-grid">${Object.entries(THEMES).map(([k, t]) => html`<button class="theme-opt" data-a="theme" data-k="${k}" aria-pressed="${draft.theme === k}"><div class="sw">${['primary', 'accent', 'bg', 'text'].map((c) => html`<i style="background:${t.colors[c]}"></i>`)}</div>${t.label}</button>`)}</div>
        <div class="color-row" style="margin-top:14px">${[['primary', 'Utama'], ['accent', 'Aksen & poin'], ['bg', 'Latar'], ['surface', 'Kartu'], ['text', 'Teks']].map(([k, l]) => html`<label class="color-in"><input type="color" data-color="${k}" value="${draft.colors[k]}"><span>${l}</span><code>${draft.colors[k]}</code></label>`)}</div>
        <div class="row" style="margin-top:16px;flex-wrap:wrap;gap:18px">
          <div><div class="small muted" style="font-weight:600;margin-bottom:6px">Sudut</div><div class="seg">${[['sharp', 'Tegas'], ['soft', 'Lembut'], ['round', 'Bulat']].map(([k, l]) => html`<button data-a="opt" data-o="radius" data-v="${k}" aria-pressed="${draft.radius === k}">${l}</button>`)}</div></div>
          <div><div class="small muted" style="font-weight:600;margin-bottom:6px">Huruf</div><div class="seg">${[['jakarta', 'Jakarta Sans'], ['serif', 'Judul serif'], ['system', 'Bawaan HP']].map(([k, l]) => html`<button data-a="opt" data-o="font" data-v="${k}" aria-pressed="${draft.font === k}">${l}</button>`)}</div></div></div></div></section>

      <section class="card"><div class="card-head"><h3>Susunan beranda</h3><span class="spacer"></span><span class="small muted">Seret atau pakai panah</span></div><div class="sec-body"><div class="sec-list" id="sec-list">
        ${draft.homeSections.map((s, i) => html`<div class="sec-item" draggable="true" data-idx="${i}"><span class="grip">${icon('drag', 18)}</span><b>${SECTION_LABEL[s.key]}</b>
          <button class="icon-btn" data-a="secmv" data-i="${i}" data-d="-1" aria-label="Naik" ${i === 0 ? raw('disabled') : ''}>${icon('up', 17)}</button><button class="icon-btn" data-a="secmv" data-i="${i}" data-d="1" aria-label="Turun" ${i === draft.homeSections.length - 1 ? raw('disabled') : ''}>${icon('down', 17)}</button>
          <label class="switch" title="Tampilkan"><input type="checkbox" data-secvis="${i}" ${s.visible ? raw('checked') : ''} aria-label="Tampilkan ${SECTION_LABEL[s.key]}"><i></i></label></div>`)}</div></div></section>

      <section class="card"><div class="card-head"><h3>Tampilan halaman menu</h3></div><div class="sec-body"><div class="seg">${[['list', 'list', 'Daftar'], ['grid', 'grid', 'Grid 2 kolom'], ['large', 'image', 'Foto besar']].map(([k, ic, l]) => html`<button data-a="opt" data-o="menuLayout" data-v="${k}" aria-pressed="${draft.menuLayout === k}">${icon(ic, 16)} ${l}</button>`)}</div></div></section>

      <section class="card"><div class="card-head"><h3>Banner promo</h3><span class="spacer"></span><button class="btn btn-sm btn-soft" data-a="bnew" ${draft.banners.length >= 8 ? raw('disabled') : ''}>${icon('plus', 16)} Tambah banner</button></div><div class="sec-body">
        ${draft.banners.length ? draft.banners.map((b, i) => html`<div class="banner-ed" data-bi="${i}">
          <div class="row"><b class="small">Banner ${i + 1}</b><span class="spacer"></span>
            <label class="check small"><span class="switch"><input type="checkbox" data-bk="active" ${b.active ? raw('checked') : ''}><i></i></span> Tampil</label>
            <button class="icon-btn" data-a="bmv" data-i="${i}" data-d="-1" aria-label="Naik" ${i === 0 ? raw('disabled') : ''}>${icon('up', 17)}</button>
            <button class="icon-btn" data-a="bdel" data-i="${i}" aria-label="Hapus banner">${icon('trash', 17)}</button></div>
          <div class="row-2"><input data-bk="title" value="${b.title}" maxlength="60" placeholder="Judul"><input data-bk="subtitle" value="${b.subtitle}" maxlength="120" placeholder="Keterangan"></div>
          <div class="row"><label class="color-in"><input type="color" data-bk="color" value="${b.color}"><span>Warna</span></label>${imagePicker('banner-' + i, b.image, html`<div class="art" style="background:${b.color}"></div>`)}</div></div>`)
          : html`<p class="muted">Belum ada banner.</p>`}</div></section>

      <section class="card"><div class="card-head"><h3>Pemesanan & pengumuman</h3></div><div class="sec-body">
        <label class="check" style="margin-bottom:14px"><span class="switch"><input type="checkbox" data-k="orderingEnabled" ${draft.orderingEnabled ? raw('checked') : ''}><i></i></span> Customer bisa memesan lewat aplikasi (ambil di kasir)</label>
        <label class="field"><span>Info saat pesanan siap</span><input data-k="pickupNote" value="${draft.pickupNote}" maxlength="120"></label>
        <label class="field"><span>Pengumuman di beranda (kosongkan untuk menyembunyikan)</span><input data-k="announcement" value="${draft.announcement}" maxlength="160" placeholder="Contoh: Libur 17 Agustus, buka kembali 18 Agustus"></label></div></section>
      <div class="save-bar"><span class="small muted" style="margin-right:auto">Perubahan langsung berlaku untuk semua customer setelah disimpan.</span><button class="btn btn-ghost" data-a="breset">Batalkan perubahan</button><button class="btn btn-primary" id="b-save" data-a="bsave" ${dirty ? '' : raw('disabled')}>Simpan tampilan</button></div>`;

    const drawControls = () => { mount($('#b-controls', root), controls()); };
    drawControls(); preview();
    const ctl = $('#b-controls', root);
    bindImagePicker(ctl, (name, url) => {
      if (name === 'logoImage') draft.logoImage = url;
      else if (name.startsWith('banner-')) draft.banners[Number(name.split('-')[1])].image = url;
      markDirty();
    });
    on(ctl, 'input', '[data-k]', (e, el) => { draft[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; markDirty(); });
    on(ctl, 'change', '[data-k][type=checkbox]', (e, el) => { draft[el.dataset.k] = el.checked; markDirty(); });
    on(ctl, 'input', '[data-color]', (e, el) => { draft.colors[el.dataset.color] = el.value.toUpperCase(); draft.theme = 'custom'; el.parentElement.querySelector('code').textContent = el.value.toUpperCase(); $$('.theme-opt', ctl).forEach((b) => b.setAttribute('aria-pressed', 'false')); markDirty(); });
    on(ctl, 'change', '[data-secvis]', (e, el) => { draft.homeSections[Number(el.dataset.secvis)].visible = el.checked; markDirty(); });
    on(ctl, 'input', '[data-bk]', (e, el) => { const b = draft.banners[Number(el.closest('[data-bi]').dataset.bi)]; b[el.dataset.bk] = el.type === 'checkbox' ? el.checked : el.value; markDirty(); });
    on(ctl, 'change', '[data-bk][type=checkbox]', (e, el) => { draft.banners[Number(el.closest('[data-bi]').dataset.bi)].active = el.checked; markDirty(); });
    // drag & drop susunan beranda
    let dragFrom = null;
    on(ctl, 'dragstart', '.sec-item', (e, el) => { dragFrom = Number(el.dataset.idx); el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    on(ctl, 'dragend', '.sec-item', (e, el) => el.classList.remove('dragging'));
    on(ctl, 'dragover', '.sec-item', (e) => e.preventDefault());
    on(ctl, 'drop', '.sec-item', (e, el) => { e.preventDefault(); const to = Number(el.dataset.idx); if (dragFrom === null || dragFrom === to) return; const [it] = draft.homeSections.splice(dragFrom, 1); draft.homeSections.splice(to, 0, it); dragFrom = null; drawControls(); markDirty(); });

    A.actions.pv = (el) => { previewPage = el.dataset.p; $$('[data-a=pv]', root).forEach((b) => b.setAttribute('aria-pressed', String(b === el))); preview(); };
    A.actions.theme = (el) => { draft.theme = el.dataset.k; draft.colors = { ...THEMES[el.dataset.k].colors }; drawControls(); markDirty(); };
    A.actions.opt = (el) => { draft[el.dataset.o] = el.dataset.v; $$(`[data-a=opt][data-o=${el.dataset.o}]`, ctl).forEach((b) => b.setAttribute('aria-pressed', String(b === el))); if (el.dataset.o === 'menuLayout') { previewPage = 'menu'; $$('[data-a=pv]', root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.p === 'menu'))); } markDirty(); };
    A.actions.secmv = (el) => { const i = Number(el.dataset.i), j = i + Number(el.dataset.d); [draft.homeSections[i], draft.homeSections[j]] = [draft.homeSections[j], draft.homeSections[i]]; drawControls(); markDirty(); };
    A.actions.bnew = () => { draft.banners.push({ id: 'b' + Date.now().toString(36), title: 'Promo baru', subtitle: '', color: draft.colors.primary, image: null, active: true }); drawControls(); markDirty(); };
    A.actions.bdel = (el) => { draft.banners.splice(Number(el.dataset.i), 1); drawControls(); markDirty(); };
    A.actions.bmv = (el) => { const i = Number(el.dataset.i); [draft.banners[i - 1], draft.banners[i]] = [draft.banners[i], draft.banners[i - 1]]; drawControls(); markDirty(); };
    A.actions.breset = () => pageLayout();
    A.actions.bsave = async (el) => {
      busy(el);
      try {
        st.config.appearance = await put('/api/staff/settings/appearance', draft);
        applyTheme(st.config.appearance);
        dirty = false; toast('Tampilan disimpan dan langsung aktif', 'ok');
        mount(root, shell()); pageLayout();
      } catch (e) { busy(el, false); toast(e.message, 'error'); }
    };
  }

  // ======================================================================
  // PENGATURAN (aturan poin, level, pilihan data, kata sandi)
  // ======================================================================
  async function pageSettings() {
    const s = await get('/api/staff/settings');
    A.options = s.options;
    const L = structuredClone(s.loyalty);
    const O = structuredClone(s.options);
    const example = () => { const amt = 46000; return `Contoh: belanja ${rupiah(amt)} mendapat ${num(Math.floor(amt / (L.rupiahPerPoint || 1)))} poin.`; };
    const draw = () => mount(main(), html`${head('Aturan & pengaturan', 'Angka di sini sama dengan parameter di sheet DATABASE Excel. Level, poin, dan status member ikut menyesuaikan.')}
      <div class="grid-2e">
      <section class="card"><div class="card-head"><h3>Aturan poin & status</h3></div><form class="sec-body" id="f-loyalty" style="padding:14px 18px 18px">
        <div class="row-2"><label class="field"><span>Rupiah belanja per 1 poin</span><input type="number" name="rupiahPerPoint" min="100" step="100" value="${L.rupiahPerPoint}" required><small id="ex">${example()}</small></label>
        <label class="field"><span>Tidak aktif setelah (hari)</span><input type="number" name="inactiveDays" min="1" value="${L.inactiveDays}" required><small>Tanpa kunjungan selama ini = TIDAK AKTIF</small></label></div>
        <div class="row-2"><label class="field"><span>Dasar perhitungan level</span><select name="tierBasis"><option value="lifetime" ${L.tierBasis !== 'rolling365' ? raw('selected') : ''}>Total belanja sejak daftar (seperti Excel)</option><option value="rolling365" ${L.tierBasis === 'rolling365' ? raw('selected') : ''}>Total belanja 12 bulan terakhir</option></select></label>
        <label class="field"><span>Masa berlaku voucher default (hari)</span><input type="number" name="voucherValidDays" min="1" max="365" value="${L.voucherValidDays || 30}"></label></div>
        <div class="card-head" style="padding:6px 0 0"><h3>Level member</h3><span class="spacer"></span><button type="button" class="btn btn-sm btn-soft" data-a="tadd" ${L.tiers.length >= 8 ? raw('disabled') : ''}>${icon('plus', 16)} Tambah level</button></div>
        <div id="tiers">${L.tiers.map((t, i) => html`<div class="tier-ed" data-ti="${i}"><input type="color" data-tk="color" value="${t.color}" aria-label="Warna ${t.name}">
          <label class="field" style="margin:0"><span>Nama level</span><input data-tk="name" value="${t.name}" maxlength="20" required></label>
          <label class="field" style="margin:0"><span>Minimal total belanja (Rp)</span><input type="number" data-tk="minSpend" value="${t.minSpend}" min="0" step="1000" ${i === 0 ? raw('readonly title="Level pertama selalu Rp0"') : ''}></label>
          <label class="field" style="margin:0"><span>Pengali poin</span><input type="number" data-tk="multiplier" value="${t.multiplier ?? 1}" min="0.5" max="5" step="0.25"></label>
          <label class="field" style="grid-column:2 / -1;margin:0"><span>Benefit (satu per baris)</span><textarea data-tk="benefits" rows="2" style="min-height:60px">${(t.benefits || []).join('\n')}</textarea></label>
          ${i > 0 ? html`<button type="button" class="btn btn-sm btn-ghost" style="grid-column:2" data-a="tdel" data-i="${i}">${icon('trash', 15)} Hapus level</button>` : ''}</div>`)}</div>
        <p class="small muted" style="margin:12px 0">Pengali poin 1 = sama seperti Excel. Isi 1,5 agar level tersebut dapat poin 1,5x.</p>
        <button class="btn btn-primary">Simpan aturan</button></form></section>

      <div>
      <section class="card"><div class="card-head"><h3>Pilihan data</h3></div><div class="sec-body" style="padding:14px 18px 18px">
        ${[['payments', 'Metode pembayaran'], ['sources', 'Sumber customer (tahu dari mana)'], ['genders', 'Gender']].map(([k, l]) => html`<div class="field"><span>${l}</span><div class="tags">${O[k].map((x, i) => html`<span class="tag">${x}<button type="button" data-a="otag-del" data-k="${k}" data-i="${i}" aria-label="Hapus ${x}">${icon('x', 13)}</button></span>`)}</div>
          <form class="row" style="margin-top:8px" data-otag="${k}"><input name="v" maxlength="30" placeholder="Tambah pilihan" style="min-height:38px"><button class="btn btn-sm btn-ghost">${icon('plus', 15)}</button></form></div>`)}
        <button class="btn btn-primary" data-a="osave">Simpan pilihan</button></div></section>

      <section class="card" style="margin-top:16px"><div class="card-head"><h3>Kata sandi saya</h3></div><form class="sec-body" id="f-pw" style="padding:14px 18px 18px">
        <label class="field"><span>Kata sandi lama</span><input type="password" name="current" required autocomplete="current-password"></label>
        <label class="field"><span>Kata sandi baru</span><input type="password" name="next" required minlength="8" autocomplete="new-password"><small>Minimal 8 karakter, berisi huruf dan angka</small></label>
        <button class="btn btn-ghost">Ganti kata sandi</button></form></section>
      <section class="card pad" style="margin-top:16px"><h3 style="font-size:15.5px;margin-bottom:8px">Keamanan sistem</h3><ul class="small muted" style="margin:0;padding-left:18px;display:grid;gap:4px">
        <li>Kata sandi disimpan sebagai hash scrypt, tidak pernah dalam bentuk asli.</li><li>Saldo poin dihitung dari buku besar yang tidak bisa diubah atau dihapus.</li>
        <li>Harga dan poin selalu dihitung ulang di server, bukan di HP customer.</li><li>Login dikunci 15 menit setelah 5 kali salah. Semua tindakan penting tercatat di Log aktivitas.</li></ul></section>
      </div></div>`);
    draw();
    const readTiers = () => $$('[data-ti]', root).forEach((row) => {
      const t = L.tiers[Number(row.dataset.ti)];
      for (const el of $$('[data-tk]', row)) {
        const k = el.dataset.tk;
        t[k] = k === 'benefits' ? el.value.split('\n').map((x) => x.trim()).filter(Boolean) : ['minSpend', 'multiplier'].includes(k) ? Number(el.value) : el.value;
      }
    });
    on(main(), 'input', '[name=rupiahPerPoint]', (e, el) => { L.rupiahPerPoint = Number(el.value); $('#ex', root).textContent = example(); });
    A.actions.tadd = () => { readTiers(); const last = L.tiers[L.tiers.length - 1]; L.tiers.push({ key: '', name: 'Level baru', minSpend: (last?.minSpend || 0) + 1000000, multiplier: 1, color: '#6B5B95', benefits: [] }); draw(); };
    A.actions.tdel = (el) => { readTiers(); L.tiers.splice(Number(el.dataset.i), 1); draw(); };
    on(main(), 'submit', '#f-loyalty', async (e, f) => {
      e.preventDefault(); readTiers();
      const b = { ...L, ...formData(f) };
      for (const k of ['rupiahPerPoint', 'inactiveDays', 'voucherValidDays']) b[k] = Number(b[k]);
      const btn = $('button.btn-primary', f); busy(btn);
      try { st.config.loyalty = { ...st.config.loyalty, ...(await put('/api/staff/settings/loyalty', b)) }; A.customers = null; toast('Aturan disimpan. Level & poin semua member ikut diperbarui.', 'ok'); pageSettings(); } catch (err) { busy(btn, false); toast(err.message, 'error'); }
    });
    on(main(), 'submit', '[data-otag]', (e, f) => { e.preventDefault(); readTiers(); const v = f.v.value.trim(); if (v && !O[f.dataset.otag].includes(v)) O[f.dataset.otag].push(v); draw(); });
    A.actions['otag-del'] = (el) => { readTiers(); O[el.dataset.k].splice(Number(el.dataset.i), 1); draw(); };
    A.actions.osave = async (el) => {
      busy(el);
      try { A.options = await put('/api/staff/settings/options', O); await store.reloadConfig(); toast('Pilihan disimpan', 'ok'); busy(el, false); } catch (err) { busy(el, false); toast(err.message, 'error'); }
    };
    on(main(), 'submit', '#f-pw', async (e, f) => {
      e.preventDefault();
      try { await post('/api/auth/password', formData(f)); f.reset(); toast('Kata sandi diganti. Sesi di perangkat lain otomatis keluar.', 'ok'); } catch (err) { toast(err.message, 'error'); }
    });
  }

  // ======================================================================
  // STAF
  // ======================================================================
  async function pageStaff() {
    const users = await get('/api/staff/users');
    mount(main(), html`${head('Akun staf', 'Kasir bisa mencatat transaksi, melayani pesanan, dan mengelola customer. Admin bisa semuanya.', html`<button class="btn btn-primary" data-a="newu">${icon('plus', 18)} Tambah staf</button>`)}
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Nama</th><th>Username</th><th>Peran</th><th>Login terakhir</th><th>Status</th><th></th></tr></thead><tbody>
      ${users.map((u) => html`<tr><td><b>${u.name}</b>${u.id === st.session.user.id ? html` <span class="badge">Anda</span>` : ''}</td><td class="tnum">${u.username}</td><td><span class="badge ${u.role === 'admin' ? 'badge-primary' : ''}">${u.role === 'admin' ? 'Admin' : 'Kasir'}</span></td>
        <td>${u.lastLoginAt ? fdatetime(u.lastLoginAt) : html`<span class="muted">Belum pernah</span>`}</td><td>${u.active ? html`<span class="badge badge-ok">Aktif</span>` : html`<span class="badge badge-danger">Nonaktif</span>`}</td>
        <td class="r"><button class="btn btn-sm btn-ghost" data-a="editu" data-id="${u.id}">Ubah</button></td></tr>`)}</tbody></table></div>`);
    const form = (u) => {
      const s = sheet(html`<form>${u ? '' : html`<label class="field"><span>Username</span><input name="username" required pattern="[a-z0-9_.]{3,30}" placeholder="huruf kecil, angka, titik" autocomplete="off"></label>`}
        <label class="field"><span>Nama</span><input name="name" required value="${u?.name || ''}" maxlength="60"></label>
        <label class="field"><span>Peran</span><select name="role"><option value="kasir" ${u?.role === 'kasir' ? raw('selected') : ''}>Kasir</option><option value="admin" ${u?.role === 'admin' ? raw('selected') : ''}>Admin</option></select></label>
        <label class="field"><span>${u ? 'Reset kata sandi (opsional)' : 'Kata sandi sementara'}</span><input type="text" name="password" ${u ? '' : raw('required')} minlength="8" autocomplete="off"><small>Staf wajib menggantinya saat pertama login.</small></label>
        ${u ? html`<label class="check" style="margin-bottom:16px"><span class="switch"><input type="checkbox" name="active" ${u.active ? raw('checked') : ''}><i></i></span> Akun aktif</label>` : ''}
        <button class="btn btn-primary btn-block">${u ? 'Simpan' : 'Buat akun'}</button></form>`, { title: u ? `Ubah ${u.name}` : 'Staf baru' });
      on(s.el, 'submit', 'form', async (e, f) => {
        e.preventDefault();
        const b = formData(f);
        if (u && !b.password) delete b.password;
        try { u ? await patch('/api/staff/users/' + u.id, b) : await post('/api/staff/users', b); s.close(); toast('Akun staf disimpan', 'ok'); pageStaff(); } catch (err) { toast(err.message, 'error'); }
      });
    };
    A.actions.newu = () => form(null);
    A.actions.editu = (el) => form(users.find((u) => u.id === Number(el.dataset.id)));
  }

  // ======================================================================
  // LOG AKTIVITAS
  // ======================================================================
  async function pageAudit() {
    const logs = await get('/api/staff/audit');
    const detail = (d) => d ? Object.entries(d).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`).join('; ') : '';
    mount(main(), html`${head('Log aktivitas', '300 aktivitas terakhir: login, transaksi, koreksi poin, perubahan pengaturan.')}
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Waktu</th><th>Oleh</th><th>Aktivitas</th><th>Target</th><th>Detail</th><th>IP</th></tr></thead><tbody>
      ${logs.map((l) => html`<tr><td style="white-space:nowrap">${fdatetime(l.createdAt)}</td><td>${l.actorName}<div class="small muted">${l.actorKind}</div></td><td><span class="badge ${/gagal|batal|hapus|koreksi/.test(l.action) ? 'badge-warn' : ''}">${l.action.replace(/_/g, ' ')}</span></td>
        <td class="tnum">${l.target || ''}</td><td class="small muted" style="max-width:320px">${detail(l.detail)}</td><td class="small muted">${l.ip || ''}</td></tr>`)}</tbody></table></div>`);
  }

  // ======================================================================
  return {
    async start() {
      await render();
      A.started = false; await pollBadge(); A.started = true;
      A.poll = setInterval(() => { if (!document.hidden) pollBadge(); }, 20000);
    },
    render,
    stop() { clearInterval(A.poll); A.cleanup.forEach((f) => f()); },
  };
}

// ======================================================================
// Login staf & ganti kata sandi wajib
// ======================================================================
export function staffLogin(root, store, { mustChange = false } = {}) {
  const app = store.state.config.appearance;
  mount(root, html`<div class="staff-auth"><div class="card"><div class="row" style="margin-bottom:20px">${logoEl(app)}<div><b>${app.brandName}</b><div class="small muted">Panel admin & kasir</div></div></div>
    ${mustChange ? html`<h2 style="font-size:20px;margin-bottom:6px">Ganti kata sandi awal</h2><p class="muted small" style="margin-bottom:18px">Demi keamanan, buat kata sandi baru sebelum mulai bekerja.</p>
      <form id="f-must"><label class="field"><span>Kata sandi saat ini</span><input type="password" name="current" required autocomplete="current-password"></label>
      <label class="field"><span>Kata sandi baru</span><input type="password" name="next" required minlength="8" autocomplete="new-password"><small>Minimal 8 karakter, berisi huruf dan angka</small></label>
      <div class="form-err hide"></div><button class="btn btn-primary btn-block">Simpan & lanjutkan</button></form>`
    : html`<h2 style="font-size:20px;margin-bottom:18px">Masuk sebagai staf</h2><form id="f-staff">
      <label class="field"><span>Username</span><input name="username" required autocomplete="username" autofocus></label>
      <label class="field"><span>Kata sandi</span><input type="password" name="password" required autocomplete="current-password"></label>
      <div class="form-err hide"></div><button class="btn btn-primary btn-block">Masuk</button></form>
      <p class="auth-foot"><a class="link" href="#/">Kembali ke aplikasi customer</a></p>`}</div></div>`);
  const f = $('form', root);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.form-err', f); const btn = $('button', f);
    err.classList.add('hide'); busy(btn);
    try {
      if (mustChange) {
        await post('/api/auth/password', formData(f));
        store.state.session.user.mustChange = false;
      } else {
        const r = await post('/api/auth/staff/login', formData(f));
        setCsrf(r.csrf); store.state.session = r;
      }
      store.route();
    } catch (ex) { busy(btn, false); err.textContent = ex.message; err.classList.remove('hide'); }
  });
}
