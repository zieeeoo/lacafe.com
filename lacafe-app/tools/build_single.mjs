// Membuat dist-single/index.html: SATU file berisi seluruh aplikasi (CSS + JS + data Excel),
// bisa dibuka dengan klik dua kali atau diunggah ke hosting statis mana pun.
// Mode ini menyimpan data di browser masing-masing (tanpa server).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const JS = path.join(ROOT, 'public', 'assets', 'js');
const OUT = path.join(ROOT, 'dist-single');

const modules = {
  loyalty: path.join(JS, 'loyalty.js'),
  core: path.join(JS, 'core.js'),
  api: path.join(JS, 'api.js'),
  customer: path.join(JS, 'customer.js'),
  admin: path.join(JS, 'admin.js'),
  app: path.join(JS, 'app.js'),
  'demo-backend': path.join(ROOT, 'demo', 'demo-backend.js'),
  demo: path.join(ROOT, 'demo', 'demo.js'),
};

const modName = (spec) => path.basename(spec).replace(/\.js$/, '');

function transform(name, src) {
  const exported = [];
  src = src.replace(/^import\s+\{([^}]*)\}\s+from\s+'([^']+)';?$/gm, (_, names, spec) =>
    `const { ${names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': ')).join(', ')} } = __req('${modName(spec)}');`);
  src = src.replace(/^import\s+(\w+)\s+from\s+'([^']+)';?$/gm, (_, local, spec) => `const ${local} = __req('${modName(spec)}').default;`);
  src = src.replace(/await import\('([^']+)'\);/g, (_, spec) => `__req('${modName(spec)}');`);
  src = src.replace(/^export\s+(async\s+function|function|const|let|class)\s+([\w$]+)/gm, (_, kw, id) => { exported.push(id); return `${kw} ${id}`; });
  src = src.replace(/^export\s+\{([^}]*)\};?$/gm, (_, names) => { names.split(',').map((n) => n.trim()).filter(Boolean).forEach((n) => exported.push(n)); return ''; });
  if (/^\s*(import|export)\s/m.test(src)) throw new Error(`Masih ada import/export yang tidak dikenali di ${name}`);
  return `__def['${name}'] = function (__exports) {\n${src}\nObject.assign(__exports, { ${exported.join(', ')} });\n};`;
}

let bundle = `(function () {
'use strict';
const __def = {}, __cache = {};
function __req(n) { if (!__cache[n]) { __cache[n] = {}; __def[n](__cache[n]); } return __cache[n]; }
__def['seed-data'] = function (__exports) { __exports.default = ${fs.readFileSync(path.join(ROOT, 'data', 'seed.json'), 'utf8').trim()}; };
`;
for (const [name, file] of Object.entries(modules)) bundle += transform(name, fs.readFileSync(file, 'utf8')) + '\n';
bundle += `__req('demo');\n})();\n`;
bundle = bundle.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

const css = fs.readFileSync(path.join(ROOT, 'public', 'assets', 'css', 'app.css'), 'utf8');
const icon = 'data:image/svg+xml,' + encodeURIComponent(fs.readFileSync(path.join(ROOT, 'public', 'assets', 'icons', 'icon.svg'), 'utf8'));

const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#1E2A5A">
<title>LaCafe Member</title>
<link rel="icon" href="${icon}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap">
<!--
  LaCafe Member - versi satu file (tanpa server).
  Data tersimpan di browser perangkat masing-masing, tidak tersinkron antar HP/komputer.
  Untuk sistem member sungguhan (customer & admin berbagi data, aman), jalankan server.js
  dari lacafe-member.zip di hosting (lihat README.md).
-->
<style>
${css}
</style>
</head>
<body>
<div id="app"><div class="boot"><span class="logo">LC</span></div></div>
<noscript>Aktifkan JavaScript untuk memakai aplikasi ini.</noscript>
<script>
${bundle}
</script>
</body>
</html>
`;
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log(`dist-single/index.html: ${(html.length / 1024).toFixed(0)} KB`);
