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
		BROWSER_BRIDGE_URL: z.string().url().optional(),
		BROWSER_BRIDGE_SECRET: z.string().min(1).optional(),
		/**
		 * (CLOUD-SEVERANCE-P2) Refused for the same reason as its twin in
		 * packages/host-service/src/env.ts: "sandbox" disables host
		 * authentication for an edge this fork does not have. The coordinator
		 * already strips it from the child environment; this is the backstop
		 * for a child started any other way.
		 */
		SUPERSET_HOST_RUN_MODE: z
			.enum(["local", "sandbox"])
			.default("local")
			.refine((value) => value !== "sandbox", {
				message:
					"SUPERSET_HOST_RUN_MODE=sandbox disables host authentication and is refused by this fork (see FEATURES.md, (CLOUD-SEVERANCE-P2)).",
			}),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
});
