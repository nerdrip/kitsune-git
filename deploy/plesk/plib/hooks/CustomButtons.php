<?php

class Modules_KitsuneGit_CustomButtons extends pm_Hook_CustomButtons
{
    public function getButtons()
    {
        return [[
            'place' => self::PLACE_ADMIN_TOOLS_AND_SETTINGS,
            'section' => 'toolsAndResourcesButtons',
            'title' => 'KitsuneGIT Web',
            'description' => 'Deploy and manage your Git collaboration server.',
            'link' => pm_Context::getActionUrl('index', 'index'),
        ]];
    }
}
