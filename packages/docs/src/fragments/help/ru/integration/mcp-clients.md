Moira работает с любым клиентом, поддерживающим Model Context Protocol (MCP). Это руководство описывает настройку распространённых MCP-клиентов.

## Обзор протокола MCP

Moira предоставляет инструменты через MCP Streamable HTTP:

- **Endpoint**: `{MCP_URL}`
- **Транспорт**: Streamable HTTP; успешные ответы могут передаваться потоком SSE
- **Аутентификация**: OAuth 2.1 или API-токен

## Конфигурация клиентов

### Claude Code

**Рекомендуется: используйте CLI-команду**

**Terminal**

```bash
claude mcp add --transport http moira {MCP_URL}
```

Затем авторизуйтесь:

**OAuth Flow**

```bash
# После добавления авторизуйтесь в claude:
/mcp
# → Выберите "moira"
# → Нажмите "Authenticate"
# → Откроется браузер для OAuth
```

#### Альтернатива: ручная настройка JSON

```json
# Альтернатива: ручная настройка JSON
# ~/.config/claude/mcp.json
{
  "mcpServers": {
    "moira": {
      "type": "http",
      "url": "{MCP_URL}"
    }
  }
}

# Затем: /mcp → Authenticate
```

#### Аутентификация без OAuth

Для CI/CD, Docker или окружений без браузера — используйте API токен вместо OAuth.

1. Войдите в веб-интерфейс Moira → Настройки → API Токены
2. Создайте токен (начинается с moira_)
3. Замените moira_YOUR_TOKEN ниже на ваш токен

**~/.config/claude/mcp.json**

```json
{
  "mcpServers": {
    "moira": {
      "url": "{MCP_URL}",
      "headers": {
        "Authorization": "Bearer moira_YOUR_TOKEN"
      }
    }
  }
}
```

### Copilot CLI

**Рекомендуется: файл конфигурации**

**~/.copilot/mcp-config.json**

```json
# ~/.copilot/mcp-config.json
{
  "mcpServers": {
    "moira": {
      "type": "http",
      "url": "{MCP_URL}"
    }
  }
}
```

Затем авторизуйтесь:

**OAuth Flow**

```text
# После сохранения конфигурации:
# 1. Запустите сессию Copilot CLI
# 2. Введите /mcp
# 3. Выберите "moira" → Authenticate
# → Откроется браузер для OAuth
```

#### Альтернатива: интерактивная настройка

```text
# В Copilot CLI:
/mcp
# → Нажмите "Add server"
# → Введите URL сервера
# → Завершите OAuth

# Конфигурация на уровне проекта:
# .copilot/mcp-config.json (тот же формат)
```

#### Аутентификация без OAuth

Для CI/CD, Docker или окружений без браузера — используйте API токен вместо OAuth.

1. Войдите в веб-интерфейс Moira → Настройки → API Токены
2. Создайте токен (начинается с moira_)
3. Замените moira_YOUR_TOKEN ниже на ваш токен

**~/.copilot/mcp-config.json**

```json
{
  "mcpServers": {
    "moira": {
      "type": "http",
      "url": "{MCP_URL}",
      "headers": {
        "Authorization": "Bearer moira_YOUR_TOKEN"
      }
    }
  }
}
```

### Cursor

**Рекомендуется: Установка в один клик**

[Добавить в Cursor]({{MCP_DEEPLINK:cursor}})

Затем авторизуйтесь:

**OAuth Flow**

```text
# После нажатия кнопки:
# 1. Cursor откроется с запросом на установку
# 2. Нажмите "Install", чтобы добавить moira MCP сервер
# 3. Settings → MCP Servers → Найдите "moira"
# 4. Нажмите "Authenticate" → Браузер откроется для OAuth
```

#### Альтернатива: Ручная настройка JSON

**~/.cursor/mcp.json**

```json
# ~/.cursor/mcp.json
{
  "mcpServers": {
    "moira": {
      "url": "{MCP_URL}"
    }
  }
}
```

#### Аутентификация без OAuth

Для CI/CD, Docker или окружений без браузера — используйте API токен вместо OAuth.

1. Войдите в веб-интерфейс Moira → Настройки → API Токены
2. Создайте токен (начинается с moira_)
3. Замените moira_YOUR_TOKEN ниже на ваш токен

**~/.cursor/mcp.json**

```json
{
  "mcpServers": {
    "moira": {
      "url": "{MCP_URL}",
      "headers": {
        "Authorization": "Bearer moira_YOUR_TOKEN"
      }
    }
  }
}
```

### Claude Desktop

Десктоп-приложение: GUI-метод

**Settings → Connectors**

```text
# В приложении Claude Desktop:

# 1. Откройте Settings (⌘+,)
# 2. Перейдите на вкладку "Connectors"
# 3. Нажмите "Add custom connector"
# 4. Введите:
#    Server URL: {MCP_URL}
# 5. Нажмите "Connect"
# 6. Откроется браузер → OAuth → Готово

# Редактировать файлы не нужно
```

### VS Code

**Рекомендуется: Установка в один клик**

[Добавить в VS Code]({{MCP_DEEPLINK:vscode}})

Затем авторизуйтесь:

**OAuth Flow**

```text
# После нажатия кнопки:
# 1. VS Code откроется с запросом на установку
# 2. Нажмите "Install", чтобы добавить moira MCP сервер
# 3. Settings → MCP Servers → Найдите "moira"
# 4. Нажмите "Authenticate" → Браузер откроется для OAuth
```

#### Альтернатива: Ручная настройка

**settings.json**

```json
# Установите расширение MCP:
# ext install mcp-connector

# Затем в settings.json:
{
  "mcp.servers": {
    "moira": {
      "url": "{MCP_URL}",
      "transport": "http"
    }
  }
}

# Или: Command Palette → "MCP: Add Server"
```

#### Аутентификация без OAuth

Для CI/CD, Docker или окружений без браузера — используйте API токен вместо OAuth.

1. Войдите в веб-интерфейс Moira → Настройки → API Токены
2. Создайте токен (начинается с moira_)
3. Замените moira_YOUR_TOKEN ниже на ваш токен

**settings.json**

```json
{
  "mcpServers": {
    "moira": {
      "url": "{MCP_URL}",
      "headers": {
        "Authorization": "Bearer moira_YOUR_TOKEN"
      }
    }
  }
}
```

### Claude Web

claude.ai - Веб-чат (самый популярный)

**Settings → Connectors**

```text
# На claude.ai (Pro/Max/Team/Enterprise):

# 1. Откройте Settings → Connectors
# 2. Нажмите "Add custom connector"
# 3. Введите:
#    Server URL: {MCP_URL}
# 4. Нажмите "Connect"
# 5. Завершите OAuth-аутентификацию в браузере
# 6. Инструменты появятся в чате

# Требуется платный тариф
```

### ChatGPT

chat.openai.com - Веб-чат

**Settings → Connectors**

```text
# На chat.openai.com (Plus/Pro):

# 1. Profile → Settings
# 2. Перейдите в "Connectors" или "Integrations"
# 3. Нажмите "Add connector"
# 4. Введите:
#    Name: MCP Moira
#    URL: {MCP_URL}
# 5. Завершите OAuth-аутентификацию
# 6. Инструменты доступны в чате

# Бесплатный тариф не поддерживает MCP
```

### Perplexity

Mac-приложение: с хелпером

**Settings → Connectors**

```text
# Perplexity Mac App:

# 1. Сначала установите PerplexityXPC хелпер:
#    Settings → Connectors → Install Helper
# 2. Нажмите "Add Connector"
# 3. Введите:
#    Server Name: moira
#    Command: npx
#    Args: -y mcp-remote {MCP_URL}
# 4. Завершите OAuth-аутентификацию
# 5. Попросите Perplexity использовать инструменты MCP Moira

# Рекомендуется платный тариф
```

### Continue

Расширение VS Code: Open-source AI-ассистент

**config.yaml**

```yaml
# Расширение Continue в VS Code:

# 1. Установите расширение Continue
# 2. Откройте конфигурацию: Ctrl+Shift+P → "Continue: Open config"
# 3. Добавьте в config.yaml:
#
# mcp:
#   servers:
#     moira:
#       url: {MCP_URL}
#       transport: http
#
# 4. Перезапустите VS Code
# 5. Авторизуйтесь по запросу
```

#### Аутентификация без OAuth

Для CI/CD, Docker или окружений без браузера — используйте API токен вместо OAuth.

1. Войдите в веб-интерфейс Moira → Настройки → API Токены
2. Создайте токен (начинается с moira_)
3. Замените moira_YOUR_TOKEN ниже на ваш токен

**config.yaml**

```yaml
mcpServers:
  - name: moira
    url: {MCP_URL}
    headers:
      Authorization: "Bearer moira_YOUR_TOKEN"
```

### Zed

Быстрый редактор кода с AI

**~/.config/zed/settings.json**

```json
# Zed editor:

# 1. Откройте Настройки (⌘+,)
# 2. Добавьте в settings.json в context_servers:
#
# "context_servers": {
#   "moira": {
#     "url": "{MCP_URL}"
#   }
# }
#
# 3. Перезапустите Zed
# 4. Авторизуйтесь
```

#### Аутентификация без OAuth

Для CI/CD, Docker или окружений без браузера — используйте API токен вместо OAuth.

1. Войдите в веб-интерфейс Moira → Настройки → API Токены
2. Создайте токен (начинается с moira_)
3. Замените moira_YOUR_TOKEN ниже на ваш токен

**~/.config/zed/settings.json**

```json
{
  "context_servers": {
    "moira": {
      "url": "{MCP_URL}",
      "headers": {
        "Authorization": "Bearer moira_YOUR_TOKEN"
      }
    }
  }
}
```

### Gemini CLI

Google AI терминальный ассистент

**~/.gemini/settings.json**

```json
# Gemini CLI:

# 1. Отредактируйте ~/.gemini/settings.json:
#
# "mcpServers": {
#   "moira": {
#     "httpUrl": "{MCP_URL}"
#   }
# }
#
# 2. Выполните: gemini auth
# 3. Завершите OAuth авторизацию
```

#### Аутентификация без OAuth

Для CI/CD, Docker или окружений без браузера — используйте API токен вместо OAuth.

1. Войдите в веб-интерфейс Moira → Настройки → API Токены
2. Создайте токен (начинается с moira_)
3. Замените moira_YOUR_TOKEN ниже на ваш токен

**~/.gemini/settings.json**

```json
{
  "mcpServers": {
    "moira": {
      "httpUrl": "{MCP_URL}",
      "headers": {
        "Authorization": "Bearer moira_YOUR_TOKEN"
      }
    }
  }
}
```

### Собственный клиент

Для собственных MCP-клиентов используйте MCP SDK с URL: `{MCP_URL}`

## Доступные инструменты

Основной цикл выглядит как `list` → `start` → повторные вызовы `step`; `session` используется для
просмотра и возобновления выполнений, а `help` — для runtime-документации.
[Сгенерированный справочник MCP-инструментов](/ru/docs/reference/tools/) является источником полного
актуального каталога, точных входных схем, действий и примеров.

## Аутентификация

Moira поддерживает два метода аутентификации:

### OAuth 2.1 (по умолчанию)

  1. Клиент инициирует подключение к MCP endpoint 2. Сервер возвращает ответ о необходимости
  аутентификации 3. Клиент открывает браузер для OAuth-потока 4. Пользователь аутентифицируется в
  Moira 5. Клиент получает токен доступа 6. Последующие запросы включают токен

:::note
Обновление OAuth-токена обрабатывается автоматически. Обновление каталога — отдельная
MCP-инициализация, описанная ниже. При истечении учётных данных может потребоваться повторная
аутентификация.
:::

### API-токены

Для MCP-клиентов, которые не поддерживают OAuth (пользовательские скрипты, CI/CD пайплайны, headless-окружения), используйте API-токены:

  1. Войдите в веб-интерфейс Moira 2. Перейдите в **Settings → API Tokens** 3. Нажмите **Create
  Token**, введите имя и срок действия 4. Скопируйте токен (показывается один раз, начинается с
  `moira_`) 5. Настройте клиент с токеном в качестве Bearer-авторизации

Пример конфигурации для пользовательского MCP-клиента:

```json
{
  "mcpServers": {
    "moira": {
      "url": "YOUR_MCP_ENDPOINT",
      "headers": {
        "Authorization": "Bearer moira_your_token_here"
      }
    }
  }
}
```

:::tip
Замените `YOUR_MCP_ENDPOINT` на ваш MCP endpoint Moira: `{MCP_URL}`. API-токены
полностью обходят OAuth-поток — используйте их, когда клиент не может открыть браузер для
аутентификации.
:::

## Обновление статического каталога

Описания и схемы инструментов входят в статический каталог, поставляемый с сервером Moira. Клиент
принимает этот каталог во время MCP-handshake `initialize`. Это правило одинаково для OAuth-токенов
доступа и API-токенов.

После изменения каталога обычный запрос с учётными данными, которые ещё не инициализировали текущий
каталог, получает HTTP 426 с `upgrade_required`. Переподключите или повторно инициализируйте MCP-сервер
с теми же учётными данными. Успешный `initialize` обновляет каталог для этих учётных данных; создавать
новый API-токен или заменять существующий не требуется.

:::note
Проверки аутентификации и состояния учётной записи выполняются до обновления каталога. Отозванные
или истёкшие учётные данные и учётная запись без доступа к MCP по-прежнему получают обычную ошибку
аутентификации или доступа.
:::

## Примеры вызова инструментов

### Список воркфлоу

```json
{
  "method": "tools/call",
  "params": {
    "name": "list",
    "arguments": {}
  }
}
```

### Запуск воркфлоу

```json
{
  "method": "tools/call",
  "params": {
    "name": "start",
    "arguments": {
      "workflowId": "moira/software-development-flow",
      "parentExecutionId": "none"
    }
  }
}
```

### Выполнение шага

```json
{
  "method": "tools/call",
  "params": {
    "name": "step",
    "arguments": {
      "processId": "abc-123",
      "input": {
        "result": "Задача выполнена успешно",
        "details": { "files": ["main.ts", "utils.ts"] }
      }
    }
  }
}
```

## Обработка ошибок

Типичные ответы об ошибках:

| Ошибка             | Причина                               | Решение                                     |
| ------------------ | ------------------------------------- | ------------------------------------------- |
| `UNAUTHORIZED`     | Недействительный/истекший токен       | Повторная аутентификация                    |
| `NOT_FOUND`        | Недействительный ID воркфлоу/процесса | Проверьте ID                                |
| `FORBIDDEN`        | Нет доступа к ресурсу                 | Проверьте права                             |
| `upgrade_required` | Требуется обновить каталог MCP        | Переподключитесь с теми же учётными данными |
| `VALIDATION_ERROR` | Недействительный ввод                 | Проверьте input schema                      |

## Настройка self-hosted

Для self-hosted Moira:

1. Разверните сервер Moira
2. Настройте URL MCP endpoint
3. Настройте аутентификацию и доступ учётной записи
4. Обновите конфигурацию клиента с вашим endpoint

```json
{
  "mcpServers": {
    "moira": {
      "url": "https://your-server.com/mcp"
    }
  }
}
```

## Устранение неполадок

### Таймаут подключения

- Проверьте сетевое подключение
- Проверьте URL endpoint
- Убедитесь, что SSE не блокируется файрволом

### Инструменты не появляются

- Переподключите MCP-сервер Moira, чтобы клиент снова выполнил `initialize`
- Сохраните текущий OAuth- или API-токен, если он не отозван и не истёк
- Проверьте синтаксис JSON в конфигурации
- Проверьте логи клиента на наличие ошибок

### Цикл аутентификации

- Очистите сохраненные токены
- Проверьте конфигурацию OAuth
- Проверьте redirect URI

## Связанное

- [Claude Code](/ru/docs/integration/claude-code/) — Специфичная настройка Claude Code
- [Быстрый старт](/ru/docs/getting-started/quickstart/) — Общее начало работы
