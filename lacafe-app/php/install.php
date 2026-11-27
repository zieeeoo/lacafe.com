<?php
// Pemasang LaCafe Member (versi PHP). Buka di browser SEKALI setelah upload, lalu hapus file ini.
// Bisa juga lewat SSH: php install.php --admin-password=RahasiaKuat1 [--data=/home/user/lacafe-data]
declare(strict_types=1);

require __DIR__ . '/app/lib/http.php';
require __DIR__ . '/app/lib/loyalty.php';
require __DIR__ . '/app/lib/db.php';
require __DIR__ . '/app/lib/security.php';
require __DIR__ . '/app/lib/services.php';
require __DIR__ . '/app/seed.php';

$configPath = getenv('LACAFE_CONFIG') ?: __DIR__ . '/app/config.php';
$cli = PHP_SAPI === 'cli';

function default_data_dir(): string
{
    // Simpan database DI LUAR folder publik (public_html) bila memungkinkan.
    $dir = str_replace('\\', '/', __DIR__);
    for ($p = $dir; $p !== dirname($p); $p = dirname($p)) {
        if (in_array(basename($p), ['public_html', 'www', 'htdocs', 'httpdocs'], true)) {
            $home = dirname($p);
            $suffix = $dir === $p ? '' : '-' . trim(preg_replace('/[^a-z0-9]+/i', '-', substr($dir, strlen($p) + 1)) ?? '', '-');
            if (@is_writable($home)) return $home . '/lacafe-data' . $suffix;
            break;
        }
    }
    return $dir . '/data'; // dilindungi data/.htaccess
}

function requirements(): array
{
    $r = [];
    $r[] = ['PHP 8.1 atau lebih baru (Anda: ' . PHP_VERSION . ')', version_compare(PHP_VERSION, '8.1.0', '>=')];
    $r[] = ['Ekstensi PDO SQLite atau PDO MySQL', extension_loaded('pdo_sqlite') || extension_loaded('pdo_mysql')];
    $r[] = ['Ekstensi mbstring', extension_loaded('mbstring')];
    $r[] = ['Folder app/ bisa ditulis (untuk config.php)', is_writable(__DIR__ . '/app')];
    $r[] = ['Folder uploads/ bisa ditulis (foto menu)', is_writable(__DIR__ . '/uploads')];
    return $r;
}

function do_install(array $in, string $configPath): array
{
    if (is_file($configPath)) throw new RuntimeException('Aplikasi sudah terpasang. Hapus app/config.php terlebih dahulu bila ingin memasang ulang (data lama tidak ikut terhapus).');
    $password = V::password($in['admin_password'] ?? '');
    $driver = ($in['driver'] ?? 'sqlite') === 'mysql' ? 'mysql' : 'sqlite';
    if ($driver === 'sqlite') {
        if (!extension_loaded('pdo_sqlite')) throw new RuntimeException('Hosting ini tidak punya PDO SQLite. Pilih MySQL.');
        $dataDir = rtrim(trim((string)($in['data_dir'] ?? '')) ?: default_data_dir(), '/');
        if (!is_dir($dataDir) && !@mkdir($dataDir, 0750, true)) throw new RuntimeException("Folder data tidak bisa dibuat: $dataDir");
        if (!is_writable($dataDir)) throw new RuntimeException("Folder data tidak bisa ditulis: $dataDir");
        @file_put_contents($dataDir . '/.htaccess', "Require all denied\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n");
        if (!is_file($dataDir . '/index.html')) @file_put_contents($dataDir . '/index.html', '');
        $dbFile = $dataDir . '/lacafe.db';
        if (is_file($dbFile)) throw new RuntimeException("Database sudah ada di $dbFile. Pindahkan/hapus file itu dulu bila ingin memasang ulang.");
        $dbCfg = ['driver' => 'sqlite', 'path' => $dbFile];
    } else {
        if (!extension_loaded('pdo_mysql')) throw new RuntimeException('Hosting ini tidak punya PDO MySQL.');
        $dbCfg = ['driver' => 'mysql', 'host' => trim((string)($in['db_host'] ?? 'localhost')) ?: 'localhost', 'port' => (int)($in['db_port'] ?? 3306) ?: 3306,
            'name' => trim((string)($in['db_name'] ?? '')), 'user' => trim((string)($in['db_user'] ?? '')), 'pass' => (string)($in['db_pass'] ?? '')];
        if ($dbCfg['name'] === '' || $dbCfg['user'] === '') throw new RuntimeException('Isi nama database dan user database dari cPanel > MySQL Databases.');
    }

    try { $db = new DB($dbCfg); } catch (Throwable $e) { throw new RuntimeException('Gagal terhubung ke database: ' . $e->getMessage()); }
    if ($db->driver === 'mysql' && $db->val("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'customers'")) {
        throw new RuntimeException('Database MySQL ini sudah berisi tabel LaCafe. Pakai database kosong.');
    }
    $GLOBALS['LACAFE_TZ'] = 'Asia/Jakarta';
    $warnings = create_schema($db);
    $summary = seed_database($db, $in['seed'] ?? (__DIR__ . '/app/seed.json'), $password, false);

    $config = [
        'db' => $dbCfg,
        'secret' => bin2hex(random_bytes(32)),
        'timezone' => 'Asia/Jakarta',
        'uploads_dir' => __DIR__ . '/uploads',
        'trust_proxy' => false,
    ];
    $php = "<?php\n// Dibuat otomatis oleh install.php pada " . gmdate('Y-m-d H:i:s') . " UTC. Jangan dibagikan.\nreturn " . var_export($config, true) . ";\n";
    if (@file_put_contents($configPath, $php, LOCK_EX) === false) throw new RuntimeException('Gagal menulis app/config.php. Pastikan folder app/ bisa ditulis (permission 755).');
    @chmod($configPath, 0640);
    return ['summary' => $summary, 'warnings' => $warnings, 'db' => $dbCfg['driver'] === 'sqlite' ? $dbCfg['path'] : $dbCfg['name'] . ' (MySQL)'];
}

// ---------------- Mode SSH / terminal ----------------
if ($cli) {
    $opt = getopt('', ['admin-password:', 'data:', 'driver:', 'db-host:', 'db-port:', 'db-name:', 'db-user:', 'db-pass:', 'seed:']);
    try {
        $r = do_install(['admin_password' => $opt['admin-password'] ?? '', 'data_dir' => $opt['data'] ?? '', 'driver' => $opt['driver'] ?? 'sqlite',
            'db_host' => $opt['db-host'] ?? 'localhost', 'db_port' => $opt['db-port'] ?? 3306, 'db_name' => $opt['db-name'] ?? '', 'db_user' => $opt['db-user'] ?? '',
            'db_pass' => $opt['db-pass'] ?? '', 'seed' => $opt['seed'] ?? null], $configPath);
        fwrite(STDOUT, "OK: {$r['summary']['customers']} customer, {$r['summary']['transactions']} transaksi, {$r['summary']['menu']} menu. Database: {$r['db']}\n");
        foreach ($r['warnings'] as $w) fwrite(STDOUT, "Catatan: $w\n");
        exit(0);
    } catch (Throwable $e) {
        fwrite(STDERR, 'GAGAL: ' . $e->getMessage() . "\n");
        exit(1);
    }
}

// ---------------- Mode browser ----------------
header('X-Frame-Options: DENY');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');
$e = fn($s) => htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');
$error = null; $done = null;
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST' && !is_file($configPath)) {
    try {
        if (($_POST['admin_password'] ?? '') !== ($_POST['admin_password2'] ?? '')) throw new RuntimeException('Konfirmasi kata sandi tidak sama.');
        $done = do_install($_POST, $configPath);
    } catch (Throwable $ex) { $error = $ex->getMessage(); }
}
$installed = is_file($configPath) && !$done;
$req = requirements();
$reqOk = !in_array(false, array_column($req, 1), true);
?><!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Pasang LaCafe Member</title>
<style>
  :root { --p:#1E2A5A; --a:#E0A43A; --bg:#F4F5F9; --t:#161A2B; --m:#6B6F80; --l:#E3E5EC; }
  * { box-sizing: border-box; } body { margin:0; font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--t); }
  .wrap { max-width: 560px; margin: 0 auto; padding: 32px 18px 60px; }
  .card { background:#fff; border:1px solid var(--l); border-radius:16px; padding:24px; margin-top:16px; }
  h1 { font-size:24px; margin:14px 0 4px; letter-spacing:-.02em; } h2 { font-size:16px; margin:0 0 12px; }
  .logo { display:inline-grid; place-items:center; width:44px; height:44px; border-radius:13px; background:var(--p); color:#fff; font-weight:800; }
  label { display:block; font-size:13px; font-weight:600; color:var(--m); margin:12px 0 6px; }
  input[type=text], input[type=password], input[type=number] { width:100%; min-height:44px; padding:10px 12px; border:1px solid #CDD0DA; border-radius:10px; font:inherit; }
  .opt { display:flex; gap:10px; align-items:flex-start; padding:12px; border:1px solid var(--l); border-radius:10px; margin-top:8px; cursor:pointer; color:var(--t); font-weight:500; }
  .opt input { margin-top:4px; } small { color:var(--m); display:block; font-weight:400; }
  button, .btn { display:inline-flex; justify-content:center; align-items:center; min-height:46px; padding:0 20px; border-radius:12px; border:0; background:var(--p); color:#fff; font:inherit; font-weight:700; cursor:pointer; text-decoration:none; width:100%; margin-top:18px; }
  .err { background:#FBE9E6; color:#A33424; padding:12px 14px; border-radius:10px; font-weight:600; }
  .ok { background:#E5F4EC; color:#1F6E48; padding:12px 14px; border-radius:10px; font-weight:600; }
  ul.req { list-style:none; padding:0; margin:0; } ul.req li { padding:6px 0; display:flex; gap:8px; } .y { color:#1F8A5B; font-weight:800; } .n { color:#C2412D; font-weight:800; }
  .mysql { display:none; } .show { display:block; } code { background:#EEF0F5; padding:2px 6px; border-radius:6px; font-size:13px; word-break:break-all; }
</style></head><body><div class="wrap">
<span class="logo">LC</span>
<h1>Pasang LaCafe Member</h1>
<p style="color:var(--m);margin:0">Aplikasi member & poin untuk customer dan admin. Sekali pasang, data dari Excel ikut diimpor.</p>

<?php if ($done): ?>
  <div class="card"><div class="ok">Berhasil dipasang. <?= (int)$done['summary']['customers'] ?> customer, <?= (int)$done['summary']['transactions'] ?> transaksi, dan <?= (int)$done['summary']['menu'] ?> menu sudah masuk.</div>
    <?php foreach ($done['warnings'] as $w): ?><p style="color:var(--m)"><?= $e($w) ?></p><?php endforeach; ?>
    <h2 style="margin-top:18px">Langkah berikutnya</h2>
    <ol style="padding-left:18px;margin:0">
      <li><b>Hapus file <code>install.php</code></b> lewat File Manager cPanel.</li>
      <li>Masuk admin: username <code>admin</code> dan kata sandi yang barusan Anda buat.</li>
      <li>Bagikan alamat website ke customer.</li>
    </ol>
    <a class="btn" href="index.html#/admin">Buka panel admin</a></div>
<?php elseif ($installed): ?>
  <div class="card"><div class="ok">Aplikasi sudah terpasang.</div><p>Demi keamanan, hapus file <code>install.php</code> dari hosting.</p><a class="btn" href="index.html">Buka aplikasi</a></div>
<?php else: ?>
  <div class="card"><h2>Pengecekan hosting</h2><ul class="req">
    <?php foreach ($req as [$label, $ok]): ?><li><span class="<?= $ok ? 'y' : 'n' ?>"><?= $ok ? '✓' : '✗' ?></span> <?= $e($label) ?></li><?php endforeach; ?>
  </ul><?php if (!$reqOk): ?><p class="err" style="margin-top:12px">Perbaiki poin bertanda ✗ dulu (ubah versi PHP di cPanel > Select PHP Version, atau atur permission folder ke 755).</p><?php endif; ?></div>

  <form method="post" class="card" autocomplete="off">
    <?php if ($error): ?><div class="err"><?= $e($error) ?></div><?php endif; ?>
    <h2 style="margin-top:<?= $error ? '16px' : '0' ?>">1. Tempat menyimpan data</h2>
    <label class="opt"><input type="radio" name="driver" value="sqlite" <?= ($_POST['driver'] ?? 'sqlite') === 'sqlite' ? 'checked' : '' ?> <?= extension_loaded('pdo_sqlite') ? '' : 'disabled' ?>>
      <span>Otomatis (SQLite), disarankan<small>Tidak perlu membuat database. Data disimpan di <code><?= $e(default_data_dir()) ?></code></small></span></label>
    <label class="opt"><input type="radio" name="driver" value="mysql" <?= ($_POST['driver'] ?? '') === 'mysql' ? 'checked' : '' ?> <?= extension_loaded('pdo_mysql') ? '' : 'disabled' ?>>
      <span>MySQL<small>Buat dulu database & user di cPanel > MySQL Databases, lalu isi di bawah.</small></span></label>
    <div class="mysql" id="mysql">
      <label>Host database</label><input type="text" name="db_host" value="<?= $e($_POST['db_host'] ?? 'localhost') ?>">
      <label>Nama database</label><input type="text" name="db_name" value="<?= $e($_POST['db_name'] ?? '') ?>" placeholder="contoh: namauser_lacafe">
      <label>User database</label><input type="text" name="db_user" value="<?= $e($_POST['db_user'] ?? '') ?>">
      <label>Kata sandi database</label><input type="password" name="db_pass">
    </div>
    <h2 style="margin-top:22px">2. Kata sandi admin</h2>
    <label>Username</label><input type="text" value="admin" disabled>
    <label>Kata sandi admin</label><input type="password" name="admin_password" required minlength="8" autocomplete="new-password">
    <small>Minimal 8 karakter, berisi huruf dan angka. Simpan baik-baik.</small>
    <label>Ulangi kata sandi</label><input type="password" name="admin_password2" required minlength="8" autocomplete="new-password">
    <button type="submit" <?= $reqOk ? '' : 'disabled' ?>>Pasang sekarang</button>
  </form>
  <script>
    const sync = () => document.getElementById('mysql').classList.toggle('show', document.querySelector('input[name=driver]:checked')?.value === 'mysql');
    document.querySelectorAll('input[name=driver]').forEach((r) => r.addEventListener('change', sync)); sync();
  </script>
<?php endif; ?>
</div></body></html>
