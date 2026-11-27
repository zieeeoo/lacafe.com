// Titik masuk aplikasi: memuat pengaturan & sesi, lalu memilih tampilan customer atau admin.
import { html, mount, applyTheme, toast } from './core.js';
import { get, setCsrf } from './api.js';
import { createCustomerApp } from './customer.js';
import { createAdminApp, staffLogin } from './admin.js';

const store = {
  state: { config: null, session: { kind: null }, me: null, cart: [] },
  current: null,
  mode: null,
  async reloadConfig() {
    const cfg = await get('/api/public/bootstrap');
    store.state.config = cfg;
    applyTheme(cfg.appearance);
    return cfg;
  },
  route,
};

function freshRoot() {
  const old = document.getElementById('app');
  const el = document.createElement('div');
  el.id = 'app';
  old.replaceWith(el); // event listener lama ikut terbuang
  return el;
}

async function route() {
  const h = location.hash.slice(1) || '/';
  const wantAdmin = h.startsWith('/admin');
  const s = store.state.session;
  let mode;
  if (wantAdmin) mode = s.kind === 'staff' ? (s.user.mustChange ? 'mustchange' : 'admin') : 'stafflogin';
  else mode = 'customer';

  if (mode !== store.mode || mode === 'stafflogin' || mode === 'mustchange') {
    store.current?.stop?.();
    store.current = null;
    store.mode = mode;
    const root = freshRoot();
    document.body.className = mode === 'customer' ? 'is-customer' : 'is-admin';
    if (mode === 'stafflogin') return staffLogin(root, store);
    if (mode === 'mustchange') return staffLogin(root, store, { mustChange: true });
    if (mode === 'admin') { store.current = createAdminApp(root, store); return store.current.start(); }
    store.current = createCustomerApp(root, { state: customerState() });
    return store.current.start();
  }
  return store.current?.render();
}

// App customer hanya melihat sesi customer (staf yang membuka tampilan customer dianggap tamu).
function customerState() {
  const st = store.state;
  return new Proxy(st, {
    get(t, k) { if (k === 'session') return t.session?.kind === 'customer' ? t.session : { kind: null }; return t[k]; },
    set(t, k, v) { t[k] = v; return true; },
  });
}

window.addEventListener('hashchange', route);
if (window.__LACAFE_DEMO__) window.__LACAFE_DEMO__.store = store; // hanya untuk mode pratinjau
window.addEventListener('lacafe:unauthorized', () => {
  if (store.state.session.kind) { store.state.session = { kind: null }; store.mode = null; toast('Sesi berakhir, silakan masuk lagi', 'error'); route(); }
});
window.addEventListener('lacafe:mustchange', () => { if (store.state.session.user) { store.state.session.user.mustChange = true; route(); } });

async function boot() {
  try {
    const [cfg, session] = await Promise.all([get('/api/public/bootstrap'), get('/api/auth/session')]);
    store.state.config = cfg;
    store.state.session = session;
    setCsrf(session.csrf);
    applyTheme(cfg.appearance);
    await route();
  } catch (e) {
    mount(document.getElementById('app'), html`<div class="boot"><div class="card pad" style="max-width:360px;text-align:center"><h3>Tidak bisa memuat aplikasi</h3><p class="muted" style="margin:8px 0 14px">${e.message}</p><button class="btn btn-primary" id="reload">Muat ulang</button></div></div>`);
    document.getElementById('reload')?.addEventListener('click', () => location.reload());
  }
}
boot();
