/**
 * (BRIDGE-AGENT-KIND) One place that answers "which agent is bound here?".
 *
 * WHY THIS EXISTS AT ALL. The bridge had three near-copies of this question and
 * they disagreed about which column to read. The answer guard read
 * `definitionId`; the tree and the question store read `agentId`. On this
 * machine `definition_id` is NULL on every one of the persisted bindings, so the
 * guard's copy answered `unknown` for healthy Claude terminals and `/v1/answer`
 * refused them with "unsupported agent kind: unknown" — three consecutive
 * refusals of a question the user was holding their wrist over, while the tree
 * beside it rendered the same terminal as Claude.
 *
 * THE TWO COLUMNS ARE NOT INTERCHANGEABLE, WHICH IS WHY BOTH ARE READ.
 *
 *  - `definition_id` is the agent CATALOG entry the desktop launched (upstream
 *    `AgentDefinitionId`). It is the more specific fact when present — but it is
 *    optional on `TerminalAgentBinding`, the notify hook does not supply it, and
 *    a user-defined agent config carries a UUID whose text says nothing about
 *    the underlying CLI. Substring matching is therefore the only reading it
 *    supports, and `unknown` is its common answer.
 *  - `agent_id` is the notify hook's own agent name — literally `"claude"` or
 *    `"codex"` — recorded on EVERY binding, because a binding is created by a
 *    hook event and the hook knows what it is. It is matched EXACTLY: a
 *    substring rule here would let an arbitrary custom agent id containing
 *    "claude" claim Claude's byte contract.
 *
 * So: definition first (more specific), agent id as the fallback (always
 * present), `unknown` only when NEITHER is recognised. `unknown` still refuses —
 * this widens what is recognised, it does not weaken the refusal.
 */

import type { QuestionAgentKind } from "./types";

/**
 * `terminal_agent_bindings.agent_id`, matched EXACTLY. Nothing else may map to
 * a writable kind: this value ultimately decides whether the answer path is
 * allowed to type Claude's picker keys into a pty.
 */
export function agentKindFromAgentId(
	agentId: string | null | undefined,
): QuestionAgentKind {
	if (agentId === "claude") return "claude";
	if (agentId === "codex") return "codex";
	return "unknown";
}

/**
 * `terminal_agent_bindings.definition_id`, matched by substring because catalog
 * ids are compound (`claude-code`, `claude-sonnet-...`). A custom config's UUID
 * matches nothing and correctly yields `unknown`, which is what makes the
 * `agent_id` fallback load-bearing rather than cosmetic.
 */
export function agentKindFromDefinitionId(
	definitionId: string | null | undefined,
): QuestionAgentKind {
	if (typeof definitionId !== "string") return "unknown";
	const id = definitionId.toLowerCase();
	if (id.includes("claude")) return "claude";
	if (id.includes("codex")) return "codex";
	return "unknown";
}

/**
 * THE binding-to-kind rule. Definition id first, agent id second, `unknown`
 * when both are unrecognised.
 */
export function resolveAgentKind(binding: {
	definitionId?: string | null;
	agentId?: string | null;
}): QuestionAgentKind {
	const fromDefinition = agentKindFromDefinitionId(binding.definitionId);
	if (fromDefinition !== "unknown") return fromDefinition;
	return agentKindFromAgentId(binding.agentId);
}
