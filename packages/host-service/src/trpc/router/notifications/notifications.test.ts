import { describe, expect, it, mock } from "bun:test";
import type { AgentIdentity } from "@superset/shared/agent-identity";
import type { AgentLifecycleEventType } from "../../../events";
import { TerminalAgentStore } from "../../../terminal-agents";
import type { HostServiceContext } from "../../../types";
import { nextLifecycleInstantMs, notificationsRouter } from "./notifications";

interface BroadcastedAgentLifecycleEvent {
	workspaceId: string;
	eventType: AgentLifecycleEventType;
	terminalId: string;
	agent?: AgentIdentity;
	occurredAt: number;
}

function createContext(
	originWorkspaceId: string | null,
	options?: {
		// (DISPOSE-LIMBO) `null` origin normally means "no row at all"; pass true
		// to model the other case — a row that EXISTS with a NULL
		// originWorkspaceId, which the router must report distinctly.
		rowExists?: boolean;
		taskId?: string | null;
	},
): {
	ctx: HostServiceContext;
	broadcastAgentLifecycle: ReturnType<
		typeof mock<(event: BroadcastedAgentLifecycleEvent) => void>
	>;
	findFirst: ReturnType<typeof mock>;
	taskStart: ReturnType<
		typeof mock<(input: { id: string }) => Promise<unknown>>
	>;
	terminalAgentStore: TerminalAgentStore;
} {
	const rowExists = options?.rowExists ?? originWorkspaceId !== null;
	const broadcastAgentLifecycle = mock(
		(_event: BroadcastedAgentLifecycleEvent) => {},
	);
	const findFirst = mock(() => ({
		sync: () => (rowExists ? { originWorkspaceId } : null),
	}));
	const workspaceFindFirst = mock(() => ({
		sync: () => ({ taskId: options?.taskId ?? null }),
	}));
	const taskStart = mock((_input: { id: string }) => Promise.resolve({}));
	const terminalAgentStore = new TerminalAgentStore();

	const ctx = {
		db: {
			query: {
				terminalSessions: {
					findFirst,
				},
				workspaces: {
					findFirst: workspaceFindFirst,
				},
			},
		},
		api: {
			task: {
				start: {
					mutate: taskStart,
				},
			},
		},
		eventBus: {
			broadcastAgentLifecycle,
		},
		terminalAgentStore,
	} as unknown as HostServiceContext;

	return {
		ctx,
		broadcastAgentLifecycle,
		findFirst,
		taskStart,
		terminalAgentStore,
	};
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
		const { ctx, findFirst, broadcastAgentLifecycle } = createContext(null, {
			rowExists: true,
		});

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

	it("nudges the linked task to In Progress once per task on Start events", async () => {
		// Unique per test: the once-per-process dedup set is module-level.
		const taskId = "task-nudge-once";
		const { ctx, taskStart } = createContext("workspace-1", { taskId });
		const caller = notificationsRouter.createCaller(ctx);

		await caller.hook({ terminalId: "terminal-1", eventType: "Start" });
		await caller.hook({ terminalId: "terminal-1", eventType: "Start" });

		expect(taskStart).toHaveBeenCalledTimes(1);
		expect(taskStart.mock.calls[0]?.[0]).toEqual({ id: taskId });
	});

	it("retries the nudge on a later Start event after a failed call", async () => {
		const taskId = "task-nudge-retry";
		const { ctx, taskStart } = createContext("workspace-1", { taskId });
		taskStart.mockImplementationOnce(() =>
			Promise.reject(new Error("cloud unreachable")),
		);
		const caller = notificationsRouter.createCaller(ctx);

		await caller.hook({ terminalId: "terminal-1", eventType: "Start" });
		// let the rejection handler clear the dedup entry
		await new Promise((resolve) => setTimeout(resolve, 0));
		await caller.hook({ terminalId: "terminal-1", eventType: "Start" });

		expect(taskStart).toHaveBeenCalledTimes(2);
	});

	it("does not nudge the task when the workspace has no linked task", async () => {
		const { ctx, taskStart } = createContext("workspace-1", { taskId: null });

		await notificationsRouter
			.createCaller(ctx)
			.hook({ terminalId: "terminal-1", eventType: "Start" });

		expect(taskStart).not.toHaveBeenCalled();
	});

	it("does not nudge the task on non-Start events", async () => {
		const { ctx, taskStart } = createContext("workspace-1", {
			taskId: "task-nudge-stop",
		});

		await notificationsRouter
			.createCaller(ctx)
			.hook({ terminalId: "terminal-1", eventType: "Stop" });

		expect(taskStart).not.toHaveBeenCalled();
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

/**
 * (ONE-BUZZ-UNTIL-READ) Every lifecycle fact this host records is stamped from
 * one instant: the binding's `lastEventAt`, the deterministic alert id, the
 * `gx` generation on the wire, and the boundary a read is compared against. A
 * wall clock that steps BACKWARDS (an ordinary NTP correction) would invert
 * that ordering, and a finish stamped behind its predecessor is one the phone
 * rejects as stale, the host cannot retract, and the renderer believes was
 * reported — a card stuck on the handset until its TTL.
 */
describe("(ONE-BUZZ-UNTIL-READ) lifecycle instants are monotonic per terminal", () => {
	it("advances by one when the clock steps back", () => {
		expect(nextLifecycleInstantMs(4_000, 5_000)).toBe(5_001);
		expect(nextLifecycleInstantMs(5_000, 5_000)).toBe(5_001);
	});

	it("honours the wall clock when it has moved forward", () => {
		expect(nextLifecycleInstantMs(6_000, 5_000)).toBe(6_000);
		// A big forward jump is real time, not a correction to undo.
		expect(nextLifecycleInstantMs(9_000_000, 5_000)).toBe(9_000_000);
	});

	it("takes the clock as-is for a terminal with no history", () => {
		expect(nextLifecycleInstantMs(5_000, undefined)).toBe(5_000);
		expect(nextLifecycleInstantMs(5_000, null)).toBe(5_000);
	});

	it("keeps two finishes ordered across a step-back, per terminal", async () => {
		const { ctx, broadcastAgentLifecycle } = createContext("workspace-1");
		const caller = notificationsRouter.createCaller(ctx);
		const realNow = Date.now;
		try {
			Date.now = () => 5_000;
			await caller.hook({
				terminalId: "terminal-1",
				eventType: "Stop",
				agent: { agentId: "claude-code" },
			});
			// NTP steps the wall clock back a second between two finishes.
			Date.now = () => 4_000;
			await caller.hook({
				terminalId: "terminal-1",
				eventType: "Stop",
				agent: { agentId: "claude-code" },
			});
			// A DIFFERENT terminal's stream is independent — one busy agent must
			// not push another terminal's stamps into the future.
			await caller.hook({
				terminalId: "terminal-2",
				eventType: "Stop",
				agent: { agentId: "claude-code" },
			});
		} finally {
			Date.now = realNow;
		}

		const instants = broadcastAgentLifecycle.mock.calls.map(
			(call) => call[0].occurredAt,
		);
		expect(instants[0]).toBe(5_000);
		// The second finish is a NEW generation, so its instant must be greater —
		// by the smallest amount that keeps the order intact.
		expect(instants[1]).toBe(5_001);
		expect(instants[2]).toBe(4_000);
	});

	it("carries the same instant to the binding and the companion sink", async () => {
		const { ctx, broadcastAgentLifecycle, terminalAgentStore } =
			createContext("workspace-1");
		const caller = notificationsRouter.createCaller(ctx);
		const realNow = Date.now;
		try {
			Date.now = () => 5_000;
			await caller.hook({
				terminalId: "terminal-1",
				eventType: "Stop",
				agent: { agentId: "claude-code" },
			});
			Date.now = () => 1_000;
			await caller.hook({
				terminalId: "terminal-1",
				eventType: "Stop",
				agent: { agentId: "claude-code" },
			});
		} finally {
			Date.now = realNow;
		}

		// The binding is the anchor the next stamp is derived from, so it has to
		// carry the corrected instant rather than the raw clock reading.
		expect(terminalAgentStore.get("terminal-1")?.lastEventAt).toBe(5_001);
		expect(broadcastAgentLifecycle.mock.calls[1]?.[0].occurredAt).toBe(5_001);
	});
});
