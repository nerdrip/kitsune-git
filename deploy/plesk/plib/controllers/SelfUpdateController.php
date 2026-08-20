<?php

require_once dirname(__DIR__) . '/library/SuiteSelfUpdate.php';

class SelfUpdateController extends pm_Controller_Action
{
    public function init()
    {
        parent::init();
        $this->view->pageTitle = 'Aktualizacja rozszerzenia Kitsune';
        $this->view->headLink()->appendStylesheet(pm_Context::getBaseUrl() . 'css/kitsune-platform.css?v=2');
        $this->view->headScript()->appendFile(pm_Context::getBaseUrl() . 'js/kitsune-platform.js?v=2');
    }

    public function indexAction()
    {
        $this->requireAdmin();
        $installed = KitsuneSuiteSelfUpdate::installed();
        $this->view->installed = $installed;
        $this->view->updateState = KitsuneSuiteSelfUpdate::state();
        $this->view->suiteHubActive = $this->hubActive();
        $this->view->pluginUrl = '/modules/' . rawurlencode($installed['id']) . '/index.php/index/index';
    }

    public function checkAction()
    {
        $this->requirePostAdmin();
        try {
            $state = KitsuneSuiteSelfUpdate::check();
            $message = $state['status'] === 'available' ? 'Dostępna aktualizacja do ' . $state['remoteVersion'] . '-r' . $state['remoteRelease'] . '.' : 'Rozszerzenie jest aktualne (' . $state['installedVersion'] . '-r' . $state['installedRelease'] . ').';
            $this->_status->addMessage('info', $message);
        } catch (Throwable $exception) { $this->_status->addMessage('error', 'Nie sprawdzono aktualizacji: ' . $exception->getMessage()); }
        $this->_helper->redirector('index', 'self-update');
    }

    public function updateAction()
    {
        $this->requirePostAdmin();
        try {
            $state = KitsuneSuiteSelfUpdate::update();
            $this->_status->addMessage('info', 'Zaktualizowano rozszerzenie do ' . $state['installedVersion'] . '-r' . $state['installedRelease'] . '. Paczka i SHA-256 są zgodne z repozytorium.');
        } catch (Throwable $exception) { $this->_status->addMessage('error', 'Nie zaktualizowano rozszerzenia: ' . $exception->getMessage()); }
        $this->_helper->redirector('index', 'self-update');
    }

    private function requireAdmin()
    {
        if (!pm_Session::getClient()->isAdmin()) throw new pm_Exception('Tylko administrator Pleska może aktualizować rozszerzenie.');
    }

    private function requirePostAdmin()
    {
        $this->requireAdmin();
        if (!$this->getRequest()->isPost()) throw new pm_Exception('POST is required.');
    }

    private function hubActive()
    {
        try { return pm_Extension::getById('kitsuneserv-bridge')->isActive(); } catch (Throwable $exception) { return false; }
    }
}
