<?php
// Memuat semua komponen & menangani satu request API.
declare(strict_types=1);

require __DIR__ . '/lib/http.php';
require __DIR__ . '/lib/loyalty.php';
require __DIR__ . '/lib/db.php';
require __DIR__ . '/lib/security.php';
require __DIR__ . '/lib/services.php';
require __DIR__ . '/routes.php';

function lacafe_config_path(): string { return getenv('LACAFE_CONFIG') ?: __DIR__ . '/config.php'; }

function lacafe_load_config(): ?array
{
    $f = lacafe_config_path();
    if (!is_file($f)) return null;
    $cfg = require $f;
    return is_array($cfg) ? $cfg : null;
}

function lacafe_handle(): void
{
    $cfg = lacafe_load_config();
    $trustProxy = (bool)($cfg['trust_proxy'] ?? false);
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['SERVER_PORT'] ?? '') === '443')
        || ($trustProxy && strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https');
    send_security_headers($https);
    if (!$cfg) json_out(503, ['error' => 'Aplikasi belum dipasang. Buka install.php di browser untuk memasang.', 'code' => 'not_installed']);

    $GLOBALS['LACAFE_TZ'] = $cfg['timezone'] ?? 'Asia/Jakarta';
    $ip = $trustProxy ? trim(explode(',', (string)($_SERVER['HTTP_CF_CONNECTING_IP'] ?? $_SERVER['HTTP_X_FORWARDED_FOR'] ?? ''))[0]) : '';
    $ip = $ip ?: (string)($_SERVER['REMOTE_ADDR'] ?? '');
    $dir = rtrim(str_replace('\\', '/', dirname((string)($_SERVER['SCRIPT_NAME'] ?? '/api.php'))), '/');
    $env = [
        'secret' => $cfg['secret'], 'https' => $cfg['cookie_secure'] ?? $https, 'cookiePath' => ($dir === '' ? '' : $dir) . '/',
        'uploadsDir' => $cfg['uploads_dir'] ?? dirname(__DIR__) . '/uploads',
    ];

    try {
        $db = new DB($cfg['db']);
        if (random_int(1, 100) === 1) $db->run('DELETE FROM sessions WHERE expires_at <= ?', [now_sql()]);
        $router = new Router();
        register_routes($router, $db, $env);

        $path = (string)($_SERVER['PATH_INFO'] ?? $_GET['r'] ?? '');
        $path = '/' . ltrim($path, '/');
        $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
        $found = $router->match($method, $path);
        if (!$found) throw new HttpError(404, 'Endpoint tidak ditemukan', 'not_found');
        if (!empty($found['methodNotAllowed'])) throw new HttpError(405, 'Metode tidak diizinkan', 'method');
        $route = $found['route'];
        $opts = $route['opts'];
        $mutating = $method !== 'GET';

        if ($mutating && !empty($_SERVER['HTTP_ORIGIN'])) {
            $o = parse_url((string)$_SERVER['HTTP_ORIGIN']);
            $originHost = ($o['host'] ?? '') . (isset($o['port']) ? ':' . $o['port'] : '');
            if (strcasecmp($originHost, (string)($_SERVER['HTTP_HOST'] ?? '')) !== 0) throw forbidden('Asal permintaan tidak diizinkan');
        }

        $auth = load_auth($db);
        $need = $opts['auth'] ?? null;
        if ($need) {
            if (!$auth) throw unauthorized();
            if ($need === 'customer' && $auth['kind'] !== 'customer') throw forbidden();
            if (($need === 'staff' || $need === 'admin') && $auth['kind'] !== 'staff') throw forbidden();
            if ($need === 'admin' && $auth['role'] !== 'admin') throw forbidden('Hanya admin yang bisa melakukan ini');
            if ($auth['kind'] === 'staff' && $auth['mustChange'] && empty($opts['allowMustChange'])) throw new HttpError(403, 'Ganti kata sandi awal terlebih dahulu', 'must_change_password');
        }
        if ($mutating && ($opts['csrf'] ?? true) !== false && $auth) {
            if (!hash_equals($auth['csrf'], (string)($_SERVER['HTTP_X_CSRF_TOKEN'] ?? ''))) throw new HttpError(403, 'Sesi tidak valid, muat ulang halaman', 'csrf');
        }

        $body = [];
        if ($mutating) {
            $limit = (int)($opts['limit'] ?? 100000);
            if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > $limit) throw new HttpError(413, 'Data terlalu besar', 'too_large');
            $raw = (string)file_get_contents('php://input', false, null, 0, $limit + 1);
            if (strlen($raw) > $limit) throw new HttpError(413, 'Data terlalu besar', 'too_large');
            if ($raw !== '') {
                if (!str_contains(strtolower((string)($_SERVER['CONTENT_TYPE'] ?? '')), 'application/json')) throw bad('Content-Type harus application/json');
                $body = json_decode($raw, true);
                if (!is_array($body) || array_is_list($body) && $body !== []) throw bad('Format data tidak valid');
            }
        }

        $ctx = ['auth' => $auth, 'ip' => $ip, 'body' => $body, 'params' => $found['params'], 'query' => $_GET];
        $result = ($route['fn'])($ctx);
        if (!empty($opts['raw'])) {
            header('Content-Type: ' . $result['type']);
            header('Content-Disposition: attachment; filename="' . $result['filename'] . '"');
            header('Cache-Control: no-store');
            echo $result['body'];
            exit;
        }
        json_out(200, $result);
    } catch (HttpError $e) {
        json_out($e->status, ['error' => $e->getMessage(), 'code' => $e->errCode]);
    } catch (PDOException $e) {
        if (str_contains($e->getMessage(), 'UNIQUE') || str_contains($e->getMessage(), 'Duplicate')) json_out(409, ['error' => 'Data bentrok dengan data lain, coba lagi', 'code' => 'conflict']);
        error_log('[lacafe] ' . $e->getMessage());
        json_out(500, ['error' => 'Terjadi kesalahan di server', 'code' => 'server_error']);
    } catch (Throwable $e) {
        error_log('[lacafe] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
        json_out(500, ['error' => 'Terjadi kesalahan di server', 'code' => 'server_error']);
    }
}
