---
title: Паттерн ветвления
description: Разные пути для разных сценариев
---

## Назначение

Маршрутизация выполнения workflow по различным путям на основе выбора пользователя, собранных данных или вычисленных условий.

## Структура

```
[get-choice] → [route] → choice=A → [path-a] → [merge]
                      → choice=B → [path-b] → [merge]
```

## Реализация

### Сбор выбора

```json
{
  "type": "agent-directive",
  "id": "get-action",
  "directive": "Ask user: create new or edit existing?",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["create", "edit"] }
    },
    "required": ["action"]
  },
  "connections": { "success": "route-action" }
}
```

### Простая бинарная маршрутизация

```json
{
  "type": "condition",
  "id": "route-action",
  "cases": [
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "action" },
        "right": "create"
      },
      "output": "create"
    }
  ],
  "connections": {
    "create": "create-workflow",
    "default": "edit-workflow"
  }
}
```

Бинарное решение — это один case плюс `default`: case называет выбираемую ветвь, а `default`
принимает все остальные значения.

## Ветвление на несколько путей

Для более чем 2 вариантов перечислите несколько cases на одном узле condition. Cases проверяются
в заданном порядке; первый, чьё `when` истинно, выбирает свой output, а `default` принимает
остальные значения:

```json
{
  "id": "route-action",
  "type": "condition",
  "cases": [
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "action" },
        "right": "create"
      },
      "output": "create"
    },
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "action" },
        "right": "edit"
      },
      "output": "edit"
    }
  ],
  "connections": {
    "create": "create-branch",
    "edit": "edit-branch",
    "default": "delete-branch"
  }
}
```

:::tip
Для ветвлений на несколько путей упорядочивайте cases от наиболее частых к наименее частым для
эффективности.
:::

## Ветвление по булевому флагу

```json
{
  "type": "condition",
  "id": "check-has-tests",
  "cases": [
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "has_tests" },
        "right": "yes"
      },
      "output": "has-tests"
    }
  ],
  "connections": {
    "has-tests": "run-tests",
    "default": "skip-tests"
  }
}
```

## Ветвление по числовому значению

```json
{
  "type": "condition",
  "id": "check-error-count",
  "cases": [
    {
      "when": {
        "operator": "gt",
        "left": { "contextPath": "error_count" },
        "right": 0
      },
      "output": "has-errors"
    }
  ],
  "connections": {
    "has-errors": "fix-errors",
    "default": "proceed"
  }
}
```

## Сложные условия

Комбинирование нескольких проверок внутри одного case:

```json
{
  "when": {
    "operator": "and",
    "conditions": [
      {
        "operator": "eq",
        "left": { "contextPath": "status" },
        "right": "ready"
      },
      {
        "operator": "gt",
        "left": { "contextPath": "items_count" },
        "right": 0
      }
    ]
  },
  "output": "ready"
}
```

## Объединение ветвей

Ветви обычно сходятся в общем узле:

```
[create-branch] → [save-workflow]
[edit-branch]   → [save-workflow]
```

Оба пути подключаются к одному целевому узлу.

## Связанные паттерны

- [Сбор информации](/ru/docs/patterns/information-collection/) - Сбор данных для принятия решений о маршрутизации
- [Паттерн пропуска](/ru/docs/patterns/skip/) - Частный случай ветвления для опциональных шагов
