CREATE TABLE `companion_push_fence` (
	`question_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`question_count` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`armed_at_ms` integer NOT NULL,
	`state` text NOT NULL,
	`sent_at_ms` integer
);
