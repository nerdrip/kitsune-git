<?php

class IndexController extends pm_Controller_Action
{
    protected $_accessLevel = 'admin';

    public function init()
    {
        parent::init();
        $this->view->pageTitle = 'KitsuneGIT Deployment Manager';
        $version = Modules_KitsuneGit_Config::EXTENSION_VERSION;
        $this->view->headLink()->appendStylesheet(pm_Context::getBaseUrl() . 'css/kitsune-git.css?v=' . $version);
        $this->view->headLink()->appendStylesheet(pm_Context::getBaseUrl() . 'css/kitsune-platform.css?v=2');
        $this->view->headScript()->appendFile(pm_Context::getBaseUrl() . 'js/kitsune-platform.js?v=2');
        $this->view->suiteProduct = 'KitsuneGIT Manager';
        $this->view->suiteVersion = $version;
        try { $this->view->suiteHubActive = pm_Extension::getById('kitsuneserv-bridge')->isActive(); }
        catch (Throwable $exception) { $this->view->suiteHubActive = false; }
    }

    public function indexAction()
    {
        $activeTab = trim((string) $this->getRequest()->getParam('tab', 'status'));
        if (!in_array($activeTab, ['status', 'deploy', 'config', 'access', 'diagnostics'], true)) $activeTab = 'status';

        if ($this->getRequest()->isPost()) {
            $post = $this->getRequest()->getPost();
            $formType = (string) ($post['formType'] ?? '');
            if ($formType === 'config') {
                $activeTab = 'config';
                if ($this->saveConfig($post)) return;
            } elseif ($formType === 'operation') {
                $activeTab = (string) ($post['returnTab'] ?? 'deploy');
                if ($this->startOperation($post)) return;
            }
        }

        $statusError = null;
        $runtimeStatus = [];
        try { $runtimeStatus = $this->runImmediate('status'); }
        catch (Throwable $exception) { $statusError = $exception->getMessage(); }

        $config = Modules_KitsuneGit_Config::values();
        $state = Modules_KitsuneGit_Config::readState();
        $this->view->activeTab = $activeTab;
        $this->view->config = $config;
        $this->view->state = $state;
        $this->view->domains = $this->domainOptions($config['domain']);
        $this->view->hasGitToken = Modules_KitsuneGit_Config::hasSecret('gitToken');
        $this->view->hasCustomSshKey = Modules_KitsuneGit_Config::hasSecret('gitSshPrivateKey');
        $this->view->runtimeStatus = $runtimeStatus;
        $this->view->statusError = $statusError;
        $this->view->publicUrl = $config['domain'] !== '' ? 'https://' . $config['domain'] : '';
        $this->view->sshUrl = $config['domain'] !== '' ? 'ssh://git@' . $config['domain'] . ':' . $config['sshPort'] : '';
        $this->view->extensionVersion = Modules_KitsuneGit_Config::EXTENSION_VERSION;
    }

    private function saveConfig(array $post)
    {
        $previous = Modules_KitsuneGit_Config::values();
        $values = [];
        foreach (Modules_KitsuneGit_Config::defaults() as $key => $default) {
            $values[$key] = trim((string) ($post[$key] ?? $previous[$key] ?? $default));
        }
        $values['proxyMode'] = 'managed';
        $values['domain'] = strtolower($values['domain']);
        $values['repositoryUrl'] = trim($values['repositoryUrl']);
        $values['gitToken'] = (string) ($post['gitToken'] ?? '');
        $values['gitSshPrivateKey'] = (string) ($post['gitSshPrivateKey'] ?? '');

        try {
            $this->validateConfiguration($values, $post);
            Modules_KitsuneGit_Config::save($values, [
                'clearGitToken' => !empty($post['clearGitToken']),
                'clearGitSshPrivateKey' => !empty($post['clearGitSshPrivateKey']),
            ]);
            try {
                $this->migrateLegacyVhost($previous['domain'], $values['domain']);
                $this->refreshWebServerDomains($previous['domain'], $values['domain']);
            } catch (Throwable $exception) {
                Modules_KitsuneGit_Config::save($previous);
                try { $this->refreshWebServerDomains($values['domain'], $previous['domain']); } catch (Throwable $ignored) {}
                throw new RuntimeException('Plesk nie zaakceptował konfiguracji domeny: ' . $exception->getMessage(), 0, $exception);
            }
        } catch (Throwable $exception) {
            $this->_status->addMessage('error', 'Nie zapisano konfiguracji: ' . $exception->getMessage());
            return false;
        }

        $this->_status->addMessage('info', 'Konfiguracja została zapisana, a vhost domeny przebudowany przez Pleska. Uruchom teraz „Pobierz i wdróż”.');
        $this->_helper->redirector('index', 'index', null, ['tab' => 'deploy']);
        return true;
    }

    private function validateConfiguration(array $values, array $post)
    {
        $domains = $this->domainOptions();
        if ($values['domain'] === '' || !isset($domains[$values['domain']])) {
            throw new RuntimeException('Wybierz aktywną domenę albo subdomenę z hostingiem WWW bezpośrednio z listy Pleska.');
        }
        if (!preg_match('/^[A-Za-z0-9._\/-]{1,255}$/', $values['repositoryBranch']) || strpos($values['repositoryBranch'], '..') !== false || $values['repositoryBranch'][0] === '/') {
            throw new RuntimeException('Gałąź Git ma nieprawidłową nazwę.');
        }
        $httpsRepository = preg_match('#^https://[^\s]+$#i', $values['repositoryUrl']) === 1;
        $sshRepository = preg_match('#^(?:git@[A-Za-z0-9.-]+:[^\s]+|ssh://git@[A-Za-z0-9.-]+(?::[0-9]+)?/[^\s]+)$#i', $values['repositoryUrl']) === 1;
        if (!$httpsRepository && !$sshRepository) throw new RuntimeException('Repozytorium musi używać HTTPS albo SSH jako użytkownik git.');
        $parts = parse_url($values['repositoryUrl']);
        if ($httpsRepository && is_array($parts) && (isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment']))) {
            throw new RuntimeException('Nie umieszczaj loginu, tokenu, parametrów ani fragmentu w URL repozytorium.');
        }
        if (!in_array($values['gitAuthMode'], ['public', 'token', 'generated-key', 'custom-key'], true)) throw new RuntimeException('Wybierz obsługiwany sposób dostępu do Git.');
        if (in_array($values['gitAuthMode'], ['public', 'token'], true) && !$httpsRepository) throw new RuntimeException('Tryb publiczny i token wymagają adresu HTTPS.');
        if (in_array($values['gitAuthMode'], ['generated-key', 'custom-key'], true) && !$sshRepository) throw new RuntimeException('Deploy key wymaga adresu SSH repozytorium.');
        if ($values['gitAuthMode'] === 'token' && !Modules_KitsuneGit_Config::hasSecret('gitToken') && trim((string) ($post['gitToken'] ?? '')) === '') {
            throw new RuntimeException('Dla prywatnego repozytorium HTTPS podaj token tylko do odczytu.');
        }
        if ($values['gitAuthMode'] === 'token' && !empty($post['clearGitToken']) && trim((string) ($post['gitToken'] ?? '')) === '') {
            throw new RuntimeException('Nie można wyczyścić tokenu, dopóki wybrany jest tryb prywatnego repozytorium HTTPS.');
        }
        if ($values['gitAuthMode'] === 'custom-key' && !Modules_KitsuneGit_Config::hasSecret('gitSshPrivateKey') && trim((string) ($post['gitSshPrivateKey'] ?? '')) === '') {
            throw new RuntimeException('Tryb własnego klucza wymaga prywatnego klucza SSH.');
        }
        if ($values['gitAuthMode'] === 'custom-key' && !empty($post['clearGitSshPrivateKey']) && trim((string) ($post['gitSshPrivateKey'] ?? '')) === '') {
            throw new RuntimeException('Nie można wyczyścić klucza, dopóki wybrany jest tryb własnego klucza SSH.');
        }
        if (!preg_match('/^[A-Za-z0-9._@-]{1,128}$/', $values['gitUsername'])) throw new RuntimeException('Użytkownik Git HTTPS ma nieprawidłowy format.');
        if (!preg_match('/^[a-z_][a-z0-9_-]{0,31}$/', $values['serviceUser'])) throw new RuntimeException('Użytkownik usługi ma nieprawidłową nazwę systemową.');
        foreach (['appRoot', 'dataRoot'] as $field) {
            if (!preg_match('#^/(?:home|opt|srv|var/lib)/[A-Za-z0-9._/-]+$#', $values[$field]) || in_array('..', explode('/', $values[$field]), true)) {
                throw new RuntimeException('Ścieżka ' . $field . ' musi być dedykowanym katalogiem w /home, /opt, /srv albo /var/lib.');
            }
        }
        $appRoot = rtrim($values['appRoot'], '/');
        $dataRoot = rtrim($values['dataRoot'], '/');
        if ($appRoot === $dataRoot || strpos($appRoot . '/', $dataRoot . '/') === 0 || strpos($dataRoot . '/', $appRoot . '/') === 0) {
            throw new RuntimeException('Kod aplikacji i dane trwałe muszą znajdować się w oddzielnych katalogach.');
        }
        foreach (['appPort', 'sshPort'] as $field) {
            $maximum = $field === 'appPort' ? 65534 : 65535;
            if (!ctype_digit($values[$field]) || (int) $values[$field] < 1024 || (int) $values[$field] > $maximum) throw new RuntimeException('Port ' . $field . ' musi mieścić się w zakresie 1024–' . $maximum . '.');
        }
        if ($values['appPort'] === $values['sshPort']) throw new RuntimeException('Port aplikacji i Git SSH nie mogą być takie same.');
        if (!ctype_digit($values['lfsMaxObjectBytes']) || (int) $values['lfsMaxObjectBytes'] < 1048576) throw new RuntimeException('Limit pojedynczego obiektu LFS musi mieć co najmniej 1 MiB.');
    }

    private function startOperation(array $post)
    {
        $operation = trim((string) ($post['operation'] ?? ''));
        if (!in_array($operation, ['check', 'deploy', 'restart', 'generate-key', 'rotate-admin-token'], true)) {
            $this->_status->addMessage('error', 'Wybierz obsługiwaną operację.');
            return false;
        }
        $config = Modules_KitsuneGit_Config::values();
        if (in_array($operation, ['check', 'deploy'], true)) {
            try { $this->validateConfiguration(array_merge($config, ['gitToken' => '', 'gitSshPrivateKey' => '']), []); }
            catch (Throwable $exception) {
                $this->_status->addMessage('error', 'Najpierw popraw konfigurację: ' . $exception->getMessage());
                return false;
            }
        }
        try {
            $runtime = Modules_KitsuneGit_Config::createRuntimeConfig($operation);
            $task = new Modules_KitsuneGit_Task_Operate();
            $task->setParam('runtimeConfig', $runtime);
            (new pm_LongTask_Manager())->start($task);
            $labels = [
                'check' => 'Sprawdzanie repozytorium',
                'deploy' => 'Pobranie i wdrożenie KitsuneGIT',
                'restart' => 'Restart usług',
                'generate-key' => 'Generowanie deployment key',
                'rotate-admin-token' => 'Rotacja tokenu administratora',
            ];
            $this->_status->addMessage('info', $labels[$operation] . ' zostało dodane do kolejki Pleska.');
        } catch (Throwable $exception) {
            $this->_status->addMessage('error', 'Nie uruchomiono operacji: ' . $exception->getMessage());
            return false;
        }
        $tab = trim((string) ($post['returnTab'] ?? 'deploy'));
        if (!in_array($tab, ['status', 'deploy', 'access', 'diagnostics'], true)) $tab = 'deploy';
        $this->_helper->redirector('index', 'index', null, ['tab' => $tab]);
        return true;
    }

    private function runImmediate($operation)
    {
        $runtime = Modules_KitsuneGit_Config::createRuntimeConfig($operation);
        try {
            $result = pm_ApiCli::callSbin('kitsune-service', ['--config', $runtime], pm_ApiCli::RESULT_FULL);
            if ((int) ($result['code'] ?? 1) !== 0) {
                $detail = trim((string) ($result['stderr'] ?? $result['stdout'] ?? 'Nie udało się odczytać stanu.'));
                throw new RuntimeException($detail);
            }
            $decoded = json_decode((string) ($result['stdout'] ?? ''), true);
            return is_array($decoded) ? $decoded : [];
        } finally {
            if (is_file($runtime)) @unlink($runtime);
        }
    }

    private function domainOptions($savedDomain = '')
    {
        $options = [];
        try {
            foreach ((array) pm_Domain::getAllDomains() as $domain) {
                if (!$domain instanceof pm_Domain || !$domain->hasHosting() || !$domain->isActive() || $domain->isSuspended() || $domain->isDisabled()) continue;
                $name = strtolower(trim((string) $domain->getName()));
                if (preg_match('/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/', $name)) $options[$name] = $name;
            }
        } catch (Throwable $exception) {}
        natcasesort($options);
        return $options;
    }

    private function refreshWebServerDomains($previous, $current)
    {
        $names = array_values(array_unique(array_filter([strtolower(trim((string) $previous)), strtolower(trim((string) $current))])));
        $manager = new pm_WebServer();
        foreach ($names as $name) $manager->updateDomainConfiguration(pm_Domain::getByName($name));
    }

    private function migrateLegacyVhost($previous, $current)
    {
        $names = array_values(array_unique(array_filter([strtolower(trim((string) $previous)), strtolower(trim((string) $current))])));
        if (!$names) return;
        $result = pm_ApiCli::callSbin('kitsune-service', array_merge(['migrate-vhost'], $names), pm_ApiCli::RESULT_FULL);
        if ((int) ($result['code'] ?? 1) !== 0) {
            $detail = trim((string) ($result['stderr'] ?? $result['stdout'] ?? ''));
            throw new RuntimeException($detail !== '' ? $detail : 'Nie można usunąć starszego bloku vhost.');
        }
    }
}
