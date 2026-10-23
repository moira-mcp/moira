---
title: Паттерн пропуска шагов
description: Возможность пропуска необязательных шагов пользователем
---

## Назначение

Позволяет пользователям или агентам пропускать необязательные шаги workflow, когда они не нужны. Полезно для опциональных этапов анализа, ревью или конфигурации.

## Структура

```
[optional-step] → [check-skip] → skip=true  → [next-step]
                              → skip=false → [process-result]
```

## Реализация

### Нода необязательного шага

```json
{
  "type": "agent-directive",
  "id": "optional-analysis",
  "directive": "Perform optional deep analysis. User can skip if not needed by providing skip='yes'.",
  "completionCondition": "Optional analysis completed or explicitly skipped under the workflow's rules",
  "inputSchema": {
    "type": "object",
    "properties": {
      "analysis_result": { "type": "string" },
      "skip": { "type": "string", "enum": ["yes"] }
    },
    "oneOf": [
      { "required": ["skip"], "not": { "required": ["analysis_result"] } },
      { "required": ["analysis_result"], "not": { "required": ["skip"] } }
    ]
  },
  "connections": { "success": "check-skip" }
}
```

:::note
Поле `skip` использует `enum: ["yes"]`, чтобы сделать его необязательным, но явным. Если
пользователь хочет пропустить — он указывает `skip: "yes"`. В противном случае предоставляет
фактический результат.
:::

### Нода проверки пропуска

```json
{
  "type": "condition",
  "id": "check-skip",
  "cases": [
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "optional-analysis.skip" },
        "right": "yes"
      },
      "output": "skipped"
    }
  ],
  "connections": {
    "skipped": "next-step",
    "default": "process-analysis"
  }
}
```

## Альтернатива: булев флаг

Для более простых случаев:

```json
{
  "inputSchema": {
    "properties": {
      "result": { "type": "string" },
      "skipped": { "type": "boolean" }
    },
    "required": ["skipped"]
  }
}
```

## Совмещение со сбором информации

Решение о пропуске можно принять заранее:

```json
{
  "id": "collect-preferences",
  "type": "agent-directive",
  "directive": "Ask user: do you want detailed analysis?",
  "completionCondition": "Actual user preference recorded",
  "inputSchema": {
    "properties": {
      "want_detailed_analysis": { "type": "boolean" }
    },
    "required": ["want_detailed_analysis"]
  },
  "connections": { "success": "route-preferences" }
}
```

Затем используйте condition:

```json
{
  "cases": [
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "collect-preferences.want_detailed_analysis" },
        "right": false
      },
      "output": "skipped"
    }
  ],
  "connections": {
    "skipped": "skip-to-summary",
    "default": "detailed-analysis"
  }
}
```

## Реальный пример

Пример необязательного чтения существующего определения; он не разрешает пропуск обязательного ревью или чтения исходного baseline перед редактированием:

```json
{
  "id": "review-existing-workflow",
  "type": "agent-directive",
  "completionCondition": "Applicable source review completed, or inapplicable new-workflow source review explicitly skipped",
  "connections": { "success": "route-review-result" },
  "directive": "If editing, review the existing workflow structure.\nIf creating new workflow, skip this step.",
  "inputSchema": {
    "properties": {
      "workflow_reviewed": { "type": "string" },
      "skip": { "type": "string", "enum": ["yes"] }
    }
  }
}
```

:::tip
Делайте поведение пропуска явным в директиве. Укажите пользователю точно, когда и как можно
пропустить шаг.
:::

## Связанные паттерны

- [Сбор информации](/ru/docs/patterns/information-collection/) - Сбор предпочтений о пропуске заранее
- [Ветвление](/ru/docs/patterns/branching/) - Маршрутизация по разным путям на основе решений
