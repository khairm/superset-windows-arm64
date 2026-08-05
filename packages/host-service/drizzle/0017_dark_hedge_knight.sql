CREATE TABLE `sidebar_mirror_meta` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`last_full_sync_at_ms` integer NOT NULL,
	`app_launch_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`workspace_count` integer NOT NULL,
	`project_count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sidebar_project_state` (
	`project_id` text PRIMARY KEY NOT NULL,
	`tab_order` integer DEFAULT 0 NOT NULL,
	`is_pinned` integer DEFAULT false NOT NULL,
	`is_collapsed` integer DEFAULT false NOT NULL,
	`synced_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sidebar_workspace_state` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`section_id` text,
	`tab_order` integer DEFAULT 0 NOT NULL,
	`is_hidden` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	`snooze_until` integer,
	`snooze_launch_id` text,
	`completed_at` integer,
	`deleted_at` integer,
	`pinned_at` integer,
	`synced_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sidebar_workspace_state_project_id_idx` ON `sidebar_workspace_state` (`project_id`);