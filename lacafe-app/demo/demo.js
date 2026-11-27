// Entry mode demo: pasang backend tiruan, lalu jalankan aplikasi yang sama persis.
import { createDemo } from './demo-backend.js';
import seed from './seed-data.js';
import { html, sheet, toast, esc } from './core.js';
import { setCsrf } from './api.js';

const demo = createDemo(seed);
window.__LACAFE_DEMO__ = {
  handle: demo.handle,
  download(path) {
    const csv = demo.csv(path);
    const s = sheet(html`<p class="muted" style="margin-bottom:10px">Di aplikasi asli, tombol ini mengunduh file CSV yang bisa dibuka di Excel. Di pratinjau, salin isinya:</p>
      <textarea readonly style="min-height:220px;font-size:12px">${csv}</textarea><button class="btn btn-primary btn-block" style="margin-top:12px" id="cp">Salin CSV</button>`, { title: 'Ekspor CSV' });
    s.el.querySelector('#cp').addEventListener('click', () => navigator.clipboard?.writeText(csv).then(() => toast('CSV disalin', 'ok'), () => toast('Salin manual dari kotak teks')));
  },
};
await import('./app.js');

const ribbon = document.createElement('div');
ribbon.className = 'demo-ribbon';
ribbon.innerHTML = `<span>Pratinjau</span><button data-k="customer">Customer</button><button data-k="admin">Admin</button><button data-k="reset" title="Kembalikan data ke isi Excel">Reset</button>`;
document.body.prepend(ribbon);
const mark = () => {
  const admin = location.hash.startsWith('#/admin');
  ribbon.querySelectorAll('[data-k]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.k === 'admin') === admin && b.dataset.k !== 'reset')));
};
mark();
window.addEventListener('hashchange', mark);
ribbon.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-k]');
  if (!b) return;
  const store = window.__LACAFE_DEMO__.store;
  if (b.dataset.k === 'reset') { demo.reset(); }
  else await demo.loginAs(b.dataset.k);
  const s = (await demo.handle('GET', '/api/auth/session')).data;
  setCsrf(s.csrf);
  store.state.session = s; store.state.me = null; store.mode = null;
  await store.reloadConfig();
  const target = b.dataset.k === 'admin' ? '#/admin' : '#/';
  if (b.dataset.k !== 'reset' && location.hash !== target) location.hash = target; else store.route();
  if (b.dataset.k === 'reset') toast('Data demo dikembalikan ke isi file Excel', 'ok');
  else toast(b.dataset.k === 'admin' ? 'Masuk sebagai admin (admin / demo1234)' : 'Masuk sebagai Aisah, LC004 (demo1234)', 'ok');
});
