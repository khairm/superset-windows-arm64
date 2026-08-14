import { createHash } from "node:crypto";
import type { CompanionLifecycleEvent } from "../trpc/router/notifications";
import { CURATION_RECHECK_MS } from "./config";
import type { BridgeLogger } from "./http";
import type { PresenceStore } from "./presence";
import type { PushSender } from "./push";
import type { HostDbReader } from "./read-api";
import { workspaceSidebarVerdict } from "./sidebar-filter";
import type { WorkspaceId } from "./types";

const ALERT_TTL_MS = 6 * 60 * 60 * 1000;
const SWEEP_MS = 2_000;
const MAX_STATE_ENTRIES = 512;
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
 */
type LifecycleAlertState = "held" | "sending" | "sent";

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
	 */
	superseded: boolean;
}

export interface LifecycleAlertManager {
	record(input: CompanionLifecycleEvent): void;
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
	push: Pick<PushSender, "sendLifecycleAlert">;
	workspaceHandle(hostWorkspaceId: string): WorkspaceId;
	isCuratedOff(hostWorkspaceId: string): boolean;
	logger: BridgeLogger;
	now?: () => number;
}

function lifecycleAlertId(input: {
	hostTerminalId: string;
	armedAtMs: number;
	kind: LifecycleAlertKind;
}): string {
	// PROTOCOL.md §0.1: first 16 digest bytes, base64url encoded (22 chars).
	return createHash("sha256")
		.update("sc/v2 lifecycle alert\0", "utf8")
		.update(input.kind, "utf8")
		.update("\0", "utf8")
		.update(input.hostTerminalId, "utf8")
		.update("\0", "utf8")
		.update(String(input.armedAtMs), "utf8")
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
			// LOUD: an evicted `held` alert is a notification the user will never
			// get, thrown away by a capacity bound rather than by a decision.
			if (evicted !== undefined && evicted.state !== "sent") {
				deps.logger.error(
					"lifecycle alert table exceeded its bound; dropped an undelivered alert",
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

	function markDelivered(claimed: HeldAlert): void {
		const current = alerts.get(claimed.alertId);
		if (current === undefined || current.state !== "sending") return;
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
	 * (LIFECYCLE-ALERT-SUPERSEDE) The terminal has moved on. Held alerts for it
	 * are cancelled outright; one already on the wire is flagged so a failed
	 * delivery is not re-held.
	 */
	function supersede(hostTerminalId: string, reason: string): void {
		for (const [alertId, alert] of alerts) {
			if (alert.hostTerminalId !== hostTerminalId) continue;
			if (alert.state === "held") {
				alerts.delete(alertId);
				deps.logger.info("cancelled a held lifecycle alert", {
					alertId,
					kind: alert.kind,
					hostTerminalId,
					reason,
				});
				continue;
			}
			if (alert.state === "sending" && !alert.superseded) {
				alerts.set(alertId, { ...alert, superseded: true });
			}
		}
	}

	function mint(
		input: CompanionLifecycleEvent,
		cycleStartedAtMs: number,
		kind: LifecycleAlertKind,
	): void {
		const alertId = lifecycleAlertId({
			hostTerminalId: input.hostTerminalId,
			armedAtMs: cycleStartedAtMs,
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
	 * The alert id dedupes the ordinary case — two POSTs about the same work cycle
	 * mint the same id — but it cannot dedupe everything, because the fields the
	 * id is derived from are read from the terminal binding AT POST TIME. A
	 * re-delivery of one Stop event that arrives after the terminal has moved on
	 * carries a DIFFERENT previous-event stamp, mints a different alert id, and
	 * would raise a second alert for work that was already reported. The producer
	 * id is the only thing that is stable across such a re-delivery, which is
	 * exactly what it is for.
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

			mint(
				input,
				input.previousEventAtMs,
				input.outcome === "failed" ? "e" : "g",
			);
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
