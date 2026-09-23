-- `ui.theme` never controlled the theme: the web app keeps the theme in the browser (useTheme and
-- its storage key). The definition and any stored values are retired; the seed no longer adds it.
DELETE FROM `userSettingValue` WHERE `settingKey` = 'ui.theme';
--> statement-breakpoint
DELETE FROM `settingDefinition` WHERE `key` = 'ui.theme';
