import { createHash } from "node:crypto";
import type { CompanionLifecycleEvent } from "../trpc/router/notifications";
import { CURATION_RECHECK_MS } from "./config";
import type { BridgeLogger } from "./http";
import { errorClassName } from "./log-privacy";
import type { PresenceStore } from "./presence";
import type { PushSender } from "./push";
import type { PushAlertContext } from "./push-context";
import type { HostDbReader } from "./read-api";
import {
	createSidebarCuration,
	workspaceSidebarVerdict,
} from "./sidebar-filter";
import type { WorkspaceId } from "./types";

const ALERT_TTL_MS = 6 * 60 * 60 * 1000;
export const READY_SETTLE_MS = 10_000;
const SWEEP_MS = 2_000;

/**
 * `Failed` is red and cancels ready before `record()` mints its immediate `e`.
 * `Stop` is excluded because a repeat must not reset the settle window.
 * `Attached` is not working; `Detached` reaches `record()` as `session-end`.
 */
const READY_SETTLE_CANCEL_EVENTS = new Set([
	"Start",
	"SubagentActive",
	"BackgroundRunning",
	"PermissionRequest",
	"Failed",
]);

/**
 * Capacity bound on the alert table. Exported so the tests that exercise
 * eviction cannot drift from it.
 */
export const MAX_STATE_ENTRIES = 512;

/**
 * How long the FIRST delivery failure keeps an alert out of the sweep, doubling
 * per consecutive failure up to `DELIVERY_RETRY_MAX_BACKOFF_MS`.
 *
 * The sweep ticks every 2 s and `sendLifecycleAlert` already spends up to four
 * bounded FCM attempts per call, so retrying on every tick would turn one broken
 * endpoint — or, much more commonly, an install with no phone paired at all —
 * into a hot loop of broadcasts for the whole six-hour TTL. Retries end at the
 * TTL like every other end of an alert's life.
 */
const DELIVERY_RETRY_BACKOFF_MS = 30_000;
const DELIVERY_RETRY_MAX_BACKOFF_MS = 15 * 60 * 1000;
/**
 * (LIFECYCLE-ALERT-IDEMPOTENCY) How many producer event ids are remembered. One
 * per hook POST that carried lifecycle fields, and they are only ever consulted
 * for a duplicate delivery of the SAME POST, so a few minutes of traffic is all
 * that has to fit. Oldest-first, and an eviction can at worst let a duplicate
 * through — the alert id dedupes the common case underneath it.
 */
const MAX_SEEN_PRODUCER_EVENTS = 512;
/** §0.1 — the 22-char base64url shape every bridge-minted id has. */
const PRODUCER_EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/**
 * (LIFECYCLE-CURATION-CACHE) How many workspace curation verdicts are cached
 * before the probe walks its map for dead rows. Not a ceiling on held alerts.
 */
const CURATION_CACHE_SOFT_MAX = 64;

type LifecycleAlertKind = "g" | "e";

/**
 * (ONE-BUZZ-UNTIL-READ) Why an alert is being retired — which decides whether
 * the PHONE hears about it.
 *
 * A reason rather than a string, because exactly ONE of them is silent and
 * getting that wrong is invisible from the host: the notification either stacks
 * up overnight or vanishes when it should have stayed.
 */
type RetireReason =
	/**
	 * A NEW WORK CYCLE started on this terminal (`outcome: "progress"`). The
	 * chat is alive and about to finish again.
	 */
	| { kind: "new-cycle" }
	/** The session ended: there is no chat left to open, so clear the buzz. */
	| { kind: "session-end" }
	/** The user read the chat on the desktop. */
	| { kind: "seen" }
	/**
	 * (ALERT-RETIRE-ON-EXIT) The TERMINAL PROCESS died — the host runtime saw a
	 * CONFIRMED pty exit.
	 *
	 * Distinct from `session-end`, which is an AGENT-level signal off the hook
	 * stream: an agent can detach while its terminal lives on, and a terminal
	 * can die with no hook ever firing (a crash, a window closed, a
	 * `kill -9`). The second case is the one this reason exists for, and it was
	 * the commonest way a notification outlived the thing it pointed at.
	 */
	| { kind: "terminal-gone" }
	/**
	 * (ALERT-RETIRE-ON-EXIT) The DESKTOP relaunched, so every alert about a
	 * finish that predates this launch names a chat the user is about to look
	 * at with fresh eyes.
	 *
	 * Scoped by a boundary instant the renderer reports once per cold start,
	 * never "everything": a finish that landed AFTER the desktop came up is
	 * still news the phone should keep.
	 */
	| { kind: "desktop-relaunch" }
	/**
	 * (ALERT-RETIRE-ON-EXIT) The user curated the thread OFF their sidebar
	 * (snoozed, archived, or removed it).
	 *
	 * The push path already refuses to FIRE for a curated-off thread
	 * `(PUSH-CURATION-GATE)`, but an alert already on the handset was minted
	 * before the user made that decision and nothing took it back down.
	 */
	| { kind: "curated-off" };

/**
 * (ONE-BUZZ-UNTIL-READ) Which reason wins when an alert is superseded twice
 * while its broadcast is still in flight.
 *
 * A new cycle is the only SILENT reason, so it must never mask a later loud
 * one: fresh work starts, then the session ends before the send lands, and the
 * notification that lands names a chat that no longer exists. Ranking makes the
 * upgrade one-way — a loud reason can replace a silent one, never the reverse.
 */
function retireReasonRank(reason: RetireReason): number {
	return reason.kind === "new-cycle" ? 0 : 1;
}

function upgradeRetireReason(
	existing: RetireReason | null,
	next: RetireReason,
): RetireReason {
	if (existing === null) return next;
	return retireReasonRank(next) > retireReasonRank(existing) ? next : existing;
}

/**
 * (ONE-BUZZ-UNTIL-READ) Does retiring this alert send a `c` frame?
 *
 * ONE BUZZ PER UNREAD CHAT. Measured overnight on v0.1.0: a single long-running
 * chat finished sixteen times in a night, ~15 minutes apart, every one of them
 * while the user was away — sixteen separate buzzing notifications stacked on
 * the phone for one conversation nobody had read yet. Retracting each one as
 * the next cycle began would have been worse, not better: the wrist would still
 * buzz sixteen times and the user would also lose the standing "this chat has
 * something for you" card in between.
 *
 * So a delivered READY alert superseded by a NEW CYCLE is retired SILENTLY: the
 * row is kept (it is still the dedupe record for that cycle) and the
 * notification is left standing on the handset, where the next `g` for the same
 * terminal replaces it in place — the phone keys ready notifications by
 * terminal handle, and `t` has been on the v3 wire since the feature shipped.
 * The user sees one live card per unread chat, updated quietly, however many
 * turns it takes.
 *
 * EVERY OTHER RETIREMENT STILL FIRES, and each for a reason the silent case
 * does not share:
 *
 *  - `session-end` — the chat is GONE. Nothing will replace the notification
 *    and tapping it opens nothing, so it must come down.
 *  - `seen` — the user read it. That is the event that RESETS the cycle, so
 *    the next finish is allowed to buzz fresh.
 *  - (ALERT-RETIRE-ON-EXIT) `terminal-gone` — the pty died. Same argument as
 *    `session-end`, from the host runtime rather than the hook stream.
 *  - (ALERT-RETIRE-ON-EXIT) `desktop-relaunch` — the user is back at the
 *    machine and the app has restarted around them.
 *  - (ALERT-RETIRE-ON-EXIT) `curated-off` — they took the thread off their
 *    sidebar, which is a decision about the thread, not about this cycle.
 *
 * `e` ALERTS FIRE FOR EVERY REASON THERE IS, including `new-cycle`: an agent
 * that died is not superseded by later work on the same terminal in any useful
 * sense, so there is no silent case to fall into. What changed on 2026-08-20
 * is which reasons can REACH an `e` at all — `seen` now does, see
 * `findReadAlerts` — not how one is retired once it does.
 */
function notifiesPhone(alert: HeldAlert, reason: RetireReason): boolean {
	return !(alert.kind === "g" && reason.kind === "new-cycle");
}

/**
 * `held` — minted, never put on the wire yet; the only state a sweep may claim.
 * `sending` — CLAIMED by exactly one caller, an FCM broadcast is in flight.
 * `sent` — accepted by FCM, and NOT yet superseded.
 * `standing` — (ONE-BUZZ-UNTIL-READ) delivered, then overtaken by a newer work
 *   cycle. The notification is STILL ON THE DEVICES and the next `g` for this
 *   terminal replaces it in place, so nothing was sent to take it down — but it
 *   is live, and a later read or session end must still be able to retract it.
 *   That is why it is a state of its own rather than `retracted`: a `retracted`
 *   row is inert, and treating a standing notification as inert would strand it
 *   on the handset forever.
 * `retracted` — a `c` frame has gone out for it. Kept until the TTL for the
 *   SAME reason `sent` is: deleting the row re-opens re-minting, and a terminal
 *   that reports progress after the user read its chat would then buzz again
 *   about the cycle they just read. It is also the storm guard — nothing
 *   further ever happens to a `retracted` row.
 */
type LifecycleAlertState =
	| "held"
	| "sending"
	| "sent"
	| "standing"
	| "retracted";

interface HeldAlert {
	alertId: string;
	kind: LifecycleAlertKind;
	hostTerminalId: string;
	hostWorkspaceId: string;
	workspaceHandle: WorkspaceId;
	/**
	 * (ONE-BUZZ-UNTIL-READ) The outcome event's instant this alert was minted
	 * from — the same value its id hashes, carried on the wire as `gx`.
	 *
	 * Stored rather than recomputed because every frame about this alert needs
	 * it: the `g` so the phone can tell a replacement from a duplicate, and the
	 * `c` so a retraction names the exact finish it cancels.
	 */
	outcomeAtMs: number;
	expiresAtMs: number;
	state: LifecycleAlertState;
	/** True only until a ready alert first reaches its settle deadline. */
	settling: boolean;
	/** Wall-clock instant a `held` alert becomes eligible again after a failure. */
	retryAtMs: number;
	/** Consecutive failed deliveries, which is what the backoff is derived from. */
	failures: number;
	/**
	 * A newer work cycle (or a session end) landed on this terminal while the
	 * broadcast was in flight. A `sending` alert cannot be un-sent, but it must
	 * not be RE-held on failure: the thing it reports has been overtaken.
	 *
	 * (ALERT-CONTEXT-NAMES) It is no longer only a suppression flag. If that
	 * in-flight send is ACCEPTED, the alert is now on the phone and the fact that
	 * superseded it is still true, so `markDelivered` retracts it immediately.
	 * Before retraction existed the flag was silently dropped on success and the
	 * alert simply stood.
	 */
	superseded: boolean;
	/**
	 * (ONE-BUZZ-UNTIL-READ) WHY it was superseded, kept so `markDelivered` can
	 * make the same silent-or-not decision when the in-flight send lands. By
	 * then the event that superseded it is long gone.
	 */
	supersededReason: RetireReason | null;
}

/**
 * (ALERT-RETIRE-ON-EXIT) Is this alert ON a device, or on its way to one?
 *
 * The three states that answer yes are `sending` (in flight, and `markDelivered`
 * will retract it the moment it lands), `sent` and `standing` (delivered, the
 * second one silently superseded but still showing). The two that answer no are
 * `held` — never left this process — and `retracted`, which is a spent row kept
 * only so the same cycle cannot be re-minted.
 */
function isLiveAlert(alert: HeldAlert): boolean {
	return (
		alert.state === "sending" ||
		alert.state === "sent" ||
		alert.state === "standing"
	);
}

export interface LifecycleSeenInput {
	hostTerminalId: string;
	hostWorkspaceId: string;

	/**
	 * The binding's `lastEventAt` the renderer marked seen THROUGH — the host
	 * clock instant of the outcome event that raised the alert. It is what makes
	 * the `g` id recomputable without any durable state (see `lifecycleAlertId`).
	 */
	seenThroughAt: number;
}

export interface LifecycleAlertManager {
	record(input: CompanionLifecycleEvent): void;
	observeStatus(hostTerminalId: string, eventType: string): void;

	/**
	 * (ALERT-CONTEXT-NAMES) The user read the chat on the desktop: take the
	 * ready-for-review alert back off their phone and watch.
	 */
	markLifecycleSeen(input: LifecycleSeenInput): void;

	/**
	 * (ALERT-RETIRE-ON-EXIT) The terminal process is GONE — a confirmed pty
	 * exit, straight off the host runtime's own lifecycle broadcast.
	 *
	 * Retires EVERY alert for that terminal, `g` and `e` alike, for the reason
	 * `session-end` retires them: tapping the notification opens a chat that no
	 * longer exists. The hook stream cannot cover this on its own — a crashed
	 * or killed agent never gets to POST its own ending.
	 */
	retireTerminal(hostTerminalId: string): void;

	/**
	 * (ALERT-RETIRE-ON-EXIT) The desktop relaunched at `boundaryMs`: retire
	 * every READY alert about a finish that predates it.
	 *
	 * Returns how many rows were retired, for the caller's log.
	 */
	retireReadyBefore(boundaryMs: number): number;

	/**
	 * (ALERT-RETIRE-ON-EXIT) The sidebar mirror changed: retire the live alerts
	 * of every workspace the user is CURRENTLY curating off.
	 *
	 * Returns how many rows were retired, for the caller's log.
	 */
	retireCuratedOffAlerts(): number;

	stop(): void;
}

export function isLifecycleWorkspaceCuratedOff(input: {
	db: HostDbReader;
	organizationId: string;
	hostWorkspaceId: string;
	nowMs: number;
}): boolean {
	return (
		workspaceSidebarVerdict({
			snapshot: input.db.readSidebarMirror(),
			nowMs: input.nowMs,
			organizationId: input.organizationId,
			workspace: input.db.findWorkspace(input.hostWorkspaceId),
		}) !== "show"
	);
}

/**
 * (LIFECYCLE-CURATION-CACHE) The probe `LifecycleAlertManagerDeps.isCuratedOff`
 * is wired to, and the same shape `createIsCuratedOffProbe` uses for the
 * question path — for the same arithmetic. Answering it means reading the WHOLE
 * sidebar mirror synchronously off host.db, on the host-service's only thread,
 * and a held alert asks once per sweep (2 s) for up to its six-hour TTL: ~10,800
 * full mirror reads per held alert if nothing caches.
 *
 * ONLY A HOLD IS CACHED, and that is what makes the cache safe as well as
 * cheap. A `false` is not stored, so curation that comes ON is seen by the very
 * next sweep; a `true` is reused for at most `CURATION_RECHECK_MS`, so curation
 * that goes OFF — a snooze expiring — costs the alert up to 30 s of extra hold.
 * That is immaterial beside the presence lapse it is already waiting on, and it
 * is the only direction the cache can delay anything.
 *
 * KEYED BY WORKSPACE, not by alert: the verdict is a fact about the workspace,
 * so two alerts from the same thread share one read.
 *
 * EVERY UNCERTAIN ANSWER FIRES. A throw (a locked db, a reader that lost its
 * file) answers `false` and says so — a missed alert is invisible from both
 * ends, and this feature reports when it cannot tell.
 */
export function createLifecycleCurationProbe(deps: {
	db: HostDbReader;
	organizationId: string;
	logger: BridgeLogger;
	now?: () => number;
}): (hostWorkspaceId: string) => boolean {
	const now = deps.now ?? (() => Date.now());
	const cache = new Map<string, { checkedAtMs: number }>();

	function pruneDeadRows(nowMs: number): void {
		if (cache.size <= CURATION_CACHE_SOFT_MAX) return;
		for (const [hostWorkspaceId, row] of cache) {
			// Older than an alert can live = nothing is still holding on it.
			if (nowMs - row.checkedAtMs > ALERT_TTL_MS) cache.delete(hostWorkspaceId);
		}
	}

	return (hostWorkspaceId: string): boolean => {
		const nowMs = now();
		const cached = cache.get(hostWorkspaceId);
		// (CLOCK-STEP-FAILS-OPEN) A NEGATIVE age is a MISS, not the freshest
		// possible hit: `now` is a wall clock and a resume or an NTP correction can
		// step it backwards, which with only an upper bound checked would pin a
		// stale hold for as long as the step.
		const ageMs = nowMs - (cached?.checkedAtMs ?? 0);
		if (cached !== undefined && ageMs >= 0 && ageMs < CURATION_RECHECK_MS) {
			return true;
		}
		let held: boolean;
		try {
			held = isLifecycleWorkspaceCuratedOff({
				db: deps.db,
				organizationId: deps.organizationId,
				hostWorkspaceId,
				nowMs,
			});
		} catch (error) {
			deps.logger.error(
				"could not read sidebar curation for a lifecycle alert; firing anyway",
				{ hostWorkspaceId, error },
			);
			cache.delete(hostWorkspaceId);
			return false;
		}
		if (!held) {
			cache.delete(hostWorkspaceId);
			return false;
		}
		// LOGGED ON TRANSITION, NOT PER SWEEP: the decision matters once per
		// episode, and 1,800 copies of it an hour would bury the lines it sits next
		// to. A hold that lapses and is re-taken is a new episode and logs again.
		if (cached === undefined) {
			deps.logger.info(
				"holding a lifecycle alert: the user has taken this thread off their sidebar. It will fire on the first sweep after that changes",
				{ hostWorkspaceId },
			);
		}
		cache.set(hostWorkspaceId, { checkedAtMs: nowMs });
		pruneDeadRows(nowMs);
		return true;
	};
}

/**
 * (ALERT-RETIRE-ON-EXIT) Which of these workspaces is the user curating OFF
 * their sidebar right now — read fresh, once, for one retirement walk.
 *
 * THE SIBLING OF `createLifecycleCurationProbe`, AND DELIBERATELY NOT IT. That
 * probe caches a `true` for 30 s `(LIFECYCLE-CURATION-CACHE)`, which is right
 * for a sweep asking every two seconds and WRONG here: a mirror write that
 * UN-snoozes a thread would read the stale hold and retract the alerts the user
 * has just brought back. Nothing is cached here for the same reason.
 *
 * ONE READ PER WALK, not per workspace. Answering the question means reading
 * the whole sidebar mirror off host.db on the host-service's only thread and
 * rebuilding the curation from it, and asking per workspace did both N times
 * for one sidebar write.
 *
 * FAIL CLOSED, which is the opposite of the send path's fail-open rule and for
 * the mirror-image reason. There, an uncertain verdict costs at worst a
 * notification the user did not need; here it would TAKE DOWN a notification
 * they have never seen, and nothing re-raises a retracted alert. So an
 * unreadable mirror answers "none of them", and a workspace whose own verdict
 * throws is left out of the set.
 *
 * ERROR CLASS ONLY in the logs: this is handed workspace ids and a reader's
 * message can carry a path.
 */
export function createFreshCurationRead(deps: {
	db: HostDbReader;
	organizationId: string;
	logger: BridgeLogger;
	now?: () => number;
}): (hostWorkspaceIds: readonly string[]) => ReadonlySet<string> {
	const now = deps.now ?? (() => Date.now());
	return (hostWorkspaceIds) => {
		const curatedOff = new Set<string>();
		if (hostWorkspaceIds.length === 0) return curatedOff;
		let curation: ReturnType<typeof createSidebarCuration>;
		try {
			curation = createSidebarCuration(
				deps.db.readSidebarMirror(),
				now(),
				deps.organizationId,
			);
		} catch (error) {
			deps.logger.error(
				"could not read sidebar curation while retiring alerts; retiring none",
				{ error: errorClassName(error) },
			);
			return curatedOff;
		}
		if (!curation.enabled) return curatedOff;
		for (const hostWorkspaceId of hostWorkspaceIds) {
			try {
				const workspace = deps.db.findWorkspace(hostWorkspaceId);
				if (workspace === null) continue;
				if (curation.workspaceVerdict(workspace) !== "show") {
					curatedOff.add(hostWorkspaceId);
				}
			} catch (error) {
				deps.logger.error(
					"could not read one workspace's sidebar curation while retiring alerts; retiring none for it",
					{ hostWorkspaceId, error: errorClassName(error) },
				);
			}
		}
		return curatedOff;
	};
}

export interface LifecycleAlertManagerDeps {
	/** Only the verdict is ever asked for; beacons belong to the push path. */
	presence: Pick<PresenceStore, "present">;
	push: Pick<PushSender, "sendLifecycleAlert" | "sendLifecycleRetraction">;
	workspaceHandle(hostWorkspaceId: string): WorkspaceId;
	isCuratedOff(hostWorkspaceId: string): boolean;

	/**
	 * (ALERT-RETIRE-ON-EXIT) Which of these workspaces the user is curating off
	 * RIGHT NOW — a FRESH read, never the 30 s cache `isCuratedOff` sits behind.
	 * See `createFreshCurationRead`, which is what this is wired to.
	 */
	curatedOffAmong(hostWorkspaceIds: readonly string[]): ReadonlySet<string>;

	/**
	 * (ALERT-CONTEXT-NAMES) Which project, workspace and tab is this alert about?
	 *
	 * Injected rather than reached for: this module holds no `HostDbReader` and
	 * deliberately still does not — it owns the cycle state machine and nothing
	 * else. It is called INSIDE `send()`, on every attempt including a retry
	 * fifteen minutes later, and the answer is NEVER stored on the held record. A
	 * held alert can outlive a workspace rename, a tab retitle and a pane move;
	 * caching the names at mint time would buzz with whichever of those was true
	 * when the agent finished rather than when the user is told.
	 *
	 * `null` disables context entirely and the phone falls back to its generic
	 * strings. Required rather than optional so a composition root states it.
	 */
	resolveContext:
		| ((input: {
				hostTerminalId: string;
				hostWorkspaceId: string;
		  }) => PushAlertContext | null)
		| null;
	/**
	 * (ALERT-CONTEXT-NAMES) The opaque terminal handle a retraction addresses the
	 * watch dismissal with. Same shape as `workspaceHandle`, and separate from
	 * `resolveContext` because a retraction carries a handle and no names.
	 */
	terminalHandle(hostTerminalId: string): string;
	/**
	 * (ONE-BUZZ-UNTIL-READ) The last lifecycle instant this HOST had recorded for
	 * each terminal before this manager started — read ONCE, at construction.
	 *
	 * It is what puts the proof-of-absence test on the same timeline as the
	 * thing it is reasoning about. `startedAtMs` is a wall-clock reading, while
	 * generations are per-terminal monotonic (`nextLifecycleInstantMs`), and a
	 * restart that lands inside a clock backstep makes those two disagree: the
	 * process starts at 4000 while the alert the previous process sent is
	 * stamped 5000, so a read of that alert looks like it happened BEFORE this
	 * process began holding state — and the silent "nothing ever existed" branch
	 * swallows the one `c` that could take the notification off the phone.
	 * Comparing against the terminal's own last recorded instant instead makes
	 * the test mean what it says: "this read names a generation only I could
	 * have minted".
	 *
	 * `null` states that no restart evidence is available, which DISABLES the
	 * proof entirely — a blind `c` the phone drops is the safe failure, a
	 * swallowed retraction is not. Required rather than optional so a
	 * composition root has to say which it is.
	 */
	proofEpochs:
		| (() => Iterable<{ hostTerminalId: string; lastEventAtMs: number }>)
		| null;
	/** Required so the composition root declares the ready-settle policy. */
	readySettleMs: number;
	logger: BridgeLogger;
	now?: () => number;
}

/**
 * (ALERT-CONTEXT-NAMES) The alert id is derived from the FINAL OUTCOME EVENT'S
 * INSTANT, not from the instant the work cycle started.
 *
 * It used to hash `previousEventAtMs` — the Start that armed the cycle — which
 * is a perfectly good identity and unrecomputable by anyone else. That mattered
 * the moment retraction arrived: the renderer knows a terminal was read
 * "through" its binding's `lastEventAt`, which is the OUTCOME event's stamp, and
 * nothing outside this process has ever seen the cycle's start. Hashing the
 * outcome instant makes the id something `markLifecycleSeen` can recompute from
 * a signal that survives a host-service restart — with no durable alert state
 * and no schema change.
 *
 * MINTING AND DEDUPE ARE UNAFFECTED, and tests pin that. Both stamps are
 * one-per-cycle: two POSTs reporting the same cycle ending carry the same
 * outcome instant and still collapse to one alert, exactly as they collapsed on
 * the same start instant before.
 *
 * ONE-TIME COST, ACCEPTED: an alert minted by the previous build and still on a
 * phone across the upgrade cannot be retracted, because its id was hashed from
 * the other stamp. It expires on its own TTL.
 */
function lifecycleAlertId(input: {
	hostTerminalId: string;
	occurredAtMs: number;
	kind: LifecycleAlertKind;
}): string {
	// PROTOCOL.md §0.1: first 16 digest bytes, base64url encoded (22 chars).
	return createHash("sha256")
		.update("sc/v2 lifecycle alert\0", "utf8")
		.update(input.kind, "utf8")
		.update("\0", "utf8")
		.update(input.hostTerminalId, "utf8")
		.update("\0", "utf8")
		.update(String(input.occurredAtMs), "utf8")
		.digest()
		.subarray(0, 16)
		.toString("base64url");
}

/**
 * Lifecycle delivery state is intentionally process-local. The validated hook
 * stream and the host DB remain the lifecycle source of truth; this bounded map
 * only holds informational alerts while presence or sidebar curation delays
 * delivery. A host-service restart can lose an unsent held alert. Durable
 * delivery would require an explicitly approved database schema change.
 *
 * (LIFECYCLE-ALERT-SUPERSEDE) A HELD alert is a claim about a work cycle that
 * has ENDED. The moment the same terminal reports progress again, that claim is
 * stale — the cycle it named is two cycles back — so the next hook event on the
 * terminal cancels it. Without that, a user who was away for an hour and then
 * sat down got a burst of alerts on the first sweep after they walked off again,
 * every one of them about a turn that had long since been superseded.
 */
export function createLifecycleAlertManager(
	deps: LifecycleAlertManagerDeps,
): LifecycleAlertManager {
	if (!Number.isFinite(deps.readySettleMs) || deps.readySettleMs < 0) {
		throw new Error("readySettleMs must be a finite non-negative number");
	}
	const now = deps.now ?? (() => Date.now());

	/**
	 * (ALERT-CONTEXT-NAMES) When this manager began holding alert state.
	 *
	 * It is the evidence that turns "I have no row for this id" into "no such
	 * alert ever existed" — see `markLifecycleSeen`. A manager is constructed
	 * once per bridge start, so this is effectively the bridge's own start
	 * instant.
	 */
	const startedAtMs = now();

	/**
	 * (ONE-BUZZ-UNTIL-READ) The proof epoch, per terminal: the last generation
	 * each terminal had recorded when this manager started.
	 *
	 * A read may only be answered with silence when it names a generation this
	 * process would necessarily hold a row for. With per-terminal monotonic
	 * instants, "necessarily" is exactly `seenThroughAt > epoch[terminal]`: this
	 * process's first stamp for that terminal is `epoch + 1` at the earliest, so
	 * anything at or below the epoch belongs to a PREDECESSOR and its row died
	 * with that process.
	 *
	 * A read failure disables the proof rather than failing the bridge start: a
	 * blind `c` costs a frame the phone drops, a wrongly swallowed one strands a
	 * notification for six hours.
	 */
	const proofEpochByTerminal = new Map<string, number>();
	let proofDisabled = deps.proofEpochs === null;
	try {
		for (const row of deps.proofEpochs?.() ?? []) {
			if (typeof row.hostTerminalId !== "string") continue;
			if (!Number.isFinite(row.lastEventAtMs)) continue;
			const existing = proofEpochByTerminal.get(row.hostTerminalId);
			if (existing === undefined || existing < row.lastEventAtMs) {
				proofEpochByTerminal.set(row.hostTerminalId, row.lastEventAtMs);
			}
		}
	} catch (error) {
		proofDisabled = true;
		deps.logger.error(
			"could not read the lifecycle proof epoch; proof-of-absence is off for this process and reads will broadcast blind",
			{ error: String(error) },
		);
	}

	/**
	 * (ONE-BUZZ-UNTIL-READ) Is this host's clock BEHIND the timeline its own
	 * persisted state is on?
	 *
	 * A terminal with no epoch entry has no predecessor generation to compare
	 * against, so the wall-clock test is normally the honest answer for it. But
	 * if any terminal's persisted instant is at or beyond this process's start,
	 * the clock stepped back across the restart and no wall-clock comparison on
	 * this process can be trusted — so those terminals lose the proof too, until
	 * the clock and the timeline agree again.
	 */
	const clockIsBehindPersistedTimeline = (() => {
		for (const instant of proofEpochByTerminal.values()) {
			if (instant >= startedAtMs) return true;
		}
		return false;
	})();

	/**
	 * (ONE-BUZZ-UNTIL-READ) May silence be read as proof for THIS read?
	 *
	 * Every clause is a separate way of knowing the map's emptiness is ignorance
	 * rather than evidence, and any one of them is enough to send the blind `c`
	 * instead.
	 */
	function canProveAbsence(hostTerminalId: string, seenThroughAt: number) {
		if (proofDisabled) return false;
		// `evictOldest` has thrown away an unexpired row: the map is no longer a
		// complete record of what this process minted.
		if (hasEvictedUnexpired) return false;
		// This process began holding state after the read happened.
		if (startedAtMs > seenThroughAt) return false;
		const epoch = proofEpochByTerminal.get(hostTerminalId);
		if (epoch === undefined) return !clockIsBehindPersistedTimeline;
		// The read names a generation a PREDECESSOR minted.
		return seenThroughAt > epoch;
	}

	/**
	 * (ALERT-CONTEXT-NAMES) When an UNEXPIRED row was last thrown away by the
	 * capacity bound, or `null` if that has never happened.
	 *
	 * It is the second half of the proof-of-absence test in
	 * `markLifecycleSeen`. "Started before the read" only implies "every alert I
	 * minted is still here" while nothing has been evicted out from under that
	 * claim, and an evicted `sending` row can still be ACCEPTED by FCM
	 * afterwards — so the alert reaches the phone with no record of it anywhere.
	 * Once this is set the silent return is off for good and the blind
	 * broadcast, which the phone drops harmlessly when it does not apply, comes
	 * back.
	 */
	let hasEvictedUnexpired = false;

	const alerts = new Map<string, HeldAlert>();
	/** (LIFECYCLE-ALERT-IDEMPOTENCY) Producer ids already applied, oldest first. */
	const seenProducerEvents = new Set<string>();
	let stopped = false;
	let timer: NodeJS.Timeout | null = null;

	function evictOldest(): void {
		while (alerts.size > MAX_STATE_ENTRIES) {
			const oldest = alerts.keys().next();
			if (oldest.done) return;
			const evicted = alerts.get(oldest.value);
			alerts.delete(oldest.value);
			if (evicted === undefined) continue;

			// EVERY UNEXPIRED EVICTION IS LOUD, whatever its state — the previous
			// version logged only `held`/`sending` and called a `sent` or
			// `retracted` row "only a tombstone that costs nothing", which was
			// wrong twice over. A `sent` row is the RECORD OF A NOTIFICATION THAT
			// IS ON THE USER'S PHONE: dropping it abandons the only thing that
			// could ever retract that alert. A `retracted` row is the tombstone
			// that stops the same cycle re-minting and re-buzzing. Both matter,
			// and both were being dropped in silence.
			const unexpired = evicted.expiresAtMs > now();
			if (unexpired) {
				// (ALERT-CONTEXT-NAMES) It also destroys the proof-of-absence
				// argument in `markLifecycleSeen`: "no row for this terminal" only
				// means "no alert existed" while nothing unexpired has been thrown
				// away. One eviction and that stops being true process-wide, so the
				// silent-return is disabled from here on rather than tracked per
				// terminal. Deliberately coarse: reaching 512 simultaneously live
				// alerts is near-impossible in practice, and when it does happen the
				// cheap wrong answer (a blind `c` the phone drops) is far better
				// than the expensive one (a real notification abandoned forever).
				hasEvictedUnexpired = true;
				deps.logger.error(
					"lifecycle alert table exceeded its bound; dropped an unexpired alert",
					{
						alertId: evicted.alertId,
						kind: evicted.kind,
						hostTerminalId: evicted.hostTerminalId,
						state: evicted.state,
						maxEntries: MAX_STATE_ENTRIES,
					},
				);
			}
		}
	}

	function prune(nowMs: number): void {
		for (const [alertId, alert] of alerts) {
			if (alert.expiresAtMs > nowMs) continue;
			alerts.delete(alertId);
			if (alert.state === "held") {
				deps.logger.info("lifecycle alert expired before it could be sent", {
					alertId,
					kind: alert.kind,
					hostTerminalId: alert.hostTerminalId,
				});
			}
		}
		evictOldest();
	}

	function dueAlerts(nowMs: number): HeldAlert[] {
		return [...alerts.values()].filter(
			(alert) => alert.state === "held" && alert.retryAtMs <= nowMs,
		);
	}

	function hasHeldAlert(): boolean {
		for (const alert of alerts.values()) {
			if (alert.state === "held") return true;
		}
		return false;
	}

	function scheduleSweep(): void {
		if (timer !== null || stopped || !hasHeldAlert()) return;
		timer = setTimeout(() => {
			timer = null;
			void sweep();
		}, SWEEP_MS);
		timer.unref?.();
	}

	/**
	 * (LIFECYCLE-ALERT-CLAIM) Take exclusive ownership of one alert, or answer
	 * `null`.
	 *
	 * SYNCHRONOUS FROM END TO END, and that is the whole point: `mint` fires a
	 * send inline while a sweep may already be walking the same map, so the state
	 * transition to `sending` must be committed to the canonical map before any
	 * `await` exists. The caller's own snapshot is never trusted — the map is
	 * re-read here — because the entry can have been cancelled, superseded, sent
	 * or expired between the snapshot and this call.
	 */
	function claim(alertId: string, nowMs: number): HeldAlert | null {
		let current = alerts.get(alertId);
		if (current === undefined || current.state !== "held") return null;
		if (current.expiresAtMs <= nowMs) {
			alerts.delete(alertId);
			return null;
		}
		if (current.retryAtMs > nowMs) return null;
		if (current.settling) {
			current = { ...current, settling: false };
			alerts.set(alertId, current);
		}
		// HELD, not dropped: presence and curation both change their minds, and the
		// alert fires on the first sweep after they do.
		if (deps.presence.present(nowMs).present) return null;
		if (deps.isCuratedOff(current.hostWorkspaceId)) return null;
		const claimed: HeldAlert = { ...current, state: "sending" };
		alerts.set(alertId, claimed);
		return claimed;
	}

	/**
	 * (ALERT-CONTEXT-NAMES) Put a `c` frame on the wire for one alert, once.
	 *
	 * Fire and forget from here: `sendLifecycleRetraction` resolves whatever
	 * happens (it cannot reject), and it queues on the alert's own chain so it
	 * cannot overtake the send it cancels. The `.catch` is belt and braces
	 * against a future contract change, never a swallowed decision.
	 *
	 * (ALERT-RETIRE-ON-EXIT) `t` IS EMPTY FOR AN `e`, and that is a correctness
	 * fix rather than a tidy-up. The phone reads a retraction terminal-FIRST:
	 * a `c` carrying a real terminal handle cancels whatever card that handle
	 * keys, and ready cards are keyed by handle. So an error retraction that
	 * carried its terminal's handle took down the STANDING READY card for the
	 * same terminal — a card the user had never read. An `e` is not keyed by
	 * handle on the phone (it is never replaced in place), so it loses nothing
	 * by naming none: the alert id alone is what cancels it.
	 *
	 * `gx` IS UNCHANGED FOR BOTH KINDS. `buildLifecycleRetractPushData` requires
	 * a positive outcome instant, and an `e` row has one — `mint` stamps
	 * `outcomeAtMs` from the event for every kind.
	 */
	function fireRetraction(alert: HeldAlert, reason: string): void {
		deps.logger.info("retracting a lifecycle alert", {
			alertId: alert.alertId,
			kind: alert.kind,
			hostTerminalId: alert.hostTerminalId,
			reason,
		});
		try {
			void deps.push
				.sendLifecycleRetraction({
					alertId: alert.alertId,
					workspaceId: alert.workspaceHandle,
					terminalHandle:
						alert.kind === "g" ? deps.terminalHandle(alert.hostTerminalId) : "",
					outcomeAtMs: alert.outcomeAtMs,
				})
				.catch((error: unknown) => {
					deps.logger.error("lifecycle retraction send rejected", {
						alertId: alert.alertId,
						error,
					});
				});
		} catch (error) {
			deps.logger.error("could not build a lifecycle retraction", {
				alertId: alert.alertId,
				error,
			});
		}
	}

	/**
	 * The broadcast was accepted. Two endings, not one.
	 *
	 * (ALERT-CONTEXT-NAMES) If the alert was SUPERSEDED while it was on the wire,
	 * the fact it reports is already stale and it is now sitting on the user's
	 * phone. The flag used to be dropped here in silence — the alert landed and
	 * nothing could ever take it back.
	 *
	 * (ONE-BUZZ-UNTIL-READ) Whether that retirement REACHES the phone is the same
	 * question `retireAlert` asks, answered with the reason recorded when the
	 * supersede happened: a new work cycle retires a ready alert silently and
	 * leaves the notification standing for the next one to replace, a session end
	 * clears it. A missing reason is treated as one that fires — a spare `c` the
	 * phone drops is cheaper than a notification for a chat that no longer exists.
	 */
	function markDelivered(claimed: HeldAlert): void {
		const current = alerts.get(claimed.alertId);
		if (current === undefined || current.state !== "sending") return;
		if (current.superseded) {
			const reason: RetireReason = current.supersededReason ?? {
				kind: "session-end",
			};
			if (!notifiesPhone(current, reason)) {
				// It LANDED, and the chat is still alive: leave it standing for the
				// next cycle's alert to replace in place.
				alerts.set(claimed.alertId, { ...current, state: "standing" });
				deps.logger.info(
					"(ONE-BUZZ-UNTIL-READ) a ready alert landed after a newer cycle began; leaving it standing for the next one to replace",
					{
						alertId: current.alertId,
						hostTerminalId: current.hostTerminalId,
					},
				);
				return;
			}
			alerts.set(claimed.alertId, { ...current, state: "retracted" });
			fireRetraction(current, `${reason.kind} while in flight`);
			return;
		}
		alerts.set(claimed.alertId, { ...current, state: "sent" });
	}

	/**
	 * A delivery that FAILED must be visible and must come back for another try —
	 * a silent watch is indistinguishable from "nothing happened", which is the
	 * one thing this feature exists to prevent. Retry is bounded by the alert's
	 * own TTL, and a superseded alert is dropped rather than re-held.
	 *
	 * "No registered device" arrives here as a failure too, on purpose: a phone
	 * can pair at any point inside the six hours. That is also the state most
	 * likely to persist, so the FIRST failure is an error and the repeats are
	 * info with a doubling backoff — loud once, never 720 times.
	 */
	function holdAfterFailure(claimed: HeldAlert, error: unknown): void {
		const failures = claimed.failures + 1;
		const fields = {
			alertId: claimed.alertId,
			kind: claimed.kind,
			hostTerminalId: claimed.hostTerminalId,
			failures,
			error,
		};
		if (failures === 1) {
			deps.logger.error("could not send lifecycle alert", fields);
		} else {
			deps.logger.info(
				"lifecycle alert still undelivered; holding it for another try",
				fields,
			);
		}
		const current = alerts.get(claimed.alertId);
		if (current === undefined || current.state !== "sending") return;
		if (current.superseded) {
			alerts.delete(claimed.alertId);
			deps.logger.info(
				"dropping a failed lifecycle alert; a newer cycle superseded it",
				{ alertId: claimed.alertId, hostTerminalId: claimed.hostTerminalId },
			);
			return;
		}
		const nowMs = now();
		if (current.expiresAtMs <= nowMs) {
			alerts.delete(claimed.alertId);
			deps.logger.error(
				"a lifecycle alert expired while its delivery was failing",
				{ alertId: claimed.alertId, hostTerminalId: claimed.hostTerminalId },
			);
			return;
		}
		const backoffMs = Math.min(
			DELIVERY_RETRY_BACKOFF_MS * 2 ** (failures - 1),
			DELIVERY_RETRY_MAX_BACKOFF_MS,
		);
		alerts.set(claimed.alertId, {
			...current,
			state: "held",
			failures,
			retryAtMs: nowMs + backoffMs,
		});
		scheduleSweep();
	}

	/**
	 * (ALERT-CONTEXT-NAMES) Ask the resolver, and never let it break a send. The
	 * names are a courtesy; the alert is the product. Nothing about a failure
	 * here is allowed to hold, delay or drop the notification, and no NAME ever
	 * reaches this log line — only ids.
	 */
	function resolveContextSafely(alert: HeldAlert): PushAlertContext | null {
		const resolve = deps.resolveContext;
		if (resolve === null) return null;
		try {
			return resolve({
				hostTerminalId: alert.hostTerminalId,
				hostWorkspaceId: alert.hostWorkspaceId,
			});
		} catch (error) {
			deps.logger.error(
				"could not resolve alert context; the notification will use its generic wording",
				{
					alertId: alert.alertId,
					hostTerminalId: alert.hostTerminalId,
					error,
				},
			);
			return null;
		}
	}

	async function send(alertId: string): Promise<void> {
		if (stopped) return;
		const claimed = claim(alertId, now());
		if (claimed === null) return;
		try {
			await deps.push.sendLifecycleAlert({
				alertId: claimed.alertId,
				workspaceId: claimed.workspaceHandle,
				kind: claimed.kind,
				expiresAtMs: claimed.expiresAtMs,
				// (ONE-BUZZ-UNTIL-READ) Both come off the ALERT ROW, never out of the
				// resolved context: a context that fails to resolve costs the names
				// and must never cost the handle a ready notification is keyed by.
				terminalHandle: deps.terminalHandle(claimed.hostTerminalId),
				outcomeAtMs: claimed.outcomeAtMs,
				// (ALERT-CONTEXT-NAMES) Resolved INSIDE the send, so every retry gets a
				// fresh answer and a rename between attempts is reflected. The result
				// is deliberately not written back to `claimed`.
				context: resolveContextSafely(claimed),
			});
		} catch (error) {
			holdAfterFailure(claimed, error);
			return;
		}
		markDelivered(claimed);
	}

	/** Fire and forget, but never as an unhandled rejection out of a timer. */
	function fire(alertId: string): void {
		void send(alertId).catch((error: unknown) => {
			console.error("[companion/lifecycle] alert send threw", alertId, error);
		});
	}

	async function sweep(): Promise<void> {
		try {
			if (stopped) return;
			const nowMs = now();
			prune(nowMs);
			for (const alert of dueAlerts(nowMs)) {
				if (stopped) return;
				await send(alert.alertId);
			}
		} catch (error) {
			console.error("[companion/lifecycle] alert sweep threw", error);
		} finally {
			scheduleSweep();
		}
	}

	/**
	 * (LIFECYCLE-ALERT-SUPERSEDE) The terminal has moved on.
	 *
	 * Four states, four different right answers, and (ALERT-CONTEXT-NAMES) added
	 * the two that involve the phone:
	 *
	 *  - `held` — never left the process. Delete it; nothing to retract.
	 *  - `sending` — cannot be un-sent. Flag it, so a FAILED delivery is not
	 *    re-held and an ACCEPTED one is retracted the moment it lands
	 *    (`markDelivered`).
	 *  - `sent` — it is on the phone and the fact it reports has been overtaken.
	 *    Retract ONCE and move to `retracted`, KEEPING the row: deleting it would
	 *    re-open re-minting for the same cycle.
	 *  - `retracted` — nothing further, ever. That is the storm guard: a terminal
	 *    that reports progress twenty times after the user read its chat sends
	 *    twenty nothings, not twenty retractions.
	 */
	function supersede(hostTerminalId: string, reason: RetireReason): void {
		retireWhere((alert) => alert.hostTerminalId === hostTerminalId, reason);
	}

	/**
	 * Retire every alert a predicate picks, over a SNAPSHOT of the table.
	 *
	 * The snapshot is the point: `retireAlert` writes to `alerts` as it goes
	 * (deleting a held row, replacing a sent one), and iterating the live map
	 * while it does that is unspecified. Returns how many rows it touched, for
	 * the callers that report a count.
	 */
	function retireWhere(
		predicate: (alert: HeldAlert) => boolean,
		reason: RetireReason,
	): number {
		let retired = 0;
		for (const alert of [...alerts.values()]) {
			if (!predicate(alert)) continue;
			retireAlert(alert, reason);
			retired += 1;
		}
		return retired;
	}

	/**
	 * (ALERT-CONTEXT-NAMES) Take ONE known alert out of play, by its state.
	 *
	 * The four-way transition above, as a function, because two callers need it
	 * and had grown their own copies: `supersede` (a newer cycle landed on this
	 * terminal) and `retractById` (the user read the chat). They differ only in
	 * how they FIND the alert — by terminal or by id — and a divergence between
	 * two hand-written copies of a state machine is exactly the class of bug the
	 * `sending` case was introduced to fix.
	 */
	function retireAlert(alert: HeldAlert, reason: RetireReason): void {
		if (alert.state === "retracted") return;
		if (alert.state === "held") {
			alerts.delete(alert.alertId);
			deps.logger.info("cancelled a held lifecycle alert", {
				alertId: alert.alertId,
				kind: alert.kind,
				hostTerminalId: alert.hostTerminalId,
				reason: reason.kind,
			});
			return;
		}
		if (alert.state === "sending") {
			// The reason is REMEMBERED, not just the fact: `markDelivered` has to
			// make the same silent-or-not decision when this send lands, and by
			// then the event that superseded it is long gone. It UPGRADES, so a
			// session end arriving behind a new cycle still takes the notification
			// down when it lands.
			alerts.set(alert.alertId, {
				...alert,
				superseded: true,
				supersededReason: upgradeRetireReason(alert.supersededReason, reason),
			});
			return;
		}
		// `sent` or `standing` — both are LIVE ON THE DEVICES.
		if (!notifiesPhone(alert, reason)) {
			// A newer cycle. The first one moves the row to `standing`; a second,
			// third and twentieth are no-ops, which is the storm guard.
			if (alert.state === "standing") return;
			alerts.set(alert.alertId, { ...alert, state: "standing" });
			deps.logger.info(
				"(ONE-BUZZ-UNTIL-READ) a newer cycle began; leaving the delivered ready alert standing for the next one to replace",
				{
					alertId: alert.alertId,
					hostTerminalId: alert.hostTerminalId,
					reason: reason.kind,
				},
			);
			return;
		}
		alerts.set(alert.alertId, { ...alert, state: "retracted" });
		fireRetraction(alert, reason.kind);
	}

	/**
	 * (ALERT-CONTEXT-NAMES) Retract one alert by id, whatever state it is in —
	 * including a state this process has never seen.
	 *
	 * THE UNKNOWN-ID CASE IS THE POINT, not an edge. A host-service restart drops
	 * every alert row while the notification it sent is still on the phone, and
	 * the id is recomputable precisely so that restart is survivable: the `c`
	 * frame goes out for an id this process has no record of, and the phone —
	 * which DOES have a record — cancels it. A phone that does not know the id
	 * drops the frame, which is why this is safe to do blind.
	 *
	 * A tombstone row is left behind so repeated calls for the same id are silent
	 * rather than a second, third and fourth broadcast. It expires on the
	 * ordinary TTL like every other row.
	 */
	function retractById(input: {
		alertId: string;
		hostTerminalId: string;
		hostWorkspaceId: string;
		/**
		 * (ONE-BUZZ-UNTIL-READ) What the blind restart `c` names, when no row
		 * survives to read an outcome instant off: the instant the user read
		 * through, which is the same value the recomputed id hashes.
		 */
		outcomeAtMs: number;
		reason: RetireReason;
	}): void {
		const existing = alerts.get(input.alertId);
		if (existing !== undefined) {
			retireAlert(existing, input.reason);
			return;
		}

		const nowMs = now();

		const tombstone: HeldAlert = {
			alertId: input.alertId,
			kind: "g",
			hostTerminalId: input.hostTerminalId,
			hostWorkspaceId: input.hostWorkspaceId,
			workspaceHandle: deps.workspaceHandle(input.hostWorkspaceId),
			outcomeAtMs: input.outcomeAtMs,
			expiresAtMs: nowMs + ALERT_TTL_MS,
			state: "retracted",
			settling: false,
			retryAtMs: nowMs,
			failures: 0,
			superseded: false,
			supersededReason: null,
		};
		alerts.set(input.alertId, tombstone);
		prune(nowMs);
		fireRetraction(tombstone, input.reason.kind);
	}

	/**
	 * (ALERT-CONTEXT-NAMES) Every alert for this terminal that the read
	 * COVERS — this process's memory of what the user has just seen.
	 *
	 * (ALERT-RETIRE-ON-EXIT) BOTH KINDS, since 2026-08-20. It used to filter to
	 * `g` on the argument that an agent which DIED is not undone by reading its
	 * chat. The owner overrode that: opening the chat is exactly how you find
	 * out an agent died, so a red card left standing on the wrist after that is
	 * the phone nagging about something already dealt with. An `e` the read
	 * covers is now retired like any other row.
	 *
	 * WHY THE RECOMPUTED ID IS NOT ENOUGH ON ITS OWN. `markLifecycleSeen` derives
	 * the `g` id by hashing the instant the renderer says it read the chat
	 * "through", and the renderer can only report an instant it can see. Those
	 * two instants are the same in the common case and NOT the same in an
	 * ordinary one: the terminal binding's `lastEventAt` advances for events that
	 * carry no lifecycle outcome at all — a `SessionStart` moves it while the
	 * hook leaves the outcome null, so no alert was ever minted for that stamp.
	 * A retraction computed from it would name an id no phone has ever held: the
	 * real notification survives, and a `c` frame is broadcast to every paired
	 * device for nothing.
	 *
	 * ANY STATE COUNTS, not just `sent`. A `held` alert has never reached a
	 * device, so the honest answer to "take it off the phone" is to delete it and
	 * send NOTHING — but only if this lookup surfaces it. Answering nothing for a
	 * held alert would drop straight through to the blind fallback and broadcast
	 * a `c` for an alert that was never delivered. Knowing anything about this
	 * terminal is enough to say the hash is not needed. `standing` counts too,
	 * and that is load-bearing twice over: a standing notification is still on
	 * the devices, so a read has to be able to retract it; and its row is still
	 * evidence for the proof-of-absence test, which would otherwise conclude
	 * nothing was ever sent for a terminal whose card is on the user's phone.
	 *
	 * (ONE-BUZZ-UNTIL-READ) BOUNDED BY THE READ, and this is the whole point of
	 * the filter. A read is a statement about a MOMENT — "I have seen this chat
	 * through `seenThroughAt`" — and it travels: the renderer batches, the resync
	 * repairs a report that was dropped minutes ago, a host restart replays one.
	 * Meanwhile the agent keeps working, so by the time a read for finish A
	 * arrives, finish B may already be on the phone. Retiring "whatever is live"
	 * would then retract work the user has NEVER seen and leave nothing behind to
	 * re-raise it. So rows whose outcome instant is AFTER the read are invisible
	 * here — every later generation stands untouched.
	 *
	 * Ordering is by generation (`outcomeAtMs`), not by expiry: with per-terminal
	 * monotonic instants (`nextLifecycleInstantMs`) that is a total order over
	 * one terminal's finishes, and a blind tombstone can no longer outrank the
	 * card the user is looking at just because it was minted later. Two rows can
	 * never share a generation — the id is hashed from it, and the map is keyed
	 * by id.
	 */
	function findReadAlerts(
		hostTerminalId: string,
		seenThroughAt: number,
	): HeldAlert[] {
		const covered: HeldAlert[] = [];
		for (const alert of alerts.values()) {
			if (alert.hostTerminalId !== hostTerminalId) continue;
			if (alert.outcomeAtMs > seenThroughAt) continue;
			covered.push(alert);
		}
		return covered.sort((a, b) => b.outcomeAtMs - a.outcomeAtMs);
	}

	function mint(
		input: CompanionLifecycleEvent,
		kind: LifecycleAlertKind,
	): void {
		const alertId = lifecycleAlertId({
			hostTerminalId: input.hostTerminalId,
			occurredAtMs: input.occurredAtMs,
			kind,
		});
		if (alerts.has(alertId)) return;
		const nowMs = now();
		const alert: HeldAlert = {
			alertId,
			kind,
			hostTerminalId: input.hostTerminalId,
			hostWorkspaceId: input.hostWorkspaceId,
			workspaceHandle: deps.workspaceHandle(input.hostWorkspaceId),
			outcomeAtMs: input.occurredAtMs,
			expiresAtMs: input.occurredAtMs + ALERT_TTL_MS,
			state: "held",
			settling: kind === "g" && deps.readySettleMs > 0,
			retryAtMs: kind === "g" ? nowMs + deps.readySettleMs : nowMs,
			failures: 0,
			superseded: false,
			supersededReason: null,
		};
		alerts.set(alertId, alert);
		prune(nowMs);
		fire(alertId);
		scheduleSweep();
	}

	/**
	 * (LIFECYCLE-ALERT-IDEMPOTENCY) Has this exact hook event already been
	 * applied?
	 *
	 * The alert id dedupes the ordinary case — two POSTs about the same work
	 * cycle mint the same id — but it cannot dedupe everything, and
	 * (ALERT-CONTEXT-NAMES) changing what the id is hashed FROM did not change
	 * that. The id is now derived from the outcome event's own `occurredAtMs`
	 * rather than from the cycle's start stamp, so a re-delivery carrying the
	 * SAME outcome instant does collapse — but a producer whose clock or payload
	 * gives one logical event two different instants (a retried POST re-stamped
	 * at send time, a hook re-firing after the terminal moved on) still mints two
	 * ids and would raise two alerts for one piece of work. The producer id is
	 * the only thing stable across such a re-delivery, which is exactly what it
	 * is for.
	 *
	 * A MALFORMED ID IS NEVER A REASON TO DROP AN ALERT. It is logged and the
	 * event is processed undeduplicated: losing a notification is the worse
	 * failure, and the tRPC boundary already validates the shape.
	 */
	function alreadyApplied(input: CompanionLifecycleEvent): boolean {
		const producerEventId = input.producerEventId;
		if (
			typeof producerEventId !== "string" ||
			!PRODUCER_EVENT_ID_PATTERN.test(producerEventId)
		) {
			deps.logger.error(
				"lifecycle event carries no usable producer id; processing it without duplicate protection",
				{ hostTerminalId: input.hostTerminalId, outcome: input.outcome },
			);
			return false;
		}
		if (seenProducerEvents.has(producerEventId)) {
			deps.logger.info("ignoring a duplicate lifecycle hook delivery", {
				producerEventId,
				hostTerminalId: input.hostTerminalId,
				outcome: input.outcome,
			});
			return true;
		}
		seenProducerEvents.add(producerEventId);
		while (seenProducerEvents.size > MAX_SEEN_PRODUCER_EVENTS) {
			const oldest = seenProducerEvents.values().next();
			if (oldest.done) break;
			seenProducerEvents.delete(oldest.value);
		}
		return false;
	}

	return {
		observeStatus(hostTerminalId, eventType) {
			if (stopped || !READY_SETTLE_CANCEL_EVENTS.has(eventType)) return;
			retireWhere(
				(alert) =>
					alert.hostTerminalId === hostTerminalId &&
					alert.kind === "g" &&
					alert.state === "held" &&
					alert.failures === 0 &&
					alert.settling,
				{ kind: "new-cycle" },
			);
		},
		record(input) {
			if (stopped) return;
			prune(now());
			if (alreadyApplied(input)) return;

			// (LIFECYCLE-ALERT-SUPERSEDE) Fresh work, or the session ending, retires
			// everything still held for this terminal. Neither can mint.
			//
			// (ONE-BUZZ-UNTIL-READ) The two are NOT the same retirement: fresh work
			// means the chat is alive and about to finish again, so a delivered
			// ready alert is left standing for the next one to replace, while a
			// session end means there is no chat left to open and the buzz must
			// come down. `notifiesPhone` is where that split lives.
			if (input.outcome === "progress") {
				supersede(input.hostTerminalId, { kind: "new-cycle" });
				return;
			}
			if (input.outcome === "session-end") {
				supersede(input.hostTerminalId, { kind: "session-end" });
				return;
			}
			if (input.outcome !== "ready" && input.outcome !== "failed") return;

			// DB source of truth: the router captures these fields from the persisted
			// terminal binding before recordEvent replaces them. Only a terminal event
			// following real work can produce an alert. Repeated Stop/Failed events see
			// the previous terminal event and are therefore silent.
			//
			// PermissionRequest is asymmetric, deliberately. A `ready` on top of one is
			// the user answering a prompt and the turn ending: no fresh completed work,
			// so it stays suppressed. A `failed` on top of one is the agent dying while
			// blocked at that prompt — a real failure, and the state the user is least
			// able to see, so it alerts as an error and never as a green.
			const previousType = input.previousEventType;
			if (input.previousEventAtMs === null || previousType === null) return;
			const armedByWork =
				previousType === "Start" ||
				previousType === "SubagentActive" ||
				previousType === "BackgroundRunning";
			const armedByBlockedFailure =
				input.outcome === "failed" && previousType === "PermissionRequest";
			if (!armedByWork && !armedByBlockedFailure) return;
			mint(input, input.outcome === "failed" ? "e" : "g");
		},
		markLifecycleSeen(input) {
			if (stopped) return;
			if (
				typeof input.hostTerminalId !== "string" ||
				input.hostTerminalId.length === 0 ||
				typeof input.hostWorkspaceId !== "string" ||
				input.hostWorkspaceId.length === 0 ||
				!Number.isInteger(input.seenThroughAt) ||
				input.seenThroughAt <= 0
			) {
				deps.logger.error(
					"ignoring an unusable lifecycle seen signal; a notification may outlive the chat the user just read",
					{
						hostTerminalId: input.hostTerminalId,
						hostWorkspaceId: input.hostWorkspaceId,
					},
				);
				return;
			}
			prune(now());

			// (ALERT-RETIRE-ON-EXIT) THE LIVE MAP COVERS BOTH KINDS. A read retires
			// the `e` rows it covers as well as the `g` ones — USER DECISION,
			// 2026-08-20, overriding the original design. The old rule kept an
			// agent-died card on the wrist after the user had opened the very chat
			// that tells them the agent died, which reads as a nag rather than a
			// warning.
			//
			// THE BLIND FALLBACK BELOW STAYS READY-ONLY. It hashes an id from an
			// instant nobody has confirmed raised an alert, so an `e` hash would
			// DOUBLE the blind broadcasts on a path whose whole job is to be rare —
			// and every bogus `c` the phone receives evicts a real claim from its
			// 64-slot window (see the note in the proof branch below).
			//
			// THE LIVE MAP IS ASKED FIRST — see `findReadAlerts` for why the
			// recomputed id alone would name a notification nobody holds whenever
			// the renderer's "seen through" instant belongs to an event that raised
			// no alert. The hash is the RESTART fallback, and only that.
			const read = findReadAlerts(input.hostTerminalId, input.seenThroughAt);
			if (
				read.length === 0 &&
				canProveAbsence(input.hostTerminalId, input.seenThroughAt)
			) {
				// NOTHING EVER EXISTED, AND THAT IS PROVABLE — so send nothing.
				//
				// This process has been holding alert state since BEFORE the instant
				// the user read through. Every alert it minted since then is still in
				// the map: `sent` and `retracted` rows are retained until their TTL
				// precisely so a cycle cannot re-mint, and `findReadAlerts`
				// accepts any state. An empty answer therefore is not ignorance, it
				// is proof — and a `c` broadcast on proof of absence is pure harm.
				//
				// (ONE-BUZZ-UNTIL-READ) "Empty" here means "nothing this read
				// COVERS". A generation minted after `seenThroughAt` is not evidence
				// that the read's own generation existed, so it neither suppresses
				// this branch nor gets retracted by it.
				//
				// WHY THAT MATTERS SO MUCH HERE. The renderer's repair path re-offers
				// every already-read terminal on a reconnect, and most read-green
				// terminals never raised a phone alert at all (the user was at the
				// desk, so presence gating held it). Broadcasting for each one would
				// put a bogus retraction on every paired device — and each one the
				// phone receives inserts into its 64-slot `SeenLifecycleEvents`
				// window, so a handful of reconnects would evict every REAL claim and
				// tombstone in it, re-enabling the double-buzz and already-read
				// re-posts that window exists to prevent.
				//
				// A host started AFTER `seenThroughAt` has no such proof: the alert
				// may well have been minted by the process before it, and the blind
				// broadcast below is the only thing that can take it off the phone.
				//
				// Deliberately NOT logged: this is the ordinary path on every warm
				// reconnect, and a line per read terminal per epoch is noise that
				// would bury the events worth reading.
				//
				// HONEST LIMIT — none, now. Two things used to be able to make this
				// branch lie and both are part of `canProveAbsence`: `evictOldest`
				// dropping an unexpired row (latched by `hasEvictedUnexpired`), and
				// the wall-clock start being compared against a per-terminal
				// MONOTONIC generation, which a restart inside a clock backstep
				// turns into a false "I was here first" (bounded by the proof
				// epoch).
				return;
			}
			if (read.length > 0) {
				// (ONE-BUZZ-UNTIL-READ) EVERY covered generation is retired, newest
				// first, not just the newest one. A `standing` card from two cycles
				// ago is still on the handset while the newest generation may only
				// ever have been `held` — retiring the newest alone would delete the
				// held row silently and leave the visible notification up forever.
				// Each retirement is per-alert and idempotent: `held` is deleted in
				// silence, `sent`/`standing` fire their one `c`, `retracted` is inert.
				// Rows past the boundary are not in this list at all.
				for (const alert of read) retireAlert(alert, { kind: "seen" });
				return;
			}
			retractById({
				alertId: lifecycleAlertId({
					hostTerminalId: input.hostTerminalId,
					occurredAtMs: input.seenThroughAt,
					kind: "g",
				}),
				hostTerminalId: input.hostTerminalId,
				hostWorkspaceId: input.hostWorkspaceId,
				outcomeAtMs: input.seenThroughAt,
				reason: { kind: "seen" },
			});
		},
		/**
		 * (ALERT-RETIRE-ON-EXIT) The pty died. Same retirement `session-end`
		 * performs, from the other source of truth.
		 *
		 * BOTH KINDS, deliberately: a dead terminal takes its error card down as
		 * well as its ready card, because neither one opens anything any more.
		 * `supersede` walks every state, so a `held` row is deleted in silence, a
		 * `sending` one is flagged for `markDelivered`, and a delivered one fires
		 * its single `c`.
		 */
		retireTerminal(hostTerminalId) {
			if (stopped) return;
			supersede(hostTerminalId, { kind: "terminal-gone" });
		},

		/**
		 * (ALERT-RETIRE-ON-EXIT) The desktop relaunched at `boundaryMs`.
		 *
		 * READY ONLY. A `g` says "there is something here for you to look at",
		 * and the user is now sitting in front of the app that shows it — the
		 * card is redundant the moment the window opens. An `e` is a record that
		 * something BROKE, which a relaunch does not answer, so error alerts
		 * survive a restart and come down only on a read, a dead terminal or the
		 * TTL.
		 *
		 * BOUNDARY-EXCLUSIVE (`<`, not `<=`), because the boundary is this
		 * launch's own instant: a finish stamped exactly there is not "before the
		 * launch".
		 *
		 * HELD ROWS ARE INCLUDED. The renderer reports this boundary once per
		 * cold start, having already seeded its own seen marks for every idle
		 * terminal at that instant — so a held alert about a pre-launch finish
		 * would fire later about work the desktop has already written off. It is
		 * deleted in silence, which is exactly right: it never reached a device.
		 *
		 * THE BOUNDARY IS TRUSTED HERE. It is range-checked by the one caller
		 * that can judge it — the bridge sink, which alone knows the host clock
		 * it has to be in the past of.
		 */
		retireReadyBefore(boundaryMs) {
			if (stopped) return 0;
			const retired = retireWhere(
				(alert) =>
					alert.kind === "g" &&
					alert.state !== "retracted" &&
					alert.outcomeAtMs < boundaryMs,
				{ kind: "desktop-relaunch" },
			);
			if (retired > 0) {
				deps.logger.info(
					"(ALERT-RETIRE-ON-EXIT) the desktop relaunched; retired the ready alerts it predates",
					{ boundaryMs, retired },
				);
			}
			return retired;
		},

		/**
		 * (ALERT-RETIRE-ON-EXIT) The sidebar mirror changed. Retire the live
		 * alerts of every workspace the user is curating off.
		 *
		 * A STATE TEST, NOT AN EDGE. Re-retiring on a later mirror write costs
		 * nothing and cannot double-send: `retireAlert` moves a row to
		 * `retracted` and every later pass over it is inert, and a workspace that
		 * is still curated off has no way to acquire a NEW live alert — the push
		 * path refuses to fire for it `(PUSH-CURATION-GATE)`. So the second walk
		 * finds an empty live set for that workspace and does nothing at all.
		 *
		 * HELD-PRESERVING. A `held` alert is not on any device, and it is already
		 * parked behind the claim path's own curation gate — which RELEASES it
		 * when the snooze expires. Retiring it here would delete the very alert
		 * that gate exists to deliver late.
		 *
		 * FAIL-CLOSED CURATION, read fresh and once — see
		 * `createFreshCurationRead`. A workspace whose verdict could not be read
		 * is simply not in the set, so an unknown verdict retires nothing.
		 */
		retireCuratedOffAlerts() {
			if (stopped) return 0;
			const live = [...alerts.values()].filter(isLiveAlert);
			if (live.length === 0) return 0;
			const curatedOff = deps.curatedOffAmong([
				...new Set(live.map((alert) => alert.hostWorkspaceId)),
			]);

			let retired = 0;
			for (const hostWorkspaceId of curatedOff) {
				let retiredHere = 0;
				for (const alert of live) {
					if (alert.hostWorkspaceId !== hostWorkspaceId) continue;
					retireAlert(alert, { kind: "curated-off" });
					retiredHere += 1;
				}
				retired += retiredHere;
				deps.logger.info(
					"(ALERT-RETIRE-ON-EXIT) the user took a thread off their sidebar; retired its live alerts",
					// This workspace's own count, not the walk's running total — the
					// line names one workspace, so a cumulative number here read as
					// "workspace-2 had three" when it had one.
					{ hostWorkspaceId, retired: retiredHere },
				);
			}
			return retired;
		},

		stop() {
			stopped = true;
			if (timer !== null) clearTimeout(timer);
			timer = null;
			alerts.clear();
			seenProducerEvents.clear();
		},
	};
}
