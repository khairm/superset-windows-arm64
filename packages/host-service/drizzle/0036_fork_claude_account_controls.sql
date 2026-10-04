ALTER TABLE `workspaces` ADD `claude_auto_switch` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `claude_schedule_fired_at` integer;--> statement-breakpoint
CREATE TABLE `claude_account_schedules` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`target_slug` text,
	`fire_at` integer NOT NULL,
	`status` text NOT NULL,
	`failed_at` integer,
	`failure` text,
	`last_error` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "claude_account_schedules_status_check" CHECK(`status` IN ('pending', 'failed')),
	CONSTRAINT "claude_account_schedules_failed_check" CHECK((`status` = 'failed') = (`failed_at` IS NOT NULL AND `failure` IS NOT NULL))
);
