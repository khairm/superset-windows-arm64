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
	installUpgradeSocketGuard,
	LocalGitCredentialProvider,
	PskHostAuthProvider,
	resolveBrowserBridgeFromEnv,
	SeveredApiAuthProvider,
	startCompanionBridgeIfEnabled,
	startStaleWorkingSweep,
	startTerminalReaper,
} from "@superset/host-service";
import {
	initTerminalBaseEnv,
	resolveTerminalBaseEnv,
} from "@superset/host-service/terminal-env";
import {
	applyWindowsUserEnvToProcess,
	WIN_USER_ENV_MERGED_BY_PARENT,
} from "@superset/shared/windows-user-env";
import {
	type HostServiceManifest,
	isProcessAlive,
	readManifest,
	shouldYieldManifest,
	writeManifest,
} from "main/lib/host-service-manifest";
import { pollHealthCheck } from "main/lib/host-service-utils";
import { env } from "./env";

const SHUTDOWN_GRACE_MS = 3_000;
const WATCHDOG_INTERVAL_MS = 2_000;
const MANIFEST_RECLAIM_INTERVAL_MS = 15_000;

type Server = ReturnType<typeof serve>;

async function main(): Promise<void> {
	// (WIN-USER-ENV) Awaited FIRST, before any env-gated flag is read — this is
	// the entry a desktop-spawned host-service runs, and `SUPERSET_COMPANION_BRIDGE`
	// never reaching `startCompanionBridgeIfEnabled` below is the incident.
	// Normally there is nothing to do: the Electron parent merged before
	// spawning us and we inherit the result via `...process.env`, which is what
	// the marker says. That does NOT make the parent's own call redundant — main
	// needs the merge in its own process for keep-awake's companion gate — and
	// this call is still the retry when the parent's merge failed, plus the
	// whole story for a CLI-spawned host. Rationale:
	// packages/shared/src/windows-user-env.ts.
	if (process.env[WIN_USER_ENV_MERGED_BY_PARENT] !== "1") {
		await applyWindowsUserEnvToProcess();
	}

	initSentry({ organizationId: env.ORGANIZATION_ID });

	// Install the parent watchdog before any awaits so a crash during
	// startup can still reap this child. `serverRef` is filled in once
	// serve() returns; shutdown handles both pre- and post-bind states.
	const serverRef: { current: Server | null } = { current: null };
	let shuttingDown = false;
	let manifestReclaimTimer: NodeJS.Timeout | null = null;
	const shutdown = (reason: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		// A reclaim tick during the drain window would resurrect the manifest
		// the coordinator just removed, leaving it naming a dead pid.
		if (manifestReclaimTimer) clearInterval(manifestReclaimTimer);
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

	// (CLOUD-SEVERANCE-P2) Upstream re-read auth-token.enc on every JWT mint so
	// a re-login in the renderer was picked up without a restart. There are no
	// logins and no JWTs; nothing consumes these headers.
	const authProvider = new SeveredApiAuthProvider();

	const {
		app,
		injectWebSocket,
		db,
		claudeAccounts,
		terminalAgentStore,
		eventBus,
	} = createApp({
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
			browserBridge: resolveBrowserBridgeFromEnv(env),
		},
		providers: {
			auth: authProvider,
			hostAuth: new PskHostAuthProvider(env.HOST_SERVICE_SECRET),
			credentials: new LocalGitCredentialProvider(),
		},
	});

	// (CLAUDE-ACCOUNTS-MOUNT) Production and standalone host-service entries
	// start the same database-anchored service before accepting terminal launches.
	await claudeAccounts.start();

	const startedAt = Date.now();
	const server = serve(
		{ fetch: app.fetch, port: env.HOST_SERVICE_PORT, hostname: "127.0.0.1" },
		(info: { port: number }) => {
			// Install only after the server is listening so startup throws still
			// reach `main().catch(...)` and exit with a non-zero code.
			installProcessSafetyNet();

			// Orphan reaping + port detection for terminals no renderer has attached.
			startTerminalReaper(db, eventBus);

			// (STALE-WORKING-SWEEP) fork-only backstop: a terminal whose LAST
			// hook event resolved to a working hold and that then goes silent has
			// no event left to re-evaluate it — the dot pins yellow forever.
			// Mounted in BOTH entries (this file and serve.ts), same lesson as
			// (COMPANION-BRIDGE-MOUNT).
			startStaleWorkingSweep(terminalAgentStore, eventBus);

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
				profileDirsForWorkspace: (workspaceId) =>
					claudeAccounts.configDirCandidatesFor(workspaceId),
				organizationId: env.ORGANIZATION_ID,
				terminalAgentStore,
			});

			if (env.ORGANIZATION_ID) {
				const manifest: HostServiceManifest = {
					pid: process.pid,
					endpoint: `http://127.0.0.1:${info.port}`,
					authToken: env.HOST_SERVICE_SECRET,
					startedAt,
					organizationId: env.ORGANIZATION_ID,
				};
				void claimManifest(manifest).catch((error) => {
					console.error("[host-service] Failed to write manifest:", error);
				});
				// Yielding at boot must not be permanent: when the holder later
				// quits (removing its manifest) or dies, re-claim so the CLI's
				// routing table always names a live instance.
				manifestReclaimTimer = setInterval(() => {
					if (readManifest(manifest.organizationId)?.pid === process.pid) {
						return;
					}
					void claimManifest(manifest).catch(() => {});
				}, MANIFEST_RECLAIM_INTERVAL_MS);
				manifestReclaimTimer.unref();
			}

			// (CLOUD-SEVERANCE-P2) No relay dial. The refusal for a RELAY_URL
			// that arrives anyway lives in the env schema, parsed at import —
			// early enough to actually stop this process, unlike a throw here.
		},
	);
	serverRef.current = server;
	installUpgradeSocketGuard(server);
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

// Same retrying probe the coordinator's adopt decision uses — a holder that
// is momentarily slow (mid-GC, DB migration) must not get its claim taken.
const MANIFEST_HOLDER_PROBE_TIMEOUT_MS = 2_500;

async function claimManifest(manifest: HostServiceManifest): Promise<void> {
	const existing = readManifest(manifest.organizationId);
	const yieldToHolder = await shouldYieldManifest(existing, process.pid, {
		isAlive: isProcessAlive,
		probeHealthy: (endpoint, authToken) =>
			pollHealthCheck(endpoint, authToken, MANIFEST_HOLDER_PROBE_TIMEOUT_MS),
	});
	if (yieldToHolder) {
		console.warn(
			`[host-service] manifest for ${manifest.organizationId} held by live pid ${existing?.pid} at ${existing?.endpoint}; not claiming`,
		);
		return;
	}
	writeManifest(manifest);
}

void main().catch(async (error) => {
	console.error("[host-service] Failed to start:", error);
	await captureFatalStartupError(error);
	process.exit(1);
});
