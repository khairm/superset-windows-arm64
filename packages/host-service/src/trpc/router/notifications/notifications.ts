import type { AgentIdentity } from "@superset/shared/agent-identity";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { terminalSessions } from "../../../db/schema";
import { mapEventType } from "../../../events";
import { publicProcedure, queryProcedure, router } from "../../index";
import {
	type AgentStatusSnapshot,
	buildAgentStatusSnapshot,
} from "./agent-status-snapshot";
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
	.extend(companionHookFields);

function trimOrUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

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

export const notificationsRouter = router({
	/**
	 * Agent lifecycle hook. The shell hook POSTs here; we normalize, resolve
	 * the terminal's workspace, and fan out over the WS event bus.
	 *
	 * Intentionally unauthenticated: a caller can only trigger a chime and a
	 * sidebar indicator. Reusing the host-service PSK would leak it into every
	 * agent shell's env for zero practical gain.
	 *
	 * (COMPANION-CAPTURE) That threat model now also covers a forged question:
	 * anything on localhost can POST a `companionQuestion` and make a phone
	 * display text it wrote. It CANNOT make the bridge type anything into a
	 * terminal — PROTOCOL.md §11.3 keeps the load-bearing answer guards on the
	 * transcript (guard 1) and a live screen snapshot (guard 5), both outside
	 * this endpoint's reach, precisely because this endpoint is unauthenticated.
	 * A forged capture therefore fails guard 1/5 and writes nothing. Do not
	 * promote anything sourced here into an answer precondition.
	 *
	 * "Outside this endpoint's reach" is mechanical, not aspirational, and both
	 * mechanisms were once missing. Guard 1 reads a transcript path DERIVED from
	 * host.db rather than the `transcriptPath` sent here, and requires the
	 * matching `tool_use` block to be positively observed; guard 5 enforces a
	 * minimum anchor length and a contiguous ascending row band, so the `header`
	 * and `label` strings sent here cannot be shrunk into a substring test any
	 * screen satisfies. Weakening either puts this endpoint back on the
	 * permitting path.
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
		const occurredAt = Date.now();

		ctx.eventBus.broadcastAgentLifecycle({
			workspaceId: terminalSession.originWorkspaceId,
			eventType,
			terminalId: input.terminalId,
			...(agent ? { agent } : {}),
			occurredAt,
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

		// (COMPANION-CAPTURE-HOOK) Strictly AFTER the dot work above, so a
		// companion bridge fault can never alter or delay the agent-status
		// broadcast: by the time anything below can throw, the dot has already
		// moved. A throw here surfaces as a 500 the notify hook logs — loud, and
		// harmless to the agent (the hook ignores the status beyond logging it).
		forwardCompanionCapture({
			payload: input,
			terminalId: input.terminalId,
			workspaceId: terminalSession.originWorkspaceId,
			occurredAt,
		});

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
