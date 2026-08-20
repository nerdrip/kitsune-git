<?php

final class KitsuneSuiteSelfUpdate
{
    public const MANIFEST_URL = 'https://raw.githubusercontent.com/nerdrip/kitsune-serv/main/update/manifest.json';
    private const STATE_KEY = 'kitsune_suite_self_update';
    private const MAX_MANIFEST_BYTES = 2097152;
    private const MAX_PACKAGE_BYTES = 134217728;

    public static function extensionId()
    {
        $path = (string) parse_url(pm_Context::getBaseUrl(), PHP_URL_PATH);
        if (!preg_match('#/modules/([a-z0-9][a-z0-9._-]{1,63})/#', $path, $match)) throw new RuntimeException('Nie można ustalić identyfikatora rozszerzenia Pleska.');
        return $match[1];
    }

    public static function installed()
    {
        $extension = pm_Extension::getById(self::extensionId());
        return ['id' => (string) $extension->getId(), 'name' => (string) $extension->getName(), 'version' => (string) $extension->getVersion(), 'release' => (string) $extension->getRelease()];
    }

    public static function state()
    {
        $raw = (string) pm_Settings::get(self::STATE_KEY, '');
        $state = $raw === '' ? [] : json_decode($raw, true);
        return is_array($state) ? array_merge(self::emptyState(), $state) : self::emptyState();
    }

    public static function check()
    {
        try {
            $installed = self::installed();
            $manifest = json_decode(self::downloadMemory(self::MANIFEST_URL, self::MAX_MANIFEST_BYTES), true);
            if (!is_array($manifest) || (int) ($manifest['schemaVersion'] ?? 0) !== 1 || !is_array($manifest['packages'] ?? null)) throw new RuntimeException('Repozytorium zwróciło nieprawidłowy manifest aktualizacji.');
            $package = null;
            foreach ($manifest['packages'] as $candidate) {
                if (is_array($candidate) && (string) ($candidate['id'] ?? '') === $installed['id']) { $package = self::validatePackage($candidate, $installed['id']); break; }
            }
            if ($package === null) throw new RuntimeException('Manifest nie zawiera paczki dla ' . $installed['id'] . '.');
            $state = [
                'status' => self::isNewer($installed, $package) ? 'available' : 'current',
                'checkedAt' => gmdate('c'), 'updatedAt' => (string) (self::state()['updatedAt'] ?? ''),
                'installedVersion' => $installed['version'], 'installedRelease' => $installed['release'],
                'remoteVersion' => $package['version'], 'remoteRelease' => $package['release'],
                'file' => $package['file'], 'sha256' => $package['sha256'], 'error' => '',
            ];
            self::save($state);
            return $state;
        } catch (Throwable $exception) {
            self::failure($exception);
            throw $exception;
        }
    }

    public static function update()
    {
        $state = self::check();
        if ($state['status'] !== 'available') throw new RuntimeException('Zainstalowana wersja rozszerzenia jest już aktualna.');
        $temporary = tempnam(pm_Context::getVarDir(), 'self-update-');
        if ($temporary === false) throw new RuntimeException('Nie można utworzyć pliku tymczasowego aktualizacji.');
        try {
            self::save(array_merge($state, ['status' => 'installing', 'error' => '']));
            self::downloadFile(self::packageUrl($state['file']), $temporary, self::MAX_PACKAGE_BYTES);
            $digest = strtolower((string) hash_file('sha256', $temporary));
            if (!hash_equals($state['sha256'], $digest)) throw new RuntimeException('Suma SHA-256 pobranej paczki jest nieprawidłowa.');
            $metadata = self::inspectPackage($temporary, self::extensionId());
            if ($metadata['version'] !== $state['remoteVersion'] || $metadata['release'] !== $state['remoteRelease']) throw new RuntimeException('meta.xml pobranej paczki nie odpowiada manifestowi.');
            pm_Extension::installByFile($temporary);
            $complete = array_merge($state, ['status' => 'updated', 'installedVersion' => $metadata['version'], 'installedRelease' => $metadata['release'], 'updatedAt' => gmdate('c'), 'error' => '']);
            self::save($complete);
            return $complete;
        } catch (Throwable $exception) {
            self::failure($exception);
            throw $exception;
        } finally {
            if (is_file($temporary)) @unlink($temporary);
        }
    }

    private static function emptyState()
    {
        return ['status' => 'unchecked', 'checkedAt' => '', 'updatedAt' => '', 'installedVersion' => '', 'installedRelease' => '', 'remoteVersion' => '', 'remoteRelease' => '', 'file' => '', 'sha256' => '', 'error' => ''];
    }

    private static function save(array $state)
    {
        pm_Settings::set(self::STATE_KEY, json_encode(array_merge(self::emptyState(), $state), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    private static function failure(Throwable $exception)
    {
        self::save(array_merge(self::state(), ['status' => 'failed', 'checkedAt' => gmdate('c'), 'error' => mb_substr($exception->getMessage(), 0, 1800)]));
    }

    private static function validatePackage($package, $expectedId)
    {
        $out = [];
        foreach (['id', 'name', 'version', 'release', 'file', 'sha256'] as $field) $out[$field] = trim((string) ($package[$field] ?? ''));
        if ($out['id'] !== $expectedId || !preg_match('/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/', $out['version']) || !preg_match('/^\d+$/', $out['release'])) throw new RuntimeException('Manifest zawiera nieprawidłowe metadane wersji rozszerzenia.');
        if (!preg_match('#^packages/[A-Za-z0-9][A-Za-z0-9._-]*\.zip$#', $out['file']) || !preg_match('/^[a-f0-9]{64}$/', $out['sha256'])) throw new RuntimeException('Manifest zawiera nieprawidłową ścieżkę lub sumę paczki.');
        return $out;
    }

    private static function isNewer(array $installed, array $package)
    {
        $comparison = version_compare($package['version'], $installed['version']);
        return $comparison > 0 || ($comparison === 0 && (int) $package['release'] > (int) $installed['release']);
    }

    private static function inspectPackage($path, $expectedId)
    {
        if (!class_exists('ZipArchive')) throw new RuntimeException('Plesk PHP nie udostępnia ZipArchive.');
        $archive = new ZipArchive();
        if ($archive->open($path) !== true) throw new RuntimeException('Nie można otworzyć pobranej paczki ZIP.');
        try { $raw = $archive->getFromName('meta.xml'); } finally { $archive->close(); }
        if ($raw === false) throw new RuntimeException('Paczka nie zawiera meta.xml w katalogu głównym.');
        $previous = libxml_use_internal_errors(true);
        try { $xml = simplexml_load_string($raw, 'SimpleXMLElement', LIBXML_NONET); } finally { libxml_clear_errors(); libxml_use_internal_errors($previous); }
        if ($xml === false || trim((string) $xml->id) !== $expectedId) throw new RuntimeException('Paczka jest przeznaczona dla innego rozszerzenia.');
        $version = trim((string) $xml->version); $release = trim((string) $xml->release);
        if (!preg_match('/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/', $version) || !preg_match('/^\d+$/', $release)) throw new RuntimeException('Paczka ma nieprawidłową wersję.');
        return ['id' => $expectedId, 'name' => trim((string) $xml->name), 'version' => $version, 'release' => $release];
    }

    private static function packageUrl($file)
    {
        return substr(self::MANIFEST_URL, 0, strrpos(self::MANIFEST_URL, '/') + 1) . $file;
    }

    private static function downloadMemory($url, $maximum)
    {
        $body = '';
        self::request($url, function ($chunk) use (&$body, $maximum) { if (strlen($body) + strlen($chunk) > $maximum) return 0; $body .= $chunk; return strlen($chunk); });
        return $body;
    }

    private static function downloadFile($url, $path, $maximum)
    {
        $stream = fopen($path, 'wb'); if ($stream === false) throw new RuntimeException('Nie można zapisać paczki aktualizacji.');
        $written = 0;
        try { self::request($url, function ($chunk) use ($stream, &$written, $maximum) { $length = strlen($chunk); if ($written + $length > $maximum) return 0; $count = fwrite($stream, $chunk); if ($count !== $length) return 0; $written += $count; return $count; }); }
        finally { fclose($stream); }
        if ($written < 1) throw new RuntimeException('Repozytorium zwróciło pustą paczkę.');
    }

    private static function request($url, callable $writer)
    {
        $parts = parse_url((string) $url);
        if (!is_array($parts) || ($parts['scheme'] ?? '') !== 'https' || empty($parts['host']) || isset($parts['user']) || isset($parts['pass']) || isset($parts['fragment'])) throw new RuntimeException('Kanał aktualizacji musi używać HTTPS.');
        $handle = curl_init($url);
        curl_setopt_array($handle, [CURLOPT_HTTPHEADER => ['Accept: application/json, application/zip', 'User-Agent: Kitsune-Plesk-Suite-Self-Update'], CURLOPT_RETURNTRANSFER => false, CURLOPT_FOLLOWLOCATION => false, CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_TIMEOUT => 180, CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_WRITEFUNCTION => static function ($handle, $chunk) use ($writer) { return $writer($chunk); }]);
        $ok = curl_exec($handle); $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE); $error = curl_error($handle); curl_close($handle);
        if ($ok === false) throw new RuntimeException('Nie pobrano aktualizacji: ' . ($error !== '' ? $error : 'przekroczono limit rozmiaru'));
        if ($status < 200 || $status >= 300) throw new RuntimeException('Repozytorium aktualizacji zwróciło HTTP ' . $status . '.');
    }
}
