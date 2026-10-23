---
title: Паттерн цикла валидации
description: Проверка результатов и повторные попытки при неудаче
---

## Назначение

Обеспечивает качество путём проверки результатов и повторного выполнения, если они не соответствуют критериям. Предотвращает прохождение некачественных результатов дальше.

## Структура

```
[action] → [check] → success → [next]
              ↓
           failure → [fix] → [increment-iteration] → [action]
```

## Реализация

### Нода действия

```json
{
  "type": "agent-directive",
  "id": "do-work",
  "directive": "Complete the task against its actual acceptance criteria. Report unresolved findings honestly.",
  "completionCondition": "Task completed with quality standards met",
  "inputSchema": {
    "type": "object",
    "properties": {
      "result": { "type": "string" },
      "quality_check_passed": { "type": "string", "enum": ["yes", "no"] }
    },
    "required": ["result", "quality_check_passed"]
  },
  "connections": { "success": "check-quality" }
}
```

### Нода проверки

```json
{
  "type": "condition",
  "id": "check-quality",
  "cases": [
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "do-work.quality_check_passed" },
        "right": "yes"
      },
      "output": "passed"
    }
  ],
  "connections": {
    "passed": "next-step",
    "default": "fix-issues"
  }
}
```

### Нода исправления

```json
{
  "type": "agent-directive",
  "id": "fix-issues",
  "directive": "Repair the confirmed findings in {{do-work.result}} at their source; preserve valid work and return to verification.",
  "completionCondition": "Confirmed defects repaired, with relevant checks performed or their blocker reported",
  "connections": { "success": "increment-iteration" }
}
```

### Счётчик итераций

Счётчик нужен только реальному бюджету повторов или потребителю нумерованных артефактов. Пример предполагает числовую запись `current_iteration` в реестре с description и `default: 0`. Иначе уберите счётчик и соедините починку с проверкой напрямую:

```json
{
  "type": "expression",
  "id": "increment-iteration",
  "expressions": ["current_iteration = current_iteration + 1"],
  "connections": { "default": "check-max-iterations" }
}
```

:::caution
Счётчик без применяемой политики только считает повторы. Повторяйте после установления причины или изменения результата; останавливайтесь на реальном блокере или действующем бюджете повторов.
:::

## С ограничением итераций

Добавьте проверку перед повторной попыткой:

```json
{
  "type": "condition",
  "id": "check-max-iterations",
  "cases": [
    {
      "when": {
        "operator": "lt",
        "left": { "contextPath": "current_iteration" },
        "right": 5
      },
      "output": "under-limit"
    }
  ],
  "connections": {
    "under-limit": "do-work",
    "default": "escalate-to-user"
  }
}
```

## Ограниченный цикл ре-валидации

Повторная проверка возвращается к той же ноде. Объясните, какой артефакт изменён и какие замечания перепроверяются. Числовой предел нужен только при требовании предметной области или вызывающей стороны.

### Счётчик — это expression нода

Если у счётчика есть реальный потребитель, увеличивайте его expression-нодой и объявите в `variableRegistry` с числовым default. Фрагмент показывает выбранную политику повторов, а не универсальные пределы.

```json
{
  "variableRegistry": {
    "validation_round": {
      "type": "number",
      "description": "Re-validation pass counter",
      "default": 0
    },
    "max_validation_rounds": {
      "type": "number",
      "description": "Re-validation bound",
      "default": 5
    }
  }
}
```

```json
{
  "type": "expression",
  "id": "increment-validation-round",
  "expressions": ["validation_round = validation_round + 1"],
  "connections": { "default": "re-validate" }
}
```

### Подсказка входа в цикл

Директива входа в цикл отображает счётчик кругов и сообщает, что повторение ожидаемо:

```json
{
  "type": "agent-directive",
  "id": "re-validate",
  "directive": "Re-validation pass {{validation_round}} of {{max_validation_rounds}}. Inspect the changed artifact against the criteria. Report unresolved findings, an unchanged failure or a real blocker honestly; do not blindly replay an uncertain external action.",
  "completionCondition": "Work re-checked against criteria",
  "inputSchema": {
    "type": "object",
    "properties": {
      "all_resolved": { "type": "string", "enum": ["yes", "no"] }
    },
    "required": ["all_resolved"]
  },
  "connections": { "success": "check-resolved" }
}
```

:::caution
Формулировка примерная. Возврат к ревью после починки ожидаем; неизменённая работа, реальный блокер или небезопасный повтор внешнего действия требуют честного сообщения. Подсказка не разрешает слепые повторы.
:::

## Числовая проверка качества

Для свойства, которое машина решает сама, маршрутизируйте по её же ответу — числу воспроизводимых
находок, коду возврата, количеству пробелов покрытия:

```json
{
  "inputSchema": {
    "properties": {
      "issues_count": { "type": "number", "minimum": 0 }
    },
    "required": ["issues_count"]
  }
}
```

```json
{
  "when": {
    "operator": "eq",
    "left": { "contextPath": "validate-result.issues_count" },
    "right": 0
  },
  "output": "clean"
}
```

Не маршрутизируйте по баллу качества. Число, которое рецензент присваивает связности, глубине или
архитектуре, не различает два состояния результата — семь против восьми не говорит читателю ничего
проверяемого, — а порог достигается подгонкой самого числа. Там, где свойство качественное, гейт —
это обоснованный вердикт рецензента и число находок, к которым он привёл. См. [Фиксированная оценка
семантического качества](/ru/docs/patterns/anti-patterns/).

## Реальный пример

Пример предполагает объявленные метаданные шага и существующие целевые ноды в содержащем workflow:

```json
{
  "id": "verify-step-implementation",
  "type": "agent-directive",
  "completionCondition": "Actual step result assessed against its expected output and gaps reported",
  "connections": { "success": "route-verification" },
  "directive": "Verify step {{current_step_name}} implementation:\n- Expected: {{expected_output}}\n- Check actual matches expected",
  "inputSchema": {
    "properties": {
      "step_verified": { "type": "string", "enum": ["yes", "no"] },
      "verification_evidence": { "type": "string" }
    },
    "required": ["step_verified", "verification_evidence"]
  }
}
```

## Поведение агента на воротах валидации

Когда workflow включает ворота валидации (ноды, запрашивающие подтверждение пользователя), агент должен следовать строгим правилам:

### Паттерн директивы ворот валидации

Директива гейта говорит, что записывает её ответ и куда ведёт каждый вариант, — тогда агент видит,
что честный ответ и есть единственный способ провести прогон правильно:

```
`plan_approved` записывает собственный ответ пользователя. Всё, кроме безоговорочного «да», — это «нет»,
и замечания идут в `user_feedback`: флоу направляет «нет» той ответственности, которой принадлежит
правка, поэтому исправление, сделанное здесь, — изменение, которого никто не рецензировал.
```

### Почему это важно

Гейт существует, чтобы передать решение тому, кому оно принадлежит. Агент, прочитавший ответ как
«мелкие правки, которые я применю сам», выдаёт работу, не прошедшую путь правки и ревью, а
`approval = "yes"`, записанное поверх замечаний, теряет сами замечания. Названное следствие — куда
уходит «нет» и что закрывает «да» — и делает честный ответ полезным.

### Пример ворот валидации

```json
{
  "type": "agent-directive",
  "id": "approve-plan",
  "directive": "Представь план и спроси, утверждён ли он.\n\nПлан: {{prepare-plan.summary}}\n\n`plan_approved` записывает собственный ответ пользователя: всё, кроме безоговорочного «да», — это «нет», с точными словами в `user_feedback`. «Нет» ведёт к ответственности, которой принадлежит ревизия, поэтому исправление, сделанное здесь, — изменение, которого никто не рецензировал.",
  "completionCondition": "User confirmed or rejected plan",
  "inputSchema": {
    "type": "object",
    "properties": {
      "plan_approved": { "type": "string", "enum": ["yes", "no"] },
      "user_feedback": { "type": "string" }
    },
    "required": ["plan_approved"],
    "if": { "properties": { "plan_approved": { "const": "no" } }, "required": ["plan_approved"] },
    "then": {
      "required": ["user_feedback"],
      "properties": { "user_feedback": { "type": "string", "minLength": 1 } }
    }
  },
  "connections": { "success": "route-plan-approval" }
}
```

## Связанные паттерны

- [Верификация шагов](/ru/docs/patterns/step-verification/) - Проверка конкретных шагов
- [Эскалация](/ru/docs/patterns/escalation/) - Обработка повторяющихся сбоев
