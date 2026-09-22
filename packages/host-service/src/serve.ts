// (WS-NATIVE-OFF) Must be first — see the module comment.
import "./ws-native-off";
import { serve } from "@hono/node-server";
import { applyWindowsUserEnvToProcess } from "@superset/shared/windows-user-env";
import { createApp } from "./app";
import { startCompanionBridgeIfEnabled } from "./companion";
import { getSupervisor, startDaemonBootstrap } from "./daemon";
import { env } from "./env";
import { installConsoleTimestamps } from "./log-timestamps";
import { SeveredApiAuthProvider } from "./providers/auth";
import { LocalGitCredentialProvider } from "./providers/git";
import { PskHostAuthProvider } from "./providers/host-auth";
import { provisionAgentIntegrations } from "./runtime/agent-provisioning";
import { processStartedAt, recordBootStamp } from "./runtime/boot-stamps";
import { resolveBrowserBridgeFromEnv } from "./runtime/browser-bridge/env";
import { applyLoginShellEnvToProcess } from "./runtime/login-shell-env";
import { startSandboxCredentialRefresh } from "./runtime/sandbox-credential-refresh";
import { detachFromLaunchDirectory } from "./runtime/working-directory";
import { installProcessSafetyNet, installUpgradeSocketGuard } from "./safety";
import { configureSelfUpdater } from "./self-update";
import { captureFatalStartupError, initSentry } from "./sentry";
import { startTerminalBaseEnvResolution } from "./terminal/env";
import { startTerminalReaper } from "./terminal/reaper";
import { startStaleWorkingSweep } from "./terminal-agents/stale-working-sweep";

async function main(): Promise<void> {
	installConsoleTimestamps();

	// (WIN-USER-ENV) Awaited FIRST, before anything below reads an env-gated
	// flag — `startCompanionBridgeIfEnabled` most of all. Standalone/CLI entry:
	// nothing merged this env before us. Rationale and semantics:
	// packages/shared/src/windows-user-env.ts.
	await applyWindowsUserEnvToProcess();

	recordBootStamp("host.process.start", processStartedAt());
	initSentry({ organizationId: env.ORGANIZATION_ID });

	// Before anything spawns a worker thread or a child process: a host
	// started from a workspace outlives that directory (HOST-SERVICE-5D).
	detachFromLaunchDirectory();

	console.log(
		`[host-service] starting (org=${env.ORGANIZATION_ID}, port=${env.PORT}, NODE_ENV=${process.env.NODE_ENV ?? "unset"})`,
	);

	// Resolve the shell-env snapshot in the background — it must not block the
	// server from listening (the login-shell probe can burn the full 8s
	// budget). PTY creation awaits waitForTerminalBaseEnv() before it reads the
	// snapshot; every other request path is unaffected.
	startTerminalBaseEnvResolution();

	// Standalone entry only: the desktop already merges the login-shell PATH
	// into hosts it spawns. Fire-and-forget for the same reason as the base-env
	// resolution above; git/gh calls racing the probe just see the launcher env
	// once, same as before this merge existed.
	void applyLoginShellEnvToProcess();

	// Fire-and-track: kick off pty-daemon spawn-or-adopt without blocking
	// host-service startup. Terminal request handlers `await
	// waitForDaemonReady(orgId)` before using the supervisor's socket path,
	// so an in-flight bootstrap doesn't race with the first terminal launch.
	// Non-terminal requests (workspaces, git, chat) are unaffected if the
	// daemon takes time to come up or fails entirely.
	startDaemonBootstrap(env.ORGANIZATION_ID);

	// Standalone entry only: the desktop provisions these itself for hosts it
	// spawns (with its per-agent disable settings); this covers CLI/systemd
	// launches, which previously had no notify hooks or shell wrappers (#6254).
	provisionAgentIntegrations();

	// (CLOUD-SEVERANCE-P2) No JWT exchange, no config-file token source — both
	// were network calls to api.superset.sh, and nothing consumes their headers
	// any more.
	const authProvider = new SeveredApiAuthProvider();

	const {
		app,
		injectWebSocket,
		db,
		launchSandboxAgent,
		resumeCrashedAgents,
		claudeAccounts,
		terminalAgentStore,
		eventBus,
	} = createApp({
		config: {
			organizationId: env.ORGANIZATION_ID,
			dbPath: env.HOST_DB_PATH,
			cloudApiUrl: env.SUPERSET_API_URL,
			migrationsFolder: env.HOST_MIGRATIONS_FOLDER,
			allowedOrigins:
				env.SUPERSET_HOST_RUN_MODE === "sandbox"
					? "*"
					: (env.CORS_ORIGINS ?? []),
			browserBridge: resolveBrowserBridgeFromEnv(env),
		},
		providers: {
			auth: authProvider,
			// (CLOUD-SEVERANCE-P2) Always the PSK. Upstream's sandbox branch
			// installs a provider that accepts everything, on the promise of
			// an edge that does not exist here; the env schema refuses that
			// mode outright, and this reads the secret rather than the flag
			// so no future flag can reach an unauthenticated provider.
			hostAuth: new PskHostAuthProvider(env.HOST_SERVICE_SECRET),
			credentials: new LocalGitCredentialProvider(),
		},
	});

	// Dev-mode shutdown: kill the daemon on host-service exit so dev
	// iteration on daemon code resets cleanly. Production keeps the
	// daemon detached so PTYs survive host-service restarts.
	// Per the migration plan's D5 decision.
	// (CLAUDE-ACCOUNTS-MOUNT) Both host-service entry points start the same
	// database-anchored account service before accepting terminal launches.
	await claudeAccounts.start();

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

	const hostname =
		env.SUPERSET_HOST_RUN_MODE === "sandbox" ? undefined : "127.0.0.1";
	const listen = { fetch: app.fetch, port: env.PORT, hostname };
	const server = serve(listen, (info) => {
		// Install only after the server is listening so startup throws still
		// reach `main().catch(...)` and exit with a non-zero code.
		installProcessSafetyNet();
		const address = info.address.includes(":")
			? `[${info.address}]`
			: info.address;
		console.log(`[host-service] listening on http://${address}:${info.port}`);
		recordBootStamp("host.listening");

		startTerminalReaper(db, eventBus);
		// A cloud workspace created with an agent starts it now: the pty daemon
		// and event bus are up, and a person opening the workspace sees the
		// agent's terminal the way they would on their own machine.
		void launchSandboxAgent();
		// A stop keeps the disk and drops every process, so nothing else on the
		// box will notice that its agents are gone.
		if (env.SUPERSET_HOST_RUN_MODE === "sandbox") void resumeCrashedAgents();
		const sandboxWorkspaceId = process.env.SUPERSET_SANDBOX_WORKSPACE_ID;
		if (env.SUPERSET_HOST_RUN_MODE === "sandbox" && sandboxWorkspaceId) {
			startSandboxCredentialRefresh({
				apiUrl: env.SUPERSET_API_URL,
				workspaceId: sandboxWorkspaceId,
				hostSecret: env.HOST_SERVICE_SECRET,
			});
		}

		// (STALE-WORKING-SWEEP) fork-only backstop: a terminal whose LAST hook
		// event resolved to a working hold and that then goes silent has no
		// event left to re-evaluate it — the dot pins yellow forever. Mounted
		// in BOTH entries (this file and the desktop child's
		// apps/desktop/src/main/host-service/index.ts), same lesson as
		// (COMPANION-BRIDGE-MOUNT).
		startStaleWorkingSweep(terminalAgentStore, eventBus);

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
			profileDirsForWorkspace: (workspaceId) =>
				claudeAccounts.configDirCandidatesFor(workspaceId),
			organizationId: env.ORGANIZATION_ID,
			terminalAgentStore,
		});

		// (CLOUD-SEVERANCE-P2) No relay dial, in either run mode. The refusal
		// for a RELAY_URL that arrives anyway lives in the env schema, parsed
		// at import — early enough to actually stop this process, unlike a
		// throw in here.
	});
	installUpgradeSocketGuard(server);
	injectWebSocket(server);

	// Standalone only: this process owns its listener and relay socket, so it
	// can hand the port to a successor build (system.update). The desktop
	// entry never registers this and its host-service stays non-updatable.
	configureSelfUpdater({
		stopServing: async () => {
			// (CLOUD-SEVERANCE-P2) Upstream cancels its relay registration here
			// first; this fork never dials one, so the listener is all there is
			// to hand over.
			const httpServer = server as unknown as {
				closeAllConnections?: () => void;
				close: (callback: () => void) => void;
			};
			httpServer.closeAllConnections?.();
			await Promise.race([
				new Promise<void>((resolve) => httpServer.close(() => resolve())),
				new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
			]);
		},
	});
}

void main().catch(async (error) => {
	console.error("[host-service] Failed to start:", error);
	await captureFatalStartupError(error);
	process.exit(1);
});
