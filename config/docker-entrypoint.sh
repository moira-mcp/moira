#!/bin/sh
# Docker entrypoint script to load telegram config from .env files

echo "🚀 Starting MCP Moira with environment configuration..."

# Extract telegram config from .env files
/usr/local/bin/extract-env.sh

# Source telegram environment if available
if [ -f ".env" ]; then
    echo "📱 Loading telegram config from .env file..."
    # Extract TELEGRAM_BOT_TOKEN
    if grep -q "^TELEGRAM_BOT_TOKEN=" .env; then
        export TELEGRAM_BOT_TOKEN=$(grep "^TELEGRAM_BOT_TOKEN=" .env | cut -d '=' -f2-)
        echo "✅ TELEGRAM_BOT_TOKEN loaded from .env"
    fi

    # Extract TELEGRAM_DEFAULT_CHAT_ID
    if grep -q "^TELEGRAM_DEFAULT_CHAT_ID=" .env; then
        export TELEGRAM_DEFAULT_CHAT_ID=$(grep "^TELEGRAM_DEFAULT_CHAT_ID=" .env | cut -d '=' -f2-)
        echo "✅ TELEGRAM_DEFAULT_CHAT_ID loaded from .env"
    fi
fi

echo "🔧 Environment configured:"
echo "TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN:+[SET]} ${TELEGRAM_BOT_TOKEN:-[NOT SET]}"
echo "TELEGRAM_DEFAULT_CHAT_ID: ${TELEGRAM_DEFAULT_CHAT_ID:+[SET]} ${TELEGRAM_DEFAULT_CHAT_ID:-[NOT SET]}"

echo "🎯 Starting supervisor with services..."

# Start supervisor with loaded environment
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf