---
title: Руководство для AI агентов
description: Как использовать MCP Moira tools и выполнять workflows
sidebar:
  order: 2
---

Это руководство объясняет как AI агенты используют MCP Moira tools для выполнения workflows.

## Обзор MCP Tools

MCP Moira предоставляет следующие инструменты:

| Tool            | Назначение                             |
| --------------- | -------------------------------------- |
| `list`          | Список доступных workflows             |
| `start`         | Подготовка или выполнение запуска      |
| `step`          | Продвижение workflow с input           |
| `manage`        | CRUD операции с workflows              |
| `session`       | Информация о пользователе и executions |
| `settings`      | Настройки пользователя                 |
| `communication` | Доставка текущему пользователю         |
| `token`         | Токены для upload/download             |
| `help`          | Документация                           |

## Базовое выполнение Workflow

### 1. Подготовка и запуск Workflow

```json
start({ action: "prepare", workflowId: "moira/robust-task", parentExecutionId: "none" })
```

Подготовка проверяет запрос и резервирует Start attempt на 15 минут, но не создаёт execution и не
выполняет ноды workflow. Она возвращает `startAttemptId` независимо от готовности изменяемых
настроек уведомлений и доверенной блокировки. Выполните именно эту попытку, чтобы пройти эти проверки:

```json
start({ action: "execute", startAttemptId: "start-attempt-123" })
```

Успешный ответ выполнения содержит:

```json
{
  "processId": "abc-123-def",
  "attemptId": "attempt-456",
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

Во время `execute` generic notification workflow без настроенного пользовательского канала возвращает
стабильный ответ `START_PRECONDITION_CHANGED` с инструкцией Settings > Notifications и не создаёт
execution. Legacy workflow с Telegram-notification возвращает инструкцию настройки Telegram.
Укажите `skipNotificationCheck: true` во время prepare только для пропуска опционального preflight
обычных уведомлений при execute; флаг не разрешает отправку и не обходит обязательную настройку
Telegram для ноды `lock`.

Если ответ `execute` потерян, повторите вызов с тем же Start attempt ID: завершённая попытка вернёт
точно сохранённый ответ и не создаст второй execution. Новая подготовка означает намеренный запуск
отдельного execution.

### 2. Выполнение шага

После выполнения работы описанной в `directive`:

```json
step({
  processId: "abc-123-def",
  attemptId: "attempt-456",
  input: {
    "steps": ["Шаг 1", "Шаг 2", "Шаг 3"]
  }
})
```

Возвращает следующую директиву или статус завершения.

### 3. Продолжать до завершения

Повторяйте вызовы `step()` пока workflow не вернёт завершение.

В каждом вызове используйте идентификатор попытки шага из текущего предъявления, в том числе для
шага с пустым вводом. Повтор той же попытки с теми же данными возвращает сохранённый результат без
повторного перехода. Не используйте попытку из более старого предъявления.

## Формат ответа

Каждый шаг workflow возвращает:

| Поле                  | Описание                                              |
| --------------------- | ----------------------------------------------------- |
| `processId`           | UUID выполнения, используйте во всех `step()` вызовах |
| `attemptId`           | Идентификатор именно этого предъявления шага          |
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

Возвращает текущее представление шага для агента без продвижения workflow: Process ID, Step attempt ID, directive,
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
start({ action: "prepare", workflowId: "dev-flow", note: "Фича: система авторизации", parentExecutionId: "none" })
start({ action: "execute", startAttemptId: "start-attempt-123" })
```

Обновить заметку во время выполнения через `step()` input:

```json
step({
  processId: "abc-123",
  attemptId: "attempt-456",
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
// 1. Подготовка без создания execution
start({ action: "prepare", workflowId: "moira/verified-research", parentExecutionId: "none" })
// → { startAttemptId: "start-1", expiresAt: "..." }

// 2. Выполнение именно этой подготовленной попытки
start({ action: "execute", startAttemptId: "start-1" })
// → { processId: "xyz", attemptId: "attempt-1", directive: "...", ... }

// 3. Выполнить работу, затем продвинуться
step({ processId: "xyz", attemptId: "attempt-1", input: { findings: "..." } })
// → { attemptId: "attempt-2", directive: "следующий шаг...", ... }
```

### Возобновление после прерывания

```json
// 1. Найти execution
session({ action: "executions" })
// → [{ executionId: "xyz", status: "waiting", ... }]

// 2. Получить текущий шаг
session({ action: "current_step", executionId: "xyz" })
// → { attemptId: "attempt-current", directive: "...", completionCondition: "...", ... }

// 3. Продолжить
step({ processId: "xyz", attemptId: "attempt-current", input: { ... } })
```

## Ошибки валидации

Если `step()` возвращает ошибку валидации, проверьте:

1. **Имена полей** - Должны точно соответствовать схеме (регистрозависимо)
2. **Обязательные поля** - Все required свойства должны присутствовать
3. **Типы данных** - String vs number vs boolean должны совпадать
4. **Enum значения** - Должны быть одним из допустимых значений

`ATTEMPT_PROCESSING` означает, что это изменение ещё принадлежит другому вызывающему: повторите тот
же Process ID, идентификатор попытки и ввод либо тот же Start attempt ID для
`start({ action: "execute" })`. `ATTEMPT_OUTCOME_UNKNOWN` означает, что внешний эффект уже мог
произойти: найдите возвращённый Process ID через `session` и не повторяйте изменение автоматически.
Владелец execution может завершить заблокированное выполнение на его текущей ревизии через
`session({ action: "cancel-execution", executionId, expectedRevision })`.

## Связанная документация

- [Справочник MCP Tools](/ru/docs/reference/tools/) - Полная документация tools
- [Инструкции для агентов](/ru/docs/integration/agent-instructions/) - Системный промпт
- [Решение проблем](/ru/docs/integration/troubleshooting/) - Типичные проблемы
