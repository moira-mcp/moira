---
title: Написание директив
description: Лучшие практики написания ясных и эффективных директив для workflows
---

## Структура директивы

Каждый узел agent-directive должен содержать:

```json
{
  "type": "agent-directive",
  "id": "unique-id",
  "directive": "Что агент должен сделать",
  "completionCondition": "Когда задача завершена",
  "inputSchema": {/* ожидаемая структура ответа */},
  "connections": { "success": "next-node" }
}
```

## Написание ясных директив

### Будьте конкретны

❌ Плохо:

```
"Fix the bugs"
```

✅ Хорошо:

```
"Fix TypeScript compilation errors in src/auth/.\n\nSteps:\n1. Run tsc --noEmit\n2. Fix each error\n3. Verify compilation succeeds"
```

### Включайте контекст

Используйте шаблонные переменные:

```
"Implement step {{current_step_index}} of {{total_steps}}: {{current_step_name}}\n\nExpected outcome: {{expected_outcome}}"
```

### Указывайте требования к выводу

```
"Run tests and report results.\n\nRequired output format:\n- Total tests\n- Passed count\n- Failed count\n- List of failed test names"
```

## Условия завершения

### Что делает условие хорошим

- **Измеримое**: можно объективно проверить
- **Конкретное**: чёткие критерии успеха/провала
- **Полное**: покрывает все требования

### Примеры

❌ Расплывчатое:

```
"Task is done"
```

✅ Конкретное:

```
"All tests pass (npm test shows 0 failures)"
```

✅ Множественные критерии:

```
"Implementation complete:\n- Feature works as specified\n- Tests added and passing\n- No TypeScript errors"
```

:::caution
Агенты заявляют о завершении, когда считают что условие выполнено. Делайте условия однозначными,
чтобы предотвратить преждевременное завершение.
:::

## Эффективное использование InputSchema

### Требуйте доказательства

```json
{
  "inputSchema": {
    "properties": {
      "task_completed": { "type": "string", "enum": ["yes", "no"] },
      "evidence": {
        "type": "string",
        "description": "Concrete proof: command output, test results, etc."
      }
    },
    "required": ["task_completed", "evidence"]
  }
}
```

### Принудительный явный выбор

```json
{
  "inputSchema": {
    "properties": {
      "quality_check": {
        "type": "string",
        "enum": ["pass", "fail"],
        "description": "Did implementation meet quality standards?"
      }
    },
    "required": ["quality_check"]
  }
}
```

### Маршрутизация по ответу

Ответ-enum обычно и решает, куда пойдёт прогон дальше. Ставьте `cases` на ту же ноду, чтобы решал
шаг, у которого есть свидетельство:

```json
{
  "id": "review",
  "type": "agent-directive",
  "directive": "Review the change against the acceptance criteria.",
  "completionCondition": "Verdict recorded with the findings that support it",
  "inputSchema": {
    "type": "object",
    "globalInputs": ["review_verdict"],
    "properties": {
      "findings": { "type": "string" }
    },
    "required": ["review_verdict"]
  },
  "expressions": ["review_round = review_round + 1"],
  "cases": [
    {
      "when": { "operator": "gte", "left": { "contextPath": "review_round" }, "right": 3 },
      "output": "exhausted"
    },
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "review_verdict" },
        "right": "blocked"
      },
      "output": "blocked"
    }
  ],
  "connections": {
    "success": "merge",
    "blocked": "fix-issues",
    "exhausted": "escalate",
    "error": "handle-error"
  }
}
```

`review_verdict` и `review_round` объявлены в `variableRegistry` workflow, поэтому обе читаются по
простому имени; локальный выход ноды читается как `review.findings`. Выражения выполняются после
валидации ответа и до case, поэтому case может прочитать вычисленное ими. Case перебираются по
порядку, а `success` — запасной выход: успешный вердикт в пределах бюджета кругов уходит в `merge`.
`error` и `timeout` зарезервированы под управление потоком: их не может назвать ни один case, и case
им не нужен.

### Сбор структурированных данных

```json
{
  "inputSchema": {
    "properties": {
      "test_results": {
        "type": "object",
        "properties": {
          "total": { "type": "number" },
          "passed": { "type": "number" },
          "failed": { "type": "number" }
        },
        "required": ["total", "passed", "failed"]
      }
    },
    "required": ["test_results"]
  }
}
```

## Правила — это исходы, и у каждого своя причина

Там, где директива формулирует правило — каким должен быть план, на чём ревью вправе блокировать,
что считается свидетельством, — называйте состояние, которому обязан удовлетворять результат, и
причину, по которой обратное плохо.

Исход можно применить к случаю, которого автор не предвидел; процедуру можно только повторить,
поэтому она верна ровно там, где совпала картина автора, и молча неверна во всех остальных местах.
Причина — это то, что позволяет исполнителю применить правило к непредвиденному случаю, а не
угадывать, и то, что позволяет рецензенту спорить с правилом по существу, а не по признаку
соблюдения.

Если свод правил достаточно длинный, чтобы его начали обходить пункт за пунктом, откройте его
оговоркой: правило, неприменимое к текущему изменению, считается соблюдённым, и доказывать
неприменимость ничем не нужно. Иначе свод снова превращается в чеклист.

❌ Процедура:

```
"ШАГ 1: прочитай план. ШАГ 2: проверь, что у каждого пункта есть проверка. ШАГ 3: сообщи количество."
```

✅ Исход с причиной:

```
"Каждый пункт называет свидетельство, по которому его примут, в наблюдаемых терминах.\n\nПочему: критерии приёмки, написанные прилагательными — надёжно, чисто, полно, — нельзя ни выполнить, ни отвергнуть, и в итоге их решает тот, кто настойчивее."
```

:::caution
Повышение голоса этого не заменяет: MANDATORY, NEVER и CRITICAL не добавляют состояния мира, в
котором правило выполнено или нарушено. См. [Директива как строевая
команда](/ru/docs/patterns/anti-patterns/).
:::

## Паттерны директив

### Работа с порядком

Задавайте порядок только там, где он — настоящая зависимость, и говорите, что делает его таковой:

```
"Перенеси схему до переключения читателя: читатель отвергает строки, которые старая схема ещё производит.\n\nПосле каждого из двух шагов сообщи состояние и команду, которой его получил."
```

### Условные инструкции

```
"{{#if has_tests}}Run test suite: {{test_command}}{{else}}No tests configured, skip testing{{/if}}"
```

### Требования к верификации

```
"Verify implementation:\n\n- [ ] Feature works as specified\n- [ ] Edge cases handled\n- [ ] Error messages clear\n\nProvide evidence for each checkbox."
```

## Типичные ошибки

### Слишком много свободы

❌ Проблема:

```
"Make the code better"
```

✅ Решение:

```
"Refactor auth module:\n- Extract validation logic to separate function\n- Add error handling for null inputs\n- Add JSDoc comments"
```

### Отсутствие контекста

❌ Проблема:

```
"Fix the error"
```

✅ Решение:

```
"Fix error in {{file_path}}:\n\nError message: {{last_error}}\nIteration: {{current_iteration}}"
```

### Избыточная маршрутизирующая обвязка

Нода `condition` или `expression`, единственная работа которой — маршрутизировать или считать то,
что предыдущая директива уже знает, — это избыточная маршрутизирующая обвязка: она добавляет
переход, который читателю приходится проследить, и второе место, где решение расходится со
свидетельством. Сложите её в директиву как `cases` или запись в `expressions` — и оставьте отдельную
ноду там, где решение действительно общее, читает состояние, которого не произвела ни одна отдельная
нода, или заслуживает именованного места в маршруте.

❌ Проблема:

```
[validate] → [route-validation] → [fix] / [next]
```

✅ Решение:

```
[validate, cases по issues_count] → [fix] / [next]
```

### Нет критериев успеха

❌ Проблема:

```
"completionCondition": "Done"
```

✅ Решение:

```
"completionCondition": "npm test passes with 0 failures, npm run build completes without errors"
```

:::tip
Прочитайте свои директивы с точки зрения агента. Будет ли понятно, что именно нужно сделать и
когда работа завершена?
:::

## Смотрите также

- [Input Schema](/ru/docs/reference/input-schema/) - Структурирование ожидаемых ответов
- [Шаблоны](/ru/docs/concepts/templates/) - Использование переменных в директивах
