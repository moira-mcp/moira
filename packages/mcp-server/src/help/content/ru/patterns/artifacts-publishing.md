---
title: Паттерн публикации Artifacts
description: Публикация HTML контента с публичными URL для обмена
---

## Назначение

Публикация статического HTML контента, доступного по публичному URL. Генерация отчётов, дашбордов и документов для просмотра в браузере.

Примеры нод — фрагменты содержащего workflow: названные производители данных и целевые ноды должны существовать. Ответ локален для производителя: уведомление ниже читает `generate-and-upload.report_url`; альтернативная загрузка требует своего соответствующего пути. Публикация HTML не доказывает доставку уведомления и требует разрешения на публичный доступ.

## Когда использовать

| Сценарий                        | Пример                                                         |
| ------------------------------- | -------------------------------------------------------------- |
| **Отчёты**                      | Анализ покупок, результаты исследований, сравнительные таблицы |
| **Дашборды**                    | Страницы статуса, визуализация метрик                          |
| **Контент для обмена**          | Документы, презентации, портфолио                              |
| **Уведомления**                 | Генерация отчёта и отправка URL пользователю                   |
| **Результаты для пользователя** | Всё, что нужно просмотреть в браузере                          |

:::caution
Не используйте artifacts для временных данных (используйте notes), структурированного JSON
хранения (используйте notes), бинарных файлов, часто изменяющегося контента, контента с
аутентификацией.
:::

## Структура

```
[generate-data] → [create-html] → [upload-artifact] → [share-url]
```

## Реализация

Простые примеры ниже показывают только успешную загрузку: переходить дальше можно лишь после подтверждённого принятия и получения настоящего URL. При отказе или неизвестном исходе оставайтесь на паузе либо используйте явный маршрут из раздела «Обработка ошибок». Недостающие полномочия не разрешают попытку публикации.

### Паттерн прямой загрузки

Когда агент генерирует HTML в памяти:

```json
{
  "id": "generate-and-upload",
  "type": "agent-directive",
  "directive": "Сгенерируй HTML отчёт из данных анализа.\n\n**Данные:**\n{{note:analysis-results}}\n\nСоздай адаптивный HTML с Tailwind CDN.\n\nЗагрузи:\nartifacts({ action: \"upload\", name: \"report.html\", content: \"<html>...\" })\n\nСохрани возвращённый `url` как report_url.",
  "completionCondition": "Отчёт загружен и URL получен",
  "inputSchema": {
    "type": "object",
    "required": ["report_url"],
    "properties": {
      "report_url": { "type": "string" }
    }
  },
  "connections": { "success": "notify-user" }
}
```

### Паттерн загрузки по токену

Когда агент сначала создаёт файлы локально:

```json
{
  "id": "upload-via-token",
  "connections": { "success": "notify-token-user" },
  "type": "agent-directive",
  "completionCondition": "Actual HTML upload accepted and returned URL captured",
  "directive": "Загрузи файл отчёта.\n\n1. Получи токен: artifacts({ action: \"token\", ttlMinutes: 30 })\n2. Прочитай файл из {{create-html.file_path}}\n3. POST на uploadUrl как multipart/form-data с полем file либо JSON с name и content\n4. Сохрани url из ответа",
  "inputSchema": {
    "properties": {
      "report_url": { "type": "string" }
    },
    "required": ["report_url"]
  }
}
```

### Условный выбор по возможностям

Маршрутизация на основе доступа агента к файлам:

```json
{
  "id": "check-file-access",
  "type": "condition",
  "cases": [
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "collect-capabilities.can_create_files" },
        "right": true
      },
      "output": "can-create-files"
    }
  ],
  "connections": {
    "can-create-files": "generate-file-then-upload",
    "default": "generate-and-upload-direct"
  }
}
```

## Использование MCP Tool

### Загрузка Artifact

```typescript
artifacts({
  action: "upload",
  name: "purchase-report.html",
  content: `<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 p-8">
  <h1 class="text-2xl font-bold">Отчёт</h1>
</body>
</html>`,
  executionId: "00000000-0000-4000-8000-000000000001", // Опционально: связь с workflow
});
```

Ответ:

```json
{
  "success": true,
  "data": {
    "uuid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "url": "https://{MOIRA_HOST}/a/a1b2c3d4...",
    "name": "purchase-report.html",
    "size": 1234,
    "expiresAt": "2025-02-28T10:00:00.000Z"
  }
}
```

### Обновление Artifact

```typescript
artifacts({
  action: "update",
  uuid: "a1b2c3d4-e5f6-4890-abcd-ef1234567890",
  content: "<html>...обновлённый контент...</html>",
  name: "report-v2.html", // Опционально
});
```

### Проверка квоты

```typescript
artifacts({
  action: "stats",
});
// Возвращает: totalArtifacts, totalSize, storageLimit, countLimit,
// storageUsedPercent, countUsedPercent
```

### Список Artifacts

```typescript
artifacts({
  action: "list",
  limit: 20,
});
```

## Квоты и лимиты

Политики хранилища, количества файлов, размера одного файла и срока действия по умолчанию задаются
сервером и могут иметь пользовательские переопределения. Используйте `stats` для эффективных квот
хранилища и количества, обрабатывайте границу из ошибок upload и считайте `expiresAt` в каждом
ответе источником истины. Допустимый срок действия upload-токена задан схемой `ttlMinutes`.

:::tip
Проверяйте квоту перед загрузкой с помощью `artifacts({ action: "stats" })`. Удаляйте только artifacts, на удаление которых есть разрешение; предупреждение о квоте не разрешает удалять другой результат.
:::

## Советы по генерации HTML

### Используйте Tailwind CDN

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="bg-gray-50 min-h-screen">
    <!-- Контент -->
  </body>
</html>
```

### Адаптивная вёрстка

```html
<div class="container mx-auto px-4 py-8">
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
    <!-- Карточки -->
  </div>
</div>
```

### Карточка продукта

```html
<div class="bg-white rounded-lg shadow-md p-6">
  <h3 class="text-lg font-semibold">Название продукта</h3>
  <p class="text-gray-600 mt-2">Описание</p>
  <div class="mt-4 flex justify-between items-center">
    <span class="text-2xl font-bold text-green-600">999 ₽</span>
    <a
      href="https://store.com/product"
      class="bg-blue-500 text-white px-4 py-2 rounded"
      target="_blank"
      rel="noopener noreferrer"
    >
      Купить
    </a>
  </div>
</div>
```

### Сравнительная таблица

```html
<table class="w-full border-collapse">
  <thead>
    <tr class="bg-gray-100">
      <th class="border p-3 text-left">Продукт</th>
      <th class="border p-3 text-left">Цена</th>
      <th class="border p-3 text-left">Рейтинг</th>
    </tr>
  </thead>
  <tbody>
    <tr class="hover:bg-gray-50">
      <td class="border p-3">Продукт А</td>
      <td class="border p-3">599 ₽</td>
      <td class="border p-3">4.5/5</td>
    </tr>
  </tbody>
</table>
```

## Интеграция с уведомлениями

Комбинация с channel-neutral уведомлением пользователя:

```json
{
  "id": "notify-user",
  "type": "user-notification",
  "message": "Отчёт готов: {{generate-and-upload.report_url}}",
  "format": "plain",
  "connections": { "default": "end", "error": "end" }
}
```

## Реальный пример

Из workflow анализа покупок:

```json
{
  "id": "create-report",
  "connections": { "success": "notify-report-user" },
  "completionCondition": "Report reflects the actual analysis and publication is authorized and accepted",
  "type": "agent-directive",
  "directive": "Создай HTML отчёт с рекомендациями продуктов.\n\n**Данные анализа:**\n{{note:purchase-{{executionId}}-03-analysis}}\n\nСгенерируй адаптивный HTML:\n- Карточки продуктов с изображениями, ценами, ссылками\n- Сравнительная таблица\n- Итоговые рекомендации\n\nЗагрузи: artifacts({ action: \"upload\", name: \"purchase-{{executionId}}.html\", content: html, executionId: \"{{executionId}}\" })",
  "inputSchema": {
    "properties": {
      "report_url": { "type": "string" }
    },
    "required": ["report_url"]
  }
}
```

## Лучшие практики

### Описательные имена

```typescript
// Хорошо
artifacts({ action: "upload", name: "purchase-analysis-2025-01-31.html", content: htmlContent });

// Плохо
artifacts({ action: "upload", name: "report.html", content: htmlContent });
```

### Связь с выполнением

```typescript
artifacts({
  action: "upload",
  name: "report.html",
  content: htmlContent,
  executionId: context.executionId,
});
```

Преимущества:

- Отслеживание какое выполнение создало artifact
- Запрос artifacts по выполнению
- Связь с выполнением не означает автоматическое удаление artifact при его архивации

### Обработка ошибок

Владелец загрузки записывает фактический исход и выбирает маршрут по своему локальному ответу. Уведомление об успехе читает URL этого владельца, а не результат предыдущего примера прямой загрузки. Добавьте следующие ноды в содержащий workflow с существующей целью `end`:

```json
[
  {
    "id": "upload-report",
    "type": "agent-directive",
    "directive": "Публикуй HTML-отчёт только в пределах имеющихся полномочий и изучи настоящий ответ загрузки. Верни uploaded, только когда установлены принятие и полученный URL. При явном отказе верни refused, при таймауте или потерянном ответе с неизвестным результатом — uncertain. Для refused и uncertain запиши наблюдаемую причину; не придумывай URL. Перед повтором неопределённой операции выясни её фактический результат. Если проверка установила уже принятый artifact, верни его достоверный URL без повторной загрузки.",
    "completionCondition": "Фактический исход загрузки честно записан вместе с принятым URL либо настоящей причиной отказа или неопределённости",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "upload_outcome": { "type": "string", "enum": ["uploaded", "refused", "uncertain"] },
        "report_url": { "type": "string", "minLength": 1 },
        "upload_reason": { "type": "string", "minLength": 1 }
      },
      "required": ["upload_outcome"],
      "if": {
        "properties": { "upload_outcome": { "const": "uploaded" } },
        "required": ["upload_outcome"]
      },
      "then": {
        "required": ["report_url"],
        "not": { "required": ["upload_reason"] }
      },
      "else": {
        "required": ["upload_reason"],
        "not": { "required": ["report_url"] }
      }
    },
    "cases": [
      {
        "when": {
          "operator": "neq",
          "left": { "contextPath": "upload-report.upload_outcome" },
          "right": "uploaded"
        },
        "output": "upload-blocked"
      }
    ],
    "connections": {
      "success": "notify-upload-result",
      "upload-blocked": "handle-upload-error"
    }
  },
  {
    "id": "notify-upload-result",
    "type": "user-notification",
    "message": "Отчёт готов: {{upload-report.report_url}}",
    "format": "plain",
    "connections": { "default": "end", "error": "end" }
  },
  {
    "id": "handle-upload-error",
    "type": "agent-directive",
    "directive": "Исход загрузки: {{upload-report.upload_outcome}}. Наблюдаемая причина: {{upload-report.upload_reason}}. Сохрани отчёт и объясни пользователю настоящий блокер. Диагностируй явный отказ либо выясни, была ли принята загрузка с неизвестным исходом, прежде чем рассматривать повтор. Действуй только в пределах имеющихся полномочий. Если обязательное решение, доступ или достоверный результат недоступны, оставайся на паузе и получи их поддерживаемым механизмом ввода пользователя; не отправляй успешное завершение и не повторяй операцию вслепую.",
    "completionCondition": "Причина отказа устранена либо неопределённый исход достоверно установлен и обосновано конкретное разрешённое продолжение через владельца загрузки; иначе оставаться на паузе",
    "connections": { "success": "upload-report" }
  }
]
```

Пустой ответ здесь невалиден. Ответ `refused` или `uncertain`, соответствующий схеме, выбирает авторский маршрут `upload-blocked`; только `uploaded` ведёт к уведомлению об успехе. Схема проверяет форму ответа, а не истинность заявления о загрузке. Владелец восстановления не завершает ноду при нерешённом блокере; повтор обосновывается устранённой причиной или установленным исходом, а не новым значением счётчика.

Ошибка инструмента внутри agent-directive сама по себе не выбирает зарезервированный `connections.error`. Этот управляющий выход отличается от явного маршрута по наблюдаемому исходу. Публичная загрузка по токену принимает POST multipart/form-data с полем `file` либо JSON `{name, content}`; соблюдайте лимиты размера, срок и одноразовость токена.

## Антипаттерны

### Использование Artifacts для хранения данных

Используйте notes для JSON данных, artifacts только для презентабельного HTML.

### Отсутствие проверки квот

Всегда проверяйте `stats` перед большими загрузками. Обрабатывайте ошибки превышения квоты.

### Неадаптивный HTML

Используйте Tailwind или media queries. Фиксированная ширина ломается на мобильных.

## Связанные паттерны

- [Персистентность Notes](/ru/docs/patterns/notes-persistence/) - Для структурированного хранения данных
- [Рабочее пространство](/ru/docs/patterns/workspace/) - Для организации файлов
