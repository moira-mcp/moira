---
title: Операторы условий
description: Справочник по всем операторам условий в узлах workflows
---

Структурированное условие — это объект, который решает, срабатывает ли case маршрутизации. Он
находится в поле `when` у case узла `condition` или `agent-directive`:

```json
{
  "id": "check-status",
  "type": "condition",
  "cases": [
    {
      "when": { "operator": "eq", "left": { "contextPath": "status" }, "right": "ready" },
      "output": "ready"
    }
  ],
  "connections": { "ready": "next-step", "default": "wait" }
}
```

Во всех примерах ниже показан сам объект условия — то, что помещается в `when` у case.

## Операторы сравнения

### Равно (`eq`)

```json
{
  "operator": "eq",
  "left": { "contextPath": "status" },
  "right": "ready"
}
```

Работает со строками, числами, булевыми значениями.

### Не равно (`neq`)

```json
{
  "operator": "neq",
  "left": { "contextPath": "error_count" },
  "right": 0
}
```

### Больше (`gt`)

```json
{
  "operator": "gt",
  "left": { "contextPath": "score" },
  "right": 80
}
```

### Больше или равно (`gte`)

```json
{
  "operator": "gte",
  "left": { "contextPath": "items_count" },
  "right": 1
}
```

### Меньше (`lt`)

```json
{
  "operator": "lt",
  "left": { "contextPath": "retry_count" },
  "right": 3
}
```

### Меньше или равно (`lte`)

```json
{
  "operator": "lte",
  "left": { "contextPath": "error_rate" },
  "right": 0.05
}
```

## Строковые операторы

### Содержит (`contains`)

```json
{
  "operator": "contains",
  "left": { "contextPath": "message" },
  "right": "error"
}
```

Также работает с массивами:

```json
{
  "operator": "contains",
  "left": { "contextPath": "tags" },
  "right": "urgent"
}
```

## Операторы существования

### Существует (`exists`)

```json
{
  "operator": "exists",
  "value": { "contextPath": "optional_field" }
}
```

Возвращает true, если переменная существует и не равна null/undefined.

## Логические операторы

### И (`and`)

Все условия должны быть истинными:

```json
{
  "operator": "and",
  "conditions": [
    {
      "operator": "eq",
      "left": { "contextPath": "status" },
      "right": "complete"
    },
    {
      "operator": "gt",
      "left": { "contextPath": "score" },
      "right": 80
    }
  ]
}
```

### ИЛИ (`or`)

Хотя бы одно условие должно быть истинным:

```json
{
  "operator": "or",
  "conditions": [
    {
      "operator": "eq",
      "left": { "contextPath": "priority" },
      "right": "high"
    },
    {
      "operator": "eq",
      "left": { "contextPath": "priority" },
      "right": "critical"
    }
  ]
}
```

### НЕ (`not`)

Инвертирует условие:

```json
{
  "operator": "not",
  "condition": {
    "operator": "eq",
    "left": { "contextPath": "status" },
    "right": "blocked"
  }
}
```

## Синтаксис путей контекста

### Простой путь

```json
{ "contextPath": "variable_name" }
```

### Вложенный путь

```json
{ "contextPath": "user.profile.name" }
```

### Индекс массива

```json
{ "contextPath": "items[0]" }
```

### Комбинированный

```json
{ "contextPath": "results[0].score" }
```

## Литеральные значения

Значения правой части могут быть литералами:

```json
{
  "right": "string value"
}
```

```json
{
  "right": 42
}
```

```json
{
  "right": true
}
```

```json
{
  "right": null
}
```

:::note
При сравнении с `contextPath` на обеих сторонах оба значения разрешаются из контекста перед
сравнением.
:::

## Типичные паттерны

### Проверка булевого флага

```json
{
  "operator": "eq",
  "left": { "contextPath": "has_tests" },
  "right": "yes"
}
```

### Проверка лимита итераций

```json
{
  "operator": "lt",
  "left": { "contextPath": "current_iteration" },
  "right": 5
}
```

### Маршрутизация трёх исходов

По одному case на каждый авторский выход; побеждает первый сработавший case, а `default` покрывает
остальные:

```json
{
  "id": "route-verdict",
  "type": "condition",
  "cases": [
    {
      "when": { "operator": "eq", "left": { "contextPath": "verdict" }, "right": "blocked" },
      "output": "blocked"
    },
    {
      "when": { "operator": "eq", "left": { "contextPath": "verdict" }, "right": "minor" },
      "output": "minor"
    }
  ],
  "connections": {
    "blocked": "escalate",
    "minor": "fix-issues",
    "default": "proceed"
  }
}
```

## Смотрите также

- [Шаблоны Workflows](/ru/docs/reference/workflow-templates/) - Использование условий в workflows
- [Валидация](/ru/docs/reference/validation/) - Правила валидации входных данных
