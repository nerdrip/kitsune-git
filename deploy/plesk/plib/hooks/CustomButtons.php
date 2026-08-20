<?php

class Modules_KitsuneGit_CustomButtons extends pm_Hook_CustomButtons
{
    public function getButtons()
    {
        if ($this->hubOwnsNavigation()) return [];
        return [[
            'place' => self::PLACE_ADMIN_TOOLS_AND_SETTINGS,
            'section' => 'toolsAndResourcesButtons',
            'title' => 'KitsuneGIT Web',
            'description' => 'Deploy and manage your Git collaboration server.',
            'link' => pm_Context::getActionUrl('index', 'index'),
        ]];
    }

    private function hubOwnsNavigation()
    {
        try { return pm_Extension::getById('kitsuneserv-bridge')->isActive(); }
        catch (Throwable $exception) { return false; }
    }
}
