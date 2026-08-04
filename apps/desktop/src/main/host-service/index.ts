/**
 * Workspace Service — Desktop Entry Point
 *
 * Starts the host-service HTTP server on a port assigned by the coordinator.
 * The coordinator polls health.check to know when it's ready.
 */

import { serve } from "@hono/node-server";
import {
	captureFatalStartupError,
	createApp,
	initSentry,
	installProcessSafetyNet,
	JwtApiAuthProvider,
	LocalGitCredentialProvider,
	LocalModelProvider,
	PskHostAuthProvider,
	startCompanionBridgeIfEnabled,
	startTerminalReaper,
} from "@superset/host-service";
import {
	initTerminalBaseEnv,
	resolveTerminalBaseEnv,
} from "@superset/host-service/terminal-env";
import { connectRelay } from "@superset/host-service/tunnel";
import { loadToken } from "lib/trpc/routers/auth/utils/auth-functions";
import { writeManifest } from "main/lib/host-service-manifest";
import { env } from "./env";

const SHUTDOWN_GRACE_MS = 3_000;
const WATCHDOG_INTERVAL_MS = 2_000;

type Server = ReturnType<typeof serve>;

async function main(): Promise<void> {
	initSentry({ organizationId: env.ORGANIZATION_ID });

	// Install the parent watchdog before any awaits so a crash during
	// startup can still reap this child. `serverRef` is filled in once
	// serve() returns; shutdown handles both pre- and post-bind states.
	const serverRef: { current: Server | null } = { current: null };
	let shuttingDown = false;
	const shutdown = (reason: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`[host-service] shutdown (${reason}), draining connections`);
		const server = serverRef.current;
		if (!server) {
			process.exit(0);
		}
		server.close();
		// SSE/WS streams (chat, watchers) ignore server.close() — give in-flight
		// HTTP a brief window, then forcibly tear sockets down.
		const forceExit = setTimeout(() => {
			const httpServer = server as unknown as {
				closeAllConnections?: () => void;
			};
			httpServer.closeAllConnections?.();
			process.exit(0);
		}, SHUTDOWN_GRACE_MS);
		forceExit.unref();
	};

	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));

	// Self-exit if our Electron parent dies without sending SIGTERM
	// (orphan reparenting to init/launchd). CLI-spawned host-services
	// don't set HOST_PARENT_PID and skip this.
	const parentPid = Number(process.env.HOST_PARENT_PID);
	if (Number.isInteger(parentPid) && parentPid > 1) {
		const interval = setInterval(() => {
			if (!isParentAlive(parentPid)) {
				clearInterval(interval);
				shutdown("parent-exit");
			}
		}, WATCHDOG_INTERVAL_MS);
		interval.unref();
	}

	const terminalBaseEnv = await resolveTerminalBaseEnv();
	initTerminalBaseEnv(terminalBaseEnv);

	const authProvider = new JwtApiAuthProvider({
		// Read fresh from disk every time we need to mint a new JWT, so that
		// re-logins in the desktop renderer (which rewrites auth-token.enc)
		// are picked up without restarting the host-service child. Falls back
		// to the boot-time token if the file is missing for any reason.
		getSessionToken: async () => {
			const { token } = await loadToken();
			return token ?? env.AUTH_TOKEN;
		},
		apiUrl: env.SUPERSET_API_URL,
	});

	const { app, injectWebSocket, api, db, terminalAgentStore } = createApp({
		config: {
			organizationId: env.ORGANIZATION_ID,
			dbPath: env.HOST_DB_PATH,
			cloudApiUrl: env.SUPERSET_API_URL,
			migrationsFolder: env.HOST_MIGRATIONS_FOLDER,
			allowedOrigins: [
				"superset-app://app",
				`http://localhost:${env.DESKTOP_VITE_PORT}`,
				`http://127.0.0.1:${env.DESKTOP_VITE_PORT}`,
			],
		},
		providers: {
			auth: authProvider,
			hostAuth: new PskHostAuthProvider(env.HOST_SERVICE_SECRET),
			credentials: new LocalGitCredentialProvider(),
			modelResolver: new LocalModelProvider(),
		},
	});

	const startedAt = Date.now();
	const server = serve(
		{ fetch: app.fetch, port: env.HOST_SERVICE_PORT, hostname: "127.0.0.1" },
		(info: { port: number }) => {
			// Install only after the server is listening so startup throws still
			// reach `main().catch(...)` and exit with a non-zero code.
			installProcessSafetyNet();

			// Orphan reaping + port detection for terminals no renderer has attached.
			startTerminalReaper(db);

			// (COMPANION-BRIDGE) (COMPANION-BRIDGE-MOUNT) fork-only: phone/watch
			// companion. Does nothing unless SUPERSET_COMPANION_BRIDGE=1. THIS is
			// the mount production actually runs: the desktop child executes this
			// entry, not packages/host-service/src/serve.ts, and the bridge
			// shipped once with the mount only there — every installed child
			// reported enabled-but-never-started while every gate stayed green.
			// Both entries now mount, and FEATURES.md pins this token in both
			// files, so a merge dropping either file's token fails the marker
			// gate. The gate greps the TOKEN, which lives in this comment — a
			// merge that deletes the call while keeping the comment still
			// passes it; the nightly semantic review is the backstop for that.
			// KNOWN, ACCEPTED: with the bridge enabled, an orderly SIGTERM has
			// two exit owners — this entry's shutdown() (3 s drain grace) and
			// the bridge's own once-handler, which exits as soon as its stop
			// settles and can cut that drain short. The loser is in-flight HTTP
			// to a renderer that is itself dying, and the Windows coordinator
			// hard-kills the child anyway; the bridge's teardown is settled and
			// logged either way.
			// Async and it never rejects; deliberately not awaited so a bridge
			// fault can never delay the manifest write or relay connect below.
			// The handle is not lost: it publishes itself to companion/registry,
			// which the companion tRPC router reads back.
			void startCompanionBridgeIfEnabled({
				hostDbPath: env.HOST_DB_PATH,
				db,
				terminalAgentStore,
			});

			if (env.ORGANIZATION_ID) {
				try {
					writeManifest({
						pid: process.pid,
						endpoint: `http://127.0.0.1:${info.port}`,
						authToken: env.HOST_SERVICE_SECRET,
						startedAt,
						organizationId: env.ORGANIZATION_ID,
					});
				} catch (error) {
					console.error("[host-service] Failed to write manifest:", error);
				}
			}

			if (env.RELAY_URL && env.ORGANIZATION_ID) {
				void connectRelay({
					api,
					relayUrl: env.RELAY_URL,
					localPort: info.port,
					organizationId: env.ORGANIZATION_ID,
					authProvider,
					hostServiceSecret: env.HOST_SERVICE_SECRET,
				});
			}
		},
	);
	serverRef.current = server;
	injectWebSocket(server);
}

function isParentAlive(parentPid: number): boolean {
	try {
		process.kill(parentPid, 0);
		return process.ppid === parentPid;
	} catch {
		return false;
	}
}

void main().catch(async (error) => {
	console.error("[host-service] Failed to start:", error);
	await captureFatalStartupError(error);
	process.exit(1);
});
