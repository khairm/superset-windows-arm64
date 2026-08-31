/**
 * (ALERT-CONTEXT-NAMES) The renderer's two writes to the companion bridge:
 * "here is what this workspace's tabs are called" and "the user just read this
 * chat".
 *
 * WHY A MODULE AND NOT A HOOK. The seen signal fires from two places that have
 * no idea which host-service owns the workspace they are looking at — the
 * workspace page's focus-clear and the sidebar's mark-read — and threading a
 * host URL down to both would put companion plumbing in two component trees
 * that have nothing else to do with it. `HostNotificationSubscriber` already
 * holds the (hostUrl, workspaces) pairing and mounts one instance per host, so
 * it publishes the mapping here and the two call sites just say what happened.
 *
 * EVERYTHING HERE IS BEST EFFORT AND SILENT ON FAILURE. A host that is down, a
 * bridge that is off (the normal state for most machines), a mutation that
 * 500s — none of them may surface to the user, because in every case the thing
 * they actually asked for has already happened locally: the dot cleared, the
 * layout changed. The cost of a lost sync is a notification that says a bit
 * less; the cost of a toast is a user learning to ignore toasts.
 */

import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import {
	getV2NotificationSourceKey,
	getV2TerminalNotificationSource,
	useV2NotificationStore,
} from "renderer/stores/v2-notifications";
import { type AlertContextSnapshot, alertContextsHash } from "./alertContexts";

/**
 * Debounce for tab-context syncs. Sized against what produces them: a live
 * terminal title changes on every prompt redraw, and a layout live-query ticks
 * on every pane move. A quarter of a second collapses a burst into one
 * mutation, and no alert is worse for being named a quarter of a second late.
 */
const SYNC_DEBOUNCE_MS = 250;

/** Diagnostic only. Ids and counts — never a name, never a title. */
function log(record: Record<string, unknown>): void {
	try {
		console.info(
			`[companion-alert-sync] ${JSON.stringify({ ts: new Date().toISOString(), ...record })}`,
		);
	} catch {
		// never let logging break a notification path
	}
}

/**
 * (ALERT-CONTEXT-NAMES) How many times, and how far apart, a snapshot the host
 * did not consume is re-offered. Doubling from the base: 1 s, 2 s, 4 s — long
 * enough to cover a bridge finishing its async registration, short enough that
 * the tab titles are in place before the first alert of the session.
 */
const READINESS_RETRY_BASE_MS = 1_000;
const MAX_READINESS_RETRIES = 3;

/** A snapshot and its hash, computed once at the door and carried together. */
interface DesiredSnapshot {
	snapshot: AlertContextSnapshot;
	hash: string;
}

interface WorkspaceSyncState {
	hostUrl: string;
	/** Hash of the last snapshot the host ACCEPTED, not the last one computed. */
	sentHash: string | null;
	/**
	 * The newest snapshot this workspace wants the host to hold, with its hash.
	 * The ONLY thing a readiness retry may send — see `scheduleReadinessRetry`.
	 */
	desired: DesiredSnapshot | null;
	pending: DesiredSnapshot | null;
	timer: ReturnType<typeof setTimeout> | null;
	/**
	 * Sends queued on the chain that have not settled. Part of what makes the
	 * equal-hash fast path safe: a matching `sentHash` only means "nothing left
	 * to do" when nothing older can still land after it.
	 */
	inFlight: number;
	/** Consecutive unconsumed offers, which the backoff is derived from. */
	retries: number;
	retryTimer: ReturnType<typeof setTimeout> | null;
	/** In-flight mutation, so two syncs for one workspace cannot interleave. */
	chain: Promise<void>;
}

const byWorkspaceId = new Map<string, WorkspaceSyncState>();

function stateFor(workspaceId: string, hostUrl: string): WorkspaceSyncState {
	const existing = byWorkspaceId.get(workspaceId);
	if (existing !== undefined) {
		// A workspace that moved hosts has nothing in common with its old sync
		// state: the new host has never seen any of it, and a retry armed for the
		// old one must not fire against the new one.
		if (existing.hostUrl !== hostUrl) {
			existing.hostUrl = hostUrl;
			existing.sentHash = null;
			existing.retries = 0;
			cancelReadinessRetry(existing);
		}
		return existing;
	}
	const created: WorkspaceSyncState = {
		hostUrl,
		sentHash: null,
		desired: null,
		pending: null,
		timer: null,
		inFlight: 0,
		retries: 0,
		retryTimer: null,
		chain: Promise.resolve(),
	};
	byWorkspaceId.set(workspaceId, created);
	return created;
}

/**
 * Queue one workspace's tab context for its host.
 *
 * HASH-GUARDED, DEBOUNCED AND SERIALISED, in that order. The hash drops the
 * overwhelming majority of calls (a re-render that changed nothing); the
 * debounce collapses a genuine burst; the chain guarantees that when two
 * snapshots do go, the LAST one accepted is the last one applied — which is
 * the property the host's own per-workspace serialisation exists to protect
 * and which would be meaningless if the renderer fired both at once.
 *
 * `desired` IS THE ONLY THING A RETRY MAY RE-SEND. A retry that captured the
 * snapshot it was armed for would resurrect it: A is refused and arms a timer,
 * B is queued and ACCEPTED, then A's timer fires — and because A's hash is not
 * the accepted B hash, the guard waves it through and the host is left
 * describing a layout the user moved past. Retries therefore read this field
 * rather than a captured value, and every new intent cancels the timer anyway.
 */
export function queueAlertContextSync({
	workspaceId,
	hostUrl,
	snapshot,
}: {
	workspaceId: string;
	hostUrl: string;
	snapshot: AlertContextSnapshot;
}): void {
	const state = stateFor(workspaceId, hostUrl);
	// HASHED ONCE, at the door. Every later decision — the fast path, the
	// completion's current-intent check, a retry — compares hashes, and hashing
	// the same snapshot three times to answer three questions about it was work
	// done on a path the layout live-query drives.
	const desired: DesiredSnapshot = {
		snapshot,
		hash: alertContextsHash(snapshot),
	};
	// Recorded BEFORE the hash guard: even a snapshot that needs no send is the
	// current intent, and a retry armed earlier must never send anything older.
	state.desired = desired;
	// THE FAST PATH REQUIRES A QUIET WORKSPACE, not just a matching hash.
	//
	// `sentHash` describes what the host holds NOW; it says nothing about a send
	// already queued or in flight that will land AFTER this call returns. With
	// the hash alone the ordering inverted: with the host on C, queue A (armed),
	// then queue C again before A completes — C early-returns having done
	// nothing, A lands and is correctly refused the `sentHash`, and now nobody
	// is left to push C. The host describes A forever, and every future C is
	// suppressed by a `sentHash` that no longer matches it.
	//
	// So the shortcut is taken only when there is nothing pending, nothing
	// debouncing and nothing in flight — i.e. when `sentHash` is the whole
	// truth. Otherwise fall through and let the completion below reconcile.
	const isQuiet =
		state.pending === null && state.timer === null && state.inFlight === 0;
	if (isQuiet && desired.hash === state.sentHash) {
		// Already where it needs to be — an armed retry has nothing left to do.
		cancelReadinessRetry(state);
		return;
	}
	// A newer intent supersedes whatever an older refusal armed. Without this the
	// timer would fire alongside the send below and duplicate it.
	cancelReadinessRetry(state);
	state.pending = desired;
	if (state.timer !== null) return;
	state.timer = setTimeout(() => {
		state.timer = null;
		const next = state.pending;
		state.pending = null;
		if (next === null) return;
		const hash = next.hash;
		state.inFlight++;
		state.chain = state.chain.then(async () => {
			try {
				const result = await getHostServiceClientByUrl(
					state.hostUrl,
				).companion.syncAlertContexts.mutate({
					workspaceId,
					tabCount: next.snapshot.tabCount,
					terminals: next.snapshot.terminals.map((terminal) => ({
						terminalId: terminal.terminalId,
						tabTitle: terminal.tabTitle.length > 0 ? terminal.tabTitle : null,
					})),
				});
				if (result?.accepted === true) {
					state.retries = 0;
					// WHAT THE HOST NOW HOLDS is this send's hash, whether or not it is
					// still what we want. Recording it as `sentHash` when it is stale
					// would suppress the send that fixes it, so the two cases are kept
					// apart: current → remember it; stale → forget the hash AND queue
					// the desired snapshot, because nothing else will.
					const current = state.desired;
					if (current === null || current.hash === hash) {
						state.sentHash = hash;
						return;
					}
					state.sentHash = null;
					queueAlertContextSync({
						workspaceId,
						hostUrl: state.hostUrl,
						snapshot: current.snapshot,
					});
					return;
				}
				scheduleReadinessRetry(workspaceId);
			} catch {
				// Same treatment for a transport failure: leave `sentHash` unset so
				// the next snapshot — or the retry below, or the next resync epoch —
				// tries again. Silent by design: see the header.
				state.sentHash = null;
				scheduleReadinessRetry(workspaceId);
			} finally {
				state.inFlight--;
			}
		});
	}, SYNC_DEBOUNCE_MS);
}

function cancelReadinessRetry(state: WorkspaceSyncState): void {
	if (state.retryTimer === null) return;
	clearTimeout(state.retryTimer);
	state.retryTimer = null;
}

/**
 * (ALERT-CONTEXT-NAMES) Re-offer the LATEST desired snapshot after the host did
 * not consume one.
 *
 * IT TAKES NO SNAPSHOT ARGUMENT, deliberately. A retry armed for a specific
 * snapshot is a stale write waiting to happen: A is refused and arms a timer, B
 * is queued and accepted, then A's timer fires and re-sends A. Reading
 * `state.desired` at FIRE TIME means a retry can only ever push the host
 * towards the current truth, never away from it.
 *
 * BOUNDED AND BACKING OFF, because the overwhelmingly common reason for
 * `accepted: false` is a machine with no companion bridge at all — most of
 * them — and that state never changes. A few spaced retries cover the startup
 * race the bridge actually loses (registration completing a moment after the
 * listener) and then stop; a reconnect epoch re-offers everything anyway
 * through `forgetAlertContextSyncsForHost`, which is the durable repair.
 */
function scheduleReadinessRetry(workspaceId: string): void {
	const state = byWorkspaceId.get(workspaceId);
	if (state === undefined) return;
	if (state.retries >= MAX_READINESS_RETRIES) return;
	if (state.retryTimer !== null) return;
	const attempt = state.retries;
	state.retries++;
	state.retryTimer = setTimeout(
		() => {
			state.retryTimer = null;
			const live = byWorkspaceId.get(workspaceId);
			// Released, or nothing is wanted any more.
			if (live === undefined || live.desired === null) return;
			queueAlertContextSync({
				workspaceId,
				hostUrl: live.hostUrl,
				snapshot: live.desired.snapshot,
			});
		},
		READINESS_RETRY_BASE_MS * 2 ** attempt,
	);
}

/**
 * (BUS-RESYNC) A host reconnected: everything it knew about tab context died
 * with the old connection (and, if it restarted, with the old process). Drop
 * the "already sent" memory for its workspaces so the next snapshot is sent in
 * full rather than suppressed by a hash the host no longer holds.
 */
export function forgetAlertContextSyncsForHost(hostUrl: string): void {
	for (const state of byWorkspaceId.values()) {
		if (state.hostUrl !== hostUrl) continue;
		state.sentHash = null;
		// A reconnect is the readiness signal a startup-race retry was waiting
		// for, so its budget starts over and any armed timer is dropped: the
		// caller re-offers every workspace immediately, and a timer left running
		// would only duplicate that.
		state.retries = 0;
		cancelReadinessRetry(state);
	}
}

/** Unmount: a workspace nothing is watching keeps no sync state. */
export function releaseAlertContextSync(workspaceId: string): void {
	const state = byWorkspaceId.get(workspaceId);
	if (state === undefined) return;
	if (state.timer !== null) clearTimeout(state.timer);
	cancelReadinessRetry(state);
	byWorkspaceId.delete(workspaceId);
}

// ---------------------------------------------------------------------------
// the two reports, and the two rules they share
// ---------------------------------------------------------------------------

/**
 * A host-clock instant this renderer may put on the wire.
 *
 * BOTH REPORTS CARRY ONE and both tRPC inputs are `.int().positive()`, so an
 * unfloored or absurd value would come back as a tRPC ERROR — a rejected
 * promise on two paths that must never produce one. Guarded here rather than
 * trusted, and `isSafeInteger` rather than `isInteger` because a value past
 * 2^53 has already lost the millisecond it is supposed to name.
 */
function isReportableInstant(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

/**
 * Run one companion mutation and answer whether a BRIDGE ACTUALLY CONSUMED IT.
 *
 * Never rejects, which is the shared contract of everything below: a host that
 * is down, a bridge that is off (the normal state on most machines) or a
 * mutation that 500s are all `false`. The distinction matters to callers —
 * `accepted: false` means NOTHING WAS APPLIED (a bridge still registering, or
 * one that refused the report on its own evidence), and recording it as done
 * would suppress the retry.
 *
 * The seen report reads its own result rather than going through here: it has a
 * second field to act on (`refusal`), and folding that into a boolean is what
 * let a permanently refused report re-send forever.
 */
function mutateAccepted(
	mutate: () => Promise<{ accepted?: boolean } | undefined>,
): Promise<boolean> {
	return mutate()
		.then((result) => result?.accepted === true)
		.catch(() => false);
}

// ---------------------------------------------------------------------------
// the seen signal
// ---------------------------------------------------------------------------

/**
 * workspaceId -> the host-service that owns it, published by
 * `HostNotificationSubscriber`. Bounded by the visible sidebar, which is what
 * that component is already scoped to.
 */
const hostUrlByWorkspaceId = new Map<string, string>();

export function registerWorkspaceHost(
	workspaceId: string,
	hostUrl: string,
): void {
	hostUrlByWorkspaceId.set(workspaceId, hostUrl);
}

export function unregisterWorkspaceHost(
	workspaceId: string,
	hostUrl: string,
): void {
	// Identity-checked, so a subscriber unmounting cannot unpublish the mapping
	// a different host's subscriber has since installed for the same workspace.
	if (hostUrlByWorkspaceId.get(workspaceId) === hostUrl) {
		hostUrlByWorkspaceId.delete(workspaceId);
	}
}

/**
 * (ALERT-CONTEXT-NAMES) Mark a terminal seen AND, if that actually cleared a
 * green dot, tell its host so the phone drops the notification.
 *
 * ONE HELPER FOR BOTH USER-INTENT SITES. The ritual is three steps that must
 * happen in this order and are wrong in a way nothing would catch if they
 * drift: read the review entry's `occurredAt` BEFORE `markTerminalSeen` deletes
 * it, mark seen with the BINDING's stamp (the monotonic seen mark), and report
 * only when a green was really removed. Written out at each call site it was
 * two copies of a sequence whose failure mode is a retraction naming an id no
 * phone holds.
 *
 * The two stamps are deliberately different and neither may be substituted for
 * the other:
 *
 *  - `lastEventAt` is the SEEN MARK. Monotonic, host clock, compared against
 *    the binding to derive `review`.
 *  - the review entry's `occurredAt` is the RETRACTION's subject: the instant
 *    of the event that turned the dot green, which is what the alert id was
 *    hashed from. A binding's `lastEventAt` advances for events that raise no
 *    alert at all (a `SessionStart` moves it while the hook leaves the
 *    lifecycle outcome null), so hashing that would name nothing.
 *
 * A CLEARED GREEN IS NOT THE ONLY EVIDENCE OF A READ. The dot is also cleared
 * by the agent starting work again, and a phone card can still be up for the
 * finish before that — the host retires it when the next status arrives, but
 * the report may already be in flight or the host may have restarted since. So
 * when the store has an OUTSTANDING ready record for this terminal, opening the
 * chat is a read even though there is no green left to clear, and the record's
 * instant (not the binding's) is what the retraction names.
 *
 * Returns whether a green dot was cleared, for callers that count.
 */
export function markTerminalSeenAndReportRead({
	workspaceId,
	terminalId,
	lastEventAt,
}: {
	workspaceId: string;
	terminalId: string;
	/** The binding's `lastEventAt` — host clock, never this machine's. */
	lastEventAt: number;
}): boolean {
	const store = useV2NotificationStore.getState();
	const reviewEntry =
		store.sources[
			getV2NotificationSourceKey(getV2TerminalNotificationSource(terminalId))
		];
	const reviewAt =
		reviewEntry?.status === "review" ? reviewEntry.occurredAt : null;
	const outstandingAt = store.outstandingReadyAt[terminalId] ?? null;

	const clearedReview = store.markTerminalSeen(terminalId, lastEventAt);
	// The live green wins when there is one — it and the outstanding record name
	// the same finish, and the entry is the fresher of the two by construction.
	const seenThroughAt = reviewAt ?? outstandingAt;
	if (seenThroughAt === null) return clearedReview;
	if (!clearedReview && outstandingAt === null) return clearedReview;

	void reportTerminalSeen({
		workspaceId,
		terminalId,
		seenThroughAt,
	}).then((accepted) => {
		// Only a report a host actually consumed retires the record, and only the
		// generation that was reported: a newer finish that landed while this was
		// in flight keeps its own record. A dropped report leaves it standing so
		// the resync sweep can try again.
		if (accepted) {
			useV2NotificationStore
				.getState()
				.clearOutstandingReady(terminalId, seenThroughAt);
		}
	});
	return clearedReview;
}

/**
 * (ALERT-RETIRE-ON-EXIT) Reports a host REFUSED on its own evidence, keyed by
 * the exact claim it refused:
 * `${hostUrl}\0${workspaceId}\0${terminalId}\0${seenThroughAt}`.
 *
 * WHY A LATCH AND NOT A RETRY. The focus path re-reports whenever the terminal
 * bindings change, which for a live agent is constantly, and it re-reports
 * while the store still holds an outstanding record for the terminal. A host
 * that answers `workspace-mismatch` is not busy or still starting up — host.db
 * does not place that terminal in that workspace and will answer the same way
 * every time — so without this the pair looped for as long as the record stood.
 *
 * IT LATCHES A CLAIM, NOT A TERMINAL, and every part of the key earns its
 * place. The HOST, because the verdict is that host's own reading of its own
 * host.db and says nothing about anyone else's: a workspace that moves to
 * another machine, or a local host-service that comes back on a different
 * address, is a fresh question and gets asked. The WORKSPACE, so the resync's
 * report — which names the workspace host.db itself owns — is a different claim
 * and still goes. The TERMINAL, so one bad pane cannot silence another. The
 * GENERATION, so the next finish is reported normally rather than inheriting
 * this one's verdict.
 *
 * ONLY A REFUSAL LATCHES. A transport failure, a bridge still registering and
 * an unreadable host.db all answer `accepted: false` with no refusal, and every
 * one of them is worth trying again.
 *
 * The record itself is NEVER cleared by this — a latched claim retired nothing,
 * so the phone card is still up and the resync is still the thing that can take
 * it down.
 */
const MAX_REFUSED_SEEN_REPORTS = 256;
const refusedSeenReports = new Set<string>();

function refusedSeenKey(input: {
	hostUrl: string;
	workspaceId: string;
	terminalId: string;
	seenThroughAt: number;
}): string {
	return `${input.hostUrl}\u0000${input.workspaceId}\u0000${input.terminalId}\u0000${input.seenThroughAt}`;
}

function latchRefusedSeenReport(key: string): void {
	refusedSeenReports.add(key);
	// Oldest first, and one add can only ever put the set one over. An evicted
	// key costs one duplicate report, which the host refuses again and re-latches.
	if (refusedSeenReports.size > MAX_REFUSED_SEEN_REPORTS) {
		const oldest = refusedSeenReports.values().next();
		if (!oldest.done) refusedSeenReports.delete(oldest.value);
	}
}

/** Test seam only: the latch outlives an individual report by design. */
export function resetSeenRefusalLatchForTest(): void {
	refusedSeenReports.clear();
}

/**
 * The user read a chat. Tell its host so the phone and watch drop the
 * ready-for-review notification.
 *
 * CALLED ONLY ON REAL EVIDENCE OF A READ — a `review` entry that was actually
 * removed, or an OUTSTANDING ready record for a terminal the user just opened.
 * That is the caller's responsibility. A seen mark that merely bumped a
 * timestamp is not evidence the user read anything, and the resync's cold-start
 * seeding does exactly that for every idle terminal on every desktop launch.
 *
 * `seenThroughAt` is the HOST's clock (the review entry's `occurredAt`), never
 * this machine's: it is hashed into the alert id the retraction has to name.
 *
 * RESOLVES WITH WHETHER THE HOST ACTUALLY APPLIED IT. Callers that keep a
 * cooldown, or an outstanding record, need to tell a delivered report from one
 * that fell on the floor. `accepted: false` covers both a bridge still
 * registering AND a host that refused the report on its own evidence (host.db
 * does not place that terminal in that workspace, or could not be read to
 * check) — in every one of them nothing was retired, so recording it as
 * "repaired" would strand the phone card for as long as the cooldown lasts.
 * Never rejects: the dot has already cleared locally and there is nothing a
 * caller could usefully do with a throw.
 *
 * A REFUSED CLAIM IS NOT PUT ON THE WIRE AGAIN — see `refusedSeenReports`.
 */
export function reportTerminalSeen({
	workspaceId,
	terminalId,
	seenThroughAt,
}: {
	workspaceId: string;
	terminalId: string;
	seenThroughAt: number;
}): Promise<boolean> {
	const hostUrl = hostUrlByWorkspaceId.get(workspaceId);
	if (hostUrl === undefined) return Promise.resolve(false);
	if (!isReportableInstant(seenThroughAt)) return Promise.resolve(false);
	const key = refusedSeenKey({
		hostUrl,
		workspaceId,
		terminalId,
		seenThroughAt,
	});
	if (refusedSeenReports.has(key)) return Promise.resolve(false);
	// Silent on failure: the dot has already cleared locally, the frame's own
	// 24 h TTL and the phone's foreground sweep are the backstops, and there is
	// nothing the user could do with this.
	return getHostServiceClientByUrl(hostUrl)
		.companion.markLifecycleSeen.mutate({
			workspaceId,
			terminalId,
			seenThroughAt,
		})
		.then((result) => {
			if (result?.accepted === true) return true;
			if (result?.refusal === "workspace-mismatch") {
				latchRefusedSeenReport(key);
				log({ event: "seen_report_refused", hostUrl, terminalId });
				return false;
			}
			log({ event: "seen_report_unconsumed", hostUrl, terminalId });
			return false;
		})
		.catch(() => {
			// A host that is down reads exactly like a bridge that is off: nothing
			// was retired either way, and the ONE line that says so is this one.
			// Returning false in silence left the commonest failure invisible.
			log({ event: "seen_report_unconsumed", hostUrl, terminalId });
			return false;
		});
}

// ---------------------------------------------------------------------------
// (ALERT-RETIRE-ON-EXIT) the relaunch boundary
// ---------------------------------------------------------------------------

/**
 * (ALERT-RETIRE-ON-EXIT) Hosts that have ACCEPTED this launch's boundary.
 *
 * NOT CLEARED BY `forgetAlertContextSyncsForHost`, and that is the one thing
 * about this latch worth being careful with. A host reconnect is not a new
 * desktop launch: the boundary would be the same instant, the retirement it
 * asks for has already happened, and re-sending it on every flap would turn a
 * once-per-launch signal into a repeating one. Only a genuine relaunch clears
 * it, by ending the renderer process the Set lives in.
 *
 * Added ONLY on `accepted === true`. A host whose bridge was still registering
 * answers `false`, and that report changed nothing — leaving it unlatched is
 * what lets the next resync epoch try again.
 *
 * AN UNLATCHED HOST IS NOT ENOUGH ON ITS OWN. The other reason a host answers
 * `false` is that it REFUSED the boundary as out of range — most plausibly one
 * in its own future, which its clock stepping forward after this renderer
 * derived the instant is enough to produce. Re-offering the identical number
 * would be refused identically, forever, so the caller drops its cached
 * per-host boundary and derives a fresh one; `hasAcknowledgedRelaunchBoundary`
 * is how it tells that case from an already-settled host.
 */
const relaunchBoundaryAcknowledgedHosts = new Set<string>();

/**
 * (ALERT-RETIRE-ON-EXIT) Has this host already accepted a boundary for this
 * launch? Asked by the caller ONLY to read a `false` correctly: a settled host
 * answers `false` because there is nothing left to send, an unsettled one
 * because the report did not land.
 */
export function hasAcknowledgedRelaunchBoundary(hostUrl: string): boolean {
	return relaunchBoundaryAcknowledgedHosts.has(hostUrl);
}

/**
 * (ALERT-RETIRE-ON-EXIT) Tell one host when this desktop launch came up, so it
 * can take down the ready cards for finishes that predate it.
 *
 * KEYED BY HOST URL, not by workspace, unlike `reportTerminalSeen` beside it.
 * The boundary is a fact about a (renderer, host) pair rather than about any
 * one workspace, and the caller — the resync — already holds the host URL.
 *
 * SAME SILENT-ON-FAILURE CONTRACT as `reportTerminalSeen`: a host that is down,
 * a bridge that is off (the normal state on most machines), a mutation that
 * 500s and a host that REFUSED the boundary all resolve `false`. Nothing here
 * may reject, and nothing may surface to the user — the desktop has already
 * relaunched and shown them everything.
 *
 * THE LATCH IS CHECKED IN HERE, not by the caller. "Once per host per launch"
 * is this function's own rule — the Set is private to it — and a caller that
 * had to remember to ask first is a caller that can forget.
 *
 * THE BOUNDARY IS NOT THIS FUNCTION'S TO RE-DERIVE. It reports the number it is
 * given and says whether the host took it; deciding that an unconsumed report
 * means "derive a new instant" belongs to the resync, which owns the per-host
 * boundary and the monotonic clock behind it.
 *
 * The instant guard is the shared one — see `isReportableInstant`.
 */
export function reportRelaunchBoundary({
	hostUrl,
	boundaryMs,
}: {
	hostUrl: string;
	boundaryMs: number;
}): Promise<boolean> {
	if (relaunchBoundaryAcknowledgedHosts.has(hostUrl)) {
		return Promise.resolve(false);
	}
	if (!isReportableInstant(boundaryMs)) {
		log({ event: "relaunch_boundary_refused", hostUrl });
		return Promise.resolve(false);
	}
	return mutateAccepted(() =>
		getHostServiceClientByUrl(hostUrl).companion.retireStaleReadyAlerts.mutate({
			boundaryMs,
		}),
	).then((accepted) => {
		if (accepted) {
			relaunchBoundaryAcknowledgedHosts.add(hostUrl);
		} else {
			log({ event: "relaunch_boundary_unconsumed", hostUrl });
		}
		return accepted;
	});
}

/** Test seam only: a fresh launch is a fresh renderer process in production. */
export function resetRelaunchBoundaryLatchForTest(): void {
	relaunchBoundaryAcknowledgedHosts.clear();
}
