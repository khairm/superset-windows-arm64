CREATE TABLE `answer_attempts` (
	`request_id` text PRIMARY KEY NOT NULL,
	`question_id` text,
	`device_id` text,
	`surface` text,
	`lease_id` text,
	`started_at_ms` integer,
	`created_at_ms` integer NOT NULL,
	`status` text NOT NULL,
	`resolved_at_ms` integer,
	`failure_code` text,
	`guards_passed_json` text DEFAULT '[]' NOT NULL,
	`coverage_epoch` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `answer_attempts_created_at_ms_idx` ON `answer_attempts` (`created_at_ms`);--> statement-breakpoint
CREATE TABLE `answer_coverage_epoch` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`epoch` text NOT NULL,
	`rotated_at_ms` integer NOT NULL,
	`rotations` integer DEFAULT 0 NOT NULL,
	`last_rotate_reason` text
);
