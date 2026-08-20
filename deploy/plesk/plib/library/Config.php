<?php

class Modules_KitsuneGit_Config
{
    public const EXTENSION_VERSION = '1.4.0';

    private const SECRETS = [
        'gitToken' => 'secret_git_token',
        'gitSshPrivateKey' => 'secret_git_ssh_private_key',
    ];

    public static function defaults()
    {
        return [
            'repositoryUrl' => 'https://github.com/nerdrip/kitsune-git.git',
            'repositoryBranch' => 'main',
            'gitAuthMode' => 'public',
            'gitUsername' => 'x-access-token',
            'gitSshKnownHosts' => '',
            'domain' => '',
            'proxyMode' => 'managed',
            'appRoot' => '/opt/kitsune-git',
            'dataRoot' => '/var/lib/kitsune-git',
            'appPort' => '4780',
            'sshPort' => '2222',
            'serviceUser' => 'psaadm',
            'lfsMaxObjectBytes' => '10737418240',
        ];
    }

    public static function values()
    {
        $result = [];
        foreach (self::defaults() as $key => $default) {
            $result[$key] = (string) pm_Settings::get($key, $default);
        }
        return $result;
    }

    public static function save(array $values, array $options = [])
    {
        foreach (self::defaults() as $key => $default) {
            if (!array_key_exists($key, $values)) continue;
            $value = trim((string) $values[$key]);
            if ($key === 'gitSshKnownHosts') $value = self::normalizeMultiline($value);
            pm_Settings::set($key, $value);
        }
        foreach (self::SECRETS as $field => $setting) {
            if (!empty($options['clear' . ucfirst($field)])) {
                pm_Settings::setEncrypted($setting, '');
                continue;
            }
            if (isset($values[$field]) && trim((string) $values[$field]) !== '') {
                pm_Settings::setEncrypted($setting, self::normalizeSecret($field, $values[$field]));
            }
        }
    }

    public static function hasSecret($field)
    {
        return self::secret($field) !== '';
    }

    public static function createRuntimeConfig($operation)
    {
        $allowed = ['status', 'check', 'deploy', 'restart', 'generate-key', 'rotate-admin-token'];
        if (!in_array($operation, $allowed, true)) throw new RuntimeException('Nieznana operacja KitsuneGIT.');

        $varDir = rtrim((string) pm_Context::getVarDir(), '/\\');
        if (!is_dir($varDir) && !mkdir($varDir, 0700, true) && !is_dir($varDir)) {
            throw new RuntimeException('Nie można utworzyć katalogu stanu rozszerzenia.');
        }
        @chmod($varDir, 0700);
        $resolved = realpath($varDir);
        if ($resolved === false) throw new RuntimeException('Nie można ustalić katalogu stanu rozszerzenia.');

        $payload = array_merge(self::values(), [
            'operation' => $operation,
            'gitToken' => self::secret('gitToken'),
            'gitSshPrivateKey' => self::secret('gitSshPrivateKey'),
            'extensionVersion' => self::EXTENSION_VERSION,
            'extensionVarDir' => $resolved,
            'requestedAt' => gmdate('c'),
        ]);
        $path = $resolved . '/operation-' . bin2hex(random_bytes(12)) . '.json';
        $previous = umask(0077);
        try {
            $json = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if ($json === false || file_put_contents($path, $json, LOCK_EX) === false) {
                throw new RuntimeException('Nie można zapisać bezpiecznej konfiguracji operacji.');
            }
            @chmod($path, 0600);
        } finally {
            umask($previous);
        }
        return $path;
    }

    public static function readState()
    {
        $empty = [
            'updatedAt' => null,
            'lastOperation' => null,
            'lastSuccess' => null,
            'lastError' => null,
            'repository' => [
                'localCommit' => null,
                'remoteCommit' => null,
                'branch' => null,
                'checkedAt' => null,
                'updateAvailable' => false,
            ],
            'service' => [
                'application' => 'not-installed',
                'preview' => 'not-installed',
                'ready' => false,
                'httpCode' => null,
            ],
            'runtime' => [],
            'deployKey' => [
                'publicKey' => '',
                'fingerprint' => '',
                'createdAt' => null,
            ],
            'prerequisites' => [],
            'log' => [],
        ];
        $path = rtrim((string) pm_Context::getVarDir(), '/\\') . '/state.json';
        if (!is_file($path)) return $empty;
        $decoded = json_decode((string) file_get_contents($path), true);
        return is_array($decoded) ? array_replace_recursive($empty, $decoded) : $empty;
    }

    private static function secret($field)
    {
        if (!isset(self::SECRETS[$field])) return '';
        try { return (string) pm_Settings::getDecrypted(self::SECRETS[$field]); }
        catch (Throwable $exception) { return ''; }
    }

    private static function normalizeSecret($field, $value)
    {
        $value = str_replace(["\r\n", "\r"], "\n", trim((string) $value));
        if ($field === 'gitToken') {
            if (strlen($value) > 8192 || preg_match('/[\x00\r\n]/', $value)) throw new RuntimeException('Token Git ma nieprawidłowy format.');
            return $value;
        }
        if ($field === 'gitSshPrivateKey') {
            if (strlen($value) > 65536 || strpos($value, 'PRIVATE KEY-----') === false) throw new RuntimeException('Wklej prywatny klucz SSH w formacie OpenSSH albo PEM.');
            return $value . "\n";
        }
        return $value;
    }

    private static function normalizeMultiline($value)
    {
        $lines = preg_split('/\r\n|\r|\n/', (string) $value);
        $clean = [];
        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '' || strpos($line, '#') === 0) continue;
            if (strlen($line) > 16384 || preg_match('/[\x00]/', $line)) throw new RuntimeException('Nieprawidłowy wpis known_hosts.');
            $clean[] = $line;
        }
        return implode("\n", array_values(array_unique($clean)));
    }
}
