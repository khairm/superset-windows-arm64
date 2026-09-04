import type { AgentIdentity } from "@superset/shared/agent-identity";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { terminalSessions, workspaces } from "../../../db/schema";
import { mapEventType } from "../../../events";
import type { HostServiceContext } from "../../../types";
import { touchLocalWorkspaceActivity } from "../../../workspaces/local-workspace-store";
import { publicProcedure, queryProcedure, router } from "../../index";
import {
	type AgentStatusSnapshot,
	buildAgentStatusSnapshot,
} from "./agent-status-snapshot";
import {
	companionLifecycleFields,
	forwardCompanionLifecycle,
} from "./companion-lifecycle-sink";
// (COMPANION-CAPTURE) (COMPANION-CAPTURE-HOOK) fork-only seam. Every line of
// companion behaviour lives in companion-question-sink.ts; this file only wires
// it. (COMPANION-CAPTURE-HOOK) appears ONLY in this file: (COMPANION-CAPTURE) is
// also satisfied by the sink and by the desktop hook, so without a token unique
// to the seam an upstream merge could take upstream's version of this router,
// delete the four lines below, and leave every gate green while the hook keeps
// logging "posted" and the phone never receives another question.
import {
	companionHookFields,
	forwardCompanionCapture,
	warnDroppedCompanionCapture,
} from "./companion-question-sink";

// Hook scripts emit "" for unset env vars; we coerce to undefined so the
// AgentIdentity broadcast carries only meaningful fields.
const agentIdentityInput = z
	.object({
		agentId: z.string().optional(),
		sessionId: z.string().optional(),
		definitionId: z.string().optional(),
	})
	.optional();

const hookInput = z
	.object({
		terminalId: z.string().optional(),
		eventType: z.string().optional(),
		agent: agentIdentityInput,
	})
	.extend(companionHookFields)
	.extend(companionLifecycleFields);

function trimOrUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

// (ONE-BUZZ-UNTIL-READ) moved to a leaf module so the stale-working sweep — the
// second producer of lifecycle events — shares the exact ordering rule.
// Re-exported here for existing importers/tests.
import { nextLifecycleInstantMs } from "../../../events/lifecycle-instant";

export { nextLifecycleInstantMs };

function normalizeAgentIdentity(
	agent: z.infer<typeof agentIdentityInput>,
): AgentIdentity | undefined {
	const agentId = trimOrUndefined(agent?.agentId);
	if (!agentId) return undefined;
	const sessionId = trimOrUndefined(agent?.sessionId);
	const definitionId = trimOrUndefined(agent?.definitionId);
	return {
		agentId: agentId as AgentIdentity["agentId"],
		...(sessionId ? { sessionId } : {}),
		...(definitionId
			? { definitionId: definitionId as AgentIdentity["definitionId"] }
			: {}),
	};
}

/**
 * (DISPOSE-LIMBO) A terminal with no session row is an invariant violation and
 * has to be loud — but a wedged pane re-raises it on EVERY PostToolUse, and one
 * full error object per hook event buries the log it was meant to surface.
 * Full detail on the first sighting per terminal, then a periodic count so the
 * condition stays visible without drowning anything else.
 */
const UNKNOWN_TERMINAL_REPORT_INTERVAL_MS = 10 * 60 * 1000;

interface UnknownTerminalReport {
	count: number;
	lastReportedAt: number;
}

const unknownTerminalReports = new Map<string, UnknownTerminalReport>();

/**
 * The dedupe table is a diagnostic, not state anything depends on, so it is
 * bounded by dropping it wholesale rather than growing one entry per ghost
 * terminal forever. The only cost of a reset is one extra full log line each.
 */
const UNKNOWN_TERMINAL_REPORT_MAX_ENTRIES = 256;

function reportUnknownTerminal(detail: {
	terminalId: string;
	eventType: string | undefined;
	mappedEventType: string;
	agentId: string | undefined;
	agentSessionId: string | undefined;
}): void {
	const seen = unknownTerminalReports.get(detail.terminalId);
	if (!seen) {
		if (unknownTerminalReports.size >= UNKNOWN_TERMINAL_REPORT_MAX_ENTRIES) {
			unknownTerminalReports.clear();
		}
		unknownTerminalReports.set(detail.terminalId, {
			count: 1,
			lastReportedAt: Date.now(),
		});
		console.error(
			"[notifications] hook for a terminal with no session row",
			detail,
		);
		return;
	}

	seen.count += 1;
	const now = Date.now();
	if (now - seen.lastReportedAt < UNKNOWN_TERMINAL_REPORT_INTERVAL_MS) return;
	seen.lastReportedAt = now;
	console.error(
		`[notifications] hook for a terminal with no session row (${seen.count} events so far)`,
		detail,
	);
}

// Tasks already nudged to "started" this process. `Start` fires on every
// agent turn and tool use, so gate the cloud call to once per task per
// process — `task.start` is idempotent and forward-only server-side, so a
// duplicate after a restart is harmless.
const startedTaskIds = new Set<string>();

function markLinkedTaskStarted(
	ctx: HostServiceContext,
	workspaceId: string,
): void {
	const workspace = ctx.db.query.workspaces
		.findFirst({
			where: eq(workspaces.id, workspaceId),
			columns: { taskId: true },
		})
		.sync();
	const taskId = workspace?.taskId;
	if (!taskId || startedTaskIds.has(taskId)) return;
	startedTaskIds.add(taskId);
	void ctx.api.task.start.mutate({ id: taskId }).catch((err) => {
		// Let a later Start event retry — calls are event-driven (one per
		// agent turn/tool use at most), so a cloud outage can't tight-loop.
		startedTaskIds.delete(taskId);
		console.warn(
			`[notifications.hook] failed to mark task ${taskId} as started:`,
			err,
		);
	});
}

export const notificationsRouter = router({
	/**
	 * Agent lifecycle hook. The shell hook POSTs here; we normalize, resolve
	 * the terminal's workspace, and fan out over the WS event bus.
	 *
	 * Intentionally unauthenticated: a caller can only trigger a chime, a
	 * sidebar indicator, and the idempotent forward-only "linked task →
	 * In Progress" nudge for a real workspace. Reusing the host-service PSK
	 * would leak it into every agent shell's env for zero practical gain.
	 *
	 * (COMPANION-CAPTURE) That threat model now also covers a forged question:
	 * anything on localhost can POST a `companionQuestion` and make a paired
	 * device display text it wrote. The sink validates the capture shape and
	 * derives its terminal/workspace/transcript identities from host.db rather
	 * than trusting caller claims. The guardless answer path intentionally does
	 * not turn transcript, screen, renderer, binding, marker or liveness reads
	 * into write vetoes; pairing, sealed authenticated transport, exact current
	 * question/fingerprint arbitration, semantic answer validation, the answer
	 * lease, terminal lock and durable request fence remain the write boundary.
	 * Do not reintroduce mutable desktop observations as answer preconditions.
	 */
	hook: publicProcedure.input(hookInput).mutation(async ({ ctx, input }) => {
		const eventType = mapEventType(input.eventType);
		if (!eventType) {
			warnDroppedCompanionCapture(
				input,
				`unmapped eventType ${String(input.eventType)}`,
			);
			return {
				success: true,
				ignored: true as const,
				reason: "unmapped-event-type" as const,
			};
		}

		if (!input.terminalId) {
			warnDroppedCompanionCapture(input, "no terminalId on the hook payload");
			return {
				success: true,
				ignored: true as const,
				reason: "no-terminal-id" as const,
			};
		}

		// (DISPOSE-LIMBO) Three outcomes, not two. "No row" and "row whose
		// originWorkspaceId went NULL" were one silent drop, so an agent POSTing
		// against a terminal this host has never heard of looked exactly like the
		// benign post-workspace-delete FK set-null case, and neither left a trace
		// loud enough to notice. A missing row is an INVARIANT VIOLATION — the
		// hook's env was stamped by a terminal we own, so the row must exist —
		// and it is how a dispose that never completed surfaces here.
		//
		// All three still answer HTTP 200: the bash hook template treats a
		// non-2xx as "host-service declined" and falls through to the legacy
		// Electron hook path, so failing loudly on the wire would silently change
		// agent behaviour. The distinct `reason` is the loud channel instead —
		// (DISPOSE-LIMBO) makes both hook writers log the response BODY.
		//
		// We deliberately do NOT insert or adopt a row from a hook event. A row
		// asserts "an attachable PTY exists for this id"; minting one from
		// hearsay would let a later attach respawn a PTY for a terminal the user
		// killed, and would resurrect exactly the rows the reaper is trying to
		// finish killing.
		const terminalSession = ctx.db.query.terminalSessions
			.findFirst({
				where: eq(terminalSessions.id, input.terminalId),
				columns: { originWorkspaceId: true },
			})
			.sync();

		if (!terminalSession) {
			reportUnknownTerminal({
				terminalId: input.terminalId,
				eventType: input.eventType,
				mappedEventType: eventType,
				agentId: input.agent?.agentId,
				agentSessionId: input.agent?.sessionId,
			});
			warnDroppedCompanionCapture(
				input,
				`terminal ${input.terminalId} has no session row`,
			);
			return {
				success: true,
				ignored: true as const,
				reason: "unknown-terminal" as const,
			};
		}

		if (!terminalSession.originWorkspaceId) {
			// Benign and expected: deleting a workspace sets this FK to NULL while
			// the agent in the terminal is still alive and still hooking.
			console.warn(
				"[notifications] dropping hook for a terminal whose workspace is gone",
				{ terminalId: input.terminalId, mappedEventType: eventType },
			);
			warnDroppedCompanionCapture(
				input,
				`terminal ${input.terminalId} has no originWorkspaceId`,
			);
			return {
				success: true,
				ignored: true as const,
				reason: "null-origin-workspace" as const,
			};
		}

		const agent = normalizeAgentIdentity(input.agent);
		// The persisted binding is the source of truth for whether this hook is a
		// genuine active-to-terminal transition. Capture it before recordEvent
		// replaces its last-event fields below — and, since it carries this
		// terminal's last instant, it is also the anchor the monotonic stamp
		// below is derived from.
		const previousBinding = ctx.terminalAgentStore.get(input.terminalId);
		const occurredAt = nextLifecycleInstantMs(
			Date.now(),
			previousBinding?.lastEventAt,
		);

		ctx.eventBus.broadcastAgentLifecycle({
			workspaceId: terminalSession.originWorkspaceId,
			eventType,
			terminalId: input.terminalId,
			...(agent ? { agent } : {}),
			occurredAt,
		});

		// (ALERT-RETIRE-ON-EXIT) BEFORE `recordEvent`, and the order is the whole
		// point. host.db keeps ONE last-event row per terminal, and it is the only
		// durable evidence that a terminal finished — the alert table is
		// process-local, so a restart recovers the ready card it may still owe a
		// retraction for by reading `lastEventType === "Stop"` off that row.
		// `recordEvent` OVERWRITES it. Run afterwards, a crash in the window
		// between the write and this call left host.db saying "Start" with no `c`
		// ever queued: the notification on the phone became unnameable and stood
		// for its full six-hour TTL.
		//
		// Forwarding first makes both outcomes safe. Crash before it and host.db
		// still says `Stop`, so the next start reconstructs and retracts the exact
		// id; crash after it and the `c` is already queued on the push chain. Both
		// can happen at once, which is a DUPLICATE retraction — the phone drops
		// the second — and duplicating a `c` is the cheap failure while losing the
		// evidence is the expensive one.
		//
		// A FAULT here propagates rather than being swallowed, which closes the
		// same window a crash opens: it skips the `recordEvent` below, so the
		// `Stop` row survives for the restart path instead of being buried by an
		// event whose retraction was never queued. The live dot already moved on
		// the broadcast above; the cost is the persisted binding (BUS-RESYNC)
		// reads, which the next hook event replaces.
		// `forwardCompanionCapture` stays strictly after, below.
		forwardCompanionLifecycle({
			payload: input,
			eventType,
			terminalId: input.terminalId,
			workspaceId: terminalSession.originWorkspaceId,
			occurredAtMs: occurredAt,
			previousEventType: previousBinding?.lastEventType ?? null,
			previousEventAtMs: previousBinding?.lastEventAt ?? null,
		});

		ctx.terminalAgentStore.recordEvent({
			terminalId: input.terminalId,
			workspaceId: terminalSession.originWorkspaceId,
			eventType,
			...(agent?.agentId ? { agentId: agent.agentId } : {}),
			...(agent?.sessionId ? { agentSessionId: agent.sessionId } : {}),
			...(agent?.definitionId ? { definitionId: agent.definitionId } : {}),
			occurredAt,
		});

		// Every lifecycle event is activity for the sidebar's "Last active"
		// ranking. Best-effort: a failed write must not fail the hook, which
		// also drives the chime and the status dots.
		try {
			touchLocalWorkspaceActivity(
				ctx,
				terminalSession.originWorkspaceId,
				occurredAt,
			);
		} catch (err) {
			console.warn(
				`[notifications.hook] failed to record activity for workspace ${terminalSession.originWorkspaceId}:`,
				err,
			);
		}

		// (COMPANION-CAPTURE-HOOK) Strictly AFTER the dot work above, so a
		// companion bridge fault can never alter or delay the agent-status
		// broadcast: by the time anything below can throw, the dot has already
		// moved. A throw here surfaces as a 500 the notify hook logs — loud, and
		// harmless to the agent (the hook ignores the status beyond logging it).
		await forwardCompanionCapture({
			payload: input,
			terminalId: input.terminalId,
			workspaceId: terminalSession.originWorkspaceId,
			occurredAt,
		});

		// An agent began working in this workspace — nudge the linked task
		// to In Progress.
		if (eventType === "Start") {
			markLinkedTaskStarted(ctx, terminalSession.originWorkspaceId);
		}

		return { success: true, ignored: false as const };
	}),

	/**
	 * (BUS-RESYNC) Durable agent status for every live terminal binding on this
	 * host. The WS event bus is fire-and-forget — an event broadcast while a
	 * renderer is disconnected is DESTROYED, and a blocked agent emits no
	 * further hook events, so a dot lost that way can never self-heal. The
	 * renderer refetches this on every bus (re)connect and reconciles.
	 *
	 * Read-only and cheap: a liveness-joined in-memory store read, one
	 * marker-directory read per bound terminal, and one covering read of the
	 * `terminal_sessions` primary key. On `queryProcedure` (repo rule: every
	 * `.query` carries a server-side timeout) so a wedged readdir rejects
	 * instead of leaving the renderer's resync promise pending forever — an
	 * un-settling promise would keep the epoch marked synced and disarm the
	 * retry, leaving the dots unreconciled for the life of the connection.
	 */
	agentStatusSnapshot: queryProcedure
		.input(
			z
				.object({
					/**
					 * (GHOST-TERMINAL) Terminal ids the caller holds dot state for.
					 * When present, `knownTerminalIds` comes back intersected with
					 * these instead of listing every row the host has ever minted.
					 *
					 * Bounded at the boundary because it feeds `inArray`, which
					 * expands to one bound parameter per element: past SQLite's
					 * variable limit the query THROWS, the resync fails, and the
					 * renderer retries the same oversized input on every reconnect —
					 * dots frozen for the life of the connection. Rejected rather
					 * than truncated: a silently shortened candidate list makes the
					 * sweep treat present terminals as unknown, which is a wrong
					 * answer dressed as a right one. The renderer sends one id per
					 * terminal it holds dot state for (tens in practice, one per open
					 * pane), so 500 is far above anything legitimate and no host-side
					 * chunking is warranted.
					 *
					 * Element LENGTH is deliberately unbounded (min 1 only): the
					 * creation boundaries accept caller-supplied ids of any length
					 * (`terminal.createSession` takes a plain string, REST likewise),
					 * and a length cap here meant one long id with dot state poisoned
					 * every snapshot query for the host — reconciliation dead on a
					 * retry loop. SQLite is protected by the ARRAY cap, not element
					 * size.
					 */
					candidateTerminalIds: z.array(z.string().min(1)).max(500).optional(),
				})
				.optional(),
		)
		.query(async ({ ctx, input }): Promise<AgentStatusSnapshot> => {
			return buildAgentStatusSnapshot(
				ctx.terminalAgentStore,
				ctx.db,
				input?.candidateTerminalIds,
			);
		}),
});
