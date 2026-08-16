<?php
if (PHP_OS_FAMILY !== 'Linux') {
    throw new pm_Exception('KitsuneGIT Web currently requires Plesk for Linux.');
}
