import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
	server: {
		AUTH_TOKEN: z.string().min(1),
		SUPERSET_API_URL: z.string().url(),
		HOST_DB_PATH: z.string().min(1),
		HOST_MIGRATIONS_FOLDER: z.string().min(1),
		HOST_SERVICE_SECRET: z.string().min(1),
		HOST_SERVICE_PORT: z.coerce.number().int().positive(),
		ORGANIZATION_ID: z.string().min(1),
		DESKTOP_VITE_PORT: z.coerce.number().int().positive(),
		/**
		 * (CLOUD-SEVERANCE-P2) Refused at parse time — see the twin in
		 * packages/host-service/src/env.ts. Parsing happens at import, before
		 * the process safety net starts swallowing throws, so this exits
		 * non-zero rather than logging and carrying on.
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
