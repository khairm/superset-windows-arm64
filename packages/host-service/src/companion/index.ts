/**
 * (COMPANION-BRIDGE) — composition root for the companion bridge.
 *
 * Wires the sealed HTTP listener, the read-only event stream, the pairing
 * window, the question store, the answer path, push and the audit log, and hands
 * host-service a single start/stop handle.
 *
 * Contract with the rest of host-service:
 *  - it runs IN-PROCESS with the pty writer, because exact-current-question
 *    arbitration and injection must share one terminal critical section (§11.3);
 *  - it fails loud on a taken port, a missing secret, or an unreadable device
 *    store — the companion feature is then reported unavailable in the desktop
 *    UI rather than silently degraded;
 *  - it never blocks the main thread on fs (nonce cache, audit log) — the
 *    renderer's `superset-app://` loader starves and the window stays blank.
 *
 * This module owns WIRING AND LIFECYCLE ONLY. Every behaviour lives in a sibling
 * module. Where a source of truth genuinely does not exist yet, an observational
 * adapter reports `null` or throws with the exact remedy — it NEVER fabricates a
 * value that would make a tree look healthy. Answer injection does not use those
 * observations as eligibility gates.
 */

import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import hostServicePackageJson from "@superset/host-service/package.json" with {
	type: "json",
};
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { ClaudeAccountsService } from "../claude-accounts";
import { isWorkspaceUuid } from "../claude-accounts/profile-manager";
import type { HostDb } from "../db";
import * as hostDbSchema from "../db/schema";
import { getDaemonClient } from "../terminal/daemon-client-singleton";
import {
	isLiveTerminalSession,
	nudgeTerminalSessionRepaint,
	prepareAcknowledgedInputSession,
	snapshotSession,
	writeAcknowledgedInputToSession,
	writeFramedInputToSession,
} from "../terminal/terminal";
import type { TerminalAgentStore } from "../terminal-agents";
import {
	type CompanionQuestionSink,
	getCompanionQuestionSink,
	setCompanionLifecycleSink,
	setCompanionQuestionSink,
} from "../trpc/router/notifications";
import { createAccessValidator } from "./access-jwt";
import { resolveAgentKind } from "./agent-kind";
import {
	type AnswerDeps,
	assertAnswerDeps,
	createMessageAttemptStore,
	type GuardSourceResult,
	type HostTerminalRef,
	handleAnswer,
	handleAnswerStatus,
	handleMessage,
	type MessageAttemptStore,
	type TerminalAgentInfo,
} from "./answer";
import { type AttemptLedger, createAttemptLedger } from "./attempt-ledger";
import { type AuditLog, createAuditLog, hashJsonPayload } from "./audit";
import {
	BRIDGE_CAPABILITIES,
	BRIDGE_HOST,
	BRIDGE_PORT,
	type CompanionPaths,
	CURATION_RECHECK_MS,
	ensureCompanionDirs,
	isCompanionBridgeEnabled,
	LOG_PREFIX,
	loadAccessServiceToken,
	loadFcmServiceAccountMeta,
	loadPublicPairHost,
	NONCE_CACHE_COMPACT_INTERVAL_MS,
	PAIRING_PUBLIC_HOST,
	PUSH_QUESTION_EXPIRY_MS,
	resolveCompanionPaths,
} from "./config";
import {
	assertDurableSqlite,
	createReplayCache,
	type ReplayCache,
	sleep,
} from "./crypto";
import { createDeviceStore, type DeviceStore } from "./device-store";
import {
	type BridgeHttpServer,
	type BridgeLogger,
	createBridgeHttpServer,
	type FreeTextAuthorizationPolicy,
	ROUTE_GATED_CAPABILITIES,
	type SealedHandlers,
} from "./http";
import {
	createKeyStore,
	createSendNonceSource,
	type KeyStore,
	openStateAnchor,
	type SendNonceSource,
	type StateAnchor,
} from "./keys";
import {
	RAW_PTY_WRITER_KIND,
	type RawWriteInput,
	type RawWriteTarget,
} from "./keystrokes";
import {
	createLeaseRegistry,
	createTerminalLockRegistry,
	type LeaseRegistry,
	type TerminalLockRegistry,
} from "./lease";
import {
	createFreshCurationRead,
	createLifecycleAlertManager,
	createLifecycleCurationProbe,
	type LifecycleSeenInput,
} from "./lifecycle-alerts";
import { PANIC_REASON_MAX_CHARS } from "./limits";
import { createTerminalLiveness, type TerminalLiveness } from "./liveness";
import { errorClassName } from "./log-privacy";
import {
	openPairingWindow,
	// Aliased: the bridge method below has the same name, and a method name is
	// not a binding, so an unaliased import would read as recursion to everyone
	// who has not memorised that rule.
	openRemotePairing as openRemotePairingWindow,
	type PairingDeps,
	type PairingWindowHandle,
	type PairingWindowHandleBase,
	type RemotePairingWindowHandle,
} from "./pairing";
import { createPresenceStore, type PresenceStore } from "./presence";
import {
	logProvenVersionStatus,
	resolveProvenVersionStatus,
} from "./proven-version";
import {
	createPushSender,
	handleRegister,
	type PushFireVerdict,
	type PushSender,
} from "./push";
import {
	type AlertContextSnapshotInput,
	type AlertContextSyncResult,
	createAlertContextRegistry,
	type PushAlertContext,
} from "./push-context";
import { createPushFence, type PushFence } from "./push-fence";
import {
	createQuestionStore,
	deriveHandle,
	type PendingQuestion,
	QUESTION_STALE_MANUAL_DISMISS_REASON,
	QUESTION_STALE_TERMINAL_GONE_REASON,
	type QuestionCaptureSink,
	type QuestionStore,
	readOrphanTranscriptVerdict,
} from "./question-store";
import {
	badRequest,
	createReadApi,
	findActiveHostTerminalId,
	type HostDbReader,
	openHostDbReadOnly,
	projectDisplayName,
	type ReadApi,
	workspaceDisplayName,
} from "./read-api";
import {
	type CompanionMirrorChange,
	clearCompanionAlertContextSink,
	clearCompanionBridge,
	clearCompanionLifecycleSeenSink,
	clearCompanionMirrorChangeSink,
	clearCompanionPresenceStore,
	clearCompanionRelaunchBoundarySink,
	clearCompanionTerminalGoneSink,
	setCompanionAlertContextSink,
	setCompanionBridge,
	setCompanionLifecycleSeenSink,
	setCompanionMirrorChangeSink,
	setCompanionPresenceStore,
	setCompanionRelaunchBoundarySink,
	setCompanionTerminalGoneSink,
} from "./registry";
import {
	isSessionsProjectId,
	placementProjectId,
	SESSIONS_PROJECT_NAME,
} from "./session-project";
import { workspaceSidebarVerdict } from "./sidebar-filter";
import type {
	Capability,
	DeviceRecord,
	EpochMs,
	EventFrame,
	PanicMode,
	PanicRequest,
	PanicResponse,
	QuestionId,
	SealedRequestContext,
	TerminalId,
	WorkspaceId,
} from "./types";
import {
	createEventStreamServer,
	type EventSnapshotSource,
	type EventStreamServer,
} from "./ws";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * (MAINTENANCE-DRAIN) How long teardown waits for in-flight maintenance.
 *
 * Bounded so a task stalled on a held file handle cannot hang `stop()` — which
 * runs inside the lifecycle's `exclusive()`, so hanging it would prevent every
 * later `start()`. Generous relative to the work (a maintenance pass is a
 * bounded SQL delete and an audit trim) and short relative to a user noticing the app will not quit.
 * Correctness does not depend on this wait: the stores refuse writes once closed.
 */
const MAINTENANCE_DRAIN_TIMEOUT_MS = 5_000;

/** How often the drain re-checks, so it notices the deadline without busy-waiting. */
const MAINTENANCE_DRAIN_POLL_MS = 50;
/**
 * The `AgentLifecycleEventType` member that means "the agent is blocked waiting
 * for the user". `mapEventType` has already normalised host.db's
 * `terminal_agent_bindings.last_event_type` to this vocabulary, so
 * `permissionAxisLatched` is a string compare and not a heuristic.
 */
const PERMISSION_REQUEST_EVENT_TYPE = "PermissionRequest";
/** UUIDv4, lowercase, hyphenated (§0.1). */
const REQUEST_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/**
 * (PUSH-CURATION-GATE) How many cached curation verdicts `createIsCuratedOffProbe`
 * keeps before it walks the map for dead rows. Not a ceiling on live holds — a
 * hundred simultaneously-held pushes is real data, not a leak — only the point
 * past which the sweep pays for a prune.
 */
const CURATION_CACHE_SOFT_MAX = 64;

export interface CompanionBridge {
	start(): Promise<void>;
	stop(reason?: string): Promise<void>;
	/** Opens the single 120 s LAN pairing window and returns the QR URI. */
	openPairing(): Promise<PairingWindowHandle>;
	/**
	 * (REMOTE-CODE-PAIRING) Opens the SAME single 120 s window in code mode and
	 * returns the 8 digits to show the user. Works from any network, because
	 * nothing about it needs the phone to reach this machine's LAN address.
	 *
	 * Throws — with the remedy in the message — when the pairing-scoped
	 * Cloudflare Access application is not configured on this machine. There is
	 * no degraded path: without that application the phone's requests never reach
	 * the bridge at all.
	 */
	openRemotePairing(): Promise<RemotePairingWindowHandle>;
	/**
	 * Closes the pairing window early. Without this the user who dismissed the QR
	 * has no way to take the 0.0.0.0:47611 listener down before its 120 s are up,
	 * and `openPairing`'s "close it before opening another" refusal is an
	 * instruction no caller can follow. Returns `false` when there was nothing
	 * open — a stated fact, not a silent success.
	 */
	closePairing(): Promise<boolean>;
	/**
	 * The DESKTOP-side panic switch. Strips write access from every paired device
	 * WITHOUT unpairing: keys survive, the phone keeps reading and keeps telling
	 * the user why it stopped writing. Re-enabling is desktop-only by design
	 * (§7.8) — there is no wire path that restores privilege.
	 */
	disableWrites(reason: string): Promise<number>;
	/** Desktop-side revoke. The device must pair again. */
	revokeAllDevices(reason: string): Promise<number>;
	/**
	 * (KEEP-AWAKE) How many devices are paired RIGHT NOW — records whose
	 * `revokedAtMs` is null. Revoked records are retained 30 days so audit
	 * entries stay attributable (§4.8), and a retained record is NOT a
	 * pairing: the keep-awake gate must drop its hold the moment `unpair_all`
	 * runs, not in a month. Reads the device store, whose rows in host.db are
	 * the only authority since (DEVICE-INDEX-DB) retired `devices.json`.
	 * Rejects when the bridge is not running.
	 */
	pairedDeviceCount(): Promise<number>;
	readonly startedAtMs: number;
	readonly running: boolean;
}

export interface CompanionBridgeOptions {
	/** `env.HOST_DB_PATH`. Opened `mode=ro`; `immutable=1` is forbidden (§7.2). */
	hostDbPath: string;
	/**
	 * The live drizzle handle. Needed ONLY by the pty-session write path
	 * (`writeFramed`/`writeInput`/`snapshotSession`), whose writes are upstream's
	 * semantics on upstream's connection. Companion-table writes do NOT go
	 * through this handle: it runs at the binding's WAL default (NORMAL), so the
	 * bridge opens its own `synchronous = FULL` connection for the device store,
	 * replay cache and answer ledger (COMPANION-DB-FULL). Every companion READ
	 * goes through the separate `mode=ro` reader opened from `hostDbPath`.
	 */
	db: HostDb;
	profileDirsForWorkspace: (workspaceId: string) => readonly string[];
	/**
	 * (MIRROR-ORG-GATE) The org this bridge serves. Compared against
	 * `sidebar_mirror_meta.organization_id` before any curation is applied — see
	 * `CompanionMountInput.organizationId`.
	 */
	organizationId: string;
	/**
	 * Handed in explicitly rather than imported as a module global, so the
	 * binding adapters read the SAME live store the hook receiver writes. A second
	 * `new TerminalAgentStore(...)` would look correct and serve a stale
	 * in-memory `byTerminal` map.
	 */
	terminalAgentStore: TerminalAgentStore;
	/** App/host-service/fork versions reported by `/v1/session/hello`. */
	versions: {
		appVersion: string;
		hostServiceVersion: string;
		forkTag: string;
	};
}

/**
 * (BRIDGE-TEARDOWN-ONE-LIST) One step of the ONE teardown list.
 *
 * `startInner` appends a step the moment it acquires the resource that step
 * releases. That list is replayed in reverse by BOTH exit paths: a failed start
 * (from `start`, before the list ever reaches `state`) and a clean `stop`.
 *
 * There used to be two: the accumulated list, used only on a failed start and
 * then discarded, and a hand-written close sequence inside `stop` that happened
 * to name the same resources in the same order. Nothing asserted the two agreed,
 * so adding a resource to one and forgetting the other leaked it on every clean
 * shutdown, silently. Adding a step to `startInner` is now the whole change.
 */
interface TeardownStep {
	what: string;
	close: () => Promise<unknown> | undefined;
}

interface BridgeState {
	paths: CompanionPaths;
	hostDb: HostDbReader;
	audit: AuditLog;
	anchor: StateAnchor;
	deviceStore: DeviceStore;
	keyStore: KeyStore;
	nonceCache: ReplayCache;
	sendNonces: SendNonceSource;
	questions: QuestionStore;
	leases: LeaseRegistry;
	locks: TerminalLockRegistry;
	ledger: AttemptLedger;
	messageAttempts: MessageAttemptStore;
	readApi: ReadApi;
	presence: PresenceStore;
	pushFence: PushFence;
	push: PushSender;
	events: EventStreamServer;
	http: BridgeHttpServer;
	/**
	 * The open pairing window of EITHER kind — QR or code. There is one slot
	 * because `pairing.ts` allows one window process-wide.
	 */
	pairing: PairingWindowHandleBase | null;
	/**
	 * (REMOTE-CODE-PAIRING) The public pairing host, read ONCE at start and
	 * captured here, or `null` when remote pairing is not enabled.
	 *
	 * Captured rather than re-read per call so `openRemotePairing` refuses on
	 * exactly the same fact the HTTP listener was BUILT with. Re-reading would let
	 * the desktop open a code window that `/v1/pair/*` cannot serve, because the
	 * host gate those routes sit behind was fixed at construction — a window the
	 * user would watch count down while the phone got 404s.
	 */
	publicPairHost: string | null;
	/**
	 * The SAME array `startInner` built, not a copy: steps appended after `state`
	 * was assigned (the maintenance timers) land here too.
	 */
	teardown: readonly TeardownStep[];
}

/**
 * (BRIDGE-LIFECYCLE-OWNER) The lifecycle has exactly ONE owner.
 *
 * `stopped -> starting -> running -> stopping -> stopped`, and NOTHING else is
 * reachable. The phase is set by the FIRST statement of `start`/`stop`, and both
 * run inside one serialising chain, so two starts, or a start racing a stop, can
 * never both hold the on-disk state.
 *
 * This is the lifecycle half of a two-part fix. The other half lives in
 * `keys.ts`: the state anchor hands the send-nonce source an owner token and
 * re-checks it against the file on every write, so even if this guard were
 * somehow bypassed a stale owner could not write — and could never lower the
 * high-water mark, which is what let a late `close()` rewind the counter and
 * re-issue nonces a previous owner had already emitted.
 */
type LifecyclePhase = "stopped" | "starting" | "running" | "stopping";

export function createCompanionBridge(
	options: CompanionBridgeOptions,
): CompanionBridge {
	assertOptions(options);

	const logger = createBridgeLogger();
	let state: BridgeState | null = null;
	let startedAtMs = 0;
	let phase: LifecyclePhase = "stopped";
	/** Serialises start against stop. Neither ever overlaps the other. */
	let lifecycle: Promise<unknown> = Promise.resolve();

	const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
		const run = lifecycle.then(work, work);
		lifecycle = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	const requireState = (): BridgeState => {
		if (!state) {
			throw new Error(
				`${LOG_PREFIX} bridge is not running — call start() first`,
			);
		}
		return state;
	};

	const start = (): Promise<void> =>
		exclusive(async () => {
			// FIRST STATEMENT. An earlier revision did not mark the start in progress
			// until the very end, so a second start ran the whole construction path
			// against files the first one already owned.
			if (phase !== "stopped") {
				throw new Error(
					`${LOG_PREFIX} start() refused: the bridge lifecycle is ${phase}`,
				);
			}
			phase = "starting";
			/**
			 * (BRIDGE-TEARDOWN-ONE-LIST) Unwound in reverse on ANY failure below —
			 * a half-started bridge owns files — and handed to `state` on success,
			 * where `stop` replays the very same list.
			 */
			const unwind: TeardownStep[] = [];
			try {
				await startInner(unwind);
				phase = "running";
			} catch (error) {
				// Release everything this attempt took, so the NEXT start sees a clean
				// process: the state anchor refuses to open twice, so leaking it here
				// would make the failure permanent instead of retryable.
				for (const entry of [...unwind].reverse()) {
					await settle(logger, entry.what, entry.close);
				}
				state = null;
				phase = "stopped";
				throw error;
			}
		});

	const startInner = async (unwind: TeardownStep[]): Promise<void> => {
		const bridgeStartedMs = Date.now();

		// 1. Filesystem + secrets. Every failure here is fatal and specific: a
		//    half-configured bridge that "mostly works" is the failure mode this
		//    whole feature cannot afford. The Access secret is validated now and
		//    re-read at the last moment by pairing; it is never held here.
		const paths = resolveCompanionPaths();
		await ensureCompanionDirs(paths);
		const accessClientId = loadAccessServiceToken(paths).clientId;
		const fcm = loadFcmServiceAccountMeta(paths);
		// (REMOTE-CODE-PAIRING) Absent = the code flow is off and the QR flow is
		// untouched; PRESENT BUT WRONG throws right here, at start, rather than at
		// the moment a user is standing in front of a countdown.
		const publicPairHost = loadPublicPairHost(paths);
		logger.info("config validated", {
			accessClientId,
			fcmProject: fcm.projectId,
			// A hostname, and a public one by design — the pairing paths are
			// unauthenticated and their security rests on the SRP exchange, not on
			// the host being secret. There is nothing here to redact.
			publicPairHost,
			remotePairing: publicPairHost === null ? "off (not configured)" : "on",
		});

		// (PORT-BEFORE-STATE) Take the one exclusive resource FIRST, before any
		// persistent state is touched.
		//
		// `openStateAnchor` -> `createDeviceStore` -> `createSendNonceSource` takes
		// OWNERSHIP of the send-nonce counter, and that ownership is exclusive: it
		// rewrites the anchor's owner token, after which the previous owner's next
		// `raiseSend` throws and its nonce source poisons itself permanently — every
		// sealed response degrades to `503 bridge_unavailable` and every event frame
		// drops its socket, with no retry anywhere. Before this reservation that
		// happened ~120 lines BEFORE `http.start()` discovered the port was taken,
		// so a duplicate spawn (an orphaned host-service child surviving an Electron
		// crash, a canary alongside stable) took the counter away from the process
		// that was actually serving the phone and took THAT process down. Binding
		// first makes the process that cannot serve fail immediately, loudly, and in
		// itself.
		const portReservation = await reserveBridgePort();
		unwind.push({
			what: "bridge port reservation",
			close: () => portReservation.release(),
		});

		// 2. Stores. Constructed once, here, and never re-derived by a handler.
		//
		//    THE ANCHOR COMES FIRST. It is the single owner of the send-nonce
		//    high-water mark and the anti-rollback binding for the device index, so
		//    every store below is constructed against one already-proven-fresh view
		//    of the on-disk state rather than each re-deriving its own.
		const anchor = await openStateAnchor(paths.root);
		unwind.push({ what: "state anchor", close: () => anchor.close() });
		const hostDb = openHostDbReadOnly(
			options.hostDbPath,
			options.profileDirsForWorkspace,
		);
		unwind.push({ what: "host db reader", close: async () => hostDb.close() });
		/**
		 * (BRIDGE-LIVENESS) The one place the bridge asks whether a terminal still
		 * exists. Built HERE because it is the only layer that may touch the pty
		 * plumbing: `read-api` and `question-store` take the interface, not the
		 * daemon.
		 *
		 * The two sources are the same pair `listWorkspaceTerminalSessions` already
		 * joins for the desktop's own session list — an in-process session, or an
		 * id the daemon reports alive — so the bridge stops being LOOSER than the
		 * host-service's own idea of a live terminal, which is what let 403 corpse
		 * rows reach the phone.
		 */
		const liveness: TerminalLiveness = createTerminalLiveness({
			hasInProcessSession: isLiveTerminalSession,
			listDaemonAliveIds: async () => {
				const daemon = await getDaemonClient();
				return (await daemon.list())
					.filter((session) => session.alive)
					.map((session) => session.id);
			},
			now: () => Date.now(),
			startedAtMs: bridgeStartedMs,
			log: (event) => logger.warn("terminal liveness", event),
		});
		// (COMPANION-DB-FULL) The bridge's OWN write connection to host.db, at
		// PRAGMA synchronous = FULL — set EXPLICITLY, never inherited. The shared
		// `options.db` connection runs at the binding's WAL default, which in
		// better-sqlite3's standard build is NORMAL (SQLITE_DEFAULT_WAL_SYNCHRONOUS=1)
		// — a committed row can be lost to power loss, which is the exact rollback
		// the fence rows below exist to prevent. `synchronous` is per-connection,
		// so this strengthens ONLY companion-table writes; upstream's own write
		// path keeps upstream's durability choice. This is also why the first
		// installed build refused to start: the stores asserted FULL against the
		// shared connection and honestly found NORMAL. Every companion store that
		// WRITES host.db (device store, replay cache, answer ledger) is handed
		// THIS connection; `options.db` remains only for pty-session writes whose
		// semantics are upstream's. No migrate() here — createApp already ran
		// migrations on this database before the mount was called.
		const companionSqlite = new Database(options.hostDbPath);
		// Registered IMMEDIATELY — before the pragmas and the durability assert,
		// any of which can throw. Registering after them leaked the open write
		// handle on a failed start, pinning host.db/-wal/-shm on Windows for the
		// life of the process with the bridge off — the exact "nothing
		// half-registers" promise this construction exists to keep.
		unwind.push({
			what: "companion write db",
			close: async () => companionSqlite.close(),
		});
		companionSqlite.pragma("journal_mode = WAL");
		companionSqlite.pragma("busy_timeout = 5000");
		companionSqlite.pragma("foreign_keys = ON");
		companionSqlite.pragma("synchronous = FULL");
		const companionDb = drizzle(companionSqlite, { schema: hostDbSchema });
		assertDurableSqlite(companionDb, "opening the companion write connection");
		const audit = createAuditLog(paths.audit);
		const keyStore = createKeyStore(paths.devices, anchor);
		// Revocation tombstones and the retryable wipe of purged key material live
		// inside the store now: purge is still the ONLY point at which a K_dev may
		// be destroyed, but a revoke must ALSO invalidate the key file, or restoring
		// an older index silently re-authorises the device.
		const deviceStore = await createDeviceStore(paths.devices, {
			// (DEVICE-INDEX-DB) The index is rows now, not devices.json — written
			// through the bridge's FULL-synchronous connection, never the shared one.
			db: companionDb,
			anchor,
			keys: keyStore,
			log: logger,
		});
		// (LASTSEEN-DEBOUNCE) The store now holds a liveness stamp in memory
		// between flushes, so it owns a timer and an unwritten value. Registered
		// here, ABOVE the send-nonce source and the listener, so the reversed
		// teardown flushes it while the anchor is still open — `persist()` may need
		// to commit through it.
		unwind.push({ what: "device store", close: () => deviceStore.close() });
		// (REPLAY-CACHE-DB) A plain await, where this used to be a one-element
		// `Promise.allSettled` with a paragraph explaining itself.
		//
		// The scaffolding was there for (BRIDGE-TEARDOWN-ONE-LIST): the replay cache
		// held an open file handle, so a construction that SUCCEEDED while its partner
		// in the same batch failed still had to reach the unwind list before this
		// function threw, and `all` would have abandoned it. Both halves of that reason
		// are gone — the JSON attempt store that was the partner is now the ledger in
		// host.db, and the cache holds no handle now that its records are rows. A
		// single-element `allSettled` protects nothing from itself.
		//
		// Still registered for unwind: `close()` is what makes a stopped bridge REFUSE
		// admissions (STORE-CLOSED) rather than quietly accepting them into a cache
		// nobody is compacting.
		//
		// NOTHING here is reordered against the anchor: `openStateAnchor` ->
		// `createDeviceStore` -> the (ANCHOR-ORDER) assertion -> `createSendNonceSource`
		// still runs strictly in sequence.
		const nonceCache = await createReplayCache({
			db: companionDb,
			noncesDir: paths.nonces,
		});
		unwind.push({ what: "nonce cache", close: () => nonceCache.close() });
		// (ANSWER-LEDGER) The durable fence, on the host database rather than a JSON
		// file, because closing the status/answer race needs a transaction. Built here
		// so a failure to open it — including the PRAGMA synchronous assertion — takes
		// the bridge down before a single answer can be typed without a durable claim.
		const ledger = createAttemptLedger({
			// The FULL-synchronous write connection, not the `mode=ro` reader every
			// companion READ uses (§7.2) — a read-only handle would fail at the first
			// claim, after the bridge had already accepted the request, and the shared
			// handle's NORMAL durability cannot carry a fence row.
			db: companionDb,
			log: (event) => logger.warn("answer ledger", event),
		});
		// (STORE-CLOSED) The attempt store was the ONLY subsystem with no teardown
		// step, which is why it was the one a detached prune could rewrite from a
		// stale snapshot after a replacement bridge had moved on. Shutting its door
		// is what stops a writer the scheduler never sees — its peers `nonceCache`
		// and `deviceStore` already guard themselves the same way, and
		// `deviceStore`'s debounced persist is detached and invisible to any drain.
		// (ANCHOR-ORDER) LOAD-BEARING ORDER, ASSERTED RATHER THAN ASSUMED.
		//
		// `createDeviceStore` is what runs the anti-rollback checks and what stamps
		// this mount's epoch into `devices.json` as the witness the NEXT mount reads.
		// If a future edit moved the send-nonce source above it, a rolled-back
		// counter state would emit nonces before anything had checked it was fresh —
		// which is the exact failure this whole anchor exists to prevent. The store
		// always commits at load, so a null here means the order was broken.
		if (anchor.devices() === null) {
			throw new Error(
				`${LOG_PREFIX} the device store did not commit its anti-rollback state before the send-nonce source was created — refusing to emit nonces under state nothing has checked`,
			);
		}
		const sendNonces = await createSendNonceSource(anchor);
		// Registered BEFORE the http listener, so the reversed teardown closes it
		// AFTER the listener — nothing can still be admitting a nonce or sealing a
		// response against a closed source. The anchor, pushed further up, is
		// released last of all: it is the ownership token for the on-disk state.
		unwind.push({ what: "send-nonce source", close: () => sendNonces.close() });
		/**
		 * (SETTLE-CHOKE-POINT) The store settles questions and the push sender
		 * retracts notifications about them, and each needs the other: the sender's
		 * fire-time probes read the store, and the store's settle seam retracts
		 * through the sender. A mutable holder rather than a closure over the
		 * `const push` below, so the ordering is stated instead of resting on a
		 * temporal dead zone — and so an impossible early settle says so out loud
		 * rather than throwing an opaque reference error.
		 */
		const settleTarget: { push: PushSender | null } = { push: null };
		const questions = createQuestionStore({
			source: hostDb,
			liveness,
			onSettled: (question) => {
				const sender = settleTarget.push;
				if (sender === null) {
					logger.error(
						"a question settled before the push sender was wired; any notification for it will outlive it",
						{ questionId: question.questionId, state: question.state },
					);
					return;
				}
				// §13.3, from the ONE place every ending passes through. Disarms an
				// un-fired push and retracts one that already went out; deliberately
				// the fire-and-forget form, because no settle path — least of all the
				// hook route or an answer that has already been typed — may wait on
				// FCM.
				sender.cancelPending(question.questionId);
			},
		});
		const leases = createLeaseRegistry();
		const locks = createTerminalLockRegistry();
		const messageAttempts = createMessageAttemptStore();

		const events = createEventStreamServer({
			devices: deviceStore,
			keys: keyStore,
			sendNonce: sendNonces,
			snapshots: createSnapshotSource(),
			logger,
		});
		/**
		 * (PUSH-PRESENCE) The two halves of presence-gated push, built before the
		 * sender because it consumes both.
		 *
		 * The presence store is published to the registry immediately, not at the
		 * end of `startInner`: the desktop's beacon tick is already running and
		 * every beacon that lands before registration is one the first question
		 * cannot use. The teardown step is pushed in the same breath, so a start
		 * that fails after this point cannot leave a dead store registered for the
		 * next bridge to inherit.
		 */
		const presence = createPresenceStore();
		setCompanionPresenceStore(presence);
		unwind.push({
			what: "presence store",
			close: async () => clearCompanionPresenceStore(presence),
		});
		// Writes through the bridge's OWN synchronous = FULL connection
		// (COMPANION-DB-FULL) — never the shared handle, which runs at NORMAL.
		/**
		 * (ALERT-CONTEXT-NAMES) The renderer's tab-title snapshots, and the one
		 * function that turns raw host ids into the three names an alert says.
		 *
		 * Built BEFORE the push sender, which consumes it, for the same reason the
		 * presence store is built before it: the ordering is STATED rather than
		 * left resting on a closure over a `const` further down.
		 *
		 * The registry is owned HERE rather than by either consumer, because both
		 * consumers need the same answer — a question push and a lifecycle alert
		 * about the same terminal must name the same tab, and two caches would be
		 * two chances to disagree.
		 */
		const alertContexts = createAlertContextRegistry({ db: hostDb, logger });
		const syncAlertContexts: (
			input: AlertContextSnapshotInput,
		) => AlertContextSyncResult = (input) => alertContexts.sync(input);
		setCompanionAlertContextSink(syncAlertContexts);
		unwind.push({
			what: "alert context registry",
			close: async () => {
				clearCompanionAlertContextSink(syncAlertContexts);
				// Nothing may survive a bridge that is no longer running: the next
				// bridge's renderer re-syncs on its first resync epoch.
				alertContexts.clear();
			},
		});
		/**
		 * Resolve project + workspace off host.db and the tab off the registry.
		 *
		 * NEVER THROWS, and every field degrades independently. A workspace row
		 * that has been deleted, a project that cannot be read, a terminal with no
		 * snapshot — each costs exactly its own field, and the phone renders its
		 * generic wording for whatever is missing rather than being denied the
		 * alert. NO NAME IS EVER LOGGED, here or downstream.
		 *
		 * (SESSIONS-PROJECT) A session workspace has `project_id = NULL` and would
		 * otherwise resolve to no project name at all, dropping a whole class of
		 * threads into generic mode. The synthetic "Sessions" label is the
		 * authoritative answer for exactly that case.
		 */
		function resolveAlertContext(input: {
			hostTerminalId: string | null;
			hostWorkspaceId: string | null;
		}): PushAlertContext | null {
			const { hostTerminalId, hostWorkspaceId } = input;
			if (hostWorkspaceId === null || hostWorkspaceId.length === 0) return null;
			let workspaceName = "";
			let projectName = "";
			try {
				const workspace = hostDb.findWorkspace(hostWorkspaceId);
				if (workspace !== null) {
					// (CHAT-CONTEXT-NAMES) The SAME display-name fallbacks `/v1/tree`
					// and `/v1/question`'s `place` use, so the notification and the
					// sheet it opens name the same rows identically. This CHANGES the
					// alert only for a row whose stored name is empty: it used to
					// resolve to `""` and the phone rendered its generic wording, and
					// it now resolves to the branch (workspace) or the repo path's
					// basename (project), exactly as every other surface names it.
					workspaceName = workspaceDisplayName(workspace);
					const placement = placementProjectId(workspace.projectId);
					if (isSessionsProjectId(placement)) {
						projectName = SESSIONS_PROJECT_NAME;
					} else {
						const project = hostDb.findProject(placement);
						projectName = project === null ? "" : projectDisplayName(project);
					}
				}
			} catch (error) {
				// (CHAT-CONTEXT-NAMES) A CLASS NAME, never the error. `new Error(name)`
				// is a plausible thing for a row read to throw, and both `message` and
				// `stack` can carry a project or workspace name — which is the exact
				// string this alert path keeps out of the log.
				logger.error(
					"could not read workspace/project names for a companion alert; it will use generic wording",
					{ hostWorkspaceId, errorName: errorClassName(error) },
				);
			}

			let tabTitle = "";
			let tabCount: number | null = null;
			if (hostTerminalId !== null && hostTerminalId.length > 0) {
				const tab = alertContexts.lookup(hostWorkspaceId, hostTerminalId);
				if (tab !== null) {
					tabTitle = tab.tabTitle;
					tabCount = tab.tabCount;
				}
			}

			return {
				terminalHandle:
					hostTerminalId !== null && hostTerminalId.length > 0
						? deriveHandle("terminal", hostTerminalId)
						: "",
				projectName,
				workspaceName,
				tabTitle,
				tabCount,
			};
		}

		const pushFence = createPushFence({
			db: companionDb,
			log: (event) => logger.info("push fence", event),
		});
		const push = createPushSender({
			serviceAccountPath: fcm.path,
			devices: deviceStore,
			presence,
			fence: pushFence,
			// (QUESTION-EXPIRY) See `createIsStillUnansweredProbe`; extracted so the
			// three-way split it makes can be exercised without booting a bridge.
			fireVerdict: createFireVerdictProbe({
				questions,
				liveness,
				resolveTerminalActivityMs: (hostTerminalId) =>
					hostDb.resolveTerminalActivityMs(hostTerminalId),
				logger,
			}),
			// (PUSH-CURATION-GATE) The SAME reader `/v1/tree` reads curation
			// through, so a thread the tree will not render cannot buzz — asked on
			// every sweep, because a snooze that expires has to be able to release
			// the buzz it deferred.
			isCuratedOff: createIsCuratedOffProbe({
				questions,
				db: hostDb,
				organizationId: options.organizationId,
				logger,
			}),
			// (PUSH-ARMED-ORPHAN) The one check available for a push rebuilt from
			// the fence: the question store is memory-only and empty at this point,
			// so the row's own persisted transcript is the only thing that can say
			// whether it was answered while the host-service was down — or whether
			// it still exists at all. Three-way, like the question store's own
			// transcript verification: only `resolved` and `gone` retire the entry,
			// and `gone` is corroborated against the projects root before it counts.
			// Everything else means "cannot check", and the buzz stands.
			resolveAlertContext,
			verifyOrphanResolved: ({ transcriptPath, toolUseId }) =>
				readOrphanTranscriptVerdict({ transcriptPath, toolUseId }),
			onFault: (fault) => {
				logger.error("push is broken", { fault });
			},
		});
		// (SETTLE-CHOKE-POINT) Live from here on. Nothing can have settled yet: no
		// route that reaches the store exists until the capture sink is registered
		// and the HTTP listener binds, both of which are below.
		settleTarget.push = push;
		const lifecycleAlerts = createLifecycleAlertManager({
			presence,
			push,
			workspaceHandle: (hostWorkspaceId): WorkspaceId =>
				deriveHandle("workspace", hostWorkspaceId),
			terminalHandle: (hostTerminalId): string =>
				deriveHandle("terminal", hostTerminalId),
			resolveContext: resolveAlertContext,
			// (ONE-BUZZ-UNTIL-READ) The proof epoch, read ONCE here at bridge
			// start: every terminal's last recorded lifecycle instant, including
			// ended sessions, straight off host.db. It is what stops a restart
			// inside a wall-clock backstep from "proving" that an alert the
			// PREVIOUS process sent never existed — see `proofEpochs`.
			proofEpochs: () =>
				hostDb.listBindings().map((binding) => ({
					hostTerminalId: binding.terminalId,
					lastEventAtMs: binding.lastEventAt,
				})),
			// (LIFECYCLE-CURATION-CACHE) The probe owns the cache, the throw-fires-
			// anyway rule and the log-on-transition discipline that being asked once
			// per two-second sweep for six hours requires.
			isCuratedOff: createLifecycleCurationProbe({
				db: hostDb,
				organizationId: options.organizationId,
				logger,
			}),
			// (ALERT-RETIRE-ON-EXIT) The retirement walk's read, which must NOT be
			// the cached probe above: a mirror write that un-snoozes a thread would
			// see the stale hold and retract the alerts the user just brought back.
			curatedOffAmong: createFreshCurationRead({
				db: hostDb,
				organizationId: options.organizationId,
				logger,
			}),
			logger,
		});
		setCompanionLifecycleSink(lifecycleAlerts);
		unwind.push({
			what: "lifecycle alert sink",
			close: async () => {
				setCompanionLifecycleSink(null);
				lifecycleAlerts.stop();
			},
		});
		/**
		 * (ALERT-CONTEXT-NAMES) The desktop's "the user read this chat" signal.
		 *
		 * Registered separately from the lifecycle sink above, and it must stay
		 * that way: that sink is the HOOK stream — one validated producer, its own
		 * idempotency window — and threading a renderer-originated seen mark
		 * through it would make a user's click indistinguishable from an agent
		 * event in the one place that decides whether an alert is minted.
		 *
		 * THE RELATIONSHIP IS RE-DERIVED FROM host.db, exactly as the tab-context
		 * registry does before it accepts a snapshot. The renderer is local and
		 * authenticated, but "authenticated" is not "correct": a stale layout row
		 * or a terminal re-parented since the mark would otherwise let one
		 * workspace's read retract another workspace's notification, which is the
		 * one thing a retraction must never do. A mismatch drops the signal with
		 * an ID-ONLY log — the failure is diagnosable and no name goes near it.
		 */
		const lifecycleSeen = (input: LifecycleSeenInput): boolean => {
			// `true` means THE BRIDGE RECEIVED IT, which is the only thing the
			// renderer's `accepted` has ever meant — a signal this bridge then drops
			// on its own evidence (below) is still a signal that reached a running
			// bridge, and reporting it as unconsumed would have the resync retry a
			// terminal host.db has already said does not belong to that workspace.
			let placed = false;
			try {
				const row = hostDb.findTerminal(input.hostTerminalId);
				placed =
					row !== null && row.originWorkspaceId === input.hostWorkspaceId;
			} catch (error) {
				// Uncertain is NOT permission here, unlike the alert path's fail-open
				// rules: the cost of dropping this is one notification staying up a
				// little longer, while the cost of acting on it wrongly is retracting
				// an alert about a chat the user has not read.
				logger.error(
					"could not revalidate a lifecycle seen signal against host.db; dropping it",
					{
						hostTerminalId: input.hostTerminalId,
						hostWorkspaceId: input.hostWorkspaceId,
						error,
					},
				);
				return true;
			}
			if (!placed) {
				logger.info(
					"dropping a lifecycle seen signal for a terminal host.db does not place in that workspace",
					{
						hostTerminalId: input.hostTerminalId,
						hostWorkspaceId: input.hostWorkspaceId,
					},
				);
				return true;
			}
			lifecycleAlerts.markLifecycleSeen(input);
			return true;
		};
		setCompanionLifecycleSeenSink(lifecycleSeen);
		unwind.push({
			what: "lifecycle seen sink",
			close: async () => clearCompanionLifecycleSeenSink(lifecycleSeen),
		});

		/**
		 * (ALERT-RETIRE-ON-EXIT) The terminal process died.
		 *
		 * NO host.db REVALIDATION, unlike the seen sink above, and the difference
		 * is who is calling. That one carries a workspace claim from a RENDERER
		 * and re-derives the relationship because a stale layout row could
		 * otherwise let one workspace's read retract another's notification. This
		 * one carries no claim at all — just "this terminal id is dead" — and it
		 * comes from the host runtime's own event bus, which is the authority on
		 * that. Asking host.db would also be asking it about a row the exit path
		 * is in the middle of updating.
		 */
		const terminalGone = (input: { hostTerminalId: string }): boolean => {
			lifecycleAlerts.retireTerminal(input.hostTerminalId);
			return true;
		};
		setCompanionTerminalGoneSink(terminalGone);
		unwind.push({
			what: "terminal gone sink",
			close: async () => clearCompanionTerminalGoneSink(terminalGone),
		});

		/**
		 * (ALERT-RETIRE-ON-EXIT) The desktop relaunched at this host-clock
		 * instant, so every ready card about a finish before it is redundant.
		 *
		 * VALIDATED HERE RATHER THAN TRUSTED. The boundary is a number the
		 * RENDERER derived (the host's own `hostNow`, less the renderer's elapsed
		 * monotonic time), so a renderer with a broken clock, or a host whose
		 * `hostNow` was wrong, can hand over something absurd. A boundary in the
		 * FUTURE is the dangerous shape — it would retire every ready alert this
		 * host holds, including finishes the user has never seen — so it is
		 * refused with a log rather than clamped. `true` either way: the bridge
		 * received it, which is all `accepted` has ever meant.
		 */
		const relaunchBoundary = (input: { boundaryMs: number }): boolean => {
			const nowMs = Date.now();
			if (
				!Number.isInteger(input.boundaryMs) ||
				input.boundaryMs <= 0 ||
				input.boundaryMs > nowMs
			) {
				logger.error(
					"refusing an out-of-range desktop relaunch boundary; stale ready notifications may survive this launch",
					{ boundaryMs: input.boundaryMs, nowMs },
				);
				return true;
			}
			const retired = lifecycleAlerts.retireReadyBefore(input.boundaryMs);
			logger.info("(ALERT-RETIRE-ON-EXIT) the desktop reported a relaunch", {
				boundaryMs: input.boundaryMs,
				retired,
			});
			return true;
		};
		setCompanionRelaunchBoundarySink(relaunchBoundary);
		unwind.push({
			what: "relaunch boundary sink",
			close: async () => clearCompanionRelaunchBoundarySink(relaunchBoundary),
		});
		/**
		 * (TREE-FRESHNESS-GSEQ) Mint the frame that matches how a record actually
		 * settled, reading the state back from the store rather than assuming it.
		 *
		 * `reconcile` yields ONE list of ids covering two different endings, and
		 * they are not interchangeable on the wire: `resolved` means somebody
		 * answered it, while `stale` (`(QUESTION-EXPIRY)`) means its terminal
		 * stopped existing and NOBODY ever answered.
		 *
		 * Nothing here invents provenance. The resolved branch reads back the
		 * `resolvedAtMs`/`resolvedBy` the store stamped for itself before settling
		 * (a desktop surface, no device label), and skips rather than guessing if
		 * either is somehow absent. `outcome: "unknown"` is the honest value and
		 * the enum's designated member for it: the evidence is a `tool_result` in
		 * the transcript, which proves the tool call ended but not whether the user
		 * chose an option or the agent cancelled. That is why this is NOT the
		 * `"answered"` the hook path publishes — there, a `PostToolUse` resolve
		 * names the surface that answered it.
		 *
		 * A record already pruned out of the store (settled in the same pass that
		 * aged it past its retention) publishes nothing: the ending is no longer
		 * readable, and a wrong frame type is worse than none. The heartbeat counts
		 * still move for it, which is the fallback signal.
		 *
		 * Never throws into the caller: a frame nobody can currently receive
		 * (`events.ws` is deliberately ungranted) must not be able to break the
		 * retraction that runs beside it.
		 */
		function publishSettledQuestion(questionId: QuestionId): void {
			try {
				const question = questions.get(questionId);
				if (question === null) return;
				if (question.state === "resolved") {
					const { resolvedAtMs, resolvedBy } = question;
					if (resolvedAtMs === null || resolvedBy === null) return;
					publishQuestionResolved(events, {
						questionId,
						resolvedAtMs: resolvedAtMs as EpochMs,
						resolvedBy,
						outcome: "unknown",
					});
					return;
				}
				if (question.state === "stale") {
					events.publish({
						t: "question.stale",
						d: { questionId, reason: QUESTION_STALE_TERMINAL_GONE_REASON },
					});
				}
			} catch (error) {
				logger.error(
					"could not publish the settled-question event; the phone will fall back to its counts comparison for freshness",
					{ questionId, error },
				);
			}
		}

		// Constructed BEFORE the read API, because `onQuestionsSettled` is what
		// retracts an already-delivered notification and a late binding there would
		// be a `?.` that silently does nothing.
		const readApi = createReadApi({
			db: hostDb,
			questions,
			liveness,
			log: (event) => logger.info("read", event),
			// (CHAT-CONTEXT-NAMES) The read path's tab titles come from the SAME
			// registry the alert path names its pushes from, so a notification and
			// the sheet it opens can never name two different tabs.
			resolveTabTitle: (w, t) => alertContexts.lookupTabTitle(w, t) ?? "",
			// (MIRROR-ORG-GATE) Curation is only applied to a mirror written for
			// THIS org.
			organizationId: options.organizationId,
			versions: options.versions,
			bridgeStartedMs,
			// The real counter, from the only thing that advances it. A hardcoded 0
			// would make every `TreeResponse.gseq` claim "consistent with zero
			// events": the client latches 0 from the snapshot frame, the first live
			// frame then looks like a sequence gap, §9.3.3 says refetch the tree, and
			// the refetched tree reports 0 again — a refetch per event, forever, with
			// `treeStale` (`lastEventGseq < 0`) unsatisfiable and therefore unable to
			// catch it.
			currentGseq: () => events.currentGseq(),
			// (RECONCILE-RETRACT) `reconcile()` settles questions the hook never
			// reported. That is exactly the moment an armed or delivered push must be
			// withdrawn — on ARM64 a dead hook is a documented failure mode, and
			// without this the phone keeps a notification standing for a question
			// answered at the desk minutes ago.
			//
			// (TREE-FRESHNESS-GSEQ) It is also a change to the tree, so it mints an
			// event. `gseq` is the ONLY freshness signal on the wire — `/v1/tree`
			// stamps it and `/v1/heartbeat` compares against it for `treeStale` — and
			// a settle that moved nothing would let the phone stamp a tree still
			// showing this question as "confirmed current". `reconcile` yields ids
			// rather than provenance, which is why the frame is built by reading each
			// record back out of the store instead of from anything passed here.
			// (SETTLE-CHOKE-POINT) No `push.cancelPending` here. `reconcile` settles
			// these records through `settle()`, which retracts for every one of them
			// — including the `stale` endings this list also carries. A second call
			// here would be a second place to keep in step.
			onQuestionsSettled: (questionIds) => {
				for (const questionId of questionIds) {
					publishSettledQuestion(questionId);
				}
			},
			// (ANSWER-LEDGER) `hello` publishes the current epoch so a client's FIRST
			// answer can be fenced; the read API never writes to the ledger.
			ledger,
		});

		const answerDeps = createAnswerDeps({
			db: options.db,
			hostDb,
			liveness,
			questions,
			events,
			leases,
			locks,
			ledger,
			messageAttempts,
			audit,
			agents: options.terminalAgentStore,
			logger,
			bridgeStartedMs,
		});
		// Proves the acknowledged raw-writer marker HERE, at start, rather than on
		// the first answer of the day. Without this call either the paste-framed or
		// fire-and-forget writer could surface as a real answer failure long after
		// every read path had been seen working.
		assertAnswerDeps(answerDeps);
		const panic = createPanicHandler({ deviceStore, audit, events });

		// (CAPABILITY-WIRING-ASSERT) Boot-time proof that every capability the
		// route table gates on is either granted or deliberately withheld. A token
		// that is gated but ungranted 501s its route forever and the only symptom
		// is a feature that never happens.
		assertCapabilityWiring();

		// 3. Handlers. http.ts owns the route table, the pipeline and the
		//    capability gate; this only binds each operation to its module.
		const handlers: SealedHandlers = {
			ping: readApi.handlePing,
			hello: readApi.handleHello,
			tree: readApi.handleTree,
			transcript: readApi.handleTranscript,
			question: readApi.handleQuestion,
			heartbeat: readApi.handleHeartbeat,
			answer: (ctx, body) => handleAnswer(answerDeps, ctx, body),
			answerStatus: (ctx, body) => handleAnswerStatus(answerDeps, ctx, body),
			message: (ctx, body) => handleMessage(answerDeps, ctx, body),
			register: (ctx, body) =>
				handleRegister(
					{ devices: deviceStore, now: () => Date.now() },
					ctx,
					body,
				),
			panic,
			eventsTicket: (ctx, body) => events.issueTicket(ctx, body),
		};

		// 4. Listener. Binds 127.0.0.1:47610 exactly, or throws — never a fallback
		//    port, because cloudflared's ingress rule is static and a
		//    silently-moved bridge presents as "phone says offline".
		const http = createBridgeHttpServer({
			accessValidator: createAccessValidator(),
			// (REMOTE-CODE-PAIRING) The public host the three unauthenticated pairing
			// paths are served on, or `null` when the operator has not enabled remote
			// pairing — in which case those paths exist on no hostname at all.
			publicPairHost,
			devices: deviceStore,
			keys: keyStore,
			nonceCache,
			sendNonce: sendNonces,
			handlers,
			events,
			freeText: createClientClaimFreeTextPolicy(logger),
			logger,
		});
		// (PORT-BEFORE-STATE) Hand the port over. The reservation held it from
		// before the first persistent write until this line, so no process that
		// could not serve reached `claimSend` while we were constructing.
		//
		// The hand-over is not gapless — `@hono/node-server` binds its own socket,
		// so ours must close first — and that is safe rather than merely small: a
		// second process can only win the port DURING this gap, i.e. before we have
		// served anything, and it then claims the counter AFTER we did, so the
		// on-disk owner is always the process that ends up listening. The loser is
		// whichever one fails to bind, and it fails here, in itself, and unwinds
		// (send-nonce source first, then the anchor) instead of poisoning the
		// process that is answering the phone. `release()` is idempotent and the
		// unwind entry stays: if `http.start()` throws, releasing an already
		// released reservation is a no-op.
		await portReservation.release();
		await http.start();
		unwind.push({ what: "http listener", close: () => http.stop() });
		unwind.push({ what: "event stream", close: () => events.stop() });
		unwind.push({ what: "push sender", close: async () => push.stop() });
		// (BRIDGE-TEARDOWN-ONE-LIST) The pairing window is the one resource a
		// CALLER adds after start, so there is nothing to close yet — this step
		// closes whatever is open at teardown time. It is registered here, rather
		// than by `openPairing`, so its position in the reversed replay is fixed by
		// the start order like every other step; appending it on open would make a
		// late-opened window the FIRST thing torn down.
		unwind.push({
			what: "pairing window",
			close: () => state?.pairing?.close(),
		});

		// (COMPANION-CAPTURE-WIRE) THE SEAM, installed only once the listener is
		// actually up — an aborted start must not leave a live sink behind, or the
		// next `start()` throws "a question sink is already registered".
		//
		// Without this registration the whole feature is inert AND LOOKS HEALTHY:
		// `notifications.hook` validates a captured AskUserQuestion, calls
		// `forwardCompanionCapture`, finds a null sink and returns — so the store
		// stays empty forever, `/v1/tree` reports `needsInput: 0` for a visibly
		// blocked agent, `/v1/question` 404s, and every `/v1/answer` is
		// `410 stale_question`. The hook still answers `{success: true}` and
		// nothing logs. That is the silent-failure class this codebase forbids.
		//
		// The wrapper also owns the two side effects that must happen exactly when
		// custody changes — arming the delayed push, and retracting it — so that
		// `QuestionStore` stays a pure custody record with no outbound
		// dependencies.
		setCompanionQuestionSink(
			createNotifyingCaptureSink({
				inner: questions.asCaptureSink(),
				questions,
				push,
				events,
				logger,
			}),
		);
		assertQuestionSinkRegistered();
		// Pushed after every subsystem it fronts, so the reversed teardown clears it
		// before any of them (only the maintenance timers, pushed later still, go
		// first) and unconditionally: a live sink pointing at a stopping bridge
		// would keep accepting captures nothing will ever deliver, and
		// `setCompanionQuestionSink` throws on installing over a live sink — so
		// skipping it makes a stop/start cycle in one process fail at `start()`
		// instead of here.
		unwind.push({
			what: "question sink",
			close: async () => setCompanionQuestionSink(null),
		});

		/**
		 * (MIRROR-CHANGE-GSEQ) A curation change is a change to the tree, so it
		 * mints an event and moves `gseq`.
		 *
		 * The sidebar mirror is the one input to `/v1/tree` that was written
		 * entirely outside the bridge — the renderer's `sidebarMirror.sync`
		 * mutation replaces the rows and nothing here noticed — so `gseq` never
		 * moved for it. The phone's heartbeat compares `gseq` alone, kept answering
		 * `treeStale: false`, and went on stamping "updated just now" over a list
		 * whose pins, membership and placement had since changed. Nothing later
		 * could repair it: the change that mattered had already happened.
		 *
		 * Never throws into the mutation. The curation write has already committed
		 * by the time this runs, and a freshness signal must not turn a successful
		 * write into a failed tRPC call that the sidebar would then retry.
		 *
		 * (ALERT-RETIRE-ON-EXIT) IT NOW DOES TWO JOBS, in two independent
		 * try/catch blocks: mint the freshness frame, and retire the live alerts
		 * of any thread the user just put away. They share a trigger and nothing
		 * else, so neither may take the other down.
		 */
		const mirrorChangeSink = (change: CompanionMirrorChange): void => {
			try {
				events.publish({
					t: "tree.curation",
					d: {
						syncedAtMs: change.syncedAtMs as EpochMs,
						workspaceCount: change.workspaceCount,
						projectCount: change.projectCount,
					},
				});
			} catch (error) {
				logger.error(
					"could not publish tree.curation; the phone will fall back to its counts comparison for freshness",
					{ error },
				);
			}

			// (ALERT-RETIRE-ON-EXIT) The same write that moved `gseq` may have been
			// the user putting a thread AWAY — snoozing, archiving or removing it.
			// The push path already refuses to fire for a curated-off thread
			// `(PUSH-CURATION-GATE)`, but a card already on the handset was minted
			// before that decision and nothing took it back down.
			//
			// ITS OWN try/catch, AFTER and INDEPENDENT OF the publish above. The
			// two are unrelated jobs sharing one trigger: a freshness frame that
			// failed to mint must not cost the user a retraction, and a retraction
			// walk that threw must not cost them a fresh tree. The manager logs
			// what it retired, per workspace.
			try {
				lifecycleAlerts.retireCuratedOffAlerts();
			} catch (error) {
				logger.error(
					"could not retire alerts for curated-off threads; a notification may outlive the user putting its thread away",
					{ error },
				);
			}
		};
		setCompanionMirrorChangeSink(mirrorChangeSink);
		unwind.push({
			what: "sidebar mirror change sink",
			close: async () => clearCompanionMirrorChangeSink(mirrorChangeSink),
		});

		// 5. Maintenance. All unref'd: a background timer must never be the reason
		//    the process refuses to exit.
		//
		// (START-DEFER) The first compaction and the first prune run AT START, as
		// §3.5 requires ("compacted on start and every 5 minutes") — but on the
		// next turn of the loop rather than blocking the rest of `startInner`.
		// They are in `timers` so the teardown clears them: a bridge stopped inside
		// that first turn must not run maintenance against a closed replay cache.
		// (MAINTENANCE-DRAIN) Every maintenance task registers its in-flight run
		// here, so the teardown can WAIT for one that has already started rather
		// than only cancelling the ones that have not yet begun.
		const maintenanceInFlight: MaintenanceInFlight = new Set();
		const timers = [
			soon(() => nonceCache.compact(Date.now()), maintenanceInFlight),
			soon(() => audit.prune(Date.now()), maintenanceInFlight),
			interval(
				NONCE_CACHE_COMPACT_INTERVAL_MS,
				() => nonceCache.compact(Date.now()),
				maintenanceInFlight,
			),
			interval(DAY_MS, () => audit.prune(Date.now()), maintenanceInFlight),
			interval(
				DAY_MS,
				() => deviceStore.purgeExpiredRevocations(Date.now()),
				maintenanceInFlight,
			),
			interval(
				HOUR_MS,
				async () => {
					// The 24 h idempotency window (§11.5); the store owns the arithmetic.
					//
					// (LEDGER-KEEP-ATTEMPTS) The ANSWER ledger is deliberately absent here.
					// Every row in it is a fence — a confirmed answer, a claim in flight, a
					// `not_received` already promised to the phone — and deleting any of
					// them un-decides something announced as permanent. It only grows; see
					// `rotateEpoch`'s docblock for why that is the cheaper end of the
					// trade. `messageAttempts` is in-memory and fences nothing, so its
					// retention is ordinary bookkeeping.
					messageAttempts.prune(Date.now());
					// Lease expiry is otherwise lazy — a question or terminal that is
					// never revisited would keep its lapsed record until process exit.
					leases.sweep(Date.now());
				},
				maintenanceInFlight,
			),
		];

		state = {
			paths,
			hostDb,
			audit,
			anchor,
			deviceStore,
			keyStore,
			nonceCache,
			sendNonces,
			questions,
			leases,
			locks,
			ledger,
			messageAttempts,
			readApi,
			presence,
			pushFence,
			push,
			events,
			http,
			pairing: null,
			publicPairHost,
			teardown: unwind,
		};
		unwind.push({
			what: "maintenance timers",
			close: async () => {
				for (const timer of timers) clearInterval(timer);
				// (MAINTENANCE-DRAIN) Cancelling stops the next run; this waits out the
				// one already executing, so a maintenance task cannot still be holding a
				// file handle while later teardown steps close what it is writing to.
				//
				// BOUNDED, and that bound is not defensive dressing. `settle` imposes no
				// timeout and `stop()` runs inside the lifecycle's `exclusive()`, so an
				// unbounded wait here would let one `persist` stalled on a handle held by
				// an antivirus scanner or a search indexer — ordinary transients on this
				// platform — hang `stop()` forever, after which no `start()` could ever
				// run again. That would trade a data-corruption bug for a silent
				// permanent wedge, which is a worse failure: the corruption at least
				// announced itself at the next mount.
				//
				// Giving up is SAFE rather than a compromise, because correctness does
				// not rest here. Every store the drain covers refuses writes once closed
				// (STORE-CLOSED), so a task still running after this deadline can no
				// longer affect durable state — the wait is about handle lifetime, and a
				// handle outliving it is a logged nuisance, not a lie.
				//
				// Looped because a drained task may have queued another (`soon` fires on
				// the next turn of the loop) and the set mutates as runs settle. Every
				// tracked promise is already `.catch`ed, so this can neither reject nor
				// mask a failure.
				const deadline = Date.now() + MAINTENANCE_DRAIN_TIMEOUT_MS;
				while (maintenanceInFlight.size > 0) {
					if (Date.now() >= deadline) {
						logger.error("maintenance did not drain before the deadline", {
							stillRunning: maintenanceInFlight.size,
							timeoutMs: MAINTENANCE_DRAIN_TIMEOUT_MS,
							effect:
								"teardown continues; the stores are already closed so nothing it does can reach durable state",
						});
						break;
					}
					await Promise.race([
						Promise.all([...maintenanceInFlight]),
						sleep(MAINTENANCE_DRAIN_POLL_MS),
					]);
				}
			},
		});
		startedAtMs = http.startedAtMs;
		logger.info(
			`listening on http://${BRIDGE_HOST}:${BRIDGE_PORT} (app ${options.versions.appVersion}, fork ${options.versions.forkTag})`,
		);
		// (PROVEN-VERSION-DRIFT) Fire-and-forget on purpose: this is a diagnostic
		// about the picker contract, and start() must neither wait on a file read
		// nor fail because one threw. It reports; it never refuses.
		void resolveProvenVersionStatus()
			.then((status) => {
				logProvenVersionStatus(status, {
					info: (event) => logger.info(JSON.stringify(event)),
					warn: (event) => logger.warn(JSON.stringify(event)),
				});
			})
			.catch(() => {
				// Unknown is not drift; see `proven-version.ts`.
			});
	};

	const stop = (reason = "requested"): Promise<void> =>
		exclusive(async () => {
			// FIRST STATEMENT, mirroring `start`. Reaching here means no start is in
			// flight and none can begin until this returns — which is what stops a
			// stopping bridge's teardown from racing a new bridge's construction over
			// the same files. `state` was previously cleared BEFORE the asynchronous
			// closes below, so a start that slipped in behind it saw "not running"
			// while the old nonce source and replay cache were still open.
			if (phase !== "running") {
				return;
			}
			phase = "stopping";
			const current = state;
			if (!current) {
				phase = "stopped";
				return;
			}
			try {
				// (BRIDGE-TEARDOWN-ONE-LIST) Replay the SAME list `startInner` built,
				// reversed — the exact sequence a failed start unwinds. The order it
				// encodes is load-bearing and is documented at each `unwind.push`:
				// the maintenance timers stop first, then the question sink (a live
				// sink pointing at a stopping bridge would accept captures nothing
				// will deliver, and installing over it throws on the next `start()`);
				// the send-nonce source closes after the listener, so nothing can
				// still be sealing a response against a closed source; and the state
				// anchor — the ownership token for the on-disk state — goes last,
				// once nothing is left that could write. The final step is the port
				// reservation, already released one line before `http.start()`;
				// `release()` is idempotent, so replaying it is a deliberate no-op
				// rather than a second close.
				//
				// "Once nothing is left that could write" DEPENDS ON (MAINTENANCE-DRAIN)
				// and used to be false. The maintenance step cancelled its timers and
				// returned immediately, so a prune already executing kept running — and
				// with it a live reference to this bridge's own store instance — right
				// through the rest of this teardown and into the next bridge's lifetime.
				// The step now waits that run out, which is the only reason the ordering
				// described above actually holds rather than merely reading as if it
				// does.
				//
				// Every step is `settle`d: best-effort and isolated, so one failing
				// subsystem cannot skip the others, and every failure is LOGGED rather
				// than swallowed — the phone's only other signal that the bridge went
				// away is a watchdog timeout.
				for (const step of [...current.teardown].reverse()) {
					await settle(logger, step.what, step.close);
				}
			} finally {
				state = null;
				phase = "stopped";
			}
			logger.info(`stopped (${reason})`);
		});

	return {
		start,
		stop,
		async openPairing(): Promise<PairingWindowHandle> {
			const current = requireState();
			// The "one window at a time" rule is enforced by `pairing.ts`, which owns
			// the process-wide slot and refuses with the message the user sees. This
			// used to re-check a remembered handle here as well; the two could
			// disagree (a window that had expired in `pairing.ts` still looked open
			// here) and keeping them in sync was manual.
			//
			// A REJECTED OPEN MUST NOT FORGET THE LIVE ONE. Clearing this field
			// before the authoritative call meant a refused second open left the
			// window that caused the refusal unreachable from here — `closePairing`
			// answered "nothing was open" and the user could not dismiss it before
			// its 120 s were up. Only a handle that is already closed is dropped
			// eagerly, so `pairingState` never reports a stale one; the live handle
			// is replaced only by a successful open.
			if (current.pairing?.closed) {
				current.pairing = null;
			}
			const handle = await openPairingWindow(pairingDeps(current, logger));
			current.pairing = handle;
			// The QR URI carries the single-use pairing code and belongs only in the
			// authenticated desktop dialog. Diagnostics receive the non-secret window
			// reference, never the URI or any material from its fragment.
			logger.warn("pairing window OPEN for 120s", {
				pairingRef: handle.pairingRef,
				expiresAtMs: handle.expiresAtMs,
			});
			return handle;
		},
		/**
		 * (REMOTE-CODE-PAIRING) Opens the same single window in CODE mode.
		 *
		 * Refuses LOUDLY, and with the remedy in the message, when the public
		 * pairing host is not configured: the alternative is a dialog counting an
		 * 8-digit code down while every request from the phone reaches a host that
		 * serves nothing, which is indistinguishable from a broken phone.
		 */
		async openRemotePairing(): Promise<RemotePairingWindowHandle> {
			const current = requireState();
			if (current.publicPairHost === null) {
				throw new Error(
					`${LOG_PREFIX} pairing by code is not enabled on this machine. It needs a public pairing hostname (${PAIRING_PUBLIC_HOST}) pointed at this tunnel and declared to the bridge by ${current.paths.publicPairHost} ({"host": "${PAIRING_PUBLIC_HOST}"}). Create the DNS record and tunnel ingress, write that file, restart the host-service, and use the QR code in the meantime.`,
				);
			}
			// Same slot, same rule as `openPairing`, enforced in the same one place —
			// including "a refused open leaves the live handle alone".
			if (current.pairing?.closed) {
				current.pairing = null;
			}
			const handle = await openRemotePairingWindow(
				pairingDeps(current, logger),
			);
			current.pairing = handle;
			// (PAIR-REF-ONLY) The reference and the deadline. NEVER the code — 8
			// digits in a log file is a code somebody can simply type.
			logger.warn("code pairing window OPEN for 120s", {
				pairingRef: handle.pairingRef,
				expiresAtMs: handle.expiresAtMs,
			});
			return handle;
		},
		async closePairing(): Promise<boolean> {
			const current = requireState();
			const open = current.pairing;
			if (open === null || open.closed) {
				current.pairing = null;
				return false;
			}
			// Cleared AFTER the close, so a close that throws leaves the handle
			// reachable instead of stranding a live listener nothing can reference.
			// `close()` flips `closed` synchronously before its first await, so a
			// later `openPairing` is not blocked either way.
			await open.close();
			current.pairing = null;
			logger.info("pairing window closed early");
			return true;
		},
		async disableWrites(reason: string): Promise<number> {
			return applyDesktopPanic(requireState(), logger, "write_disable", reason);
		},
		async revokeAllDevices(reason: string): Promise<number> {
			return applyDesktopPanic(requireState(), logger, "unpair_all", reason);
		},
		async pairedDeviceCount(): Promise<number> {
			const records = await requireState().deviceStore.list();
			return records.filter((record) => record.revokedAtMs === null).length;
		},
		get startedAtMs(): number {
			return startedAtMs;
		},
		get running(): boolean {
			// The PHASE, not the presence of `state`. During teardown `state` is
			// still set while subsystems close, and during a failed start it is not
			// set at all; only the phase is true in both directions.
			return phase === "running";
		},
	};
}

/**
 * What a pairing window — QR or code — is allowed to do to this bridge, in ONE
 * place.
 *
 * (REMOTE-CODE-PAIRING) It is one place because the two flows differ ONLY in how
 * the code reaches the phone. Everything that happens once a device confirms —
 * the uniqueness check, the key write, the device record, the audit line — is
 * identical, and a second copy of it would be a second place for the §4.8
 * uniqueness rule to be forgotten.
 */
function pairingDeps(current: BridgeState, logger: BridgeLogger): PairingDeps {
	return {
		// Read at the last possible moment and never held by this module.
		loadAccessToken: async () =>
			loadAccessServiceToken(resolveCompanionPaths()),
		onPaired: async (input) => {
			// UNIQUENESS BEFORE KEY MATERIAL. §4.8 requires a new deviceId on
			// every pairing and `deviceStore.create` is the guard that enforces
			// it — but it used to run AFTER the key was already on disk. A
			// client that submitted an already-registered deviceId therefore
			// destroyed the live device's K_dev and only then got refused: the
			// surviving record still pointed at that keyRef, so the working
			// phone failed its GCM tag on every request and could not even open
			// the sealed explanation. `keyStore.put` now mints its own random
			// keyRef so a collision is unrepresentable, and this check makes the
			// refusal happen before anything is written at all.
			const existing = await current.deviceStore.get(input.deviceId);
			if (existing !== null) {
				throw new Error(
					`${LOG_PREFIX} refusing to pair: deviceId ${input.deviceId} is already registered — §4.8 requires a NEW deviceId per pairing`,
				);
			}
			const keyRef = await current.keyStore.put(
				input.deviceId,
				input.deviceKey,
			);
			let record: DeviceRecord;
			try {
				record = await current.deviceStore.create({
					deviceId: input.deviceId,
					label: input.label,
					surface: input.surface,
					keyRef,
					pairedAtMs: Date.now(),
				});
			} catch (error) {
				// Nothing references this key now, and leaving it would be an
				// orphaned K_dev on disk forever.
				await current.keyStore.destroy(keyRef).catch(() => undefined);
				throw error;
			}
			await current.audit.append({
				tsMs: Date.now(),
				kind: "pair",
				deviceId: record.deviceId,
				surface: record.surface,
				requestId: `pair:${record.deviceId}`,
				leaseId: null,
				questionId: null,
				terminalId: null,
				guards: null,
				guardsAbstained: null,
				payloadHash: hashJsonPayload({
					deviceId: record.deviceId,
					label: record.label,
					surface: record.surface,
				}),
				outcome: "confirmed",
				failureCode: null,
			});
			logger.info("paired device", {
				deviceId: record.deviceId,
				surface: record.surface,
			});
		},
	};
}

// ---------------------------------------------------------------------------
// the host-service mount (the single call added to serve.ts)
// ---------------------------------------------------------------------------

export function claudeConfigDirsForWorkspace(
	service: ClaudeAccountsService,
	workspaceId: string,
): readonly string[] {
	if (!isWorkspaceUuid(workspaceId)) return [];
	const globalDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
	if (!service.getCapability().managed) return [globalDir];
	const workspaceDir = service.profileDirFor(workspaceId);
	if (!existsSync(workspaceDir) || workspaceDir === globalDir)
		return [globalDir];
	return [workspaceDir, globalDir];
}

export interface CompanionMountInput {
	/** `env.HOST_DB_PATH`. */
	hostDbPath: string;
	/** The live drizzle handle from `createApp()` — same process, same pty writer. */
	db: HostDb;
	profileDirsForWorkspace: (workspaceId: string) => readonly string[];
	/**
	 * (MIRROR-ORG-GATE) `env.ORGANIZATION_ID` — the org THIS host-service is
	 * serving. Required, with no default: `host.db` is per machine and the
	 * sidebar mirror inside it is per org, so without something to compare
	 * against, a mirror left behind by a previous sign-in curates the current
	 * org's tree — and because ids never collide, that reads as "every project
	 * is not in the sidebar" and hides the whole tree. A composition root that
	 * cannot say which org it is serving must fail to compile rather than serve
	 * another org's curation.
	 */
	organizationId: string;
	/**
	 * The live store from `createApp()`. Taken as an explicit field rather than
	 * the whole `CreateAppResult` so the mount seam in serve.ts stays additive to
	 * upstream's destructure instead of restructuring it.
	 */
	terminalAgentStore: TerminalAgentStore;
}

/**
 * The whole surface serve.ts adds. Returns `null` when the feature is off, which
 * is the default: an internet-exposed listener that can type into terminals is
 * opt-in via `SUPERSET_COMPANION_BRIDGE=1` and is never enabled as a side effect
 * of a config file appearing on disk.
 *
 * ASYNC ON PURPOSE, AND IT NEVER REJECTS. The mount seam is a line inside
 * upstream's `serve()` listening callback; a synchronous throw there would abort
 * the rest of that callback (the relay connect, the shutdown handlers) and take
 * upstream functionality down with an opt-in fork feature. Every failure —
 * construction, config, listener — is therefore logged loudly here and leaves the
 * companion OFF. Loud and unavailable, never half-started, never silent, and
 * never at upstream's expense.
 *
 * IT ALSO PUBLISHES THE HANDLE (`companion/registry`). That callback is
 * synchronous, so the caller cannot await this and has nowhere to keep the
 * bridge; a discarded handle made `openPairing`, `closePairing`,
 * `disableWrites` and `revokeAllDevices` unreachable code — no device could
 * ever pair, and the desktop panic switch DESIGN promises existed only as a
 * route the lost phone would have to call. Registration happens AFTER a
 * successful `start()`, so nothing can ever reach a half-built bridge.
 */
export async function startCompanionBridgeIfEnabled(
	input: CompanionMountInput,
): Promise<CompanionBridge | null> {
	if (!isCompanionBridgeEnabled()) return null;

	try {
		const version: string = hostServicePackageJson.version;
		const bridge = createCompanionBridge({
			hostDbPath: input.hostDbPath,
			db: input.db,
			profileDirsForWorkspace: input.profileDirsForWorkspace,
			organizationId: input.organizationId,
			terminalAgentStore: input.terminalAgentStore,
			versions: {
				appVersion: version,
				hostServiceVersion: version,
				// "One version, ever" — desktop, host-service and cli share it.
				forkTag: `desktop-v${version}`,
			},
		});

		// Registered BEFORE start() so a signal landing mid-startup still runs the
		// orderly stop. The bridge dies with the desktop app; host-service watches
		// its PID. These handlers only make the ORDERLY exits clean and logged. A
		// hard kill, a crash, or a taskkill gives no shutdown at all, and the
		// phone's 3x heartbeat watchdog is then the only signal. That hole is known
		// and accepted; it is not papered over here.
		//
		// (SIGNAL-TERMINATE) THE HANDLER MUST END THE PROCESS. Registering a
		// listener for SIGINT/SIGTERM REMOVES Node's default terminate, and in the
		// standalone host-service bundle these are the only listeners for those
		// signals (serve.ts's own pair is inside `if (isDev)` and `build.ts` bakes
		// NODE_ENV=production). Without the exit below, `superset stop` SIGTERMs the
		// manifest pid, waits out its full 10 s poll while the HTTP listener keeps
		// the event loop alive, and then SIGKILLs — racing the orderly close it was
		// trying to give us — and console Ctrl+C stops stopping the host-service at
		// all. `process.exit` is called only AFTER `stop()` settles, so the orderly
		// close still happens; the code is 0 because an asked-for shutdown is not a
		// failure.
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			process.once(signal, () => {
				void bridge
					.stop(signal)
					// Unpublish LAST and unconditionally: a registry still handing out a
					// stopped bridge would answer `openPairing` with `requireState()`'s
					// throw instead of the honest "companion is not running".
					.finally(() => {
						clearCompanionBridge(bridge);
						process.exit(0);
					});
			});
		}

		await bridge.start();
		setCompanionBridge(bridge);
		return bridge;
	} catch (error) {
		console.error(
			`${LOG_PREFIX} FAILED TO START — companion is unavailable:`,
			error,
		);
		return null;
	}
}

// ---------------------------------------------------------------------------
// (COMPANION-CAPTURE-WIRE) the capture seam + its side effects
// ---------------------------------------------------------------------------

export interface NotifyingSinkDeps {
	/** `QuestionStore.asCaptureSink()` — validates HARD and owns custody. */
	inner: QuestionCaptureSink;
	questions: QuestionStore;
	push: PushSender;
	events: EventStreamServer;
	logger: BridgeLogger;
}

/**
 * (PUSH-CURATION-GATE) What it takes to ask whether a thread is on the sidebar:
 * the same read-only host.db reader `/v1/tree` reads curation through, and the
 * org that curation has to belong to.
 *
 * Its own interface rather than the sink's, because the question is now asked
 * from the PUSH SENDER's fire path (see `createIsCuratedOffProbe`), which is
 * built long before a capture sink exists and has no business holding one.
 */
export interface CurationGateDeps {
	db: HostDbReader;
	/** (MIRROR-ORG-GATE) Whose curation the mirror has to be, to count. */
	organizationId: string;
	logger: Pick<BridgeLogger, "info" | "error">;
}

/** Publishes one resolved-question frame without duplicating its wire shape. */
function publishQuestionResolved(
	events: EventStreamServer,
	data: Extract<EventFrame, { t: "question.resolved" }>["d"],
): void {
	events.publish({ t: "question.resolved", d: data });
}

/**
 * Wraps the store's capture sink with the effects that must fire exactly when
 * custody changes.
 *
 * ORDER MATTERS IN BOTH DIRECTIONS. On capture the store runs FIRST, so a
 * malformed payload is rejected before anything is armed. On resolve the record
 * is READ first (to learn its questionId) and the store is settled before the
 * push is retracted, so a retraction can never race ahead of the state it is
 * retracting.
 *
 * Nothing here swallows: `inner.capture` throws `CaptureRejectedError` on a
 * malformed capture and that throw propagates to the hook route, which is a
 * loud 500 in the notify hook's log. The dot work already happened by then, so
 * the agent-status broadcast is unaffected.
 */
export function createNotifyingCaptureSink(
	deps: NotifyingSinkDeps,
): CompanionQuestionSink {
	return {
		capture(input) {
			deps.inner.capture(input);
			const question = deps.questions.byHostTerminal(input.hostTerminalId);
			if (question === null) {
				// Captured and immediately superseded inside the same tick. Nothing to
				// arm — but say so, because a silent miss here is a question that
				// never buzzes.
				deps.logger.warn(
					"captured question was not pending immediately after capture; push not armed",
					{ hostTerminalId: input.hostTerminalId },
				);
				return;
			}
			armPush(deps, question);
			publishPendingQuestion(deps, question);
		},

		resolve(input) {
			const before = deps.questions.byHostTerminal(input.hostTerminalId);
			deps.inner.resolve(input);
			if (before === null || before.toolUseId !== input.toolUseId) return;
			if (before.state !== "resolved") return;

			// `QuestionStore.resolve` writes both fields BEFORE it settles the
			// record, so `state === "resolved"` means both are set. The type system
			// cannot see that, and the old `??` fallbacks papered over it — they read
			// as a reachable "resolved but we do not know by whom" case, which does
			// not exist. Assert the invariant instead of inventing a provenance.
			const { resolvedAtMs, resolvedBy } = before;
			if (resolvedAtMs === null || resolvedBy === null) {
				throw new Error(
					`${LOG_PREFIX} question ${before.questionId} is resolved but carries no resolvedAtMs/resolvedBy — refusing to publish a question.resolved frame with a fabricated provenance`,
				);
			}

			// §13.3 is handled by `(SETTLE-CHOKE-POINT)`: `inner.resolve` above
			// settled this record, and `settle()` retracted the notification on the
			// way out. This wrapper is left with the one effect that genuinely
			// belongs to the DESK route — the frame naming who answered.
			publishQuestionResolved(deps.events, {
				questionId: before.questionId,
				resolvedAtMs,
				resolvedBy,
				outcome: "answered",
			});
		},

		/**
		 * (MANUAL-DISMISS) The user cleared this terminal's status by hand. End the
		 * question as `stale`, not `resolved`.
		 *
		 * `resolve` is wrong here and the difference is visible on the phone:
		 * `QuestionStore.resolve` stamps `resolvedBy` provenance, so the tree would
		 * report a question as answered-at-the-desk that nobody answered, and the
		 * `question.resolved` frame would name a surface that never supplied an
		 * answer. `markStale` is the store's designated ending for "stopped being
		 * answerable, no answer exists" and stamps nothing.
		 *
		 * It also does the retraction for free: `markStale` -> `settle()` ->
		 * `onSettled` -> `push.cancelPending`, the `(SETTLE-CHOKE-POINT)` path every
		 * other ending takes, so the phone notification is pulled without this
		 * wrapper touching `push` at all.
		 *
		 * `markStale` no-ops on a record that is already settled, so a dismissal
		 * racing an answer cannot un-answer anything.
		 *
		 * FENCED ON `dismissStartedAtMs`, exactly as the marker sweep is. The
		 * pending record this reads is whatever is pending NOW, which is not
		 * necessarily the question the user was looking at: an agent that raised a
		 * new AskUserQuestion between the click and this call owns the pending slot
		 * by the time it runs. Settling THAT one is terminal and unrecoverable — the
		 * phone alert is retracted, `/v1/answer` returns 410, and the agent stays
		 * blocked with nothing left to answer it from — so a question that is not
		 * provably older than the click is left strictly alone. Same direction and
		 * same boundary as `clearPendingQuestionMarkers`: equal timestamps do not
		 * prove precedence, so they survive.
		 */
		dismissByTerminal(input) {
			const question = deps.questions.byHostTerminal(input.hostTerminalId);
			if (question === null) return false;
			if (question.askedAtMs >= input.dismissStartedAtMs) {
				deps.logger.info(
					"not dismissing a companion question raised at or after the user's click; it is a question they have never seen and the phone must keep being able to answer it",
					{
						questionId: question.questionId,
						askedAtMs: question.askedAtMs,
						dismissStartedAtMs: input.dismissStartedAtMs,
					},
				);
				return false;
			}

			// The reason reaches `markStale` only as a log line (it is not stored on
			// the record), which is why the frame below names the constant rather
			// than reading a reason back off the question.
			deps.questions.markStale(question.questionId, input.reason);

			// Same guard as `publishSettledQuestion`: a frame nobody can currently
			// receive must not turn a dismissal that already happened — markers gone,
			// record settled, push retracted — into a reported failure.
			try {
				deps.events.publish({
					t: "question.stale",
					d: {
						questionId: question.questionId,
						reason: QUESTION_STALE_MANUAL_DISMISS_REASON,
					},
				});
			} catch (error) {
				deps.logger.error(
					"could not publish the manual-dismissal event; the phone will fall back to its counts comparison for freshness",
					{ questionId: question.questionId, error },
				);
			}
			return true;
		},
	};
}

interface RemoteAnswerPublisherDeps {
	questions: QuestionStore;
	events: EventStreamServer;
	logger: BridgeLogger;
}

/**
 * Records phone/watch provenance and republishes only when positive settlement
 * won the race. Pending records are published later by the capture sink's
 * `resolve`; an already-resolved record needs this corrective frame now.
 *
 * This post-write bookkeeping never throws into the confirmed answer path.
 */
export function markRemoteAnsweredAndPublish(
	deps: RemoteAnswerPublisherDeps,
	questionId: QuestionId,
	resolvedBy: NonNullable<PendingQuestion["resolvedBy"]>,
	deliveredAtMs: EpochMs,
): void {
	try {
		const wasResolved = deps.questions.get(questionId)?.state === "resolved";
		if (
			!deps.questions.markRemoteAnswered(
				questionId,
				resolvedBy,
				deliveredAtMs,
			) ||
			!wasResolved
		) {
			return;
		}
		publishQuestionResolved(deps.events, {
			questionId,
			resolvedAtMs: deliveredAtMs,
			resolvedBy,
			outcome: "answered",
		});
	} catch (error) {
		deps.logger.error("could not record remote answer provenance", {
			questionId,
			error,
		});
	}
}

/**
 * (PUSH-CURATION-GATE) Is this question's thread one the user has taken OFF
 * their sidebar?
 *
 * `/v1/tree` has consumed the sidebar mirror since `(BRIDGE-SIDEBAR-FILTER)`
 * shipped, but the push path never did, because arming does not go through the
 * read API — it hangs off the capture sink. The result was the loudest possible
 * disagreement between two surfaces of the same feature: a binned, archived,
 * completed or snoozed thread would buzz the user's WATCH, and tapping the
 * notification would open a tree that does not contain it. Snooze is the worst
 * of the four, because "not now" is precisely a statement about being
 * interrupted.
 *
 * ASKED AT FIRE TIME, NOT AT ARM TIME, and the difference is the whole
 * correctness of the gate. Curation is REVOCABLE — a snooze expires by itself,
 * an archive or a bin is undone by hand — while `armPush` runs exactly once, at
 * capture. Refusing to arm therefore turned a revocable "not now" into an
 * irrevocable "never": the question kept its place in the tree, kept counting as
 * unanswered, and had no fence row left for anything to reconsider, so the
 * snooze the user set for twenty minutes silenced that question for its whole
 * six-hour life. Answered from the sweep instead, the same verdict means only
 * "not this sweep", and the buzz lands on the first sweep after the curation
 * lapses. See `createIsCuratedOffProbe` for the caching and the log discipline
 * that being asked every two seconds requires.
 *
 * EVERY UNCERTAIN ANSWER BUZZES. This is a notification gate, and losing a buzz
 * for a genuinely blocked agent is the one failure the feature cannot absorb,
 * so the only thing that holds is a positive `!== "show"` verdict from an
 * ENABLED curation about a workspace row that exists:
 *
 *  - curation disabled (never synced, aged out, another org) -> fire;
 *  - no `workspaces` row for the question's host workspace -> fire. Absence is
 *    "no opinion recorded" everywhere else in this feature and it is here too;
 *  - anything thrown while asking (a locked db, a read-only reader that lost
 *    its file) -> fire, and say so.
 *
 * Holds are logged individually and by verdict. A held push is invisible from
 * both ends — no buzz on the wrist, and the tree the user is not looking at —
 * so this line is the only evidence the decision was taken at all.
 */
export function isCuratedOffSidebar(
	deps: CurationGateDeps,
	question: PendingQuestion,
): boolean {
	try {
		const verdict = workspaceSidebarVerdict({
			snapshot: deps.db.readSidebarMirror(),
			nowMs: Date.now(),
			organizationId: deps.organizationId,
			workspace: deps.db.findWorkspace(question.hostWorkspaceId),
		});
		if (verdict === "show") return false;
		deps.logger.info(
			"holding a push: the user has taken this thread off their sidebar, and the tree the notification would open does not contain it. It will fire on the first sweep after that changes",
			{
				questionId: question.questionId,
				hostWorkspaceId: question.hostWorkspaceId,
				verdict,
			},
		);
		return true;
	} catch (error) {
		deps.logger.error(
			"could not read sidebar curation while deciding whether to fire a push — firing anyway, because a missed buzz for a blocked agent is the worse failure",
			{ questionId: question.questionId, error },
		);
		return false;
	}
}

/**
 * (PUSH-CURATION-GATE) The fire-time probe `PushSenderDeps.isCuratedOff` is
 * wired to: `isCuratedOffSidebar` narrowed from a question record to the
 * questionId the scheduler holds, plus the two things being asked every two
 * seconds for up to six hours makes necessary.
 *
 * A QUESTION THIS STORE HAS NEVER SEEN ANSWERS `false`. That is the restart
 * case — the fence is durable and rebuilds `armed`, `QuestionStore` is memory
 * only and starts empty — and it is deliberately NOT this gate's to act on:
 * `createFireVerdictProbe` sits immediately after and drops that entry with the log
 * line that names the restart. Holding it here instead would swallow the entry
 * silently and forever.
 *
 * CACHED PER QUESTION FOR `CURATION_RECHECK_MS`. The sweep runs every
 * `PUSH_SWEEP_INTERVAL_MS` (2s) and a held question lives up to
 * `PUSH_QUESTION_EXPIRY_MS` (6h), so the uncached probe is ~10,800 reads of the
 * whole sidebar mirror per held question, synchronously, on the host-service's
 * only thread. The cost of the cache is that a lapsed snooze buzzes up to
 * `CURATION_RECHECK_MS` late, which is nothing next to the presence lapse the
 * push was already waiting on.
 *
 * LOGGED ON TRANSITION, NOT PER SWEEP, for the same arithmetic: the hold line
 * matters exactly once per episode, and 1,800 copies of it an hour would bury
 * the fault lines it sits next to. A hold that lapses and is re-taken logs
 * again, because that is a different episode. Rows for questions that ended
 * WHILE held are pruned by age — see `pruneDeadRows`.
 */
export function createIsCuratedOffProbe(deps: {
	questions: Pick<QuestionStore, "get">;
	db: HostDbReader;
	organizationId: string;
	logger: BridgeLogger;
	now?: () => number;
}): (questionId: QuestionId) => boolean {
	const now = deps.now ?? (() => Date.now());
	const cache = new Map<QuestionId, { held: boolean; checkedAtMs: number }>();
	/** Quiet `info`, real `error`: a repeat hold is noise, a failed read never is. */
	const quiet: CurationGateDeps["logger"] = {
		info: () => {},
		error: (message, fields) => deps.logger.error(message, fields),
	};
	/**
	 * A cached hold is re-read only while its question is still armed, and the
	 * sweep drops an armed entry at `askedAtMs + PUSH_QUESTION_EXPIRY_MS` at the
	 * latest. A row older than that window therefore belongs to a question that
	 * was answered, expired or fired WHILE HELD — the one path that leaves a row
	 * nobody will ever ask about again — so dropping it can lose neither a hold
	 * nor a log decision. Walked only past a cap, so a handful of genuinely held
	 * questions never pays for the sweep.
	 */
	function pruneDeadRows(nowMs: number): void {
		if (cache.size <= CURATION_CACHE_SOFT_MAX) return;
		for (const [questionId, row] of cache) {
			if (nowMs - row.checkedAtMs > PUSH_QUESTION_EXPIRY_MS) {
				cache.delete(questionId);
			}
		}
	}
	return (questionId: QuestionId): boolean => {
		const nowMs = now();
		const cached = cache.get(questionId);
		// (CLOCK-STEP-FAILS-OPEN) A NEGATIVE age is a cache MISS, not the freshest
		// possible hit. `now` is a wall clock and an NTP correction or a resume can
		// step it backwards; with only the upper bound checked, a row stamped
		// "after" the current instant satisfied the window for as long as the step
		// lasted, and because the only thing worth caching here is a HOLD, that
		// latched the hold — a snoozed thread whose snooze had since lapsed stayed
		// silent until the clock caught up. Re-reading the mirror is the same cost
		// as the first read, and this gate's contract is that every uncertain
		// answer buzzes.
		const ageMs = nowMs - (cached?.checkedAtMs ?? 0);
		if (cached !== undefined && ageMs >= 0 && ageMs < CURATION_RECHECK_MS) {
			return cached.held;
		}
		const question = deps.questions.get(questionId);
		if (question === null) {
			// Not cached: there is nothing to re-ask about, and `fireVerdict`
			// is about to forget this entry anyway.
			cache.delete(questionId);
			return false;
		}
		const held = isCuratedOffSidebar(
			{
				db: deps.db,
				organizationId: deps.organizationId,
				// Log the hold only when it is NEW — see the note above.
				logger: cached?.held === true ? quiet : deps.logger,
			},
			question,
		);
		if (held) {
			cache.set(questionId, { held, checkedAtMs: nowMs });
			pruneDeadRows(nowMs);
			return true;
		}
		// A question that is going to fire is leaving `armed` on this very sweep,
		// so its entry would never be read again. Drop it rather than let the map
		// accumulate one row per push for the life of the process.
		cache.delete(questionId);
		return false;
	};
}

/**
 * §13 — arm the delayed push for a newly captured question.
 *
 * ARMS UNCONDITIONALLY. `(PUSH-CURATION-GATE)` used to decline here, which left
 * a suppressed question with no fence row at all; the gate now lives on the fire
 * path (`PushSenderDeps.isCuratedOff`), so every captured question gets its
 * durable row, restart reconstruction keeps working for all of them, and
 * curation decides only whether a given sweep may fire.
 *
 * `schedule` is idempotent per questionId and validates its own payload at the
 * call site (a text leak or a bad count throws HERE, not in three minutes). A
 * throw is logged rather than propagated: a broken push must not turn a
 * successfully captured question into a 500 that loses the capture too. It is
 * LOUD — `PushSender.getFault()` and this line are how "the watch will stay
 * silent" becomes visible instead of presenting as "no questions".
 */
export function armPush(
	deps: NotifyingSinkDeps,
	question: PendingQuestion,
): void {
	try {
		deps.push.schedule({
			questionId: question.questionId,
			workspaceId: deriveHandle(
				"workspace",
				question.hostWorkspaceId,
			) as WorkspaceId,
			questionCount: question.questions.length,
			expiresAtMs: question.askedAtMs + PUSH_QUESTION_EXPIRY_MS,
			// (PUSH-ARMED-ORPHAN) Persisted with the fence row so a restart can
			// judge this push instead of discarding it.
			// `transcriptPath` is `""` when host.db could not derive one, which the
			// fence stores as null — "cannot check", never "resolved".
			//
			// (ALERT-CONTEXT-NAMES) The two host ids are ALSO read at fire time to
			// resolve the names the notification carries, so "none of it goes to
			// FCM" — which this comment used to say — is no longer true of them.
			// What still holds is the rule that matters: the ids themselves never
			// cross the wire. They are looked up locally, and only the resulting
			// project/workspace/tab names travel, under the waiver at the head of
			// `push.ts`. `transcriptPath` and `toolUseId` remain purely local.
			hostTerminalId: question.hostTerminalId,
			hostWorkspaceId: question.hostWorkspaceId,
			transcriptPath: question.transcriptPath,
			toolUseId: question.toolUseId,
		});
	} catch (error) {
		deps.logger.error(
			"failed to arm the delayed push for a captured question — the watch will not buzz for it",
			{ questionId: question.questionId, error },
		);
	}
}

/**
 * (TREE-FRESHNESS-GSEQ) A NEW QUESTION IS A CHANGE TO THE TREE, so it mints an
 * event and moves `gseq`.
 *
 * The phone decides whether the list on screen is still evidence about NOW from
 * two things the heartbeat gives it: `treeStale` (this `gseq`, compared against
 * the one the tree it holds was stamped with) and the status counts. Until this
 * existed, `gseq` moved for exactly one reason — a question RESOLVING — so a
 * capture had to be caught by the counts alone, and the counts do not always
 * move: `deriveSessionStatus` already reports `needs_input` for a terminal whose
 * binding is latched on `PermissionRequest`, which is the state a terminal is
 * left in after `(QUESTION-EXPIRY)` settles a question stale, or in the window
 * after a desk answer before the next hook event lands. A question captured on
 * such a terminal changed nothing either signal could see, so the phone kept
 * stamping "updated just now" over a list with no tappable card for a live
 * blocked agent.
 *
 * Published for EVERY capture, including one `(PUSH-CURATION-GATE)` will hold a
 * push for. The two gates answer different questions — that one is about
 * interrupting the user, this one is about whether a list they are already
 * looking at is current — and they fail in the same safe direction: a spurious
 * `gseq` bump costs one refetch, a missing one costs a blocked agent nobody sees.
 *
 * `BRIDGE_CAPABILITIES` is the right context for `answerable` here and not a
 * shortcut: a broadcast frame has no device, so the only question it can answer
 * is "could a fully-granted device answer this?". Per-device narrowing is
 * §9.2's snapshot, which is built per socket.
 *
 * Never throws into the capture path. A capture that succeeded must not be
 * turned into a 500 by a freshness signal, and `events.ws` is deliberately
 * ungranted today, so the frame's only live effect IS the `gseq` bump.
 */
export function publishPendingQuestion(
	deps: NotifyingSinkDeps,
	question: PendingQuestion,
): void {
	try {
		const summary = deps.questions.summarize(question, {
			granted: BRIDGE_CAPABILITIES,
		});
		if (summary === null) {
			deps.logger.warn(
				"captured question could not be summarised (its terminal no longer resolves in host.db); no question.pending frame was published",
				{ questionId: question.questionId },
			);
			return;
		}
		deps.events.publish({ t: "question.pending", d: summary });
	} catch (error) {
		deps.logger.error(
			"could not publish question.pending; the phone will fall back to its counts comparison for freshness",
			{ questionId: question.questionId, error },
		);
	}
}

/**
 * (QUESTION-EXPIRY) The push sender's fire-time re-check.
 *
 * Extracted from the composition root so the THREE-WAY split it makes can be
 * exercised without booting a bridge; `createCompanionBridge` is the only
 * production caller.
 *
 * Re-checked at fire time because the scheduler never trusts that
 * `cancelPending` was called: a missed cancel would buzz the watch for a
 * question already answered, which is the exact noise the presence gate exists
 * to remove. Liveness is re-checked here too, and it is not redundant with the
 * heartbeat's `reconcile` — a held push fires on presence lapse, which can be
 * hours after capture and at a moment no heartbeat has run, so this is the last
 * point at which "the terminal you are about to be buzzed about no longer
 * exists" can still be noticed.
 *
 * IT ANSWERS WITH A VERDICT, NOT A BOOLEAN, because the two ways of not firing
 * are not the same kind of fact and the caller must not treat them alike:
 *
 *  - `"settled"` — the record is no longer `pending`, or this store has never
 *    seen it. Both are one-shot and final. The second is the RESTART case:
 *    eviction cannot produce it (`evictOldestSettled` and `prune` both skip
 *    pending records by construction), the push fence is durable and rebuilds
 *    `armed` at construction while `QuestionStore` is memory-only and starts
 *    empty, so every push held across a host-service restart lands here. It is
 *    LOGGED because the cost is real and otherwise invisible.
 *  - `"gone"` — positive, non-empty-listing evidence that the question's
 *    terminal no longer exists. ONE observation, and the sweep is required to
 *    corroborate it before acting (`PUSH_GONE_CORROBORATION_MS`); see the hold
 *    in `evaluate`.
 *
 * `"fire"` is everything else. An unreachable daemon, a stale snapshot or an
 * empty listing all KEEP the buzz — the predicate is the strict
 * `isProvablyGone`, never `!isLive`.
 */
export function createFireVerdictProbe(deps: {
	questions: Pick<QuestionStore, "get">;
	liveness: Pick<TerminalLiveness, "isProvablyGone">;
	/** host.db's newest instant for the row; keeps a young terminal from losing the race. */
	resolveTerminalActivityMs(hostTerminalId: string): number | null;
	logger: Pick<BridgeLogger, "error">;
}): (questionId: QuestionId) => PushFireVerdict {
	return (questionId: QuestionId): PushFireVerdict => {
		const question = deps.questions.get(questionId);
		if (question === null) {
			deps.logger.error(
				"a held push names a question this store has never seen — the host-service restarted after it was armed (the fence is durable, the question store is memory-only); dropping the buzz because the question can no longer be served or answered",
				{ questionId },
			);
			return "settled";
		}
		if (question.state !== "pending") return "settled";
		if (
			deps.liveness.isProvablyGone(
				question.hostTerminalId,
				deps.resolveTerminalActivityMs(question.hostTerminalId),
			)
		) {
			return "gone";
		}
		return "fire";
	};
}

/**
 * (CAPABILITY-WIRING-ASSERT) Fail at BOOT, not at first use.
 *
 * Every capability `http.ts` gates a route on must be either granted or listed
 * here as deliberately withheld with a reason. `push.fcm` spent a whole build in
 * neither state: `/v1/device/register` returned a sealed 501 on every call, so
 * no device could ever store an FCM token, and the only symptom was a watch that
 * never buzzed.
 */
const DELIBERATELY_UNGRANTED_CAPABILITIES: Readonly<
	Partial<Record<Capability, string>>
> = {
	"events.ws":
		"createSnapshotSource() still throws; §9.2 requires a snapshot as frame 1",
};

function assertCapabilityWiring(): void {
	const missing = ROUTE_GATED_CAPABILITIES.filter(
		(capability) =>
			!BRIDGE_CAPABILITIES.includes(capability) &&
			DELIBERATELY_UNGRANTED_CAPABILITIES[capability] === undefined,
	);
	if (missing.length > 0) {
		throw new Error(
			`${LOG_PREFIX} capability wiring is inconsistent: ${missing.join(", ")} gate a route but are neither in BRIDGE_CAPABILITIES nor listed as deliberately withheld. Every route gated on them would answer 501 forever.`,
		);
	}
}

/**
 * (COMPANION-CAPTURE-WIRE) Proof the seam is live, so a future edit that drops
 * the registration fails at start rather than running inert.
 */
function assertQuestionSinkRegistered(): void {
	if (getCompanionQuestionSink() === null) {
		throw new Error(
			`${LOG_PREFIX} the question capture sink is not registered — every AskUserQuestion would be dropped and the bridge would report zero blocked agents`,
		);
	}
}

// ---------------------------------------------------------------------------
// host-service adapters
// ---------------------------------------------------------------------------

interface AnswerAdapterDeps {
	/** Live drizzle handle — `snapshotSession` adopts a session, so it writes. */
	db: HostDb;
	hostDb: HostDbReader;
	/** (BRIDGE-LIVENESS) Gates the wire-handle reverse lookup. */
	liveness: TerminalLiveness;
	questions: QuestionStore;
	events: EventStreamServer;
	leases: LeaseRegistry;
	locks: TerminalLockRegistry;
	ledger: AttemptLedger;
	messageAttempts: MessageAttemptStore;
	audit: AuditLog;
	agents: TerminalAgentStore;
	logger: BridgeLogger;
	/** §6.3 — this mount's start instant, reported by `/v1/answer/status`. */
	bridgeStartedMs: EpochMs;
}

/**
 * Binds the answer path to host-service.
 *
 * Wire ids are OPAQUE handles (§0.1), not host ids, so every adapter first maps
 * back through `deriveHandle` — the same deterministic function question-store
 * mints with. An unmappable handle is `null`, never a guess.
 *
 * `writer` is the acknowledged RAW pty write and is the only thing that drives
 * a picker: bracketed-paste framing is INERT against it, and ordinary terminal
 * input cannot report daemon refusal. `createRawPtyWriter` checks the explicit
 * runtime marker at startup so either wrong path fails loud.
 */
function createAnswerDeps(deps: AnswerAdapterDeps): AnswerDeps {
	const hostTerminalIdOf = (terminalId: TerminalId): string | null =>
		findActiveHostTerminalId(deps.hostDb, deps.liveness, terminalId);

	/**
	 * Both host ids in ONE lookup, because the pty writer needs the pair and
	 * resolving them separately is how the wire handle previously ended up being
	 * passed as `terminalId` alongside a correctly-mapped `workspaceId`.
	 */
	const resolveHostTerminal = async (
		terminalId: TerminalId,
	): Promise<HostTerminalRef | null> => {
		const hostTerminalId = hostTerminalIdOf(terminalId);
		if (hostTerminalId === null) return null;
		const hostWorkspaceId =
			deps.hostDb.findTerminal(hostTerminalId)?.originWorkspaceId ?? null;
		if (hostWorkspaceId === null) return null;
		return { hostTerminalId, hostWorkspaceId };
	};

	const writeInput = Object.assign(
		(input: RawWriteInput) => writeAcknowledgedInputToSession(input),
		{
			writerKind: RAW_PTY_WRITER_KIND,
			prepare: (input: RawWriteTarget) =>
				prepareAcknowledgedInputSession({ ...input, db: deps.db }),
		},
	);

	return {
		writeInput,
		nudgeRepaint: ({ hostTerminalId, hostWorkspaceId }) =>
			nudgeTerminalSessionRepaint({
				terminalId: hostTerminalId,
				workspaceId: hostWorkspaceId,
			}),
		async writeFramed({ terminalId, workspaceId, text, submit }) {
			return writeFramedInputToSession({
				terminalId,
				workspaceId,
				text,
				submit,
				db: deps.db,
			});
		},
		async snapshotScreen(terminalId: TerminalId): Promise<string> {
			const host = await resolveHostTerminal(terminalId);
			if (host === null) {
				// The picker check must never pass on an empty screen.
				throw new Error(
					`${LOG_PREFIX} cannot resolve terminal ${terminalId} — refusing to snapshot`,
				);
			}
			// TWO snapshots, and the first one is deliberate.
			//
			// `snapshotSession` with no `maxLines` returns `buffer.active` from line
			// 0 — for the NORMAL buffer that is the viewport PLUS up to 1 000 lines
			// of scrollback. Claude Code renders its conversation inline in the
			// normal buffer (it is not an alt-screen TUI), so every earlier render of
			// every earlier picker is in that text, and the whitespace-stripped
			// matcher would confirm "the picker is on screen" against one the user
			// closed minutes ago while the viewport shows a composer, refusing a
			// message that was perfectly safe to send.
			//
			// `maxLines` has to be the live row count, and the row count only comes
			// back on a snapshot — so the first call asks for ONE line purely to read
			// `rows` (O(1); `rows` is `term.rows` and is independent of `maxLines`),
			// and the second returns exactly the viewport.
			const probe = await snapshotSession({
				terminalId: host.hostTerminalId,
				workspaceId: host.hostWorkspaceId,
				maxLines: 1,
				db: deps.db,
			});
			if ("error" in probe) {
				throw new Error(
					`${LOG_PREFIX} screen snapshot failed for ${terminalId}: ${probe.error}`,
				);
			}
			if (!Number.isInteger(probe.rows) || probe.rows <= 0) {
				throw new Error(
					`${LOG_PREFIX} terminal ${terminalId} reported ${probe.rows} rows — refusing to bound the viewport snapshot on it`,
				);
			}
			const result = await snapshotSession({
				terminalId: host.hostTerminalId,
				workspaceId: host.hostWorkspaceId,
				maxLines: probe.rows,
				db: deps.db,
			});
			if ("error" in result) {
				throw new Error(
					`${LOG_PREFIX} screen snapshot failed for ${terminalId}: ${result.error}`,
				);
			}
			return result.text;
		},

		locks: deps.locks,
		leases: deps.leases,
		ledger: deps.ledger,
		messageAttempts: deps.messageAttempts,
		questions: deps.questions,
		markRemoteAnsweredAndPublish: (questionId, resolvedBy, deliveredAtMs) =>
			markRemoteAnsweredAndPublish(deps, questionId, resolvedBy, deliveredAtMs),
		audit: deps.audit,
		now: (): EpochMs => Date.now(),
		delay: sleep,
		bridgeStartedMs: deps.bridgeStartedMs,

		resolveHostTerminal,

		// FORGEABLE, and used only by `/v1/message`. `(ANSWER-GUARDLESS)` answer
		// injection deliberately never calls this adapter.
		async agentBinding(
			terminalId: TerminalId,
		): Promise<TerminalAgentInfo | null> {
			const hostTerminalId = hostTerminalIdOf(terminalId);
			if (hostTerminalId === null) return null;
			const binding = deps.agents.get(hostTerminalId);
			if (!binding) return { kind: "none", bound: false, agentSessionId: null };
			return {
				// (BRIDGE-AGENT-KIND) definitionId FIRST, agentId as the fallback.
				//
				// This used to read `definitionId` alone, and on this machine that
				// column is NULL on every persisted binding — the notify hook does not
				// supply it — so this answered `unknown` for healthy Claude
				// terminals and `/v1/answer` refused three consecutive attempts on one
				// live question with "unsupported agent kind: unknown", while
				// `/v1/tree` rendered the same terminal as Claude from `agent_id`.
				// Custom agent configs make it worse: their definition ids are UUIDs,
				// which would read `unknown` even when the column IS populated.
				kind: resolveAgentKind(binding),
				bound: true,
				agentSessionId: binding.agentSessionId ?? null,
			};
		},

		// `/v1/message` only. `null` when the wire handle cannot be resolved.
		async sessionActive(terminalId: TerminalId): Promise<GuardSourceResult> {
			const hostTerminalId = hostTerminalIdOf(terminalId);
			if (hostTerminalId === null) return null;
			return isLiveTerminalSession(hostTerminalId);
		},

		// FORGEABLE, and used only to keep `/v1/message` off an open picker. The
		// axis is `TerminalAgentBinding.lastEventType`, written by the same hook
		// receiver and hydrated from host.db's `terminal_agent_bindings` — the SAME
		// store `agentBinding` reads, in this process. (An earlier revision
		// returned `null` here on the grounds that the axis "lives in renderer
		// storage the bridge cannot reach". It does not; the renderer's dot has its
		// own copy.) `null` when there is no binding at all, which is a refusal.
		async permissionAxisLatched(
			terminalId: TerminalId,
		): Promise<GuardSourceResult> {
			const hostTerminalId = hostTerminalIdOf(terminalId);
			if (hostTerminalId === null) return null;
			const binding = deps.agents.get(hostTerminalId);
			if (!binding) return null;
			return binding.lastEventType === PERMISSION_REQUEST_EVENT_TYPE;
		},

		log(event: Record<string, unknown>): void {
			deps.logger.info("answer", event);
		},
	};
}

/**
 * §9.2 mandates a snapshot as the FIRST frame of every socket. Building it needs
 * the per-session `granted` capability set that only the sealed pipeline holds,
 * so there is no honest way to synthesise it here yet.
 *
 * It THROWS rather than emitting an empty tree: a phone that connects and is
 * told "nothing is pending" is worse than one that cannot connect.
 *
 * (EVENTS-WS-PRECONDITIONS) `events.ws` needs BOTH this AND a publisher. The
 * publisher half is wired for every session-independent frame: `question.pending`
 * on capture and `question.resolved`/`question.stale` on a settle
 * (`(TREE-FRESHNESS-GSEQ)`), so `currentGseq()` advances on every transition of
 * the pending set and `HeartbeatResponse.treeStale` is both satisfiable and
 * complete. What is still missing, and blocks the grant, is the PER-SESSION
 * projection: this snapshot. A broadcast `QuestionSummary` carries `answerable`
 * evaluated against `BRIDGE_CAPABILITIES` — "could a fully-granted device answer
 * this?" — which is the honest answer for a frame that has no device, but a
 * SOCKET must narrow it to its own grants before rendering an affordance, and
 * that narrowing lives in the snapshot. Supply a real `EventSnapshotSource`,
 * then grant the capability in `config.ts`.
 */
function createSnapshotSource(): EventSnapshotSource {
	const unavailable = (): never => {
		throw new Error(
			`${LOG_PREFIX} event-stream snapshot source is not wired. §9.2 requires a snapshot as frame 1, and it needs the session's granted capabilities. Supply an EventSnapshotSource backed by the tree projection before enabling the events.ws capability.`,
		);
	};
	return {
		async snapshot() {
			return unavailable();
		},
		async counts() {
			return unavailable();
		},
	};
}

/**
 * §7.5 / §11.2. `confirmedBiometric` is a BARE CLIENT BOOLEAN: a required
 * precondition, never proof. This policy refuses a request that does not even
 * claim presence, and records evidence naming exactly how weak the claim is — an
 * audit trail must never assert stronger proof than was presented.
 *
 * Upgrading it (a Keystore-signed presence assertion over
 * `requestId || questionId || fingerprint`) is a PROTOCOL change, not a policy
 * swap, and is deliberately not invented here.
 */
function createClientClaimFreeTextPolicy(
	logger: BridgeLogger,
): FreeTextAuthorizationPolicy {
	return {
		async authorize({ kind, claimedByClient }) {
			if (claimedByClient !== true) {
				throw badRequest(`${kind} requires confirmedBiometric: true`);
			}
			logger.info("free-text authorised on a client claim only", { kind });
			return { evidence: "client-claim:confirmedBiometric" };
		},
	};
}

interface BridgePortReservation {
	/** Idempotent. Releasing twice is a no-op, not an error. */
	release(): Promise<void>;
}

/**
 * (PORT-BEFORE-STATE) Binds 127.0.0.1:47610 and holds it.
 *
 * The port is the bridge's one genuinely exclusive resource and the only thing
 * that decides which process can actually serve the phone. Holding it across
 * the whole store-construction path means a second bridge instance fails HERE —
 * before `openStateAnchor`, before `claimSend`, before it can take the
 * send-nonce counter away from the instance that is serving — and fails in
 * itself rather than in the other process.
 *
 * It binds with `exclusive: true` so the OS refuses a second bind rather than
 * load-balancing across them. §1.1 forbids a fallback port, so a failure to bind
 * is fatal and says exactly what it means.
 *
 * IT MUST DESTROY WHAT IT ACCEPTS, and that is not a nicety. A `net.Server` with
 * no `connection` listener still accepts the TCP connection and holds the socket;
 * `close()` then "keeps existing connections" and does not call back until every
 * one of them ends. `cloudflared` runs as a Windows service independent of
 * Superset and dials 47610 on every request the phone makes, so a single probe
 * arriving during the store-construction window would leave `release()` pending
 * forever — `await portReservation.release()` sits one line before `http.start()`,
 * so the bridge would never listen, never fail, and never log a reason. Destroying
 * each connection on arrival keeps the reservation a pure lock: the caller sees a
 * reset (cloudflared reports 502, which §8 already means "Superset isn't running"),
 * and `close()` has nothing left to wait for.
 */
function reserveBridgePort(): Promise<BridgePortReservation> {
	return new Promise((resolve, reject) => {
		const socket = createNetServer();
		let released = false;
		// The socket exists to be held, not to serve. Anything that connects during
		// the hand-over window is answered with a reset rather than being parked.
		socket.on("connection", (connection) => connection.destroy());
		const onError = (error: unknown) => {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			reject(
				new Error(
					`${LOG_PREFIX} cannot reserve ${BRIDGE_HOST}:${BRIDGE_PORT}` +
						`${code ? ` (${code})` : ""} — another bridge instance is already ` +
						"serving on the fixed port. Refusing to start: continuing would " +
						"take the send-nonce counter away from the instance that is " +
						"actually answering the phone and leave it permanently 503.",
					{ cause: error },
				),
			);
		};
		socket.once("error", onError);
		socket.listen(
			{ host: BRIDGE_HOST, port: BRIDGE_PORT, exclusive: true },
			() => {
				socket.removeListener("error", onError);
				// A listening `net.Server` with no `error` listener THROWS on the next
				// error event, which would take host-service (and upstream with it)
				// down over an opt-in fork feature. Loud, and survivable.
				socket.on("error", (error: unknown) => {
					console.error(
						`${LOG_PREFIX} the ${BRIDGE_HOST}:${BRIDGE_PORT} reservation socket errored while held:`,
						error,
					);
				});
				resolve({
					release: () =>
						new Promise<void>((done, fail) => {
							if (released) {
								done();
								return;
							}
							released = true;
							socket.close((error) => (error ? fail(error) : done()));
						}),
				});
			},
		);
	});
}

function createBridgeLogger(): BridgeLogger {
	const extras = (fields?: Record<string, unknown>): unknown[] =>
		fields === undefined ? [] : [fields];
	return {
		info: (message, fields) =>
			console.log(`${LOG_PREFIX} ${message}`, ...extras(fields)),
		warn: (message, fields) =>
			console.warn(`${LOG_PREFIX} ${message}`, ...extras(fields)),
		error: (message, fields) =>
			console.error(`${LOG_PREFIX} ${message}`, ...extras(fields)),
	};
}

// ---------------------------------------------------------------------------
// panic (§7.8)
// ---------------------------------------------------------------------------

interface PanicDeps {
	deviceStore: DeviceStore;
	audit: AuditLog;
	events: EventStreamServer;
}

/**
 * Accepted from a device whose `writeEnabled` is already false — you can always
 * make things more restrictive — and refused from a revoked one (the transport
 * rejects revoked devices before a handler runs). There is deliberately no
 * `write_enable`: the phone can only reduce its own privilege.
 */
function createPanicHandler(deps: PanicDeps) {
	return async (
		ctx: SealedRequestContext,
		request: PanicRequest,
	): Promise<PanicResponse> => {
		const mode = assertPanicMode(request.mode);
		if (
			typeof request.reason !== "string" ||
			request.reason.length > PANIC_REASON_MAX_CHARS
		) {
			throw badRequest(
				`reason must be a string of at most ${PANIC_REASON_MAX_CHARS} characters`,
			);
		}
		if (
			typeof request.requestId !== "string" ||
			!REQUEST_ID_PATTERN.test(request.requestId)
		) {
			throw badRequest("requestId must be a lowercase hyphenated UUIDv4");
		}

		const base = {
			kind: "panic" as const,
			deviceId: ctx.device.deviceId,
			surface: ctx.device.surface,
			requestId: request.requestId,
			leaseId: null,
			questionId: null,
			terminalId: null,
			guards: null,
			guardsAbstained: null,
			payloadHash: hashJsonPayload(request),
		};
		// Before, always. A panic that crashed the process mid-apply must still be
		// visible in the log.
		await deps.audit.append({
			...base,
			tsMs: Date.now(),
			outcome: "attempted",
			failureCode: null,
		});

		try {
			const devicesAffected =
				mode === "unpair_all"
					? await revokeEveryDevice(deps)
					: await applyToDevice(deps, ctx.device, mode);
			await deps.audit.append({
				...base,
				tsMs: Date.now(),
				outcome: "confirmed",
				failureCode: null,
			});
			return { mode, appliedAtMs: Date.now(), devicesAffected };
		} catch (error) {
			await deps.audit.append({
				...base,
				tsMs: Date.now(),
				outcome: "failed",
				failureCode: "internal",
			});
			throw error;
		}
	};
}

function assertPanicMode(mode: unknown): PanicMode {
	if (
		mode === "write_disable" ||
		mode === "unpair_device" ||
		mode === "unpair_all"
	) {
		return mode;
	}
	throw badRequest("mode must be write_disable, unpair_device or unpair_all");
}

async function applyToDevice(
	deps: PanicDeps,
	device: DeviceRecord,
	mode: Exclude<PanicMode, "unpair_all">,
): Promise<number> {
	if (mode === "write_disable") {
		await deps.deviceStore.setWriteEnabled(device.deviceId, false);
		return 1;
	}
	await deps.deviceStore.revoke(device.deviceId, "panic", Date.now());
	deps.events.revoke(device.deviceId, "panic");
	return 1;
}

/**
 * Key material is NOT destroyed here. Revoked records are retained 30 days so
 * audit entries stay attributable, and `device-store`'s purge is the single
 * point that wipes a `K_dev` (wired to `onPurged` in `start()`).
 */
async function revokeEveryDevice(deps: PanicDeps): Promise<number> {
	const devices = await deps.deviceStore.list();
	const count = await deps.deviceStore.revokeAll("panic", Date.now());
	for (const device of devices) {
		if (device.revokedAtMs === null) {
			deps.events.revoke(device.deviceId, "panic");
		}
	}
	return count;
}

/**
 * The desktop-side switches. One audit line per affected device, carrying that
 * device's own surface — `AuditEntry.surface` is `phone | watch` and there is no
 * `desktop` member, so a desktop action is recorded against the devices it hit
 * rather than against a fabricated actor.
 */
async function applyDesktopPanic(
	state: BridgeState,
	logger: BridgeLogger,
	mode: Extract<PanicMode, "write_disable" | "unpair_all">,
	reason: string,
): Promise<number> {
	if (typeof reason !== "string" || reason.length === 0) {
		throw new Error(`${LOG_PREFIX} a desktop panic requires a reason`);
	}
	const requestId = `desktop:${Date.now().toString(36)}`;
	const payloadHash = hashJsonPayload({ mode, reason });
	const kind =
		mode === "write_disable" ? ("panic" as const) : ("revoke" as const);
	const devices = (await state.deviceStore.list()).filter(
		(device) => device.revokedAtMs === null,
	);
	const line = (device: DeviceRecord, outcome: "attempted" | "confirmed") =>
		state.audit.append({
			tsMs: Date.now(),
			kind,
			deviceId: device.deviceId,
			surface: device.surface,
			requestId,
			leaseId: null,
			questionId: null,
			terminalId: null,
			guards: null,
			guardsAbstained: null,
			payloadHash,
			outcome,
			failureCode: null,
		});

	for (const device of devices) await line(device, "attempted");

	const deps: PanicDeps = {
		deviceStore: state.deviceStore,
		audit: state.audit,
		events: state.events,
	};
	let affected = 0;
	if (mode === "write_disable") {
		for (const device of devices) {
			await state.deviceStore.setWriteEnabled(device.deviceId, false);
			affected += 1;
		}
	} else {
		affected = await revokeEveryDevice(deps);
	}

	for (const device of devices) await line(device, "confirmed");

	logger.warn(`desktop panic ${mode} applied to ${affected} device(s)`, {
		reason,
	});
	return affected;
}

// ---------------------------------------------------------------------------
// lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * (MAINTENANCE-DRAIN) Maintenance work that has STARTED and not yet finished.
 *
 * Cancelling a timer stops the NEXT run; it does nothing about the run already
 * executing. So teardown drains instead of merely cancelling, which is what makes
 * the claim further down — that teardown stops an old writer overlapping a new
 * bridge — actually true rather than merely intended.
 *
 * WHAT THIS PROTECTS, AND WHAT IT NO LONGER HAS TO. It was written for the JSON
 * attempt store, where an hourly prune closed over that INSTANCE's records map,
 * rewrite counter and write serialisation: a prune mid-flight at teardown could
 * resume after a replacement bridge had written newer state and rewrite the file
 * from its own stale snapshot, destroying records and LOWERING the counter
 * undetectably. That class is gone — the ledger's prune is one SQL DELETE by
 * cutoff inside a transaction, holds no snapshot, and is idempotent and monotone,
 * so an overlapping run from a dead instance cannot produce a different result
 * than the live one would.
 *
 * It still earns its place for the ordinary reason: a run in flight is holding
 * the database handle and the audit log, teardown is about to close both, and a
 * write against a closed handle at shutdown is an unexplained exception on the
 * way out. Draining is bounded (`MAINTENANCE_DRAIN_TIMEOUT_MS`) precisely so this
 * cannot itself become a reason the bridge fails to stop.
 */
type MaintenanceInFlight = Set<Promise<unknown>>;

function interval(
	everyMs: number,
	task: () => Promise<unknown>,
	inFlight: MaintenanceInFlight,
): NodeJS.Timeout {
	const timer = setInterval(() => {
		// The CAUGHT promise is what gets tracked, so a draining teardown can
		// `await` it without a maintenance failure rejecting the teardown itself.
		const run = task().catch((error: unknown) => {
			console.error(`${LOG_PREFIX} maintenance task failed:`, error);
		});
		inFlight.add(run);
		void run.finally(() => inFlight.delete(run));
	}, everyMs);
	timer.unref();
	return timer;
}

/**
 * (START-DEFER) The same contract as `interval`, run ONCE on the next turn of
 * the loop.
 *
 * It exists so a start-time maintenance pass does not sit between the listener
 * coming up and the bridge reporting itself started, while remaining a handle
 * the teardown list can cancel. A failure is logged by the same path as any
 * other maintenance failure — not swallowed, and not fatal to a bridge that is
 * otherwise serving.
 *
 * The returned handle is cleared by the same `clearInterval` loop as the
 * repeating timers: Node's `clearInterval` and `clearTimeout` both close a
 * `Timeout`, so one list and one cancel path is correct here.
 */
function soon(
	task: () => Promise<unknown>,
	inFlight: MaintenanceInFlight,
): NodeJS.Timeout {
	const timer = setTimeout(() => {
		// Tracked for the same reason as `interval` — a start-time pass that is
		// still running when the bridge stops is exactly as capable of writing over
		// a replacement bridge's state. See (MAINTENANCE-DRAIN).
		const run = task().catch((error: unknown) => {
			console.error(`${LOG_PREFIX} maintenance task failed:`, error);
		});
		inFlight.add(run);
		void run.finally(() => inFlight.delete(run));
	}, 0);
	timer.unref();
	return timer;
}

async function settle(
	logger: BridgeLogger,
	what: string,
	stopIt: () => Promise<unknown> | undefined,
): Promise<void> {
	try {
		await stopIt();
	} catch (error) {
		logger.error(`failed to stop ${what}`, { error });
	}
}

function assertOptions(options: CompanionBridgeOptions): void {
	if (!options || typeof options !== "object") {
		throw new Error(`${LOG_PREFIX} createCompanionBridge requires options`);
	}
	if (typeof options.hostDbPath !== "string" || !options.hostDbPath) {
		throw new Error(`${LOG_PREFIX} options.hostDbPath is required`);
	}
	if (!options.db) {
		throw new Error(`${LOG_PREFIX} options.db is required`);
	}
	if (!options.terminalAgentStore) {
		throw new Error(`${LOG_PREFIX} options.terminalAgentStore is required`);
	}
	for (const field of [
		"appVersion",
		"hostServiceVersion",
		"forkTag",
	] as const) {
		if (
			typeof options.versions?.[field] !== "string" ||
			!options.versions[field]
		) {
			throw new Error(
				`${LOG_PREFIX} options.versions.${field} is required and must be a non-empty string`,
			);
		}
	}
}

export * from "./types";
