CREATE TABLE `companion_replay_nonces` (
	`key` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`nonce` text NOT NULL,
	`seen_at_ms` integer NOT NULL,
	`ord` integer NOT NULL
);
