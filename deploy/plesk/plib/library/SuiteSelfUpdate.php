<?php

final class KitsuneSuiteSelfUpdate
{
    private const STATE_KEY = 'kitsune_suite_self_update';
    private const RESULT_PREFIX = 'KITSUNE_SELF_UPDATE_RESULT=';
    private const REPOSITORIES = [
        'kitsuneartifactory-manager' => ['url' => 'https://github.com/nerdrip/KitsuneArtifactory.git', 'source' => 'tools/plesk-extension/kitsuneartifactory-manager'],
        'kitsuneirc-manager' => ['url' => 'https://github.com/nerdrip/kitsune-irc.git', 'source' => 'tools/plesk-extension/kitsuneirc-manager'],
        'kitsunecolab-manager' => ['url' => 'ssh://git@git.servx.site:32785/boberski/kitsunecolab.git', 'source' => 'tools/plesk-extension/kitsunecolab-manager'],
        'kitsunepaint-manager' => ['url' => 'ssh://git@git.servx.site:32785/boberski/kitsunepaint.git', 'source' => 'tools/plesk-extension/kitsunepaint-manager'],
        'kitsunepnc-manager' => ['url' => 'ssh://git@git.servx.site:32785/boberski/kitsunepnc.git', 'source' => 'tools/plesk-extension/kitsunepnc-manager'],
        'kitsunetab-manager' => ['url' => 'ssh://git@git.servx.site:32785/boberski/kitsunetab.git', 'source' => 'tools/plesk-extension/kitsunetab-manager'],
        'kitsunetest-manager' => ['url' => 'ssh://git@git.servx.site:32785/boberski/kitsunetest.git', 'source' => 'tools/plesk-extension/kitsunetest-manager'],
        'nailit-manager' => ['url' => 'ssh://git@git.servx.site:32785/boberski/nailit.git', 'source' => 'tools/plesk-extension/nailit-manager'],
        'kitsune-git' => ['url' => 'https://github.com/nerdrip/kitsune-git.git', 'source' => 'deploy/plesk'],
        'wpkit-parse-manager' => ['url' => 'ssh://git@git.servx.site:32785/boberski/wpkit.git', 'source' => 'tools/plesk-extension/wpkit-parse-manager'],
        'nerd-apps-runtime-manager' => ['url' => 'ssh://git@git.servx.site:32785/boberski/dicex.git', 'source' => 'tools/plesk-extension/nerd-apps-runtime-manager'],
        'ultimate-tool' => ['url' => 'ssh://git@git.servx.site:32785/boberski/ultimatetool.git', 'source' => 'plesk-extension'],
    ];

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

    public static function source()
    {
        $id = self::extensionId();
        $spec = self::repositorySpec($id);
        return ['url' => self::plainSetting(['repositoryUrl', 'deploy_repositoryUrl', 'panel_repositoryUrl'], $spec['url']), 'branch' => self::plainSetting(['repositoryBranch', 'deploy_repositoryBranch', 'panel_repositoryRef'], 'main'), 'path' => $spec['source']];
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
            $remote = self::runRepositoryOperation('check');
            $state = self::stateFrom($installed, $remote, self::isNewer($installed, $remote) ? 'available' : 'current');
            self::save($state);
            return $state;
        } catch (Throwable $exception) {
            self::failure($exception);
            throw $exception;
        }
    }

    public static function update()
    {
        try {
            $state = self::check();
            if ($state['status'] !== 'available') throw new RuntimeException('Zainstalowana wersja rozszerzenia jest już aktualna.');
            self::save(array_merge($state, ['status' => 'installing', 'error' => '']));
            $result = self::runRepositoryOperation('install');
            $installed = ['version' => $result['version'], 'release' => $result['release']];
            $complete = self::stateFrom($installed, $result, 'updated');
            $complete['updatedAt'] = gmdate('c');
            self::save($complete);
            return $complete;
        } catch (Throwable $exception) {
            self::failure($exception);
            throw $exception;
        }
    }

    private static function runRepositoryOperation($mode)
    {
        $id = self::extensionId();
        if ($id === 'ultimate-tool') return self::runUltimateTool($mode);
        $spec = self::repositorySpec($id);
        $source = self::source();
        $runtime = self::writeRuntime([
            'schemaVersion' => 1,
            'extensionId' => $id,
            'repositoryUrl' => $source['url'],
            'repositoryBranch' => $source['branch'],
            'extensionSource' => $spec['source'],
            'gitUsername' => self::plainSetting(['gitUsername', 'deploy_gitUsername'], 'x-access-token'),
            'gitSshKnownHosts' => self::plainSetting(['gitSshKnownHosts', 'deploy_gitSshKnownHosts'], ''),
            'gitToken' => self::secretSetting(['secret_git_token', 'gitToken']),
            'gitSshPrivateKey' => self::secretSetting(['secret_git_ssh_private_key', 'gitSshPrivateKey']),
        ]);
        try {
            $result = pm_ApiCli::callSbin('kitsune-suite-self-update', ['--' . $mode, $runtime], pm_ApiCli::RESULT_FULL);
            return self::parseRunnerResult($result);
        } finally {
            if (is_file($runtime)) @unlink($runtime);
        }
    }

    private static function runUltimateTool($mode)
    {
        $privateKey = self::chunkedSecret('deploy_source_private_key');
        if ($privateKey === '') throw new RuntimeException('Repozytorium Ultimate Tool wymaga zapisanego prywatnego klucza wdrożeniowego.');
        $source = self::source();
        $uuid = self::uuid();
        $runtime = rtrim((string) pm_Context::getVarDir(), '/\\') . '/extension-update-' . $uuid . '.json';
        self::writeProtected($runtime, json_encode(['operationUuid' => $uuid, 'privateKey' => $privateKey, 'repositoryRef' => $source['branch'], 'repositoryUrl' => $source['url']], JSON_UNESCAPED_SLASHES));
        try {
            $result = pm_ApiCli::callSbin('ultimate-tool-manager', [$mode === 'install' ? '--extension-update' : '--extension-status', $runtime], pm_ApiCli::RESULT_FULL);
            if ((int) ($result['code'] ?? 1) !== 0) throw new RuntimeException(trim((string) ($result['stderr'] ?? $result['stdout'] ?? 'Aktualizacja Ultimate Tool nie powiodła się.')));
            $decoded = json_decode(trim((string) ($result['stdout'] ?? '')), true);
            $metadata = ['version' => (string) ($decoded['remoteVersion'] ?? ''), 'release' => (string) ($decoded['remoteRelease'] ?? ''), 'branch' => $source['branch'], 'commit' => (string) ($decoded['commit'] ?? '')];
            if (!is_array($decoded) || !preg_match('/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/', $metadata['version']) || !preg_match('/^[1-9]\d{0,8}$/', $metadata['release']) || !preg_match('/^[a-f0-9]{40,64}$/', $metadata['commit'])) throw new RuntimeException('Runner Ultimate Tool zwrócił nieprawidłowe metadane.');
            return $metadata;
        } finally {
            if (is_file($runtime)) @unlink($runtime);
        }
    }

    private static function parseRunnerResult(array $result)
    {
        if ((int) ($result['code'] ?? 1) !== 0) {
            $detail = trim((string) ($result['stderr'] ?? $result['stdout'] ?? ''));
            throw new RuntimeException($detail !== '' ? mb_substr($detail, -3000) : 'Runner aktualizacji zakończył się błędem.');
        }
        $stdout = (string) ($result['stdout'] ?? '');
        if (!preg_match('/^' . preg_quote(self::RESULT_PREFIX, '/') . '(\{[^\r\n]+\})$/m', $stdout, $match)) throw new RuntimeException('Runner aktualizacji nie zwrócił metadanych repozytorium.');
        $metadata = json_decode($match[1], true);
        if (!is_array($metadata) || !preg_match('/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/', (string) ($metadata['version'] ?? '')) || !preg_match('/^[1-9]\d{0,8}$/', (string) ($metadata['release'] ?? '')) || !preg_match('/^[a-f0-9]{40,64}$/', (string) ($metadata['commit'] ?? ''))) throw new RuntimeException('Runner aktualizacji zwrócił nieprawidłowe metadane.');
        return $metadata;
    }

    private static function writeRuntime(array $payload)
    {
        $directory = rtrim((string) pm_Context::getVarDir(), '/\\');
        if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) throw new RuntimeException('Nie można utworzyć prywatnego katalogu aktualizacji.');
        @chmod($directory, 0700);
        $path = $directory . '/self-update-' . bin2hex(random_bytes(12)) . '.json';
        self::writeProtected($path, json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        return $path;
    }

    private static function writeProtected($path, $json)
    {
        if (!is_string($json)) throw new RuntimeException('Nie można zakodować konfiguracji aktualizacji.');
        $previous = umask(0077);
        try {
            if (file_put_contents($path, $json, LOCK_EX) === false) throw new RuntimeException('Nie można zapisać konfiguracji aktualizacji.');
            @chmod($path, 0600);
        } finally {
            umask($previous);
        }
    }

    private static function stateFrom(array $installed, array $remote, $status)
    {
        return ['status' => $status, 'checkedAt' => gmdate('c'), 'updatedAt' => (string) (self::state()['updatedAt'] ?? ''), 'installedVersion' => (string) $installed['version'], 'installedRelease' => (string) $installed['release'], 'remoteVersion' => (string) $remote['version'], 'remoteRelease' => (string) $remote['release'], 'repositoryBranch' => (string) ($remote['branch'] ?? ''), 'repositoryCommit' => (string) ($remote['commit'] ?? ''), 'error' => ''];
    }

    private static function repositorySpec($id)
    {
        if (!isset(self::REPOSITORIES[$id])) throw new RuntimeException('Brak konfiguracji repozytorium dla ' . $id . '.');
        return self::REPOSITORIES[$id];
    }

    private static function plainSetting(array $keys, $default)
    {
        foreach ($keys as $key) {
            $value = trim((string) pm_Settings::get($key, ''));
            if ($value !== '') return $value;
        }
        return $default;
    }

    private static function secretSetting(array $keys)
    {
        foreach ($keys as $key) {
            try { $value = (string) pm_Settings::getDecrypted($key); } catch (Throwable $exception) { $value = ''; }
            if (trim($value) !== '') return $value;
        }
        return '';
    }

    private static function chunkedSecret($name)
    {
        $manifest = self::secretSetting([$name . '_manifest']);
        $decoded = $manifest !== '' ? json_decode($manifest, true) : null;
        if (!is_array($decoded) || (int) ($decoded['version'] ?? 0) !== 1 || (int) ($decoded['chunks'] ?? 0) < 1 || (int) $decoded['chunks'] > 48) return '';
        $value = '';
        for ($index = 0; $index < (int) $decoded['chunks']; $index++) $value .= self::secretSetting([$name . '_chunk_' . str_pad((string) $index, 2, '0', STR_PAD_LEFT)]);
        return strlen($value) === (int) ($decoded['bytes'] ?? -1) && hash_equals((string) ($decoded['sha256'] ?? ''), hash('sha256', $value)) ? $value : '';
    }

    private static function emptyState()
    {
        return ['status' => 'unchecked', 'checkedAt' => '', 'updatedAt' => '', 'installedVersion' => '', 'installedRelease' => '', 'remoteVersion' => '', 'remoteRelease' => '', 'repositoryBranch' => '', 'repositoryCommit' => '', 'error' => ''];
    }

    private static function save(array $state) { pm_Settings::set(self::STATE_KEY, json_encode(array_merge(self::emptyState(), $state), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)); }
    private static function failure(Throwable $exception) { self::save(array_merge(self::state(), ['status' => 'failed', 'checkedAt' => gmdate('c'), 'error' => mb_substr($exception->getMessage(), 0, 1800)])); }
    private static function isNewer(array $installed, array $candidate) { $comparison = version_compare($candidate['version'], $installed['version']); return $comparison > 0 || ($comparison === 0 && (int) $candidate['release'] > (int) $installed['release']); }
    private static function uuid() { $bytes = random_bytes(16); $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40); $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80); $hex = bin2hex($bytes); return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' . substr($hex, 12, 4) . '-' . substr($hex, 16, 4) . '-' . substr($hex, 20); }
}
