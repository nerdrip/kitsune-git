<?php
try {
    pm_ApiCli::callSbin('kitsune-service', ['remove'], pm_ApiCli::RESULT_FULL);
} catch (Exception $error) {
    pm_Log::err('Could not remove KitsuneGIT service: ' . $error->getMessage());
}
