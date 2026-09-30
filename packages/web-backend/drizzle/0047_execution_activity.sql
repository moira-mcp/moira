ALTER TABLE `workflowExecution` ADD `lastActivityAt` integer;--> statement-breakpoint
ALTER TABLE `workflowExecution` ADD `refusalCount` integer NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE `workflowExecution` SET
  `lastActivityAt` = (
    SELECT MAX(`at`) FROM (
      SELECT json_extract(`visit`.`value`, '$.enteredAt') AS `at`
        FROM json_each(CASE WHEN json_valid(`workflowExecution`.`visits`) THEN `workflowExecution`.`visits` ELSE '[]' END) AS `visit`
      UNION ALL
      SELECT json_extract(`visit`.`value`, '$.leftAt')
        FROM json_each(CASE WHEN json_valid(`workflowExecution`.`visits`) THEN `workflowExecution`.`visits` ELSE '[]' END) AS `visit`
      UNION ALL
      SELECT `workflowExecution`.`completedAt`
    )
  ),
  `refusalCount` = (
    SELECT COUNT(*)
      FROM json_each(CASE WHEN json_valid(`workflowExecution`.`errors`) THEN `workflowExecution`.`errors` ELSE '[]' END) AS `entry`
      WHERE json_extract(`entry`.`value`, '$.errorType') IS NOT 'degradation'
  );--> statement-breakpoint
CREATE INDEX `workflow_execution_user_state_activity_idx` ON `workflowExecution` (`userId`,`state`,`lastActivityAt`);--> statement-breakpoint
CREATE INDEX `workflow_execution_parent_idx` ON `workflowExecution` (`parentExecutionId`);
