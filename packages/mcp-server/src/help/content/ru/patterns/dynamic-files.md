---
title: Паттерн динамических файлов
description: Шаблонные пути к файлам для переиспользования workflow
---

## Назначение

Использование шаблонных переменных для путей к файлам, чтобы сделать workflow переиспользуемыми в разных проектах. Пути собираются во время выполнения и используются на протяжении всего процесса.

## Структура

```
[collect-paths] → [use-paths-in-directives] → [output-to-path]
```

## Реализация

### Сбор путей

```json
{
  "type": "agent-directive",
  "id": "collect-project-paths",
  "directive": "Determine project structure:\n- Docs location?\n- Output location?\n- Test files location?",
  "completionCondition": "Relevant existing paths and authorized output location identified",
  "inputSchema": {
    "type": "object",
    "properties": {
      "docs_path": {
        "type": "string",
        "description": "Path to project documentation"
      },
      "output_path": {
        "type": "string",
        "description": "Path for workflow outputs"
      },
      "test_path": { "type": "string", "description": "Path to test files" }
    },
    "required": ["docs_path", "output_path"]
  },
  "connections": { "success": "read-documentation" }
}
```

### Использование путей в директивах

```json
{
  "type": "agent-directive",
  "id": "read-documentation",
  "directive": "Read project documentation from {{collect-project-paths.docs_path}}.\nAnalyze structure and content.",
  "completionCondition": "Relevant documentation read completely and analysis produced",
  "connections": { "success": "write-output" }
}
```

### Вывод по динамическому пути

```json
{
  "type": "agent-directive",
  "id": "write-output",
  "directive": "Write results to {{collect-project-paths.output_path}}/analysis-results.md",
  "completionCondition": "Result written to the authorized path and checked",
  "connections": { "success": "next-step" }
}
```

## Стратегии обнаружения путей

Агент может определять пути следующими способами:

1. **Поиск в файловой системе**: Искать типичные паттерны (`docs/`, `README.md`)
2. **Значения по умолчанию**: Использовать стандартные расположения как запасной вариант
3. **Запрос у пользователя**: Когда путь не удаётся определить

```json
{
  "directive": "Find project documentation:\n1. Search for docs/ directory\n2. Check for README.md\n3. Look in standard locations\n4. Ask user if not found"
}
```

## Условное использование путей

Комбинирование с условными шаблонами:

```json
{
  "directive": "{{#if get-initial-requirements.testing_guide_path}}Read testing guide from {{get-initial-requirements.testing_guide_path}}{{else}}Determine validation from the actual project configuration{{/if}}"
}
```

:::tip
Собирайте пути, нужные текущей ответственности. Проверяйте владельца, разрешённое расположение и фактическое наличие перед чтением или записью. Шаблон не проверяет доступ к файловой системе.
:::

## Реальный пример

Фрагмент конфигурации коллектора: в содержащем workflow добавьте directive, type, completionCondition и connections:

```json
{
  "id": "get-initial-requirements",
  "inputSchema": {
    "properties": {
      "checklist_path": {
        "type": "string",
        "description": "Path to project checklist or empty if none"
      },
      "agent_onboarding_path": {
        "type": "string",
        "description": "Path to agent onboarding document or empty if none"
      },
      "docs_standards_path": {
        "type": "string",
        "description": "Path to documentation standards or empty if none"
      },
      "testing_guide_path": {
        "type": "string",
        "description": "Path to testing guide or empty if none"
      }
    }
  }
}
```

Используется далее:

```json
{
  "directive": "{{#if get-initial-requirements.checklist_path}}Review project checklist: {{get-initial-requirements.checklist_path}}{{/if}}"
}
```

## Валидация путей

Pattern в inputSchema проверяет только формат строки. Пример допускает только ASCII и исключает пробелы; адаптируйте его под проект. Он не запрещает выход через `..` и не задаёт разрешённую границу файловой системы:

```json
{
  "properties": {
    "file_path": {
      "type": "string",
      "pattern": "^[a-zA-Z0-9/_.-]+$"
    }
  }
}
```

## Связанные паттерны

- [Сбор информации](/ru/docs/patterns/information-collection/) - Сбор путей как часть онбординга
- [Паттерн пропуска](/ru/docs/patterns/skip/) - Пропуск шагов при недоступности путей
