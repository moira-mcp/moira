---
title: Паттерн верификации шагов
description: Проверка завершённости шага перед переходом к следующему
---

## Назначение

Гарантирует, что каждый шаг workflow действительно завершён перед переходом к следующему. Предотвращает пропуск незавершённой работы и требует доказательств выполнения.

## Структура

```
[execute-step] → [verify-step] → verified=yes → [next-step]
                              → verified=no  → [retry-or-escalate]
```

## Реализация

### Нода выполнения

```json
{
  "type": "agent-directive",
  "id": "execute-step",
  "directive": "Implement {{current_step_name}}:\n{{current_step_action}}",
  "completionCondition": "Step implementation complete",
  "inputSchema": {
    "type": "object",
    "properties": {
      "implementation_summary": { "type": "string" }
    },
    "required": ["implementation_summary"]
  },
  "connections": { "success": "verify-step" }
}
```

### Нода верификации

```json
{
  "type": "agent-directive",
  "id": "verify-step",
  "completionCondition": "The real artifact checked against the expected result and the evidence or remaining gap reported",
  "directive": "Verify step {{current_step_name}} completed:\n- Expected: {{expected_output}}\n- Check actual result matches expected\n- Provide evidence",
  "inputSchema": {
    "type": "object",
    "properties": {
      "step_verified": { "type": "string", "enum": ["yes", "no"] },
      "verification_evidence": { "type": "string" }
    },
    "required": ["step_verified", "verification_evidence"]
  },
  "connections": { "success": "check-verification" }
}
```

:::caution
Поле verification_evidence записывает обоснование, но строка сама по себе ничего не доказывает. Читатель проверяет относящийся к утверждению артефакт или результат действия.
:::

### Нода проверки

```json
{
  "type": "condition",
  "id": "check-verification",
  "cases": [
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "verify-step.step_verified" },
        "right": "yes"
      },
      "output": "verified"
    }
  ],
  "connections": {
    "verified": "proceed-to-next",
    "default": "handle-failure"
  }
}
```

## Требования к доказательствам

Укажите, что считается доказательством:

```json
{
  "directive": "Select evidence for the property actually changed: observed focused test/API results for behavior, the stored artifact for representation, viewed screenshots for appearance, and reasoned primary-source review for meaning and architecture. Report unavailable checks and limitations honestly; do not run unrelated checks to fill a list."
}
```

### Свидетельство соответствует роду утверждения

Утверждение о факте — команда выполнилась, тест прошёл, ссылка открывается, файл содержит этот
текст — подтверждается выводом инструмента или самим артефактом. Утверждение-суждение — структура
связна, довод держится, результат годится своему читателю — подтверждается самим рассуждением, и
ничем другим из доступного.

Смешение этих двух родов даёт сбой в обе стороны. Координата, предъявленная вместо суждения, —
номер строки, сетка покрытия, доказательство прочтения, балл из десяти — это адрес, а не оценка: она
говорит, где смотреть, но не о том, годится ли увиденное, и остаётся зелёной при плохой работе.
Суждение, предъявленное вместо факта, — мнение там, где есть проверка.

Поэтому шаг требует вывода инструмента там, где он возможен, требует прозы там, где невозможен, и
не позволяет числу подменить чтение, которого никто не выполнил.

:::caution
Шаг, гейт которого выполним только числом, число и получит. Если существенное свойство
качественное, назовите, как оно судится, вместо того, что оно должно превысить, — см.
[Фиксированная оценка семантического качества](/ru/docs/patterns/anti-patterns/).
:::

## Контекстные переменные шага

Храните метаданные шага в контексте:

```json
{
  "variableRegistry": {
    "current_step_index": { "type": "number", "description": "Номер текущего шага", "default": 1 },
    "current_step_name": {
      "type": "string",
      "description": "Название текущего шага",
      "default": "Step 1"
    },
    "current_step_action": {
      "type": "string",
      "description": "Что делает текущий шаг",
      "default": "Implement feature X"
    },
    "expected_output": {
      "type": "string",
      "description": "Ожидаемый результат текущего шага",
      "default": "Feature X works with tests passing"
    }
  }
}
```

Используйте expression ноды для обновления:

```json
{
  "type": "expression",
  "id": "increment-step",
  "expressions": ["current_step_index = current_step_index + 1"],
  "connections": { "default": "load-next-step" }
}
```

## Реальный пример

Пример предполагает объявленные метаданные шага и существующие целевые ноды в содержащем workflow:

```json
{
  "id": "verify-step-implementation",
  "type": "agent-directive",
  "completionCondition": "Actual step artifact checked against the expected outcome and remaining gaps recorded",
  "connections": { "success": "check-verification" },
  "directive": "Verify step {{current_step_index}} ({{current_step_name}}) implementation.\n\nExpected outcome: {{expected_output}}\n\nVerification checklist:\n- Functionality works as expected\n- Tests pass (if applicable)\n- No regressions introduced\n\nProvide concrete evidence for each claim.",
  "inputSchema": {
    "properties": {
      "step_verified": { "type": "string", "enum": ["yes", "no"] },
      "verification_evidence": { "type": "string" },
      "issues_found": { "type": "string" }
    },
    "required": ["step_verified", "verification_evidence"]
  }
}
```

## Обработка неудачной верификации

При неудаче — повторная попытка или эскалация:

```json
{
  "type": "condition",
  "id": "check-retry-limit",
  "cases": [
    {
      "when": {
        "operator": "lt",
        "left": { "contextPath": "current_iteration" },
        "right": 3
      },
      "output": "under-limit"
    }
  ],
  "connections": {
    "under-limit": "fix-and-retry",
    "default": "escalate-to-user"
  }
}
```

## Связанные паттерны

- [Цикл валидации](/ru/docs/patterns/validation-loop/) - Повторные попытки при неудачной верификации
- [Эскалация](/ru/docs/patterns/escalation/) - Обработка повторяющихся сбоев
