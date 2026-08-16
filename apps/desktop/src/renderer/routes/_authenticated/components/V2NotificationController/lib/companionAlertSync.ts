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

	const clearedReview = store.markTerminalSeen(terminalId, lastEventAt);
	if (!clearedReview || reviewAt === null) return clearedReview;

	void reportTerminalSeen({
		workspaceId,
		terminalId,
		seenThroughAt: reviewAt,
	});
	return true;
}

/**
 * The user read a chat. Tell its host so the phone and watch drop the
 * ready-for-review notification.
 *
 * CALLED ONLY WHEN A `review` ENTRY WAS ACTUALLY REMOVED — that is the caller's
 * responsibility and `markTerminalSeen`'s boolean is how they know. A seen mark
 * that merely bumped a timestamp is not evidence the user read anything, and
 * the resync's cold-start seeding does exactly that for every idle terminal on
 * every desktop launch.
 *
 * `seenThroughAt` is the HOST's clock (the review entry's `occurredAt`), never
 * this machine's: it is hashed into the alert id the retraction has to name.
 *
 * RESOLVES WITH WHETHER A BRIDGE ACTUALLY CONSUMED IT. Callers that keep a
 * cooldown need to tell a delivered report from one that fell on the floor —
 * `accepted: false` is the documented transient while a host's bridge finishes
 * registering, and recording that as "repaired" would suppress the retry for as
 * long as the cooldown lasts. Never rejects: the dot has already cleared
 * locally and there is nothing a caller could usefully do with a throw.
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
	if (!Number.isInteger(seenThroughAt) || seenThroughAt <= 0) {
		return Promise.resolve(false);
	}
	return getHostServiceClientByUrl(hostUrl)
		.companion.markLifecycleSeen.mutate({
			workspaceId,
			terminalId,
			seenThroughAt,
		})
		.then((result) => {
			const accepted = result?.accepted === true;
			if (!accepted) {
				log({ event: "seen_report_unconsumed", hostUrl, terminalId });
			}
			return accepted;
		})
		.catch(() => {
			// Silent: the dot has already cleared locally, the frame's own 24 h TTL
			// and the phone's foreground sweep are the backstops, and there is
			// nothing the user could do with this.
			return false;
		});
}
