<?php
// Reset kata sandi admin lewat Terminal cPanel / SSH (tidak bisa dibuka dari browser).
// Pemakaian:  php app/tools/reset-admin.php KataSandiBaru123
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require dirname(__DIR__) . '/bootstrap.php';
$cfg = lacafe_load_config();
if (!$cfg) { fwrite(STDERR, "Aplikasi belum dipasang.\n"); exit(1); }
try {
    $pw = V::password($argv[1] ?? '');
    $db = new DB($cfg['db']);
    $n = $db->run("UPDATE staff SET password_hash = ?, active = 1, failed_logins = 0, locked_until = NULL, must_change_password = 1 WHERE username = 'admin'", [hash_password($pw)]);
    if (!$n) $db->run("INSERT INTO staff(username, name, role, password_hash, must_change_password, created_at) VALUES ('admin','Pemilik','admin',?,1,?)", [hash_password($pw), now_sql()]);
    $db->run("DELETE FROM sessions WHERE kind = 'staff'");
    audit($db, null, 'reset_admin_cli', 'admin');
    fwrite(STDOUT, "Kata sandi admin diganti. Masuk dengan username 'admin', lalu Anda akan diminta membuat kata sandi baru.\n");
} catch (Throwable $e) { fwrite(STDERR, 'GAGAL: ' . $e->getMessage() . "\n"); exit(1); }
