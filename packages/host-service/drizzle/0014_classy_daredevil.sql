CREATE TABLE `companion_device_index` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`generation` text NOT NULL,
	`epoch` text NOT NULL,
	`seq` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `companion_devices` (
	`device_id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`surface` text NOT NULL,
	`paired_at_ms` integer NOT NULL,
	`last_seen_ms` integer,
	`key_ref` text NOT NULL,
	`fcm_token` text,
	`fcm_token_updated_ms` integer,
	`write_enabled` integer NOT NULL,
	`revoked_at_ms` integer,
	`revoke_reason` text
);
