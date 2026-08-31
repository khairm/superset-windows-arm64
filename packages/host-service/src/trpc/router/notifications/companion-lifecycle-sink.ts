import { z } from "zod";

export const companionLifecycleFields = {
	companionLifecycleEventId: z
		.string()
		.regex(/^[A-Za-z0-9_-]{22}$/)
		.optional(),
	companionLifecycleOutcome: z
		.enum(["progress", "ready", "failed", "hold", "session-end"])
		.optional(),
};

export interface CompanionLifecycleEvent {
	/**
	 * (LIFECYCLE-ALERT-IDEMPOTENCY) The PRODUCER's identity for this hook event —
	 * `companionLifecycleEventId`, derived by the notify hook from the terminal,
	 * session, hook name, timestamp and tool_use_id. It is validated at the tRPC
	 * boundary (22 base64url chars) and it is CONSUMED: the lifecycle manager
	 * remembers a bounded window of them so a duplicate delivery of the same hook
	 * event applies exactly once.
	 *
	 * It is NOT the alert's identity. The user-visible alert id is derived from
	 * the work cycle and the alert kind, so two different hook events that report
	 * the same cycle ending still collapse to one alert.
	 */
	producerEventId: string;
	outcome: "progress" | "ready" | "failed" | "hold" | "session-end";
	eventType: string;
	hostTerminalId: string;
	hostWorkspaceId: string;
	occurredAtMs: number;
	previousEventType: string | null;
	previousEventAtMs: number | null;
}

export interface CompanionLifecycleSink {
	record(input: CompanionLifecycleEvent): void;
	observeStatus(hostTerminalId: string, eventType: string): void;
}

let sink: CompanionLifecycleSink | null = null;

export function setCompanionLifecycleSink(
	next: CompanionLifecycleSink | null,
): void {
	if (next !== null && sink !== null) {
		throw new Error(
			"[companion-lifecycle] a lifecycle sink is already registered; unregister it before installing another",
		);
	}
	sink = next;
}

export function getCompanionLifecycleSink(): CompanionLifecycleSink | null {
	return sink;
}

/**
 * Hand one hook event to the lifecycle sink.
 *
 * THROWS INTO THE CALLER on a sink fault, deliberately. The hook handler runs
 * this BEFORE the host.db write that overwrites the terminal's last recorded
 * event (see the ordering note at the call site), so swallowing a fault here
 * would let `recordEvent` bury the `Stop` row that is the ONLY durable evidence
 * of the ready alert this call just failed to retract: the card on the phone
 * becomes unnameable and stands for its full six-hour TTL. Throwing skips that
 * write, so the row survives and the next start reconstructs and retracts the
 * exact id.
 *
 * The live dot is not the price — `broadcastAgentLifecycle` has already fired
 * by the time this runs. What a throw costs is the persisted binding that
 * (BUS-RESYNC) reads, which the next hook event replaces anyway. A stale resync
 * row is the cheap failure; unretractable alert evidence is the expensive one.
 *
 * The stale-working sweep calls this the other way round, AFTER its own
 * `recordEvent`, and rightly so: it announces a finish it has already written,
 * so there is no evidence to protect. A throw there aborts the rest of that
 * pass, which the next tick redoes over bindings that are still stale.
 */
export function forwardCompanionLifecycle(input: {
	payload: {
		companionLifecycleEventId?: string;
		companionLifecycleOutcome?:
			| "progress"
			| "ready"
			| "failed"
			| "hold"
			| "session-end";
	};
	eventType: string;
	terminalId: string;
	workspaceId: string;
	occurredAtMs: number;
	previousEventType: string | null;
	previousEventAtMs: number | null;
}): void {
	sink?.observeStatus(input.terminalId, input.eventType);
	const eventId = input.payload.companionLifecycleEventId;
	const outcome = input.payload.companionLifecycleOutcome;
	if (eventId === undefined || outcome === undefined) return;
	sink?.record({
		producerEventId: eventId,
		outcome,
		eventType: input.eventType,
		hostTerminalId: input.terminalId,
		hostWorkspaceId: input.workspaceId,
		occurredAtMs: input.occurredAtMs,
		previousEventType: input.previousEventType,
		previousEventAtMs: input.previousEventAtMs,
	});
}
