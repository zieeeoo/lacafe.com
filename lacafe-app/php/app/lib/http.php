<?php
// Utilitas HTTP & validasi input (padanan src/http.js versi Node).
declare(strict_types=1);

final class HttpError extends Exception
{
    public function __construct(public int $status, string $message, public string $errCode = 'error')
    {
        parent::__construct($message);
    }
}

function bad(string $m, string $code = 'invalid'): HttpError { return new HttpError(400, $m, $code); }
function unauthorized(string $m = 'Silakan masuk terlebih dahulu'): HttpError { return new HttpError(401, $m, 'unauthorized'); }
function forbidden(string $m = 'Anda tidak punya akses untuk tindakan ini'): HttpError { return new HttpError(403, $m, 'forbidden'); }
function not_found(string $m = 'Data tidak ditemukan'): HttpError { return new HttpError(404, $m, 'not_found'); }
function conflict(string $m): HttpError { return new HttpError(409, $m, 'conflict'); }

final class V
{
    public static function str(mixed $x, string $name, int $min = 0, int $max = 200, bool $required = true, ?string $pattern = null): ?string
    {
        if ($x === null || $x === '') {
            if ($required) throw bad("$name wajib diisi");
            return null;
        }
        if (!is_string($x)) throw bad("$name tidak valid");
        $s = trim(preg_replace('/[\x00-\x1F\x7F]/u', '', $x) ?? '');
        $len = mb_strlen($s);
        if ($len < $min) throw bad("$name minimal $min karakter");
        if ($len > $max) throw bad("$name maksimal $max karakter");
        if ($pattern !== null && !preg_match($pattern, $s)) throw bad("$name tidak valid");
        return $s;
    }

    public static function int(mixed $x, string $name, int $min = -1000000000000, int $max = 1000000000000, bool $required = true): ?int
    {
        if ($x === null || $x === '') {
            if ($required) throw bad("$name wajib diisi");
            return null;
        }
        if (is_string($x) && preg_match('/^-?\d+$/', $x)) $x = (int)$x;
        if (is_float($x) && floor($x) == $x) $x = (int)$x;
        if (!is_int($x)) throw bad("$name harus bilangan bulat");
        if ($x < $min || $x > $max) throw bad("$name harus di antara $min dan $max");
        return $x;
    }

    public static function num(mixed $x, string $name, float $min, float $max): float
    {
        if (is_string($x) && is_numeric($x)) $x = (float)$x;
        if (!is_int($x) && !is_float($x)) throw bad("$name harus angka");
        if ($x < $min || $x > $max) throw bad("$name harus di antara $min dan $max");
        return (float)$x;
    }

    public static function oneOf(mixed $x, string $name, array $list, bool $required = true): mixed
    {
        if (($x === null || $x === '') && !$required) return null;
        if (!in_array($x, $list, true)) throw bad("$name tidak valid");
        return $x;
    }

    public static function phone(mixed $x, bool $required = true): ?string
    {
        if ($x === null || $x === '') {
            if ($required) throw bad('Nomor WhatsApp wajib diisi');
            return null;
        }
        $d = preg_replace('/\D/', '', (string)$x) ?? '';
        if (str_starts_with($d, '62')) $d = '0' . substr($d, 2);
        elseif ($d !== '' && !str_starts_with($d, '0')) $d = '0' . $d;
        if (!preg_match('/^08\d{7,12}$/', $d)) throw bad('Nomor WhatsApp tidak valid (contoh: 0812xxxxxxx)');
        return $d;
    }

    public static function date(mixed $x, string $name, bool $required = true): ?string
    {
        if (!$x) {
            if ($required) throw bad("$name wajib diisi");
            return null;
        }
        if (!is_string($x) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $x, $m) || !checkdate((int)$m[2], (int)$m[3], (int)$m[1])) throw bad("$name tidak valid");
        return $x;
    }

    public static function color(mixed $x, string $name): string
    {
        if (!is_string($x) || !preg_match('/^#[0-9a-fA-F]{6}$/', $x)) throw bad("$name harus warna hex, contoh #1E2A5A");
        return strtoupper($x);
    }

    public static function password(mixed $x): string
    {
        if (!is_string($x) || strlen($x) < 8) throw bad('Kata sandi minimal 8 karakter');
        if (strlen($x) > 128) throw bad('Kata sandi maksimal 128 karakter');
        if (!preg_match('/[A-Za-z]/', $x) || !preg_match('/\d/', $x)) throw bad('Kata sandi harus berisi huruf dan angka');
        return $x;
    }
}

function json_out(int $status, mixed $data): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}
