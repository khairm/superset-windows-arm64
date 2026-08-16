import { createHash } from "node:crypto";
import type { CompanionLifecycleEvent } from "../trpc/router/notifications";
import { CURATION_RECHECK_MS } from "./config";
import type { BridgeLogger } from "./http";
import type { PresenceStore } from "./presence";
import type { PushSender } from "./push";
import type { PushAlertContext } from "./push-context";
import type { HostDbReader } from "./read-api";
import { workspaceSidebarVerdict } from "./sidebar-filter";
import type { WorkspaceId } from "./types";

const ALERT_TTL_MS = 6 * 60 * 60 * 1000;
const SWEEP_MS = 2_000;

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
 * `held` — minted, never put on the wire yet; the only state a sweep may claim.
 * `sending` — CLAIMED by exactly one caller, an FCM broadcast is in flight.
 * `sent` — accepted by FCM. Kept until the TTL so the same cycle cannot re-mint.
 * `retracted` — (ALERT-CONTEXT-NAMES) a `c` frame has gone out for it. Kept
 *   until the TTL for the SAME reason `sent` is: deleting the row re-opens
 *   re-minting, and a terminal that reports progress after the user read its
 *   chat would then buzz again about the cycle they just read. It is also the
 *   storm guard — nothing further ever happens to a `retracted` row.
 */
type LifecycleAlertState = "held" | "sending" | "sent" | "retracted";

interface HeldAlert {
	alertId: string;
	kind: LifecycleAlertKind;
	hostTerminalId: string;
	hostWorkspaceId: string;
	workspaceHandle: WorkspaceId;
	expiresAtMs: number;
	state: LifecycleAlertState;
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

	/**
	 * (ALERT-CONTEXT-NAMES) The user read the chat on the desktop: take the
	 * ready-for-review alert back off their phone and watch.
	 */
	markLifecycleSeen(input: LifecycleSeenInput): void;
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

export interface LifecycleAlertManagerDeps {
	/** Only the verdict is ever asked for; beacons belong to the push path. */
	presence: Pick<PresenceStore, "present">;
	push: Pick<PushSender, "sendLifecycleAlert" | "sendLifecycleRetraction">;
	workspaceHandle(hostWorkspaceId: string): WorkspaceId;
	isCuratedOff(hostWorkspaceId: string): boolean;

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
		const current = alerts.get(alertId);
		if (current === undefined || current.state !== "held") return null;
		if (current.expiresAtMs <= nowMs) {
			alerts.delete(alertId);
			return null;
		}
		if (current.retryAtMs > nowMs) return null;
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
					terminalHandle: deps.terminalHandle(alert.hostTerminalId),
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
	 * phone: retract it immediately, behind this exact send on the same chain.
	 * The flag used to be dropped here in silence — the alert landed and nothing
	 * could ever take it back.
	 */
	function markDelivered(claimed: HeldAlert): void {
		const current = alerts.get(claimed.alertId);
		if (current === undefined || current.state !== "sending") return;
		if (current.superseded) {
			alerts.set(claimed.alertId, { ...current, state: "retracted" });
			fireRetraction(current, "superseded while in flight");
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
	function supersede(hostTerminalId: string, reason: string): void {
		for (const alert of [...alerts.values()]) {
			if (alert.hostTerminalId !== hostTerminalId) continue;
			retireAlert(alert, reason);
		}
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
	function retireAlert(alert: HeldAlert, reason: string): void {
		if (alert.state === "retracted") return;
		if (alert.state === "held") {
			alerts.delete(alert.alertId);
			deps.logger.info("cancelled a held lifecycle alert", {
				alertId: alert.alertId,
				kind: alert.kind,
				hostTerminalId: alert.hostTerminalId,
				reason,
			});
			return;
		}
		if (alert.state === "sending") {
			if (!alert.superseded) {
				alerts.set(alert.alertId, { ...alert, superseded: true });
			}
			return;
		}
		alerts.set(alert.alertId, { ...alert, state: "retracted" });
		fireRetraction(alert, reason);
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
		reason: string;
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
			expiresAtMs: nowMs + ALERT_TTL_MS,
			state: "retracted",
			retryAtMs: nowMs,
			failures: 0,
			superseded: false,
		};
		alerts.set(input.alertId, tombstone);
		prune(nowMs);
		fireRetraction(tombstone, input.reason);
	}

	/**
	 * (ALERT-CONTEXT-NAMES) The ready alert this terminal has, if this process
	 * still remembers one at all.
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
	 * ANY STATE COUNTS, not just `sent`, and that is the second half of the same
	 * bug. A `held` alert has never reached a device, so the honest answer to
	 * "take it off the phone" is to delete it and send NOTHING — but only if this
	 * lookup surfaces it. Answering `null` for a held alert would drop straight
	 * through to the blind fallback and broadcast a `c` for an alert that was
	 * never delivered. Knowing anything about this terminal is enough to say the
	 * hash is not needed; `retractById` then does the right thing per state.
	 *
	 * `sent` WINS when several stand, because that is the one the user is looking
	 * at. Otherwise the newest, by expiry. In practice there is at most one —
	 * `supersede` retires the previous cycle before a new one is minted.
	 *
	 * The hash still matters and is still the fallback: after a restart this map
	 * is empty and recomputing is the only way to name anything at all.
	 */
	function findLiveReadyAlert(hostTerminalId: string): HeldAlert | null {
		let best: HeldAlert | null = null;
		for (const alert of alerts.values()) {
			if (alert.hostTerminalId !== hostTerminalId) continue;
			if (alert.kind !== "g") continue;
			if (best === null) {
				best = alert;
				continue;
			}

			const bestIsSent = best.state === "sent";

			const candidateIsSent = alert.state === "sent";
			if (candidateIsSent && !bestIsSent) {
				best = alert;
				continue;
			}
			if (
				candidateIsSent === bestIsSent &&
				alert.expiresAtMs > best.expiresAtMs
			) {
				best = alert;
			}
		}
		return best;
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
			expiresAtMs: input.occurredAtMs + ALERT_TTL_MS,
			state: "held",
			retryAtMs: nowMs,
			failures: 0,
			superseded: false,
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
		record(input) {
			if (stopped) return;
			prune(now());
			if (alreadyApplied(input)) return;

			// (LIFECYCLE-ALERT-SUPERSEDE) Fresh work, or the session ending, retires
			// everything still held for this terminal. Neither can mint.
			if (input.outcome === "progress" || input.outcome === "session-end") {
				supersede(input.hostTerminalId, input.outcome);
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

			// ONLY `g`. "Ready for review" is the alert the green dot clearing is
			// evidence about; an `e` reports an agent that DIED, which reading the
			// chat does not undo, and which the user may well want to still see on
			// their phone when they walk away from a desk they only glanced at.
			//
			// THE LIVE MAP IS ASKED FIRST — see `findLiveReadyAlert` for why the
			// recomputed id alone would name a notification nobody holds whenever
			// the renderer's "seen through" instant belongs to an event that raised
			// no alert. The hash is the RESTART fallback, and only that.
			const live = findLiveReadyAlert(input.hostTerminalId);
			if (
				live === null &&
				startedAtMs <= input.seenThroughAt &&
				!hasEvictedUnexpired
			) {
				// NOTHING EVER EXISTED, AND THAT IS PROVABLE — so send nothing.
				//
				// This process has been holding alert state since BEFORE the instant
				// the user read through. Every alert it minted since then is still in
				// the map: `sent` and `retracted` rows are retained until their TTL
				// precisely so a cycle cannot re-mint, and `findLiveReadyAlert`
				// accepts any state. An empty answer therefore is not ignorance, it
				// is proof — and a `c` broadcast on proof of absence is pure harm.
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
				// HONEST LIMIT — none, now. `evictOldest` used to be able to drop an
				// unexpired `sent` row silently and make this branch lie; it now
				// latches `hasEvictedUnexpired`, which is part of the condition
				// above, so a process that has ever evicted anything unexpired stops
				// claiming proof and goes back to broadcasting blind.
				return;
			}
			retractById({
				alertId:
					live?.alertId ??
					lifecycleAlertId({
						hostTerminalId: input.hostTerminalId,
						occurredAtMs: input.seenThroughAt,
						kind: "g",
					}),
				hostTerminalId: input.hostTerminalId,
				hostWorkspaceId: input.hostWorkspaceId,
				reason: "the user read the chat on the desktop",
			});
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
