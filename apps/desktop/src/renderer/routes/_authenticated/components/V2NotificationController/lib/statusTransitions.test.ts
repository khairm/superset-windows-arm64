import { describe, expect, it } from "bun:test";
import type { AgentLifecyclePayload } from "@superset/workspace-client";
import { resolveV2AgentStatusTransition } from "./statusTransitions";

const WORKSPACE_ID = "workspace-1";

function payload(
	overrides: Partial<AgentLifecyclePayload>,
): AgentLifecyclePayload {
	return {
		eventType: "Stop",
		terminalId: "terminal-1",
		occurredAt: 1,
		...overrides,
	};
}

describe("resolveV2AgentStatusTransition", () => {
	it("marks start as working and clears permission/review on the terminal source", () => {
		expect(
			resolveV2AgentStatusTransition({
				workspaceId: WORKSPACE_ID,
				payload: payload({
					eventType: "Start",
					terminalId: "terminal-1",
				}),
				statuses: {},
				targetVisible: false,
			}),
		).toEqual({
			clearSources: [],
			axes: {
				source: { type: "terminal", id: "terminal-1" },
				set: ["working"],
				clear: ["permission", "review"],
			},
		});
	});

	it("(DOT-AXES) SubagentActive asserts working WITHOUT clearing a pending permission", () => {
		// The bug this guards: background agents' tool completions stream in
		// while the main loop is blocked on AskUserQuestion — they must raise
		// the working axis only, so the fold keeps showing red.
		expect(
			resolveV2AgentStatusTransition({
				workspaceId: WORKSPACE_ID,
				payload: payload({
					eventType: "SubagentActive",
					terminalId: "terminal-1",
				}),
				statuses: {
					"terminal:terminal-1": {
						workspaceId: WORKSPACE_ID,
						status: "permission",
					},
				},
				targetVisible: false,
			}),
		).toEqual({
			clearSources: [],
			axes: {
				source: { type: "terminal", id: "terminal-1" },
				set: ["working"],
				clear: [],
			},
		});
	});

	it("marks a permission request without touching the other axes", () => {
		expect(
			resolveV2AgentStatusTransition({
				workspaceId: WORKSPACE_ID,
				payload: payload({
					eventType: "PermissionRequest",
					terminalId: "terminal-1",
				}),
				statuses: {},
				targetVisible: false,
			}),
		).toEqual({
			clearSources: [],
			axes: {
				source: { type: "terminal", id: "terminal-1" },
				set: ["permission"],
				clear: [],
			},
		});
	});

	it("clears permission state on stop", () => {
		expect(
			resolveV2AgentStatusTransition({
				workspaceId: WORKSPACE_ID,
				payload: payload({
					eventType: "Stop",
					terminalId: "terminal-1",
				}),
				statuses: {
					"terminal:terminal-1": {
						workspaceId: WORKSPACE_ID,
						status: "permission",
					},
				},
				targetVisible: false,
			}),
		).toEqual({
			clearSources: [{ type: "terminal", id: "terminal-1" }],
			axes: null,
		});
	});

	it("clears stop when the exact target pane is visible", () => {
		expect(
			resolveV2AgentStatusTransition({
				workspaceId: WORKSPACE_ID,
				payload: payload({ eventType: "Stop", terminalId: "terminal-1" }),
				statuses: {},
				targetVisible: true,
			}),
		).toEqual({
			clearSources: [{ type: "terminal", id: "terminal-1" }],
			axes: null,
		});
	});

	it("marks background stop as review and ends permission/working", () => {
		expect(
			resolveV2AgentStatusTransition({
				workspaceId: WORKSPACE_ID,
				payload: payload({ eventType: "Stop", terminalId: "terminal-1" }),
				statuses: {},
				targetVisible: false,
			}),
		).toEqual({
			clearSources: [],
			axes: {
				source: { type: "terminal", id: "terminal-1" },
				set: ["review"],
				clear: ["permission", "working"],
			},
		});
	});

	it("does not change pane status on session Attached", () => {
		expect(
			resolveV2AgentStatusTransition({
				workspaceId: WORKSPACE_ID,
				payload: payload({ eventType: "Attached", terminalId: "terminal-1" }),
				statuses: {},
				targetVisible: false,
			}),
		).toEqual({ clearSources: [], axes: null });
	});

	it("clears the transient axes on session Detached, sparing review", () => {
		expect(
			resolveV2AgentStatusTransition({
				workspaceId: WORKSPACE_ID,
				payload: payload({ eventType: "Detached", terminalId: "terminal-1" }),
				statuses: {
					"terminal:terminal-1": {
						workspaceId: WORKSPACE_ID,
						status: "working",
					},
				},
				targetVisible: false,
			}),
		).toEqual({
			clearSources: [],
			axes: {
				source: { type: "terminal", id: "terminal-1" },
				set: [],
				clear: ["permission", "working"],
			},
		});
	});

	it("ignores permission state from a different workspace", () => {
		expect(
			resolveV2AgentStatusTransition({
				workspaceId: WORKSPACE_ID,
				payload: payload({ eventType: "Stop", terminalId: "terminal-1" }),
				statuses: {
					"terminal:terminal-1": {
						workspaceId: "workspace-2",
						status: "permission",
					},
				},
				targetVisible: false,
			}),
		).toEqual({
			clearSources: [],
			axes: {
				source: { type: "terminal", id: "terminal-1" },
				set: ["review"],
				clear: ["permission", "working"],
			},
		});
	});
});
