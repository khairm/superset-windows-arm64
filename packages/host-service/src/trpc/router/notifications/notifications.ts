import type { AgentIdentity } from "@superset/shared/agent-identity";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { terminalSessions } from "../../../db/schema";
import { mapEventType } from "../../../events";
import { publicProcedure, router } from "../../index";
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
			return { success: true, ignored: true as const };
		}

		if (!input.terminalId) {
			warnDroppedCompanionCapture(input, "no terminalId on the hook payload");
			return { success: true, ignored: true as const };
		}

		const terminalSession = ctx.db.query.terminalSessions
			.findFirst({
				where: eq(terminalSessions.id, input.terminalId),
				columns: { originWorkspaceId: true },
			})
			.sync();
		if (!terminalSession?.originWorkspaceId) {
			warnDroppedCompanionCapture(
				input,
				`terminal ${input.terminalId} has no originWorkspaceId`,
			);
			return { success: true, ignored: true as const };
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
});
