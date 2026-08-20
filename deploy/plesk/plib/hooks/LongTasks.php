<?php

class Modules_KitsuneGit_LongTasks extends pm_Hook_LongTasks
{
    public function getLongTasks()
    {
        return [new Modules_KitsuneGit_Task_Operate()];
    }
}
