---
title: Решение проблем
description: Типичные проблемы и решения для AI агентов работающих с MCP Moira
sidebar:
  order: 4
---

Это руководство помогает восстановиться после типичных проблем при работе с MCP Moira workflows.

## Восстановление контекста после архивации

Когда беседа архивируется или компактируется, агент теряет:

- Текущий execution ID (processId)
- Контекст шага workflow
- Информацию о прогрессе

Состояние workflow сохраняется на MCP сервере - теряется только память агента.

### Шаги восстановления

1. **Найти активные executions:**

```json
session({ action: "executions" })
```

Возвращает список executions со статусом, workflow ID и заметками:

```json
[
  {
    "executionId": "abc-123",
    "workflowId": "development-flow",
    "status": "waiting",
    "note": "Фича: система авторизации",
    "currentNodeId": "implement-step"
  }
]
```

2. **Получить текущий шаг без продвижения:**

```json
session({ action: "current_step", executionId: "abc-123" })
```

Возвращает текущую директиву и контекст:

```json
{
  "directive": "Реализовать фичу...",
  "completionCondition": "Фича работает и протестирована",
  "inputSchema": { ... }
}
```

3. **Продолжить workflow:**

```json
step({ processId: "abc-123", input: { ... } })
```

### Сохранение Process ID

Для облегчения восстановления сохраняйте process ID в рабочей директории:

```bash
# Создать process-id.txt в директории фичи
echo "abc-123" > ./feature-name/process-id.txt
```

Включайте в архивы сессий:

- Название фичи
- Process ID
- Описание текущего шага

## Справочник инструментов навигации

### session - executions

Список всех активных workflow executions текущего пользователя.

**Вызов:** `session({ action: "executions" })`

**Фильтры:**

- `status`: Массив статусов - `["waiting", "running", "completed", "failed"]`
- `workflowId`: Фильтр по конкретному workflow
- `search`: Поиск в заметках executions

**Пример с фильтрами:**

```json
session({
  action: "executions",
  status: ["waiting", "running"],
  search: "auth"
})
```

### session - current_step

Получает текущую директиву шага без продвижения workflow.

**Вызов:** `session({ action: "current_step", executionId: "..." })`

**Параметры:**

- `executionId` (обязательно): ID execution для проверки

**Возвращает:**

- `directive`: Что делать
- `completionCondition`: Критерии успеха
- `inputSchema`: Структура ответа

### session - execution_context

Получает полное состояние execution включая переменные контекста.

**Вызов:** `session({ action: "execution_context", executionId: "..." })`

**Параметры:**

- `executionId` (обязательно): ID execution для просмотра

**Возвращает:**

- `executionId`: UUID execution
- `workflowId`: Выполняемый workflow
- `status`: Статус execution (running, waiting, completed, failed)
- `currentNodeId`: ID текущего узла
- `waitingForInputNodeId`: Узел ожидающий input (если есть)
- `note`: Заметка execution
- `context.variables`: Переменные контекста
- `context.nodeStates`: Состояния узлов
- `createdAt`, `updatedAt`, `completedAt`: Временные метки
- `error`: Сообщение об ошибке (если failed)

## Типичные проблемы

### "Process not found or expired"

**Причина:** Неверный или истёкший processId

**Решение:**

1. Используйте `session({ action: "executions" })` для поиска активных executions
2. Используйте правильный executionId из списка
3. Process ID - это UUID типа `abc123-def456-...`

### "Execution is not waiting for input"

**Причина:** Попытка продвинуть завершённый или упавший execution

**Решение:**

1. Проверьте статус execution через `session({ action: "execution_context", executionId: "..." })`
2. Статус должен быть `waiting` для принятия input
3. Если `completed` или `failed`, запустите новый execution

### Ошибки валидации на step()

**Причина:** Input не соответствует inputSchema

**Решение:**

1. Проверьте `inputSchema` текущего шага
2. Убедитесь что имена полей совпадают точно (регистрозависимо)
3. Убедитесь что типы данных совпадают (string vs number)
4. Включите все обязательные поля

### Агент забывает контекст Workflow

**Причина:** Сессия была архивирована/компактирована

**Решение:**

1. Проверьте process-id.txt в рабочей директории
2. Используйте `session({ action: "current_step" })` для получения контекста
3. Напомните агенту: "Продолжай workflow \{processId\}"

### `[[UNDEFINED_VARIABLE]]` в директиве в рантайме

**Причина:** Используемая переменная не была разрешена при отрисовке директивы. Три причины:

1. Переменная не объявлена в `variableRegistry`.
2. Переменная объявлена, но без `default`, и её не записал вышестоящий узел до того, как директива её использовала.
3. Голый `{{...}}` был помещён в данные, которые агент вернул через `step()`, и эти данные позже подставились в директиву (template-in-data). Возвращаемые значения данных литеральны — они не пересканируются как шаблоны.

Движок логирует предупреждение с указанием оставшегося плейсхолдера и `executionId`.

**Решение:**

1. Объявите переменную в `variableRegistry` со значением `default`.
2. Убедитесь, что вышестоящий узел записывает переменную (через `globalInputs`) до её первого использования.
3. Никогда не подставляйте `{{...}}` в данные, возвращаемые из `step()` — держите шаблоны только в статических полях узла.

## Сценарии восстановления

### Сценарий: Возобновление после прерывания

```
Пользователь: Продолжай работу над фичей авторизации

Агент:
1. session({ action: "executions", search: "auth" })
   → Найден: executionId: "abc-123", status: "waiting"

2. session({ action: "current_step", executionId: "abc-123" })
   → directive: "Реализовать endpoint логина"

3. [Выполняет работу]

4. step({ processId: "abc-123", input: { result: "done" } })
```

### Сценарий: Найти потерянный Process ID

```
Пользователь: Какие workflows я запустил?

Агент:
1. session({ action: "executions" })
   → Список всех активных executions с заметками

2. session({ action: "execution_context", executionId: "abc-123" })
   → Показывает полный контекст включая переменные
```

### Сценарий: Проверить почему Workflow застрял

```
Агент:
1. session({ action: "execution_context", executionId: "abc-123" })
   → status: "waiting", currentNodeId: "validation-step"

2. session({ action: "current_step", executionId: "abc-123" })
   → Показывает чего ожидает workflow
```

## Связанная документация

- [Руководство для агентов](/ru/docs/integration/agent-guide/) - Основы использования tools
- [Справочник MCP Tools](/ru/docs/reference/tools/) - Полная документация tools
