<?php

class IndexController extends pm_Controller_Action
{
    public function init()
    {
        parent::init();
        $this->view->pageTitle = 'KitsuneGIT Web';
        $this->view->headLink()->appendStylesheet(pm_Context::getBaseUrl() . 'css/kitsune-platform.css?v=1');
        $this->view->headScript()->appendFile(pm_Context::getBaseUrl() . 'js/kitsune-platform.js?v=1');
        $this->view->suiteProduct = 'KitsuneGIT Web';
        $this->view->suiteVersion = '1.3.0';
        try { $this->view->suiteHubActive = pm_Extension::getById('kitsuneserv-bridge')->isActive(); }
        catch (Throwable $exception) { $this->view->suiteHubActive = false; }
    }

    public function indexAction()
    {
        if (!pm_Session::getClient()->isAdmin()) {
            throw new pm_Exception('Administrator access is required.');
        }

        $form = new pm_Form_Simple();
        $form->addElement('text', 'releaseUrl', [
            'label' => 'Release tar.gz URL',
            'required' => true,
            'value' => pm_Settings::get('releaseUrl', ''),
            'validators' => [['Url', false, ['allowLocal' => false]]],
        ]);
        $form->addElement('text', 'sha256', [
            'label' => 'SHA-256 checksum',
            'required' => true,
            'value' => pm_Settings::get('sha256', ''),
            'validators' => [['Regex', false, ['/^[a-fA-F0-9]{64}$/']]],
        ]);
        $form->addElement('text', 'domain', [
            'label' => 'Dedicated Plesk domain',
            'required' => true,
            'value' => pm_Settings::get('domain', ''),
            'description' => 'An existing domain reserved for KitsuneGIT; its custom nginx directives must be empty.',
            'validators' => [['Regex', false, ['/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/']]],
        ]);
        $form->addElement('text', 'sshPort', [
            'label' => 'Git SSH port',
            'required' => true,
            'value' => pm_Settings::get('sshPort', '2222'),
            'description' => 'A free TCP port exposed by the server firewall (1024–65535).',
            'validators' => [['Between', false, [1024, 65535]]],
        ]);
        $form->addControlButtons(['sendTitle' => 'Install / upgrade']);

        if ($this->getRequest()->isPost() && $form->isValid($this->getRequest()->getPost())) {
            $url = $form->getValue('releaseUrl');
            if (stripos($url, 'https://') !== 0) {
                $form->getElement('releaseUrl')->addError('Only HTTPS release URLs are accepted.');
            } else {
                $result = pm_ApiCli::callSbin('kitsune-service', [
                    'install', $url, strtolower($form->getValue('sha256')), strtolower($form->getValue('domain')), (string)$form->getValue('sshPort')
                ], pm_ApiCli::RESULT_FULL);
                pm_Settings::set('releaseUrl', $url);
                pm_Settings::set('sha256', strtolower($form->getValue('sha256')));
                pm_Settings::set('domain', strtolower($form->getValue('domain')));
                pm_Settings::set('sshPort', (string)$form->getValue('sshPort'));
                $this->_status->addMessage('info', 'KitsuneGIT Web was installed or upgraded.');
                $this->_helper->redirector('index');
            }
        }

        try {
            $status = pm_ApiCli::callSbin('kitsune-service', ['status'], pm_ApiCli::RESULT_FULL);
            $this->view->serviceStatus = trim($status['stdout'] ?? 'unknown');
            $credentials = pm_ApiCli::callSbin('kitsune-service', ['credentials'], pm_ApiCli::RESULT_FULL);
            $values = parse_ini_string($credentials['stdout'] ?? '') ?: [];
            $this->view->adminToken = $values['KITSUNE_ADMIN_TOKEN'] ?? '';
        } catch (Exception $error) {
            $this->view->serviceStatus = 'not installed';
            $this->view->adminToken = '';
        }
        $this->view->form = $form;
        $domain = pm_Settings::get('domain', '');
        $this->view->publicUrl = $domain ? 'https://' . $domain : '';
        $this->view->sshUrl = $domain ? 'ssh://git@' . $domain . ':' . pm_Settings::get('sshPort', '2222') : '';
    }

    public function restartAction()
    {
        if (!$this->getRequest()->isPost() || !pm_Session::getClient()->isAdmin()) throw new pm_Exception('Invalid request.');
        pm_ApiCli::callSbin('kitsune-service', ['restart'], pm_ApiCli::RESULT_FULL);
        $this->_status->addMessage('info', 'KitsuneGIT Web restarted.');
        $this->_helper->redirector('index');
    }
}
