---
title: Паттерн персистентности Notes
description: Сохранение и получение данных между шагами и запусками workflow
---

## Назначение

Сохраняйте каноническое значение, которому нужен адрес за пределами одного выполнения. Notes обеспечивают key-value хранилище с версионированием и тегами. Движок уже сохраняет переменные выполнения: обычное прерывание не требует копирования этих данных в notes.

## Когда использовать

| Сценарий                         | Пример                                                                |
| -------------------------------- | --------------------------------------------------------------------- |
| **Восстановление сессии**        | Сохранение промежуточных результатов для продолжения после прерывания |
| **Передача данных между шагами** | Передача сложных данных между agent-directive нодами                  |
| **Пользовательские настройки**   | Запоминание выборов, настроек, конфигурации                           |
| **Результаты анализа**           | Сохранение исследований, сравнений, рекомендаций                      |
| **История выполнения**           | Отслеживание решений во время выполнения workflow                     |

:::caution
Не используйте notes для временных вычислений (используйте context variables), данных только для
следующего шага (используйте inputSchema), данных сверх действующей политики notes или бинарных данных. Обычные файлы храните в принадлежащем выполнению workspace; artifacts публикуют HTML.
:::

## Структура

```
[collect-data] → [write-note] → [other-steps] → [read-note] → [use-data]
```

## Реализация

### Нода write-note

Сохранение результата agent-directive ноды:

```json
{
  "id": "save-analysis",
  "type": "write-note",
  "key": "purchase-{{executionId}}-01-analysis",
  "source": "{{analyze-step.analysis}}",
  "tags": ["purchase-{{executionId}}", "analysis"],
  "connections": {
    "default": "next-step",
    "error": "handle-error"
  }
}
```

**Паттерн ключа:** `{domain}-{{executionId}}-{sequence}-{description}`

| Часть         | Назначение            | Пример                   |
| ------------- | --------------------- | ------------------------ |
| `domain`      | Область workflow      | `purchase`, `research`   |
| `scope`       | Изоляция выполнения   | `{{executionId}}`        |
| `sequence`    | Порядок               | `01`, `02`, `03`         |
| `description` | Подсказка содержимого | `user-needs`, `analysis` |

### Пакетный режим записи

Запись нескольких notes из массива:

```json
{
  "id": "save-batch",
  "type": "write-note",
  "source": "collect-items.items",
  "batchMode": true,
  "connections": { "default": "next" }
}
```

Пакетный `source` — путь в контексте без шаблонных скобок. Здесь `collect-items` возвращает `items`. Остальные примеры предполагают наличие названных производителей данных и целевых нод в содержащем workflow. Формат массива source:

```json
[
  { "key": "item-001", "value": "content 1", "tags": ["batch"] },
  { "key": "item-002", "value": "content 2", "tags": ["batch"] }
]
```

### Нода read-note

Загрузка notes в локальные данные ноды: далее используйте `load-data.previousData`:

```json
{
  "id": "load-data",
  "type": "read-note",
  "outputVariable": "previousData",
  "filter": {
    "keyPattern": "purchase-{{executionId}}"
  },
  "connections": { "default": "use-data" }
}
```

**Режим single** возвращает объект только при ровно одном результате в возвращённой странице; при нуле или нескольких совпадениях остаётся массив. Обработчик читает одну ограниченную страницу, а не проверяет уникальность среди всех notes. Результат примера доступен как `load-preferences.userPrefs`:

```json
{
  "id": "load-preferences",
  "type": "read-note",
  "outputVariable": "userPrefs",
  "filter": { "tag": "preferences" },
  "singleMode": true,
  "connections": { "default": "apply-prefs" }
}
```

### Нода upsert-note

Обновление первого возвращённого совпадения либо создание новой note, если результат не найден. Используйте достаточно узкий поиск; это не проверка уникальности:

```json
{
  "id": "update-preferences",
  "type": "upsert-note",
  "search": {
    "tag": "user-prefs",
    "keyPattern": "prefs-{{userId}}"
  },
  "keyTemplate": "prefs-{{userId}}-new",
  "value": "{{collect-preferences.preferences}}",
  "tags": ["user-prefs"],
  "outputVariable": "saveResult",
  "connections": { "default": "confirm" }
}
```

## Инъекция шаблонов

Прямой доступ к notes в директивах:

```json
{
  "id": "research-step",
  "type": "agent-directive",
  "directive": "Исследуй на основе потребностей пользователя.\n\n**Потребности:**\n{{note:purchase-{{executionId}}-01-user-needs}}\n\nОпредели основные категории.",
  "completionCondition": "Исследование завершено",
  "connections": { "success": "next-step" }
}
```

**Синтаксис:** `{{note:key-name}}`

Содержимое note инжектируется в директиву до получения агентом.

## Использование MCP Tool

Внутри agent-directive нод используйте MCP tool `notes`:

```typescript
// Сохранить note
notes({
  action: "save",
  key: "user-preferences",
  value: JSON.stringify({ theme: "dark", lang: "ru" }),
  tags: ["preferences"],
});

// Получить note
notes({
  action: "get",
  key: "user-preferences",
});

// Список notes по тегу
notes({
  action: "list",
  tag: "preferences",
});

// Проверить квоту
notes({
  action: "stats",
});
```

## Каноническое долговечное значение

Выберите один канонический подробный результат. Файловый пакет и note с одним отчётом создают конкурирующие источники. Write-note подходит, когда сама note является долговечным значением:

```json
{
  "id": "write-note-01",
  "type": "write-note",
  "key": "purchase-{{executionId}}-01-user-needs",
  "source": "{{analyze-user-needs.needs}}",
  "tags": ["analysis-{{executionId}}", "research"],
  "connections": { "default": "research-product-category" }
}
```

## Лучшие практики

### Стратегия тегов

- Используйте тег выполнения: `purchase-{{executionId}}`
- Используйте тег категории: `research`, `research-flow`
- Позволяет эффективную фильтрацию и очистку

### Обработка ошибок

```json
{
  "id": "write-critical",
  "type": "write-note",
  "key": "critical-data-{{executionId}}",
  "source": "{{produce-results.result}}",
  "connections": {
    "default": "continue",
    "error": "handle-write-error"
  }
}
```

### Сериализация данных

- Объекты и массивы автоматически сериализуются в JSON
- Примитивные значения сохраняются как строки
- Большие объекты храните в принадлежащем выполнению workspace; artifacts используйте для публикации HTML

## Антипаттерны

### Отсутствие изоляции выполнения

```jsonc
// Неправильно - общий между выполнениями
{ "key": "user-analysis" }

// Правильно - изолирован по выполнению
{ "key": "user-analysis-{{executionId}}" }
```

### Избыточное использование notes для простых данных

Не храните счётчики циклов или временные значения в notes. Используйте expression ноды или context variables.

### Хранение больших бинарных данных

Notes предназначены для структурированных текстовых данных. Используйте [Artifacts](/ru/docs/patterns/artifacts-publishing/) для публикации HTML, а принадлежащий выполнению workspace — для бинарных и обычных больших файлов.

## Связанные паттерны

- [Публикация Artifacts](/ru/docs/patterns/artifacts-publishing/) - Для HTML контента с публичными URL
- [Рабочее пространство](/ru/docs/patterns/workspace/) - Для организованных файловых структур
