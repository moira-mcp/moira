DELETE FROM `globalSetting`
WHERE `key` LIKE 'mcp.toolDescription.%'
   OR (`key` LIKE 'mcp.agent.%' AND `key` LIKE '%.toolDescription.%');
--> statement-breakpoint
ALTER TABLE `apiToken` ADD `toolsVersion` text;
