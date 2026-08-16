/**
 * (ALERT-CONTEXT-NAMES) The tab-context registry.
 *
 * The rules under test are the ones that decide whether an alert names the
 * RIGHT tab, names no tab, or names somebody else's.
 */

import { describe, expect, it } from "bun:test";
import type { BridgeLogger } from "./http";
import {
	ALERT_CONTEXT_MAX_TERMINALS_PER_WORKSPACE,
	ALERT_CONTEXT_MAX_WORKSPACES,
	createAlertContextRegistry,
} from "./push-context";
import type { HostDbReader, HostTerminalRow } from "./read-api";

interface Line {
	message: string;
	fields?: Record<string, unknown>;
}

function setup(
	placement: Record<string, string | null> = { "terminal-1": "workspace-1" },
) {
	const infos: Line[] = [];
	const errors: Line[] = [];
	const logger: BridgeLogger = {
		info: (message, fields) => infos.push({ message, fields }),
		warn: () => {},
		error: (message, fields) => errors.push({ message, fields }),
	};
	const db = {
		listTerminalIdsForWorkspace: (workspaceId: string): string[] =>
			Object.entries(placement)
				.filter(([, owner]) => owner === workspaceId)
				.map(([terminalId]) => terminalId),
		findTerminal: (id: string): HostTerminalRow | null => {
			if (!(id in placement)) return null;
			return {
				id,
				originWorkspaceId: placement[id] ?? null,
				status: "active",
				createdAt: 1,
				lastAttachedAt: null,
				endedAt: null,
			};
		},
	} as unknown as HostDbReader;
	return {
		registry: createAlertContextRegistry({ db, logger }),
		infos,
		errors,
		place: (terminalId: string, workspaceId: string | null) => {
			placement[terminalId] = workspaceId;
		},
	};
}

describe("(ALERT-CONTEXT-NAMES) alert context registry", () => {
	it("answers with the title a terminal was synced with", () => {
		const { registry } = setup();
		registry.sync({
			hostWorkspaceId: "workspace-1",
			tabCount: 3,
			terminals: [{ terminalId: "terminal-1", tabTitle: "Claude Resume" }],
		});
		expect(registry.lookup("workspace-1", "terminal-1")).toEqual({
			tabTitle: "Claude Resume",
			tabCount: 3,
		});
	});

	it("answers null for a workspace or terminal it has never seen", () => {
		const { registry } = setup();
		expect(registry.lookup("workspace-1", "terminal-1")).toBeNull();
		registry.sync({
			hostWorkspaceId: "workspace-1",
			tabCount: 1,
			terminals: [{ terminalId: "terminal-1", tabTitle: "A" }],
		});
		expect(registry.lookup("workspace-1", "terminal-9")).toBeNull();
		expect(registry.lookup("workspace-9", "terminal-1")).toBeNull();
	});

	it("REPLACES a workspace rather than merging into it", () => {
		const { registry, place } = setup();
		place("terminal-2", "workspace-1");
		registry.sync({
			hostWorkspaceId: "workspace-1",
			tabCount: 2,
			terminals: [
				{ terminalId: "terminal-1", tabTitle: "A" },
				{ terminalId: "terminal-2", tabTitle: "B" },
			],
		});
		registry.sync({
			hostWorkspaceId: "workspace-1",
			tabCount: 1,
			terminals: [{ terminalId: "terminal-2", tabTitle: "B" }],
		});
		// terminal-1's pane was closed. Merging would keep naming a tab that is
		// no longer open.
		expect(registry.lookup("workspace-1", "terminal-1")).toBeNull();
		expect(registry.lookup("workspace-1", "terminal-2")).toEqual({
			tabTitle: "B",
			tabCount: 1,
		});
	});

	it("EVICTS on an empty terminal list", () => {
		const { registry } = setup();
		registry.sync({
			hostWorkspaceId: "workspace-1",
			tabCount: 1,
			terminals: [{ terminalId: "terminal-1", tabTitle: "A" }],
		});
		const result = registry.sync({
			hostWorkspaceId: "workspace-1",
			tabCount: 0,
			terminals: [],
		});
		expect(result.outcome).toBe("evicted");
		expect(registry.lookup("workspace-1", "terminal-1")).toBeNull();
	});

	it("REFUSES a terminal host.db does not place in that workspace", () => {
		const { registry, place } = setup();
		place("terminal-2", "workspace-OTHER");
		const result = registry.sync({
			hostWorkspaceId: "workspace-1",
			tabCount: 2,
			terminals: [
				{ terminalId: "terminal-1", tabTitle: "mine" },
				{ terminalId: "terminal-2", tabTitle: "somebody elses" },
			],
		});
		expect(result.rejectedTerminals).toBe(1);
		expect(registry.lookup("workspace-1", "terminal-2")).toBeNull();
		expect(registry.lookup("workspace-1", "terminal-1")).not.toBeNull();
	});

	it("REFUSES a terminal host.db has never heard of", () => {
		const { registry } = setup();
		const result = registry.sync({
			hostWorkspaceId: "workspace-1",
			tabCount: 1,
			terminals: [{ terminalId: "ghost", tabTitle: "A" }],
		});
		expect(result.outcome).toBe("unknown-workspace");
		expect(registry.lookup("workspace-1", "ghost")).toBeNull();
	});

	it("drops the title when one snapshot claims two DIFFERENT titles", () => {
		const { registry, infos } = setup();
		const result = registry.sync({
			hostWorkspaceId: "workspace-1",
			tabCount: 2,
			terminals: [
				{ terminalId: "terminal-1", tabTitle: "left" },
				{ terminalId: "terminal-1", tabTitle: "right" },
			],
		});
		expect(result.ambiguousTitles).toBe(1);
		expect(registry.lookup("workspace-1", "terminal-1")).toEqual({
			tabTitle: "",
			tabCount: 2,
		});
		// Ids only — never the titles that disagreed.
		const line = infos.find((entry) =>
			entry.message.includes("appeared twice"),
		);
		expect(line).toBeDefined();
		expect(JSON.stringify(line?.fields)).not.toContain("left");
		expect(JSON.stringify(line?.fields)).not.toContain("right");
	});

	it("keeps the title when the same terminal appears twice with the SAME title", () => {
		const { registry } = setup();
		registry.sync({
			hostWorkspaceId: "workspace-1",
			tabCount: 2,
			terminals: [
				{ terminalId: "terminal-1", tabTitle: "same" },
				{ terminalId: "terminal-1", tabTitle: "same" },
			],
		});
		expect(registry.lookup("workspace-1", "terminal-1")?.tabTitle).toBe("same");
	});

	it("refuses a whole snapshot over the terminal cap rather than truncating", () => {
		const placement: Record<string, string> = {};
		const terminals = [];
		for (let i = 0; i <= ALERT_CONTEXT_MAX_TERMINALS_PER_WORKSPACE; i++) {
			placement[`t-${i}`] = "workspace-1";
			terminals.push({ terminalId: `t-${i}`, tabTitle: "A" });
		}
		const { registry, errors } = setup(placement);
		const result = registry.sync({
			hostWorkspaceId: "workspace-1",
			tabCount: 1,
			terminals,
		});
		expect(result.outcome).toBe("too-many-terminals");
		// A half-applied snapshot would mislabel whichever terminals fell off.
		expect(registry.lookup("workspace-1", "t-0")).toBeNull();
		expect(errors.length).toBeGreaterThan(0);
	});

	it("refuses an implausible tab count", () => {
		const { registry } = setup();
		for (const tabCount of [-1, 1.5, 10_000]) {
			expect(
				registry.sync({
					hostWorkspaceId: "workspace-1",
					tabCount,
					terminals: [{ terminalId: "terminal-1", tabTitle: "A" }],
				}).outcome,
			).toBe("bad-tab-count");
		}
		expect(registry.lookup("workspace-1", "terminal-1")).toBeNull();
	});

	it("evicts OLDEST-FIRST past its workspace bound, and a re-sync counts as young", () => {
		const placement: Record<string, string> = {};
		for (let i = 0; i <= ALERT_CONTEXT_MAX_WORKSPACES; i++) {
			placement[`t-${i}`] = `w-${i}`;
		}
		const { registry } = setup(placement);
		for (let i = 0; i < ALERT_CONTEXT_MAX_WORKSPACES; i++) {
			registry.sync({
				hostWorkspaceId: `w-${i}`,
				tabCount: 1,
				terminals: [{ terminalId: `t-${i}`, tabTitle: "A" }],
			});
		}
		// Touch the oldest so it is no longer the oldest.
		registry.sync({
			hostWorkspaceId: "w-0",
			tabCount: 2,
			terminals: [{ terminalId: "t-0", tabTitle: "A" }],
		});
		registry.sync({
			hostWorkspaceId: `w-${ALERT_CONTEXT_MAX_WORKSPACES}`,
			tabCount: 1,
			terminals: [
				{ terminalId: `t-${ALERT_CONTEXT_MAX_WORKSPACES}`, tabTitle: "A" },
			],
		});
		expect(registry.inspect().workspaces).toBe(ALERT_CONTEXT_MAX_WORKSPACES);
		expect(registry.lookup("w-0", "t-0")).not.toBeNull();
		expect(registry.lookup("w-1", "t-1")).toBeNull();
	});

	it("keeps NOTHING after clear — a stopped bridge has no context", () => {
		const { registry } = setup();
		registry.sync({
			hostWorkspaceId: "workspace-1",
			tabCount: 1,
			terminals: [{ terminalId: "terminal-1", tabTitle: "A" }],
		});
		registry.clear();
		expect(registry.inspect()).toEqual({ workspaces: 0, terminals: 0 });
		expect(registry.lookup("workspace-1", "terminal-1")).toBeNull();
	});

	it("never puts a title into a log line", () => {
		const { registry, infos, errors } = setup();
		registry.sync({
			hostWorkspaceId: "workspace-1",
			tabCount: 1,
			terminals: [
				{ terminalId: "terminal-1", tabTitle: "SECRET-TAB-TITLE" },
				{ terminalId: "ghost", tabTitle: "SECRET-TAB-TITLE" },
			],
		});
		const logged = JSON.stringify([...infos, ...errors]);
		expect(logged).not.toContain("SECRET-TAB-TITLE");
	});

	it("refuses to be built without a db reader", () => {
		expect(() =>
			createAlertContextRegistry({
				db: null as unknown as HostDbReader,
				logger: { info: () => {}, warn: () => {}, error: () => {} },
			}),
		).toThrow(/host\.db reader/);
	});
});
