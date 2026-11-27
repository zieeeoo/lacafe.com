<?php
// Keamanan: kata sandi, token, kode member berputar, pembatasan percobaan, header.
declare(strict_types=1);

function hash_password(string $pw): string { return password_hash($pw, PASSWORD_DEFAULT); }

/** Verifikasi dengan waktu konstan, juga ketika akun tidak ada (mencegah tebak-tebakan akun). */
function verify_password(string $pw, ?string $hash): bool
{
    static $dummy = null;
    if ($hash === null || $hash === '') {
        $dummy ??= password_hash(bin2hex(random_bytes(8)) . 'a1', PASSWORD_DEFAULT);
        password_verify($pw, $dummy);
        return false;
    }
    return password_verify($pw, $hash);
}

function random_token(int $bytes = 32): string { return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', '-_'), '='); }
function sha256(string $s): string { return hash('sha256', $s); }

function random_code(int $len, string $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'): string
{
    $s = '';
    for ($i = 0; $i < $len; $i++) $s .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    return $s;
}
function activation_code(): string { $s = random_code(8); return substr($s, 0, 4) . '-' . substr($s, 4); }
function voucher_code(): string { return 'V' . random_code(10); }

const PASS_WINDOW = 60;
/** Kode member 6 digit berbasis HMAC, berganti setiap 60 detik (mirip TOTP). */
function member_pass_code(string $secret, string $memberCode, ?int $at = null): string
{
    $win = intdiv($at ?? time(), PASS_WINDOW);
    $mac = hash_hmac('sha256', "$memberCode:$win", $secret, true);
    $off = ord($mac[31]) & 0x0f;
    $n = ((ord($mac[$off]) & 0x7f) << 24) | (ord($mac[$off + 1]) << 16) | (ord($mac[$off + 2]) << 8) | ord($mac[$off + 3]);
    return str_pad((string)($n % 1000000), 6, '0', STR_PAD_LEFT);
}
function pass_expires_in(): int { return PASS_WINDOW - (time() % PASS_WINDOW); }

/** Pembatasan percobaan berbasis database (PHP tidak punya memori bersama antar request). */
function rate_limit(DB $db, string $key, int $windowSec, int $max): void
{
    $now = time();
    if (random_int(1, 50) === 1) $db->run('DELETE FROM rate_hits WHERE ts < ?', [$now - 86400]);
    $db->run('DELETE FROM rate_hits WHERE k = ? AND ts < ?', [$key, $now - $windowSec]);
    $count = (int)$db->val('SELECT COUNT(*) FROM rate_hits WHERE k = ?', [$key]);
    if ($count >= $max) {
        $oldest = (int)$db->val('SELECT MIN(ts) FROM rate_hits WHERE k = ?', [$key]);
        $wait = max(1, (int)ceil(($oldest + $windowSec - $now) / 60));
        throw new HttpError(429, "Terlalu banyak percobaan. Coba lagi dalam $wait menit", 'rate_limited');
    }
    $db->run('INSERT INTO rate_hits(k, ts) VALUES (?, ?)', [$key, $now]);
}

function send_security_headers(bool $https): void
{
    header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: same-origin');
    header('Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()');
    header('Cross-Origin-Opener-Policy: same-origin');
    if ($https) header('Strict-Transport-Security: max-age=31536000');
}
