CREATE TABLE `companion_lifecycle_reads` (
	`terminal_id` text PRIMARY KEY NOT NULL,
	`read_through_at` integer NOT NULL,
	FOREIGN KEY (`terminal_id`) REFERENCES `terminal_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
