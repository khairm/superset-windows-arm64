ALTER TABLE `host_settings` ADD `claude_accounts_managed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `host_settings` ADD `claude_accounts_db_instance_id` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `claude_account_slug` text;
