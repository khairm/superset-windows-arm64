// (WS-NATIVE-OFF) Must be first — see the module comment.
import "./ws-native-off";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { startCompanionBridgeIfEnabled } from "./companion";
import { getSupervisor, startDaemonBootstrap } from "./daemon";
import { env } from "./env";
import { SeveredApiAuthProvider } from "./providers/auth";
import { LocalGitCredentialProvider } from "./providers/git";
import { PskHostAuthProvider } from "./providers/host-auth";
import { LocalModelProvider } from "./providers/model-providers";
import { installProcessSafetyNet, installUpgradeSocketGuard } from "./safety";
import { captureFatalStartupError, initSentry } from "./sentry";
import { startTerminalBaseEnvResolution } from "./terminal/env";
import { startTerminalReaper } from "./terminal/reaper";

async function main(): Promise<void> {
	initSentry({ organizationId: env.ORGANIZATION_ID });
	console.log(
		`[host-service] starting (org=${env.ORGANIZATION_ID}, port=${env.PORT}, NODE_ENV=${process.env.NODE_ENV ?? "unset"})`,
	);

	// Resolve the shell-env snapshot in the background — it must not block the
	// server from listening (the login-shell probe can burn the full 8s
	// budget). PTY creation awaits waitForTerminalBaseEnv() before it reads the
	// snapshot; every other request path is unaffected.
	startTerminalBaseEnvResolution();

	// Fire-and-track: kick off pty-daemon spawn-or-adopt without blocking
	// host-service startup. Terminal request handlers `await
	// waitForDaemonReady(orgId)` before using the supervisor's socket path,
	// so an in-flight bootstrap doesn't race with the first terminal launch.
	// Non-terminal requests (workspaces, git, chat) are unaffected if the
	// daemon takes time to come up or fails entirely.
	startDaemonBootstrap(env.ORGANIZATION_ID);

	// (CLOUD-SEVERANCE-P2) No JWT exchange, no config-file token source — both
	// were network calls to api.superset.sh, and nothing consumes their headers
	// any more.
	const authProvider = new SeveredApiAuthProvider();

	const { app, injectWebSocket, api, db, terminalAgentStore, eventBus } =
		createApp({
			config: {
				organizationId: env.ORGANIZATION_ID,
				dbPath: env.HOST_DB_PATH,
				cloudApiUrl: env.SUPERSET_API_URL,
				migrationsFolder: env.HOST_MIGRATIONS_FOLDER,
				allowedOrigins: env.CORS_ORIGINS ?? [],
			},
			providers: {
				auth: authProvider,
				hostAuth: new PskHostAuthProvider(env.HOST_SERVICE_SECRET),
				credentials: new LocalGitCredentialProvider(),
				modelResolver: new LocalModelProvider(),
			},
		});

	// Dev-mode shutdown: kill the daemon on host-service exit so dev
	// iteration on daemon code resets cleanly. Production keeps the
	// daemon detached so PTYs survive host-service restarts.
	// Per the migration plan's D5 decision.
	const isDev = process.env.NODE_ENV === "development";
	if (isDev) {
		let shuttingDown = false;
		const devShutdown = async (signal: NodeJS.Signals) => {
			if (shuttingDown) return;
			shuttingDown = true;
			console.log(
				`[host-service] dev-mode ${signal} — stopping pty-daemon for clean iteration`,
			);
			try {
				await getSupervisor().stop(env.ORGANIZATION_ID);
			} catch (err) {
				console.error(
					"[host-service] dev shutdown: supervisor.stop failed:",
					err,
				);
			} finally {
				process.exit(0);
			}
		};
		process.on("SIGINT", () => void devShutdown("SIGINT"));
		process.on("SIGTERM", () => void devShutdown("SIGTERM"));
	}

	const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
		// Install only after the server is listening so startup throws still
		// reach `main().catch(...)` and exit with a non-zero code.
		installProcessSafetyNet();
		console.log(`[host-service] listening on http://localhost:${info.port}`);

		startTerminalReaper(db, eventBus);

		// (COMPANION-BRIDGE) (COMPANION-BRIDGE-MOUNT) fork-only: phone/watch
		// companion. Does nothing unless SUPERSET_COMPANION_BRIDGE=1. Mounted here,
		// after the server is listening, so a slow fs can never delay host-service
		// startup. `startCompanionBridgeIfEnabled` is async and never rejects — a
		// bridge fault must not abort the rest of this callback (connectRelay
		// below), so it is deliberately not awaited and needs no catch here.
		// (COMPANION-BRIDGE-MOUNT) is pinned HERE and in the desktop entry
		// (apps/desktop/src/main/host-service/index.ts) — production desktop
		// children run THAT entry, not this file; this mount serves the
		// standalone/CLI host-service. (COMPANION-BRIDGE) alone is satisfied by
		// the fork-only companion/ directory, so without a per-entry token an
		// upstream merge could delete a mount and every gate would still pass
		// with the bridge silently never starting — which is exactly how the
		// bridge first shipped: mounted only here, never started in production.
		//
		// THE HANDLE IS NOT LOST. This callback is synchronous, so there is nothing
		// here that could hold the returned bridge; it publishes itself to
		// `companion/registry` once started, and the `companion` tRPC router is what
		// reads it back. Do not "fix" this into a variable — an unread local would
		// leave pairing and the desktop panic switch exactly as unreachable as
		// discarding it did.
		void startCompanionBridgeIfEnabled({
			hostDbPath: env.HOST_DB_PATH,
			db,
			organizationId: env.ORGANIZATION_ID,
			terminalAgentStore,
		});

		// (CLOUD-SEVERANCE-P2) No relay dial. The refusal for a RELAY_URL that
		// arrives anyway lives in the env schema, which is parsed at import —
		// early enough to actually stop this process, unlike a throw in here.
	});
	installUpgradeSocketGuard(server);
	injectWebSocket(server);
}

void main().catch(async (error) => {
	console.error("[host-service] Failed to start:", error);
	await captureFatalStartupError(error);
	process.exit(1);
});
