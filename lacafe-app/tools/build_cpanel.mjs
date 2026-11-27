// Membuat paket hosting cPanel (PHP) di dist-cpanel/lacafe/ — isi folder ini diunggah ke public_html.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'dist-cpanel', 'lacafe');
fs.rmSync(path.join(ROOT, 'dist-cpanel'), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

fs.cpSync(path.join(ROOT, 'php'), OUT, { recursive: true });
fs.cpSync(path.join(ROOT, 'public', 'assets'), path.join(OUT, 'assets'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'data', 'seed.json'), path.join(OUT, 'app', 'seed.json'));

const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
  .replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta name="lacafe-api" content="api.php">')
  .replaceAll('href="/', 'href="')
  .replaceAll('src="/', 'src="');
fs.writeFileSync(path.join(OUT, 'index.html'), html);

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'manifest.webmanifest'), 'utf8'));
manifest.start_url = './';
manifest.scope = './';
manifest.icons = manifest.icons.map((i) => ({ ...i, src: i.src.replace(/^\//, '') }));
fs.writeFileSync(path.join(OUT, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2));

const count = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0);
console.log(`dist-cpanel/lacafe siap: ${count(OUT)} file`);
