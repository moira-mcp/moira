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
    url: "{MCP_URL}"
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
