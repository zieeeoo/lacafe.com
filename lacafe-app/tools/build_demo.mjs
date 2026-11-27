// Membuat versi pratinjau statis (tanpa server) di dist-demo/.
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'dist-demo');
fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public', 'assets'), path.join(OUT, 'assets'), { recursive: true });
const js = path.join(OUT, 'assets', 'js');
fs.writeFileSync(path.join(js, 'demo-backend.js'), fs.readFileSync(path.join(ROOT, 'demo', 'demo-backend.js'), 'utf8').replace("'../public/assets/js/loyalty.js'", "'./loyalty.js'"));
fs.copyFileSync(path.join(ROOT, 'demo', 'demo.js'), path.join(js, 'demo.js'));
fs.writeFileSync(path.join(js, 'seed-data.js'), 'export default ' + fs.readFileSync(path.join(ROOT, 'data', 'seed.json'), 'utf8') + ';\n');
fs.rmSync(path.join(OUT, 'assets', 'icons', 'icon-512.png'), { force: true });
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
  .replace(/<link rel="manifest"[^>]*>\n\s*/, '')
  .replace(/<link rel="apple-touch-icon"[^>]*>\n\s*/, '')
  .replace('href="/assets/icons/icon.svg"', 'href="assets/icons/icon.svg"')
  .replace('href="/assets/css/app.css"', 'href="assets/css/app.css"')
  .replace('<title>LaCafe</title>', '<title>LaCafe Member</title>')
  .replace('<script type="module" src="/assets/js/app.js"></script>', '<script type="module" src="assets/js/demo.js"></script>');
fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log('dist-demo siap:', fs.readdirSync(js).join(', '));
