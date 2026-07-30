/**
 * (COMPANION-BRIDGE) — composition root for the companion bridge.
 *
 * Wires the sealed HTTP listener, the read-only event stream, the pairing
 * window, the question store, the answer path, push and the audit log, and hands
 * host-service a single start/stop handle.
 *
 * Contract with the rest of host-service:
 *  - it runs IN-PROCESS with the pty writer, because the answer guard stack and
 *    the injection must share one critical section (§11.3);
 *  - it fails loud on a taken port, a missing secret, or an unreadable device
 *    store — the companion feature is then reported unavailable in the desktop
 *    UI rather than silently degraded;
 *  - it never blocks the main thread on fs (nonce cache, audit log) — the
 *    renderer's `superset-app://` loader starves and the window stays blank.
 *
 * This module owns WIRING AND LIFECYCLE ONLY. Every behaviour lives in a sibling
 * module. Where a source of truth genuinely does not exist yet, the adapter
 * reports `null` ("unreadable", which every consumer must treat as a refusal) or
 * throws with the exact remedy — it NEVER fabricates a value that would let a
 * guard pass or a tree look healthy.
 */

import { access } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import hostServicePackageJson from "@superset/host-service/package.json" with {
	type: "json",
};
import type { HostDb } from "../db";
import {
	isLiveTerminalSession,
	snapshotSession,
	writeFramedInputToSession,
	writeInputToSession,
} from "../terminal/terminal";
import type { TerminalAgentStore } from "../terminal-agents";
import {
	getCompanionQuestionSink,
	setCompanionQuestionSink,
} from "../trpc/router/notifications";
import { createAccessValidator } from "./access-jwt";
import {
	type AnswerDeps,
	type AttemptStore,
	assertAnswerDeps,
	createAttemptStore,
	createMessageAttemptStore,
	type GuardSourceResult,
	type HostTerminalRef,
	handleAnswer,
	handleAnswerStatus,
	handleMessage,
	type MessageAttemptStore,
	type TerminalAgentInfo,
} from "./answer";
import { type AuditLog, createAuditLog, hashJsonPayload } from "./audit";
import {
	BRIDGE_CAPABILITIES,
	BRIDGE_HOST,
	BRIDGE_PORT,
	type CompanionPaths,
	ensureCompanionDirs,
	isCompanionBridgeEnabled,
	LOG_PREFIX,
	loadAccessServiceToken,
	loadFcmServiceAccountMeta,
	NONCE_CACHE_COMPACT_INTERVAL_MS,
	PUSH_QUESTION_EXPIRY_MS,
	resolveCompanionPaths,
} from "./config";
import { createReplayCache, type ReplayCache } from "./crypto";
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
	createLeaseRegistry,
	createTerminalLockRegistry,
	type LeaseRegistry,
	type TerminalLockRegistry,
} from "./lease";
import { PANIC_REASON_MAX_CHARS } from "./limits";
import { openPairingWindow, type PairingWindowHandle } from "./pairing";
import { createPushSender, handleRegister, type PushSender } from "./push";
import {
	createQuestionStore,
	deriveHandle,
	type PendingQuestion,
	type QuestionCaptureSink,
	type QuestionStore,
} from "./question-store";
import {
	badRequest,
	createReadApi,
	findActiveHostTerminalId,
	type HostDbReader,
	openHostDbReadOnly,
	type ReadApi,
} from "./read-api";
import { clearCompanionBridge, setCompanionBridge } from "./registry";
import type {
	AgentKind,
	Capability,
	DeviceRecord,
	EpochMs,
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
 * The `AgentLifecycleEventType` member that means "the agent is blocked waiting
 * for the user". `mapEventType` has already normalised host.db's
 * `terminal_agent_bindings.last_event_type` to this vocabulary, so guard 4 is a
 * string compare and not a heuristic.
 */
const PERMISSION_REQUEST_EVENT_TYPE = "PermissionRequest";
/** UUIDv4, lowercase, hyphenated (§0.1). */
const REQUEST_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface CompanionBridge {
	start(): Promise<void>;
	stop(reason?: string): Promise<void>;
	/** Opens the single 120 s LAN pairing window and returns the QR URI. */
	openPairing(): Promise<PairingWindowHandle>;
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
	readonly startedAtMs: number;
	readonly running: boolean;
}

export interface CompanionBridgeOptions {
	/** `env.HOST_DB_PATH`. Opened `mode=ro`; `immutable=1` is forbidden (§7.2). */
	hostDbPath: string;
	/**
	 * The live drizzle handle. Needed ONLY by `snapshotSession`, which adopts a
	 * pty session and therefore writes; every companion READ goes through the
	 * separate `mode=ro` reader opened from `hostDbPath`.
	 */
	db: HostDb;
	/**
	 * Handed in explicitly rather than imported as a module global, so the answer
	 * guards read the SAME live store the hook receiver writes. A second
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
	attempts: AttemptStore;
	messageAttempts: MessageAttemptStore;
	readApi: ReadApi;
	push: PushSender;
	events: EventStreamServer;
	http: BridgeHttpServer;
	pairing: PairingWindowHandle | null;
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
		logger.info("config validated", {
			accessClientId,
			fcmProject: fcm.projectId,
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
		const hostDb = openHostDbReadOnly(options.hostDbPath);
		unwind.push({ what: "host db reader", close: async () => hostDb.close() });
		const audit = createAuditLog(paths.audit);
		const keyStore = createKeyStore(paths.devices, anchor);
		// Revocation tombstones and the retryable wipe of purged key material live
		// inside the store now: purge is still the ONLY point at which a K_dev may
		// be destroyed, but a revoke must ALSO invalidate the key file, or restoring
		// an older index silently re-authorises the device.
		const deviceStore = await createDeviceStore(paths.devices, {
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
		// (START-PARALLEL) The replay cache and the answer-attempt store each read
		// and rehydrate one file, and neither depends on the other or on the
		// anchor chain below, so they are constructed together instead of back to
		// back. NOTHING here is reordered against the anchor: `openStateAnchor` ->
		// `createDeviceStore` -> the (ANCHOR-ORDER) assertion -> `createSendNonceSource`
		// still runs strictly in sequence. The attempt store reads ONE value off the
		// anchor — `generation`, for its (ATTEMPT-WITNESS) binding — and reads it from
		// the already-open anchor above rather than from the chain below, so the
		// parallelism holds.
		//
		// `allSettled`, not `all`, and the reason is (BRIDGE-TEARDOWN-ONE-LIST):
		// `createReplayCache` holds an open file handle, so a version that
		// SUCCEEDED while its partner failed must still reach the unwind list
		// before this function throws. `all` would abandon it.
		const [cacheOutcome, attemptsOutcome] = await Promise.allSettled([
			createReplayCache({ noncesDir: paths.nonces }),
			// §11.4/§11.5 — DURABLE, and hydrated before the first request can be
			// served. An in-memory map made `known: false` ("nothing was sent") a
			// claim this bridge could not honour across the restarts the desktop
			// performs routinely; the file is what makes the 24 h retention real.
			createAttemptStore({
				dir: paths.root,
				// (ATTEMPT-WITNESS) The install identity the attempts file's rise-only
				// witness is bound to. `openStateAnchor` ran further up — it has to, for
				// the send-nonce ordering — so the generation is already durable here.
				//
				// What the witness buys, stated precisely because the obvious guess is
				// wrong: a RECORDED status already survives a restart, because
				// `handleAnswerStatus` returns `known: true` with the record's own status
				// whenever the record is there, and the file is durable. The witness
				// works on the OTHER branch — it is what lets `known: false` be asserted
				// for a request submitted BEFORE this mount, turning "no record, and I
				// cannot tell you why" into the actionable "it never arrived". Absent it,
				// coverage can only start at this mount and every pre-restart miss
				// degrades to `unconfirmed`.
				generation: anchor.generation,
				log: (event) => logger.warn("answer-attempt store", event),
			}),
		]);
		if (cacheOutcome.status === "fulfilled") {
			const cache = cacheOutcome.value;
			unwind.push({ what: "nonce cache", close: () => cache.close() });
		}
		if (cacheOutcome.status === "rejected") throw cacheOutcome.reason;
		if (attemptsOutcome.status === "rejected") throw attemptsOutcome.reason;
		const nonceCache = cacheOutcome.value;
		const attempts = attemptsOutcome.value;
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
		const questions = createQuestionStore({ source: hostDb });
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
		const push = createPushSender({
			serviceAccountPath: fcm.path,
			devices: deviceStore,
			// Re-checked at fire time: a missed cancel would buzz the watch for a
			// question already answered, which is the exact noise the 180 s delay
			// exists to remove.
			isStillUnanswered: (questionId: QuestionId) =>
				questions.get(questionId)?.state === "pending",
			onFault: (fault) => {
				logger.error("push is broken", { fault });
			},
		});
		// Constructed BEFORE the read API, because `onQuestionsSettled` is what
		// retracts an already-delivered notification and a late binding there would
		// be a `?.` that silently does nothing.
		const readApi = createReadApi({
			db: hostDb,
			questions,
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
			// answered at the desk minutes ago. Retraction only: `reconcile` yields
			// ids, not resolution provenance, and publishing a `question.resolved`
			// frame from here would have to invent `resolvedBy`.
			onQuestionsSettled: (questionIds) => {
				for (const questionId of questionIds) {
					push.cancelPending(questionId);
				}
			},
		});

		const answerDeps = createAnswerDeps({
			db: options.db,
			hostDb,
			questions,
			leases,
			locks,
			attempts,
			messageAttempts,
			audit,
			agents: options.terminalAgentStore,
			logger,
			bridgeStartedMs,
		});
		// Proves the raw writer is the raw writer HERE, at start, rather than on
		// the first answer of the day. `createRawPtyWriter`'s probe is the only
		// structural defence against the paste-framing writer being wired into the
		// injector (names do not survive bundling), and it is lazy — without this
		// call a mis-wired writer would surface as an untyped 500 on a real
		// answer, long after every read path had been seen working.
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
					// The 24 h idempotency window (§11.5); the stores own the arithmetic.
					await attempts.prune(Date.now());
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
			attempts,
			messageAttempts,
			readApi,
			push,
			events,
			http,
			pairing: null,
			teardown: unwind,
		};
		unwind.push({
			what: "maintenance timers",
			close: async () => {
				for (const timer of timers) clearInterval(timer);
				// (MAINTENANCE-DRAIN) Cancelling stops the next run; this waits out the
				// one already executing. Without it a prune mid-flight here would go on
				// to rewrite the attempts file from a snapshot belonging to THIS bridge
				// after a replacement had already written newer state — destroying
				// records and lowering the rewrite counter, in a way that leaves both
				// files agreeing so nothing downstream can detect it.
				//
				// Looped rather than a single `Promise.all` because a drained task may
				// itself have queued another (`soon` fires on the next turn of the
				// loop), and the set is mutated as runs settle. Every tracked promise
				// is already `.catch`ed, so this can neither reject nor mask a failure —
				// maintenance errors are logged by the same path as always.
				while (maintenanceInFlight.size > 0) {
					await Promise.all([...maintenanceInFlight]);
				}
			},
		});
		startedAtMs = http.startedAtMs;
		logger.info(
			`listening on http://${BRIDGE_HOST}:${BRIDGE_PORT} (app ${options.versions.appVersion}, fork ${options.versions.forkTag})`,
		);
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
			// `closed`, not `expiresAtMs`: the window is SINGLE USE and closes the
			// moment a device pairs, long before it expires. Comparing clocks here
			// would refuse every pairing after the first for the rest of the 120 s,
			// and remembering the handle without checking anything at all — which
			// this did — refused every pairing after the first FOREVER, because
			// nothing ever cleared the field. `pairing.ts` clears its own
			// process-wide guard in `close()`; this is the mirror of that.
			if (current.pairing !== null && !current.pairing.closed) {
				throw new Error(
					`${LOG_PREFIX} a pairing window is already open — close it before opening another`,
				);
			}
			current.pairing = null;
			const handle = await openPairingWindow({
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
			});
			current.pairing = handle;
			// The QR URI, in the host-service log, ON PURPOSE.
			//
			// It carries the single-use pairing code in its FRAGMENT. That fragment
			// is never sent to an origin (§4.2) but it IS a secret for the next
			// 120 s, so this is a deliberate trade: until a desktop surface renders
			// the QR, the log is the only place a human can read the URI, and a
			// pairing window nobody can see is a feature nobody can use. The code
			// dies with the window — it is single-use, and `close()` zeroes it.
			logger.warn(
				"pairing window OPEN for 120s — scan this, it contains a single-use code",
				{ qrUri: handle.qrUri, expiresAtMs: handle.expiresAtMs },
			);
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

// ---------------------------------------------------------------------------
// the host-service mount (the single call added to serve.ts)
// ---------------------------------------------------------------------------

export interface CompanionMountInput {
	/** `env.HOST_DB_PATH`. */
	hostDbPath: string;
	/** The live drizzle handle from `createApp()` — same process, same pty writer. */
	db: HostDb;
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

interface NotifyingSinkDeps {
	/** `QuestionStore.asCaptureSink()` — validates HARD and owns custody. */
	inner: QuestionCaptureSink;
	questions: QuestionStore;
	push: PushSender;
	events: EventStreamServer;
	logger: BridgeLogger;
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
function createNotifyingCaptureSink(
	deps: NotifyingSinkDeps,
): QuestionCaptureSink {
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

			// §13.3 — a notification must never outlive the thing it was about.
			// `cancelPending` disarms an un-fired push AND fires a retraction for one
			// that already went out; it is deliberately the fire-and-forget form,
			// because the hook route must not wait on FCM.
			deps.push.cancelPending(before.questionId);
			deps.events.publish({
				t: "question.resolved",
				d: {
					questionId: before.questionId,
					resolvedAtMs,
					resolvedBy,
					outcome: "answered",
				},
			});
		},
	};
}

/**
 * §13 — arm the delayed push for a newly captured question.
 *
 * `schedule` is idempotent per questionId and validates its own payload at the
 * call site (a text leak or a bad count throws HERE, not in three minutes). A
 * throw is logged rather than propagated: a broken push must not turn a
 * successfully captured question into a 500 that loses the capture too. It is
 * LOUD — `PushSender.getFault()` and this line are how "the watch will stay
 * silent" becomes visible instead of presenting as "no questions".
 */
function armPush(deps: NotifyingSinkDeps, question: PendingQuestion): void {
	try {
		deps.push.schedule({
			questionId: question.questionId,
			workspaceId: deriveHandle(
				"workspace",
				question.hostWorkspaceId,
			) as WorkspaceId,
			questionCount: question.questions.length,
			expiresAtMs: question.askedAtMs + PUSH_QUESTION_EXPIRY_MS,
		});
	} catch (error) {
		deps.logger.error(
			"failed to arm the delayed push for a captured question — the watch will not buzz for it",
			{ questionId: question.questionId, error },
		);
	}
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
	questions: QuestionStore;
	leases: LeaseRegistry;
	locks: TerminalLockRegistry;
	attempts: AttemptStore;
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
 * `writer` is the RAW pty write and is the only thing that drives a picker:
 * bracketed-paste framing is INERT against it, proven in a real pty.
 * `createRawPtyWriter` probes the function at startup so wiring the framed
 * writer here is a loud failure rather than answers that silently never arrive.
 */
function createAnswerDeps(deps: AnswerAdapterDeps): AnswerDeps {
	const hostTerminalIdOf = (terminalId: TerminalId): string | null =>
		findActiveHostTerminalId(deps.hostDb, terminalId);

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

	return {
		writeInput: writeInputToSession,
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
				// Guard 5 must never pass on an empty screen.
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
			// every earlier picker is in that text, and guard 5's whitespace-stripped
			// matcher would confirm "the picker is on screen" against one the user
			// closed minutes ago while the viewport shows a composer. A bare digit
			// then lands in that composer.
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
					`${LOG_PREFIX} terminal ${terminalId} reported ${probe.rows} rows — refusing to bound the guard-5 snapshot on it`,
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
		attempts: deps.attempts,
		messageAttempts: deps.messageAttempts,
		questions: deps.questions,
		audit: deps.audit,
		now: (): EpochMs => Date.now(),
		bridgeStartedMs: deps.bridgeStartedMs,

		resolveHostTerminal,

		// GUARD 1, LOAD-BEARING. The transcript is the one source the
		// unauthenticated localhost hook cannot write — AND, since
		// (TRANSCRIPT-PATH-DERIVED), cannot CHOOSE either: `PendingQuestion.transcriptPath`
		// is computed from host.db by `HostDbReader.resolveTranscriptPath`, never
		// taken from the hook payload. While the hook named the file, "point guard 1
		// at an empty file" made "still unanswered" true on demand and guard 1
		// passed for a question that was never asked.
		//
		// It verifies the tool call it was ASKED about. Re-deriving the question
		// from `byTerminal(terminalId)` and reading that record's `toolUseId`
		// instead — which this adapter used to do — hands the choice of which tool
		// call gets verified back to the unauthenticated hook, and guard 1 stops
		// being the one source the hook cannot move. A supersede mid-sequence then
		// makes guard 1 answer about the NEW question while the injector keeps
		// typing the old one's digits.
		async toolResultExists({
			terminalId,
			toolUseId,
		}): Promise<GuardSourceResult> {
			const question = deps.questions.byTerminal(terminalId);
			if (question === null) return null;
			if (question.toolUseId !== toolUseId) {
				// The store no longer holds the question being answered. That is not
				// "no tool_result exists"; it is "cannot check", which is a refusal.
				return null;
			}
			const verdict = await deps.questions.verifyResolvedInTranscript(question);
			if (verdict === "unreadable") return null;
			return verdict === "resolved";
		},

		// GUARD 2, FORGEABLE — never load-bearing.
		async agentBinding(
			terminalId: TerminalId,
		): Promise<TerminalAgentInfo | null> {
			const hostTerminalId = hostTerminalIdOf(terminalId);
			if (hostTerminalId === null) return null;
			const binding = deps.agents.get(hostTerminalId);
			if (!binding) return { kind: "none", bound: false, agentSessionId: null };
			return {
				kind: agentKindOf(binding.definitionId),
				bound: true,
				agentSessionId: binding.agentSessionId ?? null,
			};
		},

		// GUARD 3, supporting.
		async sessionActive(terminalId: TerminalId): Promise<GuardSourceResult> {
			const hostTerminalId = hostTerminalIdOf(terminalId);
			if (hostTerminalId === null) return null;
			return isLiveTerminalSession(hostTerminalId);
		},

		// GUARD 4, FORGEABLE. The permission axis this guard needs is
		// `TerminalAgentBinding.lastEventType`, written by the same hook receiver
		// and hydrated from host.db's `terminal_agent_bindings` — the SAME store
		// guard 2 reads, in this process. (An earlier revision returned `null` here
		// on the grounds that the axis "lives in renderer storage the bridge cannot
		// reach". It does not; the renderer's dot has its own copy.) `null` when
		// there is no binding at all, which is a refusal.
		async permissionAxisLatched(
			terminalId: TerminalId,
		): Promise<GuardSourceResult> {
			const hostTerminalId = hostTerminalIdOf(terminalId);
			if (hostTerminalId === null) return null;
			const binding = deps.agents.get(hostTerminalId);
			if (!binding) return null;
			return binding.lastEventType === PERMISSION_REQUEST_EVENT_TYPE;
		},

		// GUARD 6, VETO ONLY: absence is a sound veto, presence proves nothing.
		//
		// (ASKQ-MARKER-READ) `~/.superset/agent-subagent-running/<hostTerminalId>.askq/`
		// is a DIRECTORY of per-owner "an AskUserQuestion is pending" markers,
		// written by `superset-notify.py` at PreToolUse:AskUserQuestion and removed
		// by the raising agent's own answer, its SubagentStop, the main turn
		// boundary, an API abort, or a watcher-detected interrupt. Several of those
		// clears do NOT depend on the PostToolUse hook surviving — which is exactly
		// the case guard 6 exists for on this ARM64 box, where emulated msys2 has
		// killed hooks mid-flight.
		//
		// `homedir()`, deliberately NOT `resolveSupersetHome()`: both writers
		// (`pane-map-hook.ts`'s embedded Python and `agent-jsonl-watcher.ts`)
		// hardcode the home directory, so honouring `SUPERSET_HOME_DIR` here would
		// read a directory nothing ever writes and turn every answer into a veto.
		//
		// Returns `null` (unreadable, no veto) when the owner key cannot be
		// computed or the host id cannot be resolved. It NEVER reports `false` on a
		// guess: a wrong `false` is a refused answer the user cannot distinguish
		// from a stale question.
		async askqMarkerExists({
			terminalId,
			agentId,
		}): Promise<GuardSourceResult> {
			const hostTerminalId = hostTerminalIdOf(terminalId);
			if (hostTerminalId === null) return null;
			if (!SAFE_MARKER_SEGMENT.test(hostTerminalId)) return null;
			const owner = askqOwnerKey(agentId);
			if (owner === null) return null;
			try {
				// `fs/promises`, matching the rule `read-api.ts`'s `resolveTranscript`
				// already states: no synchronous fs on a request path. This runs in
				// the pty-writer process, once per guard pass and therefore once per
				// keystroke, and blocking fs here is the documented footgun that
				// starves the renderer's `superset-app://` loader.
				//
				// EVERY failure is `false`, exactly as `existsSync` behaved — it
				// swallows fs errors and reports absent. Guard 6 is a veto, so
				// "absent" is the RESTRICTIVE reading; turning a permission error
				// into `null` here would quietly drop a veto, which is not an
				// efficiency change.
				return await access(
					join(
						homedir(),
						".superset",
						"agent-subagent-running",
						`${hostTerminalId}.askq`,
						owner,
					),
				).then(
					() => true,
					() => false,
				);
			} catch (error) {
				deps.logger.warn("askq marker read failed", { error });
				return null;
			}
		},

		log(event: Record<string, unknown>): void {
			deps.logger.info("answer", event);
		},
	};
}

/**
 * (ASKQ-MARKER-READ) A path segment we are willing to build. The writers
 * validate host terminal ids with exactly this pattern before touching the
 * filesystem; matching it here is what keeps a hook-supplied id from becoming a
 * traversal.
 */
const SAFE_MARKER_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * (ASKQ-MARKER-READ) The raising agent's marker filename: its SANITIZED
 * `agent_id` (alphanumerics, `-` and `_` kept, everything else stripped — the
 * same reduction `superset-notify.py` applies), or `_main` for a main-loop
 * question.
 *
 * `null` when a non-empty `agentId` sanitizes away to nothing: the owner key is
 * then unknowable, and answering about the WRONG owner would be worse than
 * admitting we cannot read it. Two concurrent questions on one terminal (main
 * plus a subagent) have independent markers by design, so keying this wrong
 * would veto a live question or miss a dead one.
 */
function askqOwnerKey(agentId: string | null): string | null {
	if (agentId === null || agentId.length === 0) return "_main";
	const sanitized = agentId.replace(/[^A-Za-z0-9_-]/g, "");
	return sanitized.length > 0 ? sanitized : null;
}

function agentKindOf(definitionId: string | undefined): AgentKind {
	if (typeof definitionId !== "string") return "unknown";
	const id = definitionId.toLowerCase();
	if (id.includes("claude")) return "claude";
	if (id.includes("codex")) return "codex";
	return "unknown";
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
 * publisher half is now wired for the session-independent frames
 * (`question.resolved`) in `createNotifyingCaptureSink`, so `currentGseq()`
 * finally advances and `HeartbeatResponse.treeStale` is satisfiable. What is
 * still missing, and blocks the grant, is anything that needs a PER-SESSION
 * projection: this snapshot, and `question.pending` (whose `QuestionSummary`
 * carries `answerable`, which is computed against that session's grants — a
 * broadcast copy would have to guess, and guessing "answerable" on a phone is
 * how a dead affordance gets rendered). Supply a real `EventSnapshotSource` and
 * a per-session question projection, then grant the capability in `config.ts`.
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
 * executing. That gap was not theoretical: an hourly `attempts.prune` holds a
 * reference to its own `AttemptStore` closure — that instance's records map, its
 * rewrite counter, its paths — and the store's write serialisation and witness
 * guard are per-INSTANCE. So a prune that was mid-flight when the bridge stopped
 * would resume after a REPLACEMENT bridge had already written newer state, and
 * rewrite the file from its own stale snapshot: records destroyed, and the
 * rewrite counter LOWERED. Both files then agree, so the next start sees a
 * consistent pair, logs no rollback, and publishes a coverage window that
 * vouches for an answer it no longer holds — which is the one lie this whole
 * subsystem exists to prevent. It also breaks the "rise-only" property, which
 * only ever held within a single instance.
 *
 * So teardown drains instead of merely cancelling, which is what makes the claim
 * further down — that teardown stops an old writer overlapping a new bridge —
 * actually true rather than merely intended.
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
