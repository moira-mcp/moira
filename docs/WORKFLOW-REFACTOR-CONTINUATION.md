# Продолжение общего рефакторинга workflow

Общий рефакторинг публичных workflow отложен на время срочной работы над Workflow Management Flow, Software Development Flow и Robust Task. Возобновлять отложенную работу следует только по явному указанию пользователя.

## Точка возврата

- Принятый результат зафиксирован коммитом [`894bbe20`](https://github.com/moira-mcp/moira/commit/894bbe206f6c67669f106e3f7b39141c40868787) в ветке `feat/public-workflows-wmf-refresh-20260820` после rebase на `origin/master` `fbc8e255`.
- Workflow Management Flow для Task Breakdown: [`283665f0-9fbb-4ae8-8e54-8b5cde5864c0`](https://moira-mcp.com/app/executions/283665f0-9fbb-4ae8-8e54-8b5cde5864c0). Локальная рабочая область: `moira-ws/workflow-management-flow-task-breakdown-flow-edit-20260820-1931/`.
- Workflow Management Flow для Startup Idea Validation: [`9c9fa834-1d08-4537-94c6-d2bdcd52e348`](https://moira-mcp.com/app/executions/9c9fa834-1d08-4537-94c6-d2bdcd52e348). Локальная рабочая область: `moira-ws/workflow-management-flow-startup-idea-validation-edit-20260821-0133/`.

## Условие возобновления

После явной команды пользователя восстановить оба процесса по указанным execution ID, проверить их фактические текущие шаги через Moira и продолжить исходный рефакторинг из сохранённого состояния. Не восстанавливать уже завершённые пункты из памяти и не создавать новый план взамен существующих процессов.

До такой команды этот документ является только точкой возврата. Срочная ветка не должна продолжать или расширять общий рефакторинг остальных workflow.
