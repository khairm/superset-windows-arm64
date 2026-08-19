import { randomBytes } from "node:crypto";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
	server: {
		HOST_SERVICE_SECRET: z
			.string()
			.min(1)
			.default(randomBytes(32).toString("hex")),
		ORGANIZATION_ID: z.string().uuid(),
		HOST_DB_PATH: z.string().min(1),
		HOST_MIGRATIONS_FOLDER: z.string().min(1),
		AUTH_TOKEN: z.string().min(1),
		SUPERSET_AUTH_CONFIG_PATH: z.string().min(1).optional(),
		SUPERSET_API_URL: z.string().url(),
		CORS_ORIGINS: z
			.string()
			.transform((s) => s.split(",").map((o) => o.trim()))
			.optional(),
		PORT: z.coerce.number().int().positive().default(4879),
		/**
		 * (CLOUD-SEVERANCE-P2) A set RELAY_URL is a hard startup failure.
		 *
		 * The check lives in the env schema, not in the listen callback, and
		 * the difference is the whole point: env parsing runs at import, long
		 * before `installProcessSafetyNet()` registers the uncaughtException
		 * handler that keeps this service alive through anything thrown later.
		 * A refusal raised after that handler is installed is a log line
		 * wearing a throw's clothes — the service stays up and the manifest
		 * has already been written, so the app believes it is healthy.
		 */
		RELAY_URL: z
			.string()
			.url()
			.optional()
			.refine((value) => value === undefined, {
				message:
					"RELAY_URL is set but this fork has no relay (see FEATURES.md, (CLOUD-SEVERANCE-P2)). Unset it.",
			}),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
});
