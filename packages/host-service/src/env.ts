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
		// Loopback control surface for the desktop's in-app browser panes. Only
		// set when a desktop app spawned this host; absent on standalone hosts.
		BROWSER_BRIDGE_URL: z.string().url().optional(),
		BROWSER_BRIDGE_SECRET: z.string().min(1).optional(),
		/**
		 * (CLOUD-SEVERANCE-P2) "sandbox" is REFUSED, and this is a security
		 * refusal rather than a tidying one.
		 *
		 * Upstream's sandbox mode swaps the PSK host-auth provider for
		 * `EdgeGuardedHostAuthProvider`, whose `validate()` returns true for
		 * every request. That is sound where upstream runs it — a cloud
		 * sandbox sits behind a provider preview whose edge turns unauthorised
		 * callers away, and its own docblock is honest that "a sandbox whose
		 * preview is ever made public is open". This fork HAS no edge. Here the
		 * same flag would mean a host-service that accepts any request that
		 * reaches it, on a server bound to every interface, with terminal
		 * creation among the things it accepts.
		 *
		 * Nothing in this fork sets it. It is refused anyway because it can
		 * arrive from a shell profile or a copied systemd unit, and because the
		 * cost of being wrong is arbitrary command execution from the LAN.
		 */
		SUPERSET_HOST_RUN_MODE: z
			.enum(["local", "sandbox"])
			.default("local")
			.refine((value) => value !== "sandbox", {
				message:
					"SUPERSET_HOST_RUN_MODE=sandbox disables host authentication and is refused by this fork, which has no edge to authenticate for (see FEATURES.md, (CLOUD-SEVERANCE-P2)).",
			}),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
});
