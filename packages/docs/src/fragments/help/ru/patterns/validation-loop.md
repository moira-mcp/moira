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
  "directive": "Complete the task. Iteration: {{current_iteration}}",
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
  "condition": {
    "operator": "eq",
    "left": { "contextPath": "quality_check_passed" },
    "right": "yes"
  },
  "connections": {
    "true": "next-step",
    "false": "fix-issues"
  }
}
```

### Нода исправления

```json
{
  "type": "agent-directive",
  "id": "fix-issues",
  "directive": "Fix issues found in iteration {{current_iteration}}. Previous result: {{result}}",
  "connections": { "success": "increment-iteration" }
}
```

### Счётчик итераций

С использованием expression ноды:

```json
{
  "type": "expression",
  "id": "increment-iteration",
  "expressions": ["current_iteration = current_iteration + 1"],
  "connections": { "default": "do-work" }
}
```

:::caution
Всегда включайте счётчики итераций для предотвращения бесконечных циклов. Рекомендуется добавить
проверку максимального количества итераций.
:::

## С ограничением итераций

Добавьте проверку перед повторной попыткой:

```json
{
  "type": "condition",
  "id": "check-max-iterations",
  "condition": {
    "operator": "lt",
    "left": { "contextPath": "current_iteration" },
    "right": 5
  },
  "connections": {
    "true": "do-work",
    "false": "escalate-to-user"
  }
}
```

## Ограниченный цикл ре-валидации

Цикл ре-валидации или ре-ревью на каждом круге возвращается к ОДНОЙ И ТОЙ ЖЕ ноде проверки. Без подсказки в директиве входа в цикл агент может ошибочно воспринять повторное появление той же ноды как зацикливание и сообщить о цикле пользователю. Два требования предотвращают это.

### Счётчик — это expression нода

Счётчик кругов ДОЛЖЕН инкрементироваться expression нодой (автоматически потоком), объявленной в `variableRegistry` с числовым `default`. Счётчик, инкрементируемый агентом, — это антипаттерн: агента не просят выполнять арифметику, а отсутствующее или нечисловое значение ломает проверку предела.

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
  "directive": "Re-validation pass {{validation_round}} of {{max_validation_rounds}} — a normal quality loop, expected to converge. This is NOT a bug and NOT a stuck flow; do not report a loop to the user.\n\nRe-check the work against the criteria and report whether all issues are resolved.",
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
Текст подсказки точный. Ре-валидация через одну и ту же ноду ожидаема, а не баг — директива должна
это сообщать, иначе агент может остановиться и сообщить о ложном цикле.
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
  "condition": {
    "operator": "eq",
    "left": { "contextPath": "issues_count" },
    "right": 0
  }
}
```

Не маршрутизируйте по баллу качества. Число, которое рецензент присваивает связности, глубине или
архитектуре, не различает два состояния результата — семь против восьми не говорит читателю ничего
проверяемого, — а порог достигается подгонкой самого числа. Там, где свойство качественное, гейт —
это обоснованный вердикт рецензента и число находок, к которым он привёл. См. [Фиксированная оценка
семантического качества](/ru/docs/patterns/anti-patterns/).

## Реальный пример

Из `development-flow.json`:

```json
{
  "id": "verify-step-implementation",
  "directive": "Verify step {{current_step_name}} implementation:\n- Expected: {{expected_outcome}}\n- Check actual matches expected",
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
`approval` записывает собственный ответ пользователя. Всё, кроме безоговорочного «да», — это «нет»,
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
  "directive": "Представь план и спроси, утверждён ли он.\n\nПлан: {{plan_summary}}\n\n`approval` записывает собственный ответ пользователя: всё, кроме безоговорочного «да», — это «нет», с точными словами в `user_feedback`. «Нет» ведёт к ответственности, которой принадлежит ревизия, поэтому исправление, сделанное здесь, — изменение, которого никто не рецензировал.",
  "completionCondition": "User confirmed or rejected plan",
  "inputSchema": {
    "type": "object",
    "properties": {
      "plan_approved": { "type": "string", "enum": ["yes", "no"] },
      "user_feedback": { "type": "string" }
    },
    "required": ["plan_approved"]
  },
  "connections": { "success": "route-plan-approval" }
}
```

## Связанные паттерны

- [Верификация шагов](/ru/docs/patterns/step-verification/) - Проверка конкретных шагов
- [Эскалация](/ru/docs/patterns/escalation/) - Обработка повторяющихся сбоев
