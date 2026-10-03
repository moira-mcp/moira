-- Preserve an operator's choice while enabling registration notifications on installation.
INSERT OR IGNORE INTO globalSetting (key, value, type, label, description, category, sortOrder, updatedAt)
VALUES ('system.notify_admins_on_registration', 'true', 'boolean', 'Notify administrators of registrations', 'Send new account notifications to admitted administrators through their configured Telegram channel.', 'system', 1, unixepoch() * 1000);
