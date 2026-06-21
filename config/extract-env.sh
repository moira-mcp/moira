#!/bin/sh
# Extract environment variables from .env files for Docker

# Function to extract value from .env file
extract_env() {
    local file="$1"
    local key="$2"
    if [ -f "$file" ]; then
        grep "^${key}=" "$file" | cut -d '=' -f2- | sed 's/^["'\'']//' | sed 's/["'\'']$//'
    fi
}

# Try to get TELEGRAM_BOT_TOKEN from .env files
TELEGRAM_BOT_TOKEN=""
TELEGRAM_DEFAULT_CHAT_ID=""

# Check .env first
if [ -f ".env" ]; then
    TELEGRAM_BOT_TOKEN=$(extract_env ".env" "TELEGRAM_BOT_TOKEN")
    TELEGRAM_DEFAULT_CHAT_ID=$(extract_env ".env" "TELEGRAM_DEFAULT_CHAT_ID")
fi

# Fallback to config/.env.production
if [ -z "$TELEGRAM_BOT_TOKEN" ] && [ -f "config/.env.production" ]; then
    TELEGRAM_BOT_TOKEN=$(extract_env "config/.env.production" "TELEGRAM_BOT_TOKEN")
    TELEGRAM_DEFAULT_CHAT_ID=$(extract_env "config/.env.production" "TELEGRAM_DEFAULT_CHAT_ID")
fi

# Export for supervisor
export TELEGRAM_BOT_TOKEN
export TELEGRAM_DEFAULT_CHAT_ID

echo "Telegram config extracted:"
echo "TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN:+[SET]} ${TELEGRAM_BOT_TOKEN:-[NOT SET]}"
echo "TELEGRAM_DEFAULT_CHAT_ID: ${TELEGRAM_DEFAULT_CHAT_ID:+[SET]} ${TELEGRAM_DEFAULT_CHAT_ID:-[NOT SET]}"