import { describe, expect, it, mock } from "bun:test";
import type { AgentIdentity } from "@superset/shared/agent-identity";
import type { AgentLifecycleEventType } from "../../../events";
import { TerminalAgentStore } from "../../../terminal-agents";
import type { HostServiceContext } from "../../../types";
import { notificationsRouter } from "./notifications";

interface BroadcastedAgentLifecycleEvent {
	workspaceId: string;
	eventType: AgentLifecycleEventType;
	terminalId: string;
	agent?: AgentIdentity;
	occurredAt: number;
}

function createContext(
	originWorkspaceId: string | null,
	// (DISPOSE-LIMBO) `null` origin normally means "no row at all"; pass true to
	// model the other case — a row that EXISTS with a NULL originWorkspaceId,
	// which the router must report distinctly.
	rowExists = originWorkspaceId !== null,
): {
	ctx: HostServiceContext;
	broadcastAgentLifecycle: ReturnType<
		typeof mock<(event: BroadcastedAgentLifecycleEvent) => void>
	>;
	findFirst: ReturnType<typeof mock>;
	terminalAgentStore: TerminalAgentStore;
} {
	const broadcastAgentLifecycle = mock(
		(_event: BroadcastedAgentLifecycleEvent) => {},
	);
	const findFirst = mock(() => ({
		sync: () => (rowExists ? { originWorkspaceId } : null),
	}));
	const terminalAgentStore = new TerminalAgentStore();

	const ctx = {
		db: {
			query: {
				terminalSessions: {
					findFirst,
				},
			},
		},
		eventBus: {
			broadcastAgentLifecycle,
		},
		terminalAgentStore,
	} as unknown as HostServiceContext;

	return { ctx, broadcastAgentLifecycle, findFirst, terminalAgentStore };
}

describe("notificationsRouter.hook", () => {
	it("derives workspaceId from terminalId before broadcasting", async () => {
		const { ctx, broadcastAgentLifecycle, findFirst } =
			createContext("workspace-1");
		const caller = notificationsRouter.createCaller(ctx);

		const result = await caller.hook({
			terminalId: "terminal-1",
			eventType: "task_complete",
		});

		expect(result).toEqual({ success: true, ignored: false });
		expect(findFirst).toHaveBeenCalledTimes(1);
		expect(broadcastAgentLifecycle).toHaveBeenCalledTimes(1);
		expect(broadcastAgentLifecycle.mock.calls[0]?.[0]).toMatchObject({
			workspaceId: "workspace-1",
			eventType: "Stop",
			terminalId: "terminal-1",
		});
		expect(typeof broadcastAgentLifecycle.mock.calls[0]?.[0].occurredAt).toBe(
			"number",
		);
	});

	it("ignores missing or unknown terminal ids", async () => {
		const missingTerminal = createContext("workspace-1");
		const missingResult = await notificationsRouter
			.createCaller(missingTerminal.ctx)
			.hook({ eventType: "Stop" });

		expect(missingResult).toEqual({
			success: true,
			ignored: true,
			reason: "no-terminal-id",
		});
		expect(missingTerminal.findFirst).not.toHaveBeenCalled();
		expect(missingTerminal.broadcastAgentLifecycle).not.toHaveBeenCalled();

		const unknownTerminal = createContext(null);
		const unknownResult = await notificationsRouter
			.createCaller(unknownTerminal.ctx)
			.hook({ terminalId: "terminal-missing", eventType: "Stop" });

		// (DISPOSE-LIMBO) A hook for a terminal with NO row is an invariant
		// violation, and must be distinguishable on the wire from the benign
		// row-exists-but-workspace-deleted case below.
		expect(unknownResult).toEqual({
			success: true,
			ignored: true,
			reason: "unknown-terminal",
		});
		expect(unknownTerminal.findFirst).toHaveBeenCalledTimes(1);
		expect(unknownTerminal.broadcastAgentLifecycle).not.toHaveBeenCalled();
	});

	it("ignores a terminal whose workspace was deleted, distinctly", async () => {
		// (DISPOSE-LIMBO) Row present, originWorkspaceId NULL — the FK set-null
		// left behind by deleting a workspace whose agent is still hooking.
		const { ctx, findFirst, broadcastAgentLifecycle } = createContext(
			null,
			true,
		);

		const result = await notificationsRouter
			.createCaller(ctx)
			.hook({ terminalId: "terminal-1", eventType: "Stop" });

		expect(result).toEqual({
			success: true,
			ignored: true,
			reason: "null-origin-workspace",
		});
		expect(findFirst).toHaveBeenCalledTimes(1);
		expect(broadcastAgentLifecycle).not.toHaveBeenCalled();
	});

	it("ignores unknown event types before looking up the terminal", async () => {
		const { ctx, broadcastAgentLifecycle, findFirst } =
			createContext("workspace-1");
		const caller = notificationsRouter.createCaller(ctx);

		const result = await caller.hook({
			terminalId: "terminal-1",
			eventType: "unknown-event",
		});

		expect(result).toEqual({
			success: true,
			ignored: true,
			reason: "unmapped-event-type",
		});
		expect(findFirst).not.toHaveBeenCalled();
		expect(broadcastAgentLifecycle).not.toHaveBeenCalled();
	});

	it("forwards agent identity when the hook stamps it", async () => {
		const { ctx, broadcastAgentLifecycle } = createContext("workspace-1");

		await notificationsRouter.createCaller(ctx).hook({
			terminalId: "terminal-1",
			eventType: "Stop",
			agent: { agentId: "claude", sessionId: "session-abc" },
		});

		expect(broadcastAgentLifecycle).toHaveBeenCalledTimes(1);
		expect(broadcastAgentLifecycle.mock.calls[0]?.[0]).toMatchObject({
			workspaceId: "workspace-1",
			terminalId: "terminal-1",
			eventType: "Stop",
			agent: { agentId: "claude", sessionId: "session-abc" },
		});
	});

	it("normalizes empty-string identity fields to undefined", async () => {
		const { ctx, broadcastAgentLifecycle } = createContext("workspace-1");

		await notificationsRouter.createCaller(ctx).hook({
			terminalId: "terminal-1",
			eventType: "Stop",
			agent: { agentId: "claude", sessionId: "" },
		});

		const broadcast = broadcastAgentLifecycle.mock.calls[0]?.[0];
		expect(broadcast?.agent).toEqual({ agentId: "claude" });
	});

	it("records the event onto the terminal agent store", async () => {
		const { ctx, terminalAgentStore } = createContext("workspace-1");

		await notificationsRouter.createCaller(ctx).hook({
			terminalId: "terminal-1",
			eventType: "SessionStart",
			agent: { agentId: "claude", sessionId: "session-abc" },
		});

		const binding = terminalAgentStore.get("terminal-1");
		expect(binding?.agentId).toBe("claude");
		expect(binding?.agentSessionId).toBe("session-abc");
		expect(binding?.workspaceId).toBe("workspace-1");
		expect(binding?.lastEventType).toBe("Attached");
	});

	it("maps Claude Code's StopFailure API-error hook to a Failed event and records it", async () => {
		const { ctx, broadcastAgentLifecycle, terminalAgentStore } =
			createContext("workspace-1");
		const caller = notificationsRouter.createCaller(ctx);

		await caller.hook({
			terminalId: "terminal-1",
			eventType: "SessionStart",
			agent: { agentId: "claude", sessionId: "session-abc" },
		});
		const result = await caller.hook({
			terminalId: "terminal-1",
			eventType: "StopFailure",
			agent: { agentId: "claude", sessionId: "session-abc" },
		});

		expect(result).toEqual({ success: true, ignored: false });
		const failedBroadcast = broadcastAgentLifecycle.mock.calls.at(-1)?.[0];
		expect(failedBroadcast).toMatchObject({
			workspaceId: "workspace-1",
			eventType: "Failed",
			terminalId: "terminal-1",
			// Failed keeps the agent identifiable, unlike an exit that drops it.
			agent: { agentId: "claude", sessionId: "session-abc" },
		});
		const binding = terminalAgentStore.get("terminal-1");
		expect(binding?.lastEventType).toBe("Failed");
		expect(binding?.agentId).toBe("claude");
		expect(binding?.agentSessionId).toBe("session-abc");
	});

	it("drops agent identity entirely when agentId is missing", async () => {
		const { ctx, broadcastAgentLifecycle } = createContext("workspace-1");

		await notificationsRouter.createCaller(ctx).hook({
			terminalId: "terminal-1",
			eventType: "Stop",
			agent: { agentId: "" },
		});

		const broadcast = broadcastAgentLifecycle.mock.calls[0]?.[0];
		expect(broadcast?.agent).toBeUndefined();
	});
});
