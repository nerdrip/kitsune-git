<?php

class Modules_KitsuneGit_Task_Operate extends pm_LongTask_Task
{
    public $trackProgress = true;

    public function run()
    {
        $runtimeConfig = (string) $this->getParam('runtimeConfig');
        try {
            $this->updateProgress(5);
            $result = pm_ApiCli::callSbin('kitsune-service', ['--config', $runtimeConfig], pm_ApiCli::RESULT_FULL);
            $this->updateProgress(100);
            if ((int) ($result['code'] ?? 1) !== 0) {
                $detail = trim((string) ($result['stderr'] ?? $result['stdout'] ?? 'Operacja nie powiodła się.'));
                throw new RuntimeException($detail !== '' ? $detail : 'Operacja nie powiodła się.');
            }
            return (string) ($result['stdout'] ?? 'OK');
        } finally {
            if ($runtimeConfig !== '' && is_file($runtimeConfig)) @unlink($runtimeConfig);
        }
    }
}
