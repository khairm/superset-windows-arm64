import { beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
	askqMarkerRoot,
	withFakeHome,
} from "../../test/helpers/askq-markers";
import type { EventBus } from "../events/event-bus";
import type { TerminalAgentBinding, TerminalAgentStore } from "./index";
import {
	evaluateStaleWorkingBinding,
	startStaleWorkingSweep,
} from "./stale-working-sweep";

// (STALE-WORKING-SWEEP) The sweep reads the same on-disk marker truth the
// Python notify hook maintains, all rooted at homedir() — redirected per test
// by the shared fake-home helper so nothing touches the developer's own
// ~/.superset.

const TERMINAL_ID = "terminal-stale-sweep";
const STALE_MS = 30 * 60_000;

const fakeHome = withFakeHome("stale-sweep-");
let home = "";

function markerRoot(): string {
	return askqMarkerRoot(home);
}

function evaluate() {
	return evaluateStaleWorkingBinding({
		terminalId: TERMINAL_ID,
		agentSessionId: "session-stale-sweep",
		staleAfterMs: STALE_MS,
	});
}

beforeEach(async () => {
	home = await fakeHome();
	fs.mkdirSync(markerRoot(), { recursive: true });
	// (SENTINEL-HOLD) the sweep requires the hook's recorded turn end; every
	// test that expects a finalization runs against a stuck-hold shape.
	fs.writeFileSync(path.join(markerRoot(), `${TERMINAL_ID}.mainstopped`), "");
});

describe("evaluateStaleWorkingBinding", () => {
	it("finalizes green when no hold marker is live", async () => {
		expect(await evaluate()).toMatchObject({ eventType: "Stop" });
	});

	it("refuses to finalize without the recorded turn-end sentinel", async () => {
		// A main loop deep inside one long quiet stretch (usage-limit wait,
		// long MCP call) writes no marker at all — silence alone must not green.
		fs.rmSync(path.join(markerRoot(), `${TERMINAL_ID}.mainstopped`));
		expect(await evaluate()).toBeNull();
	});

	it("never touches a terminal with a pending question", async () => {
		const askq = path.join(markerRoot(), `${TERMINAL_ID}.askq`);
		fs.mkdirSync(askq, { recursive: true });
		fs.writeFileSync(path.join(askq, "_main"), "");
		expect(await evaluate()).toBeNull();
	});

	it("keeps a hold while .bgactive is fresh, releases once it is stale", async () => {
		const bgActive = path.join(markerRoot(), `${TERMINAL_ID}.bgactive`);
		fs.writeFileSync(bgActive, "");
		expect(await evaluate()).toBeNull();

		const stale = new Date(Date.now() - STALE_MS - 60_000);
		fs.utimesSync(bgActive, stale, stale);
		expect(await evaluate()).toMatchObject({ eventType: "Stop" });
	});

	it("honors a run-dir subagent marker for the hook's full 12h window", async () => {
		// A subagent inside ONE long tool call refreshes nothing; the hook's
		// own 12h marker boundary is the only safe expiry.
		const runDir = path.join(markerRoot(), TERMINAL_ID);
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(path.join(runDir, "agent-1"), "");
		expect(await evaluate()).toBeNull();

		const pastStale = new Date(Date.now() - STALE_MS - 60_000);
		fs.utimesSync(path.join(runDir, "agent-1"), pastStale, pastStale);
		expect(await evaluate()).toBeNull();

		const pastMarkerWindow = new Date(Date.now() - 13 * 60 * 60_000);
		fs.utimesSync(path.join(runDir, "agent-1"), pastMarkerWindow, pastMarkerWindow);
		expect(await evaluate()).toMatchObject({ eventType: "Stop" });
	});

	it("holds while a compaction marker is live", async () => {
		const compacting = path.join(markerRoot(), `${TERMINAL_ID}.compacting`);
		fs.writeFileSync(compacting, "manual");
		expect(await evaluate()).toBeNull();

		const leaked = new Date(Date.now() - 3 * 60 * 60_000);
		fs.utimesSync(compacting, leaked, leaked);
		expect(await evaluate()).toMatchObject({ eventType: "Stop" });
	});

	it("returns a Failed verdict for a parked deferred failure WITHOUT consuming the marker", async () => {
		// Evaluation is read-only: the commit path consumes the marker only
		// after the re-read guard, so a racing event can never lose the abort.
		const pending = path.join(markerRoot(), `${TERMINAL_ID}.pendingfailure`);
		fs.writeFileSync(pending, "");
		expect(await evaluate()).toMatchObject({
			eventType: "Failed",
			pendingFailurePath: pending,
		});
		expect(fs.existsSync(pending)).toBe(true);
	});

	it("refuses an unsafe terminal id outright", async () => {
		expect(
			await evaluateStaleWorkingBinding({
				terminalId: "../escape",
				staleAfterMs: STALE_MS,
			}),
		).toBeNull();
	});
});

describe("startStaleWorkingSweep", () => {
	function staleBinding(): TerminalAgentBinding {
		const staleAt = Date.now() - STALE_MS - 60_000;
		return {
			agentId: "claude" as TerminalAgentBinding["agentId"],
			agentSessionId: "session-stale-sweep",
			lastEventAt: staleAt,
			lastEventType: "SubagentActive",
			startedAt: staleAt,
			terminalId: TERMINAL_ID,
			workspaceId: "workspace-1",
		};
	}

	/** Runs the sweep against one fake binding and collects what it emitted. */
	async function runSweepOnce(
		binding: TerminalAgentBinding,
		options?: { onRecord?: () => void },
	): Promise<{
		broadcast: Array<{ eventType: string; terminalId: string }>;
		recorded: Array<{ eventType: string }>;
	}> {
		const broadcast: Array<{ eventType: string; terminalId: string }> = [];
		const recorded: Array<{ eventType: string }> = [];
		const store = {
			get: (terminalId: string) =>
				terminalId === binding.terminalId ? binding : undefined,
			list: () => [binding],
			recordEvent: (input: { eventType: string }) => {
				options?.onRecord?.();
				recorded.push(input);
			},
		} as unknown as TerminalAgentStore;
		const eventBus = {
			broadcastAgentLifecycle: (message: {
				eventType: string;
				terminalId: string;
			}) => {
				broadcast.push(message);
			},
		} as unknown as EventBus;

		const stop = startStaleWorkingSweep(store, eventBus, {
			intervalMs: 20,
			staleAfterMs: STALE_MS,
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 250));
		} finally {
			stop();
		}
		return { broadcast, recorded };
	}

	it("finalizes a stale working binding through the bus and the store", async () => {
		const { broadcast, recorded } = await runSweepOnce(staleBinding());

		expect(broadcast).toContainEqual(
			expect.objectContaining({ eventType: "Stop", terminalId: TERMINAL_ID }),
		);
		expect(recorded).toContainEqual(
			expect.objectContaining({ eventType: "Stop" }),
		);
		const logPath = path.join(home, ".superset", "logs", "dot-decisions.log");
		expect(fs.readFileSync(logPath, "utf8")).toContain("STALE-SWEEP GREEN");
	});

	it("commits a Failed release and consumes the pending-failure marker", async () => {
		const pending = path.join(markerRoot(), `${TERMINAL_ID}.pendingfailure`);
		fs.writeFileSync(pending, "");

		const { broadcast } = await runSweepOnce(staleBinding());

		expect(broadcast).toContainEqual(
			expect.objectContaining({ eventType: "Failed" }),
		);
		expect(fs.existsSync(pending)).toBe(false);
	});

	it("leaves a fresh working binding alone", async () => {
		const binding = { ...staleBinding(), lastEventAt: Date.now() };
		const { broadcast } = await runSweepOnce(binding, {
			onRecord: () => {
				throw new Error("must not record for a fresh binding");
			},
		});
		expect(broadcast).toHaveLength(0);
	});
});
