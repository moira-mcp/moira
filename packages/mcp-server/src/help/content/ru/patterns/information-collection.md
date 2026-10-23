---
title: Паттерн сбора информации
description: Сбор возможностей агента или предпочтений пользователя в начале workflow
---

## Назначение

Сбор информации об окружении агента, предпочтениях пользователя или конфигурации проекта перед продолжением workflow. Это позволяет использовать условное поведение на последующих шагах.

## Структура

```
[start] → [collect-info] → [route-by-info] → [branch-a | branch-b]
```

## Реализация

### Узел-коллектор

```json
{
  "type": "agent-directive",
  "id": "collect-info",
  "directive": "Determine agent capabilities:\n- File system access?\n- Web fetch access?\n- Test framework?",
  "completionCondition": "Relevant capabilities checked in the current environment; unavailable access reported honestly",
  "inputSchema": {
    "type": "object",
    "properties": {
      "has_file_access": { "type": "boolean" },
      "has_web_access": { "type": "boolean" },
      "test_framework": { "type": "string" }
    },
    "required": ["has_file_access", "has_web_access"]
  },
  "connections": { "success": "route-by-capabilities" }
}
```

### Узел маршрутизации

```json
{
  "type": "condition",
  "id": "route-by-capabilities",
  "cases": [
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "collect-info.has_file_access" },
        "right": true
      },
      "output": "has-file-access"
    }
  ],
  "connections": {
    "has-file-access": "file-based-flow",
    "default": "memory-based-flow"
  }
}
```

## Использование собранных значений

Значения локальны для ноды. Здесь показаны фрагменты нод и конфигурации; целевые ноды должны существовать в содержащем workflow. В последующих шаблонах указывайте ID производителя:

```json
{
  "directive": "{{#if collect-info.has_file_access}}Discover an authorized output path and save the result there{{else}}Return the result in the workflow answer{{/if}}"
}
```

## Реальный пример

Фрагмент конфигурации для сбора контекста проекта (при создании ноды добавьте connections и completionCondition):

```json
{
  "type": "agent-directive",
  "id": "get-initial-requirements",
  "completionCondition": "Relevant project rules and validation entries identified from actual sources",
  "connections": { "success": "next-step" },
  "directive": "Read applicable project instructions and identify the validation entry relevant to the requested change. Record discovered paths and report unavailable commands rather than guessing.",
  "inputSchema": {
    "properties": {
      "test_command": { "type": "string" },
      "has_tests": { "type": "string", "enum": ["yes", "no"] },
      "build_command": { "type": "string" },
      "checklist_path": { "type": "string" },
      "has_checklist": { "type": "string", "enum": ["yes", "no"] },
      "has_browser_ui": { "type": "string", "enum": ["yes", "no"] }
    },
    "required": ["has_tests", "has_checklist"],
    "if": { "properties": { "has_tests": { "const": "yes" } }, "required": ["has_tests"] },
    "then": {
      "required": ["test_command"],
      "properties": { "test_command": { "type": "string", "minLength": 1 } }
    }
  }
}
```

:::tip
Собирайте сведения тогда, когда они нужны потребителю. Доступные факты проекта выясняйте самостоятельно; спрашивайте только о решениях или доступе, которые нельзя установить из разрешённого контекста. Флаг наличия возможности не даёт разрешения ею пользоваться.
:::

## Связанные паттерны

- [Паттерн пропуска](/ru/docs/patterns/skip/) - Использование собранных флагов для пропуска шагов
- [Динамические файлы](/ru/docs/patterns/dynamic-files/) - Использование собранных путей в шаблонах
- [Ветвление](/ru/docs/patterns/branching/) - Маршрутизация на основе собранных значений
