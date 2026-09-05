---
title: Руководство для AI агентов
description: Как использовать MCP Moira tools и выполнять workflows
sidebar:
  order: 2
---

Это руководство объясняет как AI агенты используют MCP Moira tools для выполнения workflows.

## Обзор MCP Tools

MCP Moira предоставляет следующие инструменты:

| Tool       | Назначение                             |
| ---------- | -------------------------------------- |
| `list`     | Список доступных workflows             |
| `start`    | Запуск выполнения workflow             |
| `step`     | Продвижение workflow с input           |
| `manage`   | CRUD операции с workflows              |
| `session`  | Информация о пользователе и executions |
| `settings` | Настройки пользователя                 |
| `token`    | Токены для upload/download             |
| `help`     | Документация                           |

## Базовое выполнение Workflow

### 1. Запуск Workflow

```json
start({ workflowId: "moira/robust-task", parentExecutionId: "none" })
```

Если предварительная настройка Telegram не требуется, ответ содержит:

```json
{
  "processId": "abc-123-def",
  "directive": "Разбей задачу на шаги...",
  "completionCondition": "Задача разбита на 3+ шага",
  "inputSchema": {
    "type": "object",
    "properties": {
      "steps": { "type": "array" }
    },
    "required": ["steps"]
  }
}
```

Если workflow требует настройки Telegram, `start` возвращает инструкцию настройки без создания
execution и без `processId`. Выполните инструкцию и снова вызовите `start`.

### 2. Выполнение шага

После выполнения работы описанной в `directive`:

```json
step({
  processId: "abc-123-def",
  input: {
    "steps": ["Шаг 1", "Шаг 2", "Шаг 3"]
  }
})
```

Возвращает следующую директиву или статус завершения.

### 3. Продолжать до завершения

Повторяйте вызовы `step()` пока workflow не вернёт завершение.

## Формат ответа

Каждый шаг workflow возвращает:

| Поле                  | Описание                                              |
| --------------------- | ----------------------------------------------------- |
| `processId`           | UUID выполнения, используйте во всех `step()` вызовах |
| `directive`           | Что делать (инструкция)                               |
| `completionCondition` | Когда готово (критерии успеха)                        |
| `inputSchema`         | Как структурировать ответ (JSON Schema)               |

## Directive vs Condition

**directive** = ЧТО делать
**completionCondition** = КОГДА успешно завершено

Пример:

- directive: "Запусти все тесты проекта"
- completionCondition: "Все тесты проходят (0 ошибок)"

Агент должен:

1. Выполнить директиву (запустить тесты)
2. Проверить что completionCondition выполнено (0 ошибок)
3. Только тогда продолжить с `step()`

## Input Schema

Когда указан `inputSchema`, ответ должен точно соответствовать схеме.

Пример схемы:

```json
{
  "type": "object",
  "properties": {
    "result": {
      "type": "string",
      "enum": ["pass", "fail"]
    },
    "evidence": {
      "type": "string"
    }
  },
  "required": ["result", "evidence"]
}
```

Валидный ответ:

```json
{
  "result": "pass",
  "evidence": "Все 302 теста прошли"
}
```

## Инструменты навигации

### Список executions

```json
session({ action: "executions" })
```

Возвращает первую страницу активных executions текущего пользователя со статусом, workflow ID и
заметками. Для следующих страниц используйте `limit` и `offset`.

### Получить текущий шаг

Возобновить workflow после прерывания:

```json
session({ action: "current_step", executionId: "abc-123" })
```

Возвращает текущее представление шага для агента без продвижения workflow: Process ID, directive,
success criteria и input schema при её наличии. При необходимости ответ также содержит контекст
дочерних workflow, system reminder и teleport.

### Получить полный контекст

```json
session({ action: "execution_context", executionId: "abc-123" })
```

Возвращает состояние execution включая переменные контекста и историю.

## Заметки Execution

Отслеживайте прогресс execution с заметками:

```json
start({ workflowId: "dev-flow", note: "Фича: система авторизации", parentExecutionId: "none" })
```

Обновить заметку во время выполнения через `step()` input:

```json
step({
  processId: "abc-123",
  input: {
    "task_result": "done",
    "execution_note": "Шаг 3: Интеграционные тесты"
  }
})
```

Или через session tool:

```json
session({
  action: "update-note",
  executionId: "abc-123",
  note: "Шаг 3: Интеграционные тесты"
})
```

## Поиск Workflows

### Первая страница Workflows

```json
list()
```

### Поиск по имени

```json
list({ search: "test" })
```

### Фильтр по видимости

```json
list({ visibility: "public", limit: 10 })
```

## Типичные паттерны

### Запуск и выполнение первого шага

```json
// 1. Запуск
start({ workflowId: "moira/verified-research", parentExecutionId: "none" })
// → { processId: "xyz", directive: "...", ... }

// 2. Выполнить работу, затем продвинуться
step({ processId: "xyz", input: { findings: "..." } })
// → { directive: "следующий шаг...", ... }
```

### Возобновление после прерывания

```json
// 1. Найти execution
session({ action: "executions" })
// → [{ executionId: "xyz", status: "waiting", ... }]

// 2. Получить текущий шаг
session({ action: "current_step", executionId: "xyz" })
// → { directive: "...", completionCondition: "...", ... }

// 3. Продолжить
step({ processId: "xyz", input: { ... } })
```

## Ошибки валидации

Если `step()` возвращает ошибку валидации, проверьте:

1. **Имена полей** - Должны точно соответствовать схеме (регистрозависимо)
2. **Обязательные поля** - Все required свойства должны присутствовать
3. **Типы данных** - String vs number vs boolean должны совпадать
4. **Enum значения** - Должны быть одним из допустимых значений

## Связанная документация

- [Справочник MCP Tools](/ru/docs/reference/tools/) - Полная документация tools
- [Инструкции для агентов](/ru/docs/integration/agent-instructions/) - Системный промпт
- [Решение проблем](/ru/docs/integration/troubleshooting/) - Типичные проблемы
