import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	createLifecycleAlertManager,
	createLifecycleCurationProbe,
	type LifecycleAlertManager,
	MAX_STATE_ENTRIES,
} from "./lifecycle-alerts";
import type { PushAlertContext } from "./push-context";
import type { HostDbReader } from "./read-api";

const HANDLE = "w".repeat(22);
const TERMINAL_HANDLE = "t".repeat(22);

/** A fresh 22-char base64url producer id per hook event, as the hook mints. */
let producerSeq = 0;
const producerEventId = () => {
	producerSeq += 1;
	return producerSeq.toString().padStart(22, "p");
};

interface LogLine {
	message: string;
	fields?: Record<string, unknown>;
}

function setup(
	options: {
		present?: boolean;
		/**
		 * (ONE-BUZZ-UNTIL-READ) The manager's own start instant. Defaults to the
		 * clock's first reading; a test that models a restart inside a wall-clock
		 * BACKSTEP starts it behind the generations already on the phone.
		 */
		startAtMs?: number;
		/**
		 * (ONE-BUZZ-UNTIL-READ) What host.db says each terminal's last lifecycle
		 * instant was when this manager started. `null` = no restart evidence at
		 * all, which disables proof-of-absence outright.
		 */
		proofEpochs?: Array<[string, number]> | null;
		readySettleMs?: number;
		/** Model a host.db read that fails at bridge start. */
		epochThrows?: boolean;
	} = {},
) {
	let now = options.startAtMs ?? 1_000;
	let present = options.present ?? false;
	/** Set to reject the next send; cleared by the test when it wants success. */
	let failSends = false;
	/** When set, a send parks on this promise instead of resolving. */
	let gate: Promise<void> | null = null;
	const sent: Array<{ kind: string; alertId: string }> = [];
	const retracted: string[] = [];
	/**
	 * (ONE-BUZZ-UNTIL-READ) The full frames, kept beside the id-only arrays the
	 * older assertions read: `gx` and the handle are what make a retraction name
	 * ONE finish rather than whatever card the phone happens to be showing.
	 */
	const sends: Array<{
		kind: string;
		alertId: string;
		terminalHandle: string;
		outcomeAtMs: number;
	}> = [];
	const retractions: Array<{
		alertId: string;
		terminalHandle: string;
		outcomeAtMs: number;
	}> = [];
	const errors: LogLine[] = [];
	const infos: LogLine[] = [];
	/** (ALERT-CONTEXT-NAMES) What the injected resolver answers, per test. */
	let context: PushAlertContext | null = null;
	/** Every context the manager asked for, in order — retry freshness proof. */
	const contextCalls: Array<{ hostTerminalId: string }> = [];
	/** (ALERT-RETIRE-ON-EXIT) What the injected curation read answers, per test. */
	let curatedOff: (hostWorkspaceId: string) => boolean = () => false;
	/** One entry per retirement walk: the workspaces it asked about, in order. */
	const curationAsks: string[][] = [];
	const manager = createLifecycleAlertManager({
		presence: {
			present: () => ({
				present,
				reason: present ? "keystroke" : "no-signal",
				humanInputAgeMs: null,
				beaconAgeMs: null,
				idleSeconds: null,
				locked: null,
			}),
		},
		push: {
			sendLifecycleAlert: async (input) => {
				sent.push({ kind: input.kind, alertId: input.alertId });
				sends.push({
					kind: input.kind,
					alertId: input.alertId,
					terminalHandle: input.terminalHandle,
					outcomeAtMs: input.outcomeAtMs,
				});
				if (gate !== null) await gate;
				if (failSends) throw new Error("fcm refused every device");
			},
			sendLifecycleRetraction: async (input) => {
				retracted.push(input.alertId);
				retractions.push({
					alertId: input.alertId,
					terminalHandle: input.terminalHandle,
					outcomeAtMs: input.outcomeAtMs,
				});
			},
		},
		workspaceHandle: () => HANDLE,
		terminalHandle: () => TERMINAL_HANDLE,
		readySettleMs: options.readySettleMs ?? 0,
		resolveContext: (input) => {
			contextCalls.push({ hostTerminalId: input.hostTerminalId });
			return context;
		},
		proofEpochs:
			options.proofEpochs === null
				? null
				: () => {
						if (options.epochThrows) throw new Error("host.db is locked");
						return (options.proofEpochs ?? []).map(
							([hostTerminalId, lastEventAtMs]) => ({
								hostTerminalId,
								lastEventAtMs,
							}),
						);
					},
		isCuratedOff: () => false,
		/**
		 * (ALERT-RETIRE-ON-EXIT) The fresh curation read, as a test seam. It
		 * records what it was asked so a test can prove the walk asked ONCE for
		 * the whole live set rather than once per workspace.
		 */
		curatedOffAmong: (hostWorkspaceIds) => {
			curationAsks.push([...hostWorkspaceIds]);
			return new Set(hostWorkspaceIds.filter((id) => curatedOff(id)));
		},
		logger: {
			info: (message, fields) => infos.push({ message, fields }),
			warn: () => {},
			error: (message, fields) => errors.push({ message, fields }),
		},
		now: () => now,
	});
	liveManagers.push(manager);
	return {
		manager,
		sent,
		retracted,
		sends,
		retractions,
		contextCalls,
		errors,
		infos,
		setNow: (value: number) => (now = value),
		setPresent: (value: boolean) => (present = value),
		setFailSends: (value: boolean) => (failSends = value),
		setGate: (value: Promise<void> | null) => (gate = value),
		setContext: (value: PushAlertContext | null) => (context = value),
		curationAsks,
		setCuratedOff: (value: (hostWorkspaceId: string) => boolean) =>
			(curatedOff = value),
	};
}

/**
 * Every manager a test made, stopped after it. A manager left running keeps a
 * 2 s sweep timer alive for the rest of the file, and 34 hand-written `stop()`
 * calls is 34 chances to forget one.
 */
const liveManagers: LifecycleAlertManager[] = [];

afterEach(() => {
	for (const manager of liveManagers) manager.stop();
	liveManagers.length = 0;
});

function event(overrides: Record<string, unknown> = {}) {
	return {
		producerEventId: producerEventId(),
		outcome: "progress" as const,
		eventType: "Start",
		hostTerminalId: "terminal-1",
		hostWorkspaceId: "workspace-1",
		occurredAtMs: 1_000,
		previousEventType: null,
		previousEventAtMs: null,
		...overrides,
	};
}

/** One completed work cycle: Start at `armedAtMs`, clean Stop after it. */
function cycle(armedAtMs: number, overrides: Record<string, unknown> = {}) {
	return [
		event({ occurredAtMs: armedAtMs, ...overrides }),
		event({
			outcome: "ready",
			eventType: "Stop",
			occurredAtMs: armedAtMs + 1_000,
			previousEventType: "Start",
			previousEventAtMs: armedAtMs,
			...overrides,
		}),
	];
}

/** One cycle that DIES: Start at `armedAtMs`, StopFailure after it. */
function failedCycle(
	armedAtMs: number,
	overrides: Record<string, unknown> = {},
) {
	return [
		event({ occurredAtMs: armedAtMs, ...overrides }),
		event({
			outcome: "failed",
			eventType: "StopFailure",
			occurredAtMs: armedAtMs + 1_000,
			previousEventType: "Start",
			previousEventAtMs: armedAtMs,
			...overrides,
		}),
	];
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** One sweep interval (2 s) plus slack. */
const sweep = () => new Promise((resolve) => setTimeout(resolve, 2_200));

describe("lifecycle alerts", () => {
	it("alerts once for Start then clean Stop and rearms for the next cycle", async () => {
		const state = setup();
		state.manager.record(event());
		state.manager.record(
			event({
				outcome: "ready",
				eventType: "Stop",
				occurredAtMs: 2_000,
				previousEventType: "Start",
				previousEventAtMs: 1_000,
			}),
		);
		state.manager.record(
			event({
				outcome: "ready",
				eventType: "Stop",
				occurredAtMs: 2_100,
				previousEventType: "Stop",
				previousEventAtMs: 2_000,
			}),
		);
		await tick();
		expect(state.sent).toHaveLength(1);
		expect(state.sent[0]?.kind).toBe("g");

		state.setNow(3_000);
		state.manager.record(event({ occurredAtMs: 3_000 }));
		state.manager.record(
			event({
				outcome: "ready",
				eventType: "Stop",
				occurredAtMs: 4_000,
				previousEventType: "Start",
				previousEventAtMs: 3_000,
			}),
		);
		await tick();
		expect(state.sent).toHaveLength(2);
		expect(state.sent[0]?.alertId).not.toBe(state.sent[1]?.alertId);
		// PROTOCOL.md §0.1: 16 digest bytes, base64url, 22 chars.
		for (const row of state.sent) {
			const bytes = Buffer.from(row.alertId, "base64url");
			expect(bytes).toHaveLength(16);
			expect(bytes.toString("base64url")).toBe(row.alertId);
		}
	});

	it("turns a deferred failure into error, never ready", async () => {
		const state = setup();
		state.manager.record(event());
		state.manager.record(
			event({ outcome: "hold", eventType: "SubagentActive" }),
		);
		state.manager.record(
			event({
				outcome: "failed",
				eventType: "Failed",
				occurredAtMs: 2_000,
				previousEventType: "SubagentActive",
				previousEventAtMs: 1_500,
			}),
		);
		await tick();
		expect(state.sent.map((row) => row.kind)).toEqual(["e"]);
	});

	it("holds while present and releases after presence changes", async () => {
		const state = setup({ present: true });
		state.manager.record(event());
		state.manager.record(
			event({
				outcome: "ready",
				eventType: "Stop",
				occurredAtMs: 2_000,
				previousEventType: "Start",
				previousEventAtMs: 1_000,
			}),
		);
		await tick();
		expect(state.sent).toEqual([]);
		state.setPresent(false);
		await sweep();
		expect(state.sent).toHaveLength(1);
	});

	it("cancels a held alert when the terminal starts working again", async () => {
		// The desk-session burst: alerts pile up while the user is at the keyboard,
		// each one about a cycle the NEXT cycle already superseded, and all of them
		// fire the moment they walk away.
		const state = setup({ present: true });
		for (const step of cycle(1_000)) state.manager.record(step);
		await tick();
		expect(state.sent).toEqual([]);

		// A new cycle starts on the same terminal.
		state.setNow(5_000);
		state.manager.record(event({ occurredAtMs: 5_000 }));
		state.setPresent(false);
		await sweep();
		expect(state.sent).toEqual([]);
		expect(
			state.infos.some((line) => line.message.includes("cancelled a held")),
		).toBe(true);

		// The NEW cycle's own ending still alerts.
		state.manager.record(
			event({
				outcome: "ready",
				eventType: "Stop",
				occurredAtMs: 6_000,
				previousEventType: "Start",
				previousEventAtMs: 5_000,
			}),
		);
		await tick();
		expect(state.sent).toHaveLength(1);
	});

	it("cancels a held alert when the session ends", async () => {
		const state = setup({ present: true });
		for (const step of cycle(1_000)) state.manager.record(step);
		await tick();
		expect(state.sent).toEqual([]);

		state.manager.record(
			event({
				outcome: "session-end",
				eventType: "Detached",
				occurredAtMs: 5_000,
			}),
		);
		state.setPresent(false);
		await sweep();
		expect(state.sent).toEqual([]);
	});

	it("leaves another terminal's held alert alone", async () => {
		const state = setup({ present: true });
		for (const step of cycle(1_000, { hostTerminalId: "terminal-2" })) {
			state.manager.record(step);
		}
		state.manager.record(event({ occurredAtMs: 5_000 }));
		state.setPresent(false);
		await sweep();
		expect(state.sent).toHaveLength(1);
	});

	it("alerts on a failure that lands on a blocked terminal, but never a ready", async () => {
		const failed = setup();
		failed.manager.record(
			event({
				outcome: "failed",
				eventType: "Failed",
				occurredAtMs: 2_000,
				previousEventType: "PermissionRequest",
				previousEventAtMs: 1_500,
			}),
		);
		await tick();
		expect(failed.sent.map((row) => row.kind)).toEqual(["e"]);

		// Answering a prompt and ending the turn is not fresh completed work.
		const ready = setup();
		ready.manager.record(
			event({
				outcome: "ready",
				eventType: "Stop",
				occurredAtMs: 2_000,
				previousEventType: "PermissionRequest",
				previousEventAtMs: 1_500,
			}),
		);
		await tick();
		expect(ready.sent).toEqual([]);
	});

	it("never sends the same alert twice when a sweep overlaps an in-flight send", async () => {
		const state = setup();
		let release = () => {};
		state.setGate(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		for (const step of cycle(1_000)) state.manager.record(step);
		await tick();
		expect(state.sent).toHaveLength(1);

		// Sweeps keep running while the broadcast is parked. A sweep that re-read
		// its own stale snapshot instead of the map would send this alert again.
		await sweep();
		expect(state.sent).toHaveLength(1);
		release();
		await tick();
		expect(state.sent).toHaveLength(1);
	});

	it("holds a failed delivery and retries it inside the TTL", async () => {
		const state = setup();
		state.setFailSends(true);
		for (const step of cycle(1_000)) state.manager.record(step);
		await tick();
		expect(state.sent).toHaveLength(1);
		expect(
			state.errors.some((line) =>
				line.message.includes("could not send lifecycle alert"),
			),
		).toBe(true);

		// The retry backoff is 30 s; the sweep before it must not re-send.
		await sweep();
		expect(state.sent).toHaveLength(1);

		state.setFailSends(false);
		state.setNow(1_000 + 60_000);
		await sweep();
		expect(state.sent).toHaveLength(2);
		expect(state.sent[0]?.alertId).toBe(state.sent[1]?.alertId ?? "");
	});

	it("applies a re-delivered hook event exactly once", async () => {
		const state = setup();
		const start = event({ occurredAtMs: 1_000 });
		const stop = event({
			outcome: "ready",
			eventType: "Stop",
			occurredAtMs: 2_000,
			previousEventType: "Start",
			previousEventAtMs: 1_000,
		});
		state.manager.record(start);
		state.manager.record(stop);
		await tick();
		expect(state.sent).toHaveLength(1);

		// The SAME hook event delivered again, after the terminal moved on, so its
		// previous-event stamp no longer matches: the alert id cannot dedupe it and
		// only the producer id can.
		state.manager.record(event({ occurredAtMs: 3_000 }));
		state.manager.record({ ...stop, previousEventAtMs: 3_000 });
		await tick();
		expect(state.sent).toHaveLength(1);
		expect(
			state.infos.some((line) => line.message.includes("duplicate lifecycle")),
		).toBe(true);
	});
});

describe("ready alert settle window", () => {
	const SETTLE_MS = 10_000;

	it("sends only after ten continuous seconds of ready", async () => {
		const state = setup({ readySettleMs: SETTLE_MS });
		for (const step of cycle(1_000)) state.manager.record(step);

		state.setNow(10_999);
		await sweep();
		expect(state.sent).toHaveLength(0);

		state.setNow(11_000);
		await sweep();
		expect(state.sent).toHaveLength(1);
	});

	it("sends failure alerts immediately", async () => {
		const state = setup({ readySettleMs: SETTLE_MS });
		for (const step of failedCycle(1_000)) state.manager.record(step);
		await tick();
		expect(state.sent.map((alert) => alert.kind)).toEqual(["e"]);
	});

	it("cancels settling ready alerts for every working or blocked status", async () => {
		const state = setup({ readySettleMs: SETTLE_MS });
		const eventTypes = [
			"Start",
			"SubagentActive",
			"BackgroundRunning",
			"PermissionRequest",
			"Failed",
		];
		for (const [index, eventType] of eventTypes.entries()) {
			const hostTerminalId = `terminal-${index}`;
			for (const step of cycle(1_000, { hostTerminalId })) {
				state.manager.record(step);
			}
			state.manager.observeStatus(hostTerminalId, eventType);
		}

		state.setNow(11_000);
		await sweep();
		expect(state.sent).toHaveLength(0);
		expect(state.retracted).toHaveLength(0);
	});

	it("cancels the first Stop on SubagentActive and sends only after the second window", async () => {
		const state = setup({ readySettleMs: SETTLE_MS });
		for (const step of cycle(1_000)) state.manager.record(step);

		state.setNow(2_000);
		state.manager.observeStatus("terminal-1", "SubagentActive");
		state.manager.record(
			event({
				outcome: "ready",
				eventType: "Stop",
				occurredAtMs: 3_000,
				previousEventType: "SubagentActive",
				previousEventAtMs: 2_500,
			}),
		);

		state.setNow(11_000);
		await sweep();
		expect(state.sent).toHaveLength(0);
		expect(state.retracted).toHaveLength(0);
		state.setNow(12_000);
		await sweep();
		expect(state.sent).toHaveLength(1);
	});

	it("does not reset the window for a repeated Stop", async () => {
		const state = setup({ readySettleMs: SETTLE_MS });
		for (const step of cycle(1_000)) state.manager.record(step);

		state.setNow(2_000);
		state.manager.observeStatus("terminal-1", "Stop");
		state.manager.record(
			event({
				outcome: "ready",
				eventType: "Stop",
				occurredAtMs: 3_000,
				previousEventType: "Stop",
				previousEventAtMs: 2_000,
			}),
		);

		state.setNow(11_000);
		await sweep();
		expect(state.sent).toHaveLength(1);
	});

	it("does not re-enter settling after the deadline when the clock steps back", async () => {
		const state = setup({ present: true, readySettleMs: SETTLE_MS });
		for (const step of cycle(1_000)) state.manager.record(step);

		state.setNow(11_000);
		await sweep();
		expect(state.sent).toHaveLength(0);

		state.setNow(5_000);
		state.manager.observeStatus("terminal-1", "PermissionRequest");
		state.setPresent(false);
		state.setNow(12_000);
		await sweep();
		expect(state.sent).toHaveLength(1);
	});

	it("keeps a zero-window presence hold through a clock backstep", async () => {
		const state = setup({ present: true, readySettleMs: 0 });
		for (const step of cycle(1_000)) state.manager.record(step);
		await tick();
		expect(state.sent).toHaveLength(0);

		state.setNow(500);
		state.manager.observeStatus("terminal-1", "PermissionRequest");
		state.setPresent(false);
		state.setNow(1_000);
		await sweep();
		expect(state.sent).toHaveLength(1);
	});

	it("retires a settling alert when the lifecycle is marked seen", async () => {
		const state = setup({ readySettleMs: SETTLE_MS, proofEpochs: null });
		for (const step of cycle(1_000)) state.manager.record(step);
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 2_000,
		});

		state.setNow(11_000);
		await sweep();
		expect(state.sent).toHaveLength(0);
		expect(state.retracted).toHaveLength(0);
	});

	it("retires a settling alert when its terminal exits", async () => {
		const state = setup({ readySettleMs: SETTLE_MS });
		for (const step of cycle(1_000)) state.manager.record(step);
		state.manager.retireTerminal("terminal-1");

		state.setNow(11_000);
		await sweep();
		expect(state.sent).toHaveLength(0);
	});

	it("keeps the strict retireReadyBefore boundary for a settling alert", async () => {
		const state = setup({ readySettleMs: SETTLE_MS });
		for (const step of cycle(1_000)) state.manager.record(step);
		expect(state.manager.retireReadyBefore(2_000)).toBe(0);

		state.setNow(11_000);
		await sweep();
		expect(state.sent).toHaveLength(1);
	});

	it("cleans up a settling alert when stopped", async () => {
		const state = setup({ readySettleMs: SETTLE_MS });
		for (const step of cycle(1_000)) state.manager.record(step);
		state.manager.stop();

		state.setNow(11_000);
		await sweep();
		expect(state.sent).toHaveLength(0);
	});

	it("keeps settling through Stop and Attached status observations", async () => {
		const state = setup({ readySettleMs: SETTLE_MS });
		for (const step of cycle(1_000)) state.manager.record(step);
		state.manager.observeStatus("terminal-1", "Stop");
		state.manager.observeStatus("terminal-1", "Attached");

		state.setNow(11_000);
		await sweep();
		expect(state.sent).toHaveLength(1);
	});

	it("rejects a settle window that could never become due", () => {
		expect(() => setup({ readySettleMs: Number.NaN })).toThrow(
			"readySettleMs must be a finite non-negative number",
		);
		expect(() => setup({ readySettleMs: -1 })).toThrow(
			"readySettleMs must be a finite non-negative number",
		);
	});
});

describe("lifecycle curation probe", () => {
	const ORG = "org-1";
	const PROBE_NOW = 1_700_000_000_000;

	/** A reader over a one-workspace mirror that counts how often it is read. */
	function db(options: { hidden: boolean }) {
		let mirrorReads = 0;
		const reader: Pick<HostDbReader, "readSidebarMirror" | "findWorkspace"> = {
			readSidebarMirror: () => {
				mirrorReads += 1;
				return {
					meta: {
						lastFullSyncAtMs: PROBE_NOW - 1_000,
						appLaunchId: "launch-1",
						organizationId: ORG,
						workspaceCount: 1,
						projectCount: 1,
					},
					workspaces: [
						{
							workspaceId: "workspace-1",
							projectId: "project-1",
							isHidden: options.hidden,
							archivedAt: null,
							snoozeUntil: null,
							snoozeLaunchId: null,
							completedAt: null,
							deletedAt: null,
							pinnedAt: null,
							tabOrder: 0,
						},
					],
					projects: [
						{
							projectId: "project-1",
							tabOrder: 0,
							isPinned: false,
							isCollapsed: false,
						},
					],
				};
			},
			findWorkspace: () => ({
				id: "workspace-1",
				projectId: "project-1",
				name: "workspace-1",
				branch: "feature/x",
				worktreePath: "/tmp/workspace-1",
				type: "worktree",
				createdAt: PROBE_NOW - 10_000,
			}),
		};
		return { reads: () => mirrorReads, reader };
	}

	it("reads the mirror once per recheck window while a thread is off the sidebar", () => {
		const source = db({ hidden: true });
		let now = PROBE_NOW;
		const infos: LogLine[] = [];
		const probe = createLifecycleCurationProbe({
			db: source.reader as HostDbReader,
			organizationId: ORG,
			logger: {
				info: (message, fields) => infos.push({ message, fields }),
				warn: () => {},
				error: () => {},
			},
			now: () => now,
		});

		// 15 sweeps inside one 30 s recheck window: one read, one log line.
		for (let i = 0; i < 15; i++) {
			expect(probe("workspace-1")).toBe(true);
			now += 2_000;
		}
		expect(source.reads()).toBe(1);
		expect(infos).toHaveLength(1);

		// Past the window it re-reads, and the repeat episode is not logged again.
		now += 30_000;
		expect(probe("workspace-1")).toBe(true);
		expect(source.reads()).toBe(2);
		expect(infos).toHaveLength(1);
	});

	it("never caches a fire, and fires when the read throws", () => {
		const source = db({ hidden: false });
		const probe = createLifecycleCurationProbe({
			db: source.reader as HostDbReader,
			organizationId: ORG,
			logger: { info: () => {}, warn: () => {}, error: () => {} },
			now: () => PROBE_NOW,
		});
		expect(probe("workspace-1")).toBe(false);
		expect(probe("workspace-1")).toBe(false);
		expect(source.reads()).toBe(2);

		const errors: LogLine[] = [];
		const throwing = createLifecycleCurationProbe({
			db: {
				readSidebarMirror: () => {
					throw new Error("host.db is locked");
				},
				findWorkspace: () => null,
			} as unknown as HostDbReader,
			organizationId: ORG,
			logger: {
				info: () => {},
				warn: () => {},
				error: (message, fields) => errors.push({ message, fields }),
			},
			now: () => PROBE_NOW,
		});
		expect(throwing("workspace-1")).toBe(false);
		expect(errors).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// (ALERT-CONTEXT-NAMES)
// ---------------------------------------------------------------------------

/** The `g` id for one terminal's outcome instant, recomputed the way the host does. */
function readyAlertIdFor(occurredAtMs: number, hostTerminalId = "terminal-1") {
	return createHash("sha256")
		.update("sc/v2 lifecycle alert\0", "utf8")
		.update("g", "utf8")
		.update("\0", "utf8")
		.update(hostTerminalId, "utf8")
		.update("\0", "utf8")
		.update(String(occurredAtMs), "utf8")
		.digest()
		.subarray(0, 16)
		.toString("base64url");
}

describe("(ALERT-CONTEXT-NAMES) alert ids are recomputable from the outcome event", () => {
	it("mints the id a restarted host would derive from `seenThroughAt` alone", async () => {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(1);
		// The Stop landed at 2_000 — the FINAL outcome event, which is exactly the
		// binding `lastEventAt` the renderer marks seen through.
		expect(state.sent[0]?.alertId).toBe(readyAlertIdFor(2_000));
	});

	it("still collapses two POSTs about the same cycle onto one alert", async () => {
		const state = setup();
		const events = cycle(1_000);
		for (const e of events) state.manager.record(e);
		await tick();
		// Same cycle, same outcome instant, DIFFERENT producer id: the alert id
		// must still dedupe it.
		const stop = events[1];
		if (stop === undefined) throw new Error("cycle() must yield a stop event");
		state.manager.record({ ...stop, producerEventId: producerEventId() });
		await tick();
		expect(state.sent).toHaveLength(1);
	});

	it("still mints a fresh alert for the NEXT cycle", async () => {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		for (const e of cycle(5_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(2);
		expect(state.sent[0]?.alertId).not.toBe(state.sent[1]?.alertId);
	});
});

describe("(ALERT-CONTEXT-NAMES) retraction state machine", () => {
	/**
	 * (ONE-BUZZ-UNTIL-READ) THE OVERNIGHT CASE. Measured on v0.1.0: one chat
	 * finished sixteen times in a night, ~15 minutes apart, every time while the
	 * user was away — sixteen stacked buzzing notifications for one unread
	 * conversation. A new work cycle now retires the delivered alert SILENTLY:
	 * the notification stays on the handset and the next `g` for that terminal
	 * replaces it in place.
	 */
	it("does NOT retract a delivered ready alert when a new cycle starts", async () => {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(1);

		state.manager.record(event({ occurredAtMs: 3_000 }));
		await tick();
		expect(state.retracted).toHaveLength(0);

		// STORM GUARD, unchanged: everything after `retracted` is a no-op, however
		// much progress the terminal reports — and none of it buzzes either.
		for (let i = 0; i < 20; i++) {
			state.manager.record(event({ occurredAtMs: 4_000 + i }));
		}
		await tick();
		expect(state.retracted).toHaveLength(0);
		expect(state.sent).toHaveLength(1);
	});

	it("still buzzes fresh for the NEXT finish after a silent retirement", async () => {
		// One live card per unread chat, updated quietly — but the next cycle is
		// a real alert, which the phone replaces the standing one with.
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		for (const e of cycle(5_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(2);
		expect(state.sent[0]?.alertId).not.toBe(state.sent[1]?.alertId);
		expect(state.retracted).toHaveLength(0);
	});

	it("DOES retract a delivered ready alert when the SESSION ENDS", async () => {
		// There is no chat left to open: tapping the notification would land on
		// nothing, so it must come down.
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(1);

		state.manager.record(
			event({ outcome: "session-end", occurredAtMs: 3_000 }),
		);
		await tick();
		expect(state.retracted).toEqual([state.sent[0]?.alertId ?? ""]);
	});

	it("DOES retract a delivered ERROR alert when a new cycle starts", async () => {
		// (ONE-BUZZ-UNTIL-READ) is a rule about READY alerts only. An agent that
		// DIED is not superseded by later work in any useful sense, and an error
		// the user has not seen is exactly what must not be quietly folded away —
		// so `e` keeps the original behaviour.
		const state = setup();
		for (const e of failedCycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent[0]?.kind).toBe("e");

		state.manager.record(event({ occurredAtMs: 3_000 }));
		await tick();
		expect(state.retracted).toEqual([state.sent[0]?.alertId ?? ""]);
	});

	it("does NOT re-mint the same cycle after it has been retired", async () => {
		const state = setup();
		const events = cycle(1_000);
		for (const e of events) state.manager.record(e);
		await tick();
		state.manager.record(event({ occurredAtMs: 3_000 }));
		await tick();

		// A redelivery of the same Stop under a fresh producer id. The retracted
		// row is KEPT precisely so this cannot buzz again — that is why the silent
		// retirement transitions the state rather than deleting the row.
		const stop = events[1];
		if (stop === undefined) throw new Error("cycle() must yield a stop event");
		state.manager.record({ ...stop, producerEventId: producerEventId() });
		await tick();
		expect(state.sent).toHaveLength(1);
		expect(state.retracted).toHaveLength(0);
	});

	it("deletes a HELD alert without sending a retraction", async () => {
		const state = setup({ present: true });
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(0);
		state.manager.record(event({ occurredAtMs: 3_000 }));
		await tick();
		// Nothing was ever on the phone, so there is nothing to take off it.
		expect(state.retracted).toHaveLength(0);
	});

	it("leaves an alert superseded MID-FLIGHT by a new cycle standing", async () => {
		const state = setup();
		let release = () => {};
		state.setGate(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(1);

		// Superseded by fresh work while the broadcast is still in flight.
		state.manager.record(event({ occurredAtMs: 3_000 }));
		await tick();
		expect(state.retracted).toHaveLength(0);

		state.setGate(null);
		release();
		await tick();
		await tick();
		// It LANDED on the phone, and the chat is still alive — so it stays, for
		// the next cycle's alert to replace.
		expect(state.retracted).toHaveLength(0);
	});

	it("retracts an alert superseded MID-FLIGHT by a SESSION END once it lands", async () => {
		const state = setup();
		let release = () => {};
		state.setGate(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(1);

		state.manager.record(
			event({ outcome: "session-end", occurredAtMs: 3_000 }),
		);
		await tick();
		expect(state.retracted).toHaveLength(0);

		state.setGate(null);
		release();
		await tick();
		await tick();
		// The chat is gone, so the notification that just landed comes straight
		// back off. Before retraction existed the flag was dropped in silence.
		expect(state.retracted).toEqual([state.sent[0]?.alertId ?? ""]);
	});

	it("does not retract an alert superseded mid-flight that FAILED", async () => {
		const state = setup();
		state.setFailSends(true);
		let release = () => {};
		state.setGate(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		state.manager.record(event({ occurredAtMs: 3_000 }));
		await tick();
		state.setGate(null);
		release();
		await tick();
		await tick();
		// Nothing ever reached a device; the alert is dropped, not retracted.
		expect(state.retracted).toHaveLength(0);
	});
});

/**
 * (ONE-BUZZ-UNTIL-READ) `standing` is the state the whole feature turns on: the
 * alert has been delivered, a newer cycle has retired it, and its notification
 * is STILL ON THE DEVICES — so the row has to outlive the retirement, and the
 * one retraction it is owed has to fire later, exactly once, whichever way the
 * user or the session gets round to it.
 */
describe("(ONE-BUZZ-UNTIL-READ) the standing state", () => {
	/** The `g` a plain `cycle(armedAtMs)` mints: its Stop lands 1 s after Start. */
	const outcomeOf = (armedAtMs: number) => armedAtMs + 1_000;

	it("fires exactly ONE retraction when a standing alert's session ends", async () => {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(1);

		// New cycle: silent retirement, notification left on the handset.
		state.manager.record(event({ occurredAtMs: 3_000 }));
		await tick();
		expect(state.retracted).toHaveLength(0);

		state.manager.record(
			event({ outcome: "session-end", occurredAtMs: 9_000 }),
		);
		await tick();
		// The `c` names the finish the phone is HOLDING — the standing alert's own
		// outcome instant, never the session-end's.
		expect(state.retractions).toEqual([
			{
				alertId: state.sent[0]?.alertId ?? "",
				terminalHandle: TERMINAL_HANDLE,
				outcomeAtMs: outcomeOf(1_000),
			},
		]);
	});

	it("fires exactly ONE retraction when the user reads a standing alert", async () => {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		state.manager.record(event({ occurredAtMs: 3_000 }));
		await tick();
		expect(state.retracted).toHaveLength(0);

		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 3_500,
		});
		await tick();
		expect(state.retractions).toEqual([
			{
				alertId: state.sent[0]?.alertId ?? "",
				terminalHandle: TERMINAL_HANDLE,
				outcomeAtMs: outcomeOf(1_000),
			},
		]);

		// And it is owed exactly one: reading again is silent.
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 4_000,
		});
		await tick();
		expect(state.retracted).toHaveLength(1);
	});

	it("stays inert however many further cycles run over a standing alert", async () => {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		state.manager.record(event({ occurredAtMs: 3_000 }));
		await tick();

		for (let i = 0; i < 20; i++) {
			state.manager.record(event({ occurredAtMs: 4_000 + i }));
		}
		await tick();
		expect(state.retracted).toHaveLength(0);

		// Still owed its single retraction, and it still names the right finish.
		state.manager.record(
			event({ outcome: "session-end", occurredAtMs: 9_000 }),
		);
		await tick();
		expect(state.retractions).toEqual([
			{
				alertId: state.sent[0]?.alertId ?? "",
				terminalHandle: TERMINAL_HANDLE,
				outcomeAtMs: outcomeOf(1_000),
			},
		]);
	});

	it("is inert once retracted — a later cycle cannot make it fire twice", async () => {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		state.manager.record(
			event({ outcome: "session-end", occurredAtMs: 3_000 }),
		);
		await tick();
		expect(state.retracted).toHaveLength(1);

		state.manager.record(event({ occurredAtMs: 4_000 }));
		state.manager.record(
			event({ outcome: "session-end", occurredAtMs: 5_000 }),
		);
		await tick();
		expect(state.retracted).toHaveLength(1);
	});

	/**
	 * The in-flight reason UPGRADES. A new cycle asks for silence and a session
	 * end asks for a retraction; whichever order they arrive in while the send is
	 * still in the air, the session end wins — the weaker reason must never be
	 * able to swallow the stronger one's `c`.
	 */
	it("upgrades a mid-flight new-cycle supersession to a session end", async () => {
		const state = setup();
		let release = () => {};
		state.setGate(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(1);

		state.manager.record(event({ occurredAtMs: 3_000 }));
		state.manager.record(
			event({ outcome: "session-end", occurredAtMs: 4_000 }),
		);
		await tick();
		expect(state.retracted).toHaveLength(0);

		state.setGate(null);
		release();
		await tick();
		await tick();
		expect(state.retractions).toEqual([
			{
				alertId: state.sent[0]?.alertId ?? "",
				terminalHandle: TERMINAL_HANDLE,
				outcomeAtMs: outcomeOf(1_000),
			},
		]);
	});

	it("does not DOWNGRADE a mid-flight session end to a new cycle", async () => {
		const state = setup();
		let release = () => {};
		state.setGate(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();

		state.manager.record(
			event({ outcome: "session-end", occurredAtMs: 3_000 }),
		);
		state.manager.record(event({ occurredAtMs: 4_000 }));
		await tick();

		state.setGate(null);
		release();
		await tick();
		await tick();
		expect(state.retracted).toEqual([state.sent[0]?.alertId ?? ""]);
	});

	it("carries the alert's own outcome instant on the `g` it sends", async () => {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sends).toEqual([
			{
				kind: "g",
				alertId: state.sent[0]?.alertId ?? "",
				terminalHandle: TERMINAL_HANDLE,
				outcomeAtMs: outcomeOf(1_000),
			},
		]);
	});
});

describe("(ALERT-CONTEXT-NAMES) markLifecycleSeen", () => {
	it("retracts the ready alert the user just read", async () => {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 2_000,
		});
		await tick();
		expect(state.retracted).toEqual([state.sent[0]?.alertId ?? ""]);
	});

	it("is idempotent — repeated reads send one retraction", async () => {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		for (let i = 0; i < 5; i++) {
			state.manager.markLifecycleSeen({
				hostTerminalId: "terminal-1",
				hostWorkspaceId: "workspace-1",
				seenThroughAt: 2_000,
			});
		}
		await tick();
		expect(state.retracted).toHaveLength(1);
	});

	it("still sends a no-op-safe retraction for an id this process never saw", async () => {
		// The restart case: the notification is on the phone, the host's memory of
		// it died with the old process, and the id is recomputable anyway. The
		// manager here starts at t=1_000 and the read is "through" t=500, so this
		// process CANNOT prove the alert never existed — a predecessor may well
		// have minted it.
		const state = setup();
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 500,
		});
		await tick();
		expect(state.retracted).toEqual([readyAlertIdFor(500)]);
		// And a second read does not broadcast again.
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 500,
		});
		await tick();
		expect(state.retracted).toHaveLength(1);
	});

	/**
	 * THE BLIND-BROADCAST GUARD. The renderer's repair path re-offers every
	 * already-read terminal on a reconnect, and most read-green terminals never
	 * raised a phone alert at all — the user was at the desk, so presence gating
	 * held it. Each bogus `c` would insert into the phone's 64-slot
	 * `SeenLifecycleEvents` window and, a few reconnects later, evict the real
	 * claims and tombstones that stop double-buzzing.
	 */
	it("sends NOTHING when it can prove no alert ever existed", async () => {
		// The manager started at t=1_000 and has held state continuously since;
		// the read is "through" a LATER instant. Any alert for it would still be
		// in the map, so an empty answer is proof rather than ignorance.
		const state = setup();
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-never-alerted",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 5_000,
		});
		await tick();
		expect(state.retracted).toHaveLength(0);
	});

	it("does not let the proof branch swallow a REAL retraction", async () => {
		// Same warm host, but this terminal DID alert. The live lookup finds it,
		// so the proof branch never applies.
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(1);

		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 5_000,
		});
		await tick();
		expect(state.retracted).toEqual([state.sent[0]?.alertId ?? ""]);
	});

	it("stays silent however many times a warm host is re-offered the same read", async () => {
		// The repair path's whole safety argument: repeats must be free. On a
		// host that can prove absence they cost nothing at all — not even a
		// tombstone row.
		const state = setup();
		for (let i = 0; i < 25; i++) {
			state.manager.markLifecycleSeen({
				hostTerminalId: `terminal-${i}`,
				hostWorkspaceId: "workspace-1",
				seenThroughAt: 5_000,
			});
		}
		await tick();
		expect(state.retracted).toHaveLength(0);
	});

	/**
	 * PROOF OF ABSENCE IS ONLY PROOF WHILE NOTHING HAS BEEN THROWN AWAY. The
	 * capacity bound evicts oldest-first, and an evicted `sent` row is the record
	 * of a notification that is on the user's phone right now. If the map's
	 * silence still counted as proof after that, the alert could never be
	 * retracted by anything.
	 */
	it("stops claiming proof after an unexpired row is evicted", async () => {
		const state = setup();
		// Fill past the bound with alerts that are all still live, so the eviction
		// that follows drops an unexpired row rather than a dead one.
		for (let i = 0; i < MAX_STATE_ENTRIES + 2; i++) {
			for (const e of cycle(1_000, { hostTerminalId: `filler-${i}` })) {
				state.manager.record(e);
			}
		}
		await tick();
		expect(
			state.errors.some((line) =>
				line.message.includes("dropped an unexpired alert"),
			),
		).toBe(true);

		// A terminal this process has no row for. Before the eviction this would
		// have been answered with silence; now the blind broadcast is back.
		state.retracted.length = 0;
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-never-seen",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 5_000,
		});
		await tick();
		expect(state.retracted).toEqual([
			readyAlertIdFor(5_000, "terminal-never-seen"),
		]);
	});

	it("logs an evicted SENT row loudly — it is not a free tombstone", async () => {
		const state = setup();
		// Fill to the bound and let every send SETTLE, so the rows about to be
		// evicted are `sent` — the record of a notification on the user's phone,
		// which the previous version dropped without a word.
		for (let i = 0; i < MAX_STATE_ENTRIES; i++) {
			for (const e of cycle(1_000, { hostTerminalId: `filler-${i}` })) {
				state.manager.record(e);
			}
		}
		await tick();
		await tick();

		// Two more cycles push the oldest (now `sent`) rows out.
		for (let i = 0; i < 2; i++) {
			for (const e of cycle(1_000, { hostTerminalId: `late-${i}` })) {
				state.manager.record(e);
			}
		}
		const dropped = state.errors.filter((line) =>
			line.message.includes("dropped an unexpired alert"),
		);
		expect(dropped.length).toBeGreaterThan(0);
		expect(dropped.some((line) => line.fields?.state === "sent")).toBe(true);
		for (const line of dropped) {
			expect(typeof line.fields?.alertId).toBe("string");
		}
	});

	it("does not claim proof for a send that was evicted mid-flight and then landed", async () => {
		const state = setup();
		let release = () => {};
		state.setGate(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		// This one parks in `sending`.
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(1);

		// Push it out of the map while its broadcast is still in flight.
		state.setGate(null);
		for (let i = 0; i < MAX_STATE_ENTRIES + 2; i++) {
			for (const e of cycle(1_000, { hostTerminalId: `filler-${i}` })) {
				state.manager.record(e);
			}
		}
		release();
		await tick();
		await tick();

		// FCM accepted it, so the alert is on the phone with no row anywhere. The
		// eviction latch is what stops the map's silence being read as proof.
		state.retracted.length = 0;
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 9_000,
		});
		await tick();
		expect(state.retracted).toHaveLength(1);
	});

	/**
	 * THE REGRESSION THIS EXISTS FOR. The renderer reports the instant it can
	 * see, and a terminal binding's `lastEventAt` advances for events that raise
	 * no alert at all — a `SessionStart` moves it while the hook leaves the
	 * lifecycle outcome null (pinned renderer-side by `statusTransitions.test.ts`).
	 * Hashing THAT instant names an id no phone has ever held: the real
	 * notification survives on the handset and a `c` frame is broadcast to every
	 * paired device for nothing.
	 */
	it("retracts the alert the phone actually holds, not the id the stamp hashes to", async () => {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		const delivered = state.sent[0]?.alertId ?? "";
		expect(delivered).toBe(readyAlertIdFor(2_000));

		// The renderer marks the chat read "through" a LATER stamp than the one
		// the alert was minted from — the SessionStart that moved the binding on.
		const laterStamp = 2_500;
		expect(readyAlertIdFor(laterStamp)).not.toBe(delivered);
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: laterStamp,
		});
		await tick();

		// The live map is asked first, so the id that goes out is the one on the
		// phone — not the hash of a stamp nothing was minted from.
		expect(state.retracted).toEqual([delivered]);
		expect(state.retracted).not.toContain(readyAlertIdFor(laterStamp));
	});

	it("does not broadcast a blind retraction while a live alert is still HELD", async () => {
		// Held means it never reached a device, so there is nothing to take back —
		// and the mismatched stamp must not turn that into a broadcast either.
		const state = setup({ present: true });
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(0);

		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 2_500,
		});
		await tick();
		expect(state.retracted).toHaveLength(0);
	});

	it("ignores another terminal's sent alert when picking the live one", async () => {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		for (const e of cycle(1_000, { hostTerminalId: "terminal-2" })) {
			state.manager.record(e);
		}
		await tick();
		expect(state.sent).toHaveLength(2);

		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-2",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 9_999,
		});
		await tick();
		expect(state.retracted).toEqual([readyAlertIdFor(2_000, "terminal-2")]);
	});

	it("refuses an unusable signal loudly instead of broadcasting nonsense", async () => {
		const state = setup();
		state.manager.markLifecycleSeen({
			hostTerminalId: "",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 2_000,
		});
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 0,
		});
		await tick();
		expect(state.retracted).toHaveLength(0);
		expect(state.errors.length).toBeGreaterThan(0);
	});

	/**
	 * (ALERT-RETIRE-ON-EXIT) USER DECISION, 2026-08-20, reversing the original
	 * design (which this test used to pin the other way round). Reading the chat
	 * is exactly how the user learns the agent died, so the error card must come
	 * down with the ready one.
	 */
	it("retracts an ERROR alert the read covers — opening the chat IS finding out", async () => {
		const state = setup();
		for (const e of failedCycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent[0]?.kind).toBe("e");
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 2_000,
		});
		await tick();
		// The LIVE MAP answered, so the `e` row itself was retired — not the
		// blind `g` hash, which nothing holds. Exactly one `c` went out.
		expect(state.retracted).toEqual([state.sent[0]?.alertId ?? ""]);
	});

	/**
	 * (ALERT-RETIRE-ON-EXIT) An `e` retraction carries NO terminal handle. The
	 * phone reads a `c` terminal-first, and ready cards are keyed by handle — so
	 * an error retraction that named its terminal cancelled the unread STANDING
	 * READY card for the same terminal. `gx` still rides along: the frame
	 * builder requires a positive outcome instant, and an `e` row has one.
	 */
	it("sends an e retraction with an EMPTY handle and a real gx", async () => {
		const state = setup();
		for (const e of failedCycle(1_000)) state.manager.record(e);
		await tick();
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 2_000,
		});
		await tick();
		expect(state.retractions).toHaveLength(1);
		expect(state.retractions[0]?.terminalHandle).toBe("");
		expect(state.retractions[0]?.outcomeAtMs).toBe(2_000);
	});

	it("keeps the real handle on a g retraction", async () => {
		const state = setup();
		for (const step of cycle(1_000)) state.manager.record(step);
		await tick();
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 2_000,
		});
		await tick();
		expect(state.retractions).toHaveLength(1);
		expect(state.retractions[0]?.terminalHandle).toBe(TERMINAL_HANDLE);
		expect(state.retractions[0]?.outcomeAtMs).toBe(2_000);
	});

	it("still falls back to the READY hash alone when nothing is held", async () => {
		// The blind restart path stays `g`-only: hashing an `e` id too would
		// double every blind broadcast on the path that must stay rarest.
		const state = setup({ proofEpochs: null });
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 2_000,
		});
		await tick();
		expect(state.retracted).toEqual([readyAlertIdFor(2_000)]);
		expect(state.retractions[0]?.terminalHandle).toBe(TERMINAL_HANDLE);
	});
});

/**
 * (ONE-BUZZ-UNTIL-READ) A READ IS ABOUT A MOMENT, NOT ABOUT "NOW".
 *
 * Reports travel: the renderer batches them, the resync re-sends one that was
 * dropped minutes ago, a restart replays one. Meanwhile the agent keeps
 * working — so a read of finish A can arrive after finish B is already on the
 * phone. Retiring whatever happened to be live would then retract work the user
 * has never seen, and nothing would re-raise it.
 */
describe("(ONE-BUZZ-UNTIL-READ) a read is bounded by its own instant", () => {
	it("leaves a LATER finish standing when a delayed read of an earlier one lands", async () => {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		// A new cycle retires A silently, then finishes: B is on the phone.
		for (const e of cycle(3_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(2);
		const alertA = state.sent[0]?.alertId ?? "";
		const alertB = state.sent[1]?.alertId ?? "";
		expect(state.retracted).toHaveLength(0);

		// The delayed read of A arrives.
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 2_000,
		});
		await tick();

		// A is retired — it was standing and owed one `c`. B is untouched.
		expect(state.retractions).toEqual([
			{
				alertId: alertA,
				terminalHandle: TERMINAL_HANDLE,
				outcomeAtMs: 2_000,
			},
		]);
		expect(state.retracted).not.toContain(alertB);

		// And B is still retractable by a read that actually covers it.
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 4_000,
		});
		await tick();
		expect(state.retracted).toEqual([alertA, alertB]);
	});

	it("does not blind-broadcast for a read a later generation cannot answer", async () => {
		// The read names a generation this warm process never minted; the only row
		// it has is NEWER than the read. That is not evidence the older alert
		// existed, so the proof-of-absence branch still applies and nothing goes
		// out — least of all a `c` for the finish the user has not seen.
		const state = setup();
		for (const e of cycle(5_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(1);

		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 3_000,
		});
		await tick();
		expect(state.retracted).toHaveLength(0);
	});

	it("retires EVERY covered generation, not just the newest", async () => {
		// A is delivered and then silently retired by a new cycle (standing, still
		// on the phone). The next finish is HELD — the user came back to the desk
		// — so the newest covered generation has never reached a device. Retiring
		// only that one would drop the held row in silence and leave A's card up.
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		const alertA = state.sent[0]?.alertId ?? "";
		state.setPresent(true);
		for (const e of cycle(3_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(1);

		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 4_000,
		});
		await tick();
		expect(state.retracted).toEqual([alertA]);
	});
});

describe("(ALERT-CONTEXT-NAMES) names are resolved per attempt", () => {
	it("asks the resolver INSIDE the send, and again on every retry", async () => {
		const state = setup();
		state.setFailSends(true);
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.contextCalls).toHaveLength(1);

		// Past the first backoff, the sweep tries again — and re-resolves, so a
		// workspace renamed in the meantime buzzes with its new name.
		state.setNow(1_000 + 60_000);
		state.setFailSends(false);
		await sweep();
		expect(state.contextCalls.length).toBeGreaterThan(1);
		expect(state.sent.length).toBeGreaterThan(1);
	});

	it("survives a resolver that throws, and still sends", async () => {
		const state = setup();
		state.setContext(null);
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(1);
	});
});

/**
 * (ONE-BUZZ-UNTIL-READ) THE PROOF EPOCH.
 *
 * Silence is only proof while "I started before that instant" is a statement
 * about the SAME timeline the instant is on. It is not: generations are
 * per-terminal monotonic (`nextLifecycleInstantMs`) and a manager's start is a
 * wall-clock reading, so a restart that lands inside an NTP backstep can start
 * "before" a generation the PREVIOUS process already put on a phone. The proof
 * is therefore bounded per terminal by what host.db recorded before this
 * process began.
 */
describe("(ONE-BUZZ-UNTIL-READ) proof of absence is bounded by the restart", () => {
	it("broadcasts blind for a generation a PREDECESSOR minted, after a clock step-back", async () => {
		// The restart lands at wall-clock 4_000; host.db says this terminal's last
		// lifecycle instant was 5_000, because the process before it corrected a
		// backstep. A read of that alert must NOT be answered with silence — the
		// notification is on the phone and this process holds no row for it.
		const state = setup({
			startAtMs: 4_000,
			proofEpochs: [["terminal-1", 5_000]],
		});
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 5_000,
		});
		await tick();
		expect(state.retractions).toEqual([
			{
				alertId: readyAlertIdFor(5_000),
				terminalHandle: TERMINAL_HANDLE,
				outcomeAtMs: 5_000,
			},
		]);
	});

	it("still broadcasts blind when a NEWER generation is held post-restart", async () => {
		// Same restart, and this process has since minted 5_001 for the same
		// terminal (held — the user is at the desk). That row is filtered out as
		// newer than the read, and it says nothing about whether the predecessor's
		// 5_000 existed, so the blind `c` must still go out.
		const state = setup({
			present: true,
			startAtMs: 4_000,
			proofEpochs: [["terminal-1", 5_000]],
		});
		state.manager.record(
			event({ occurredAtMs: 5_001, previousEventAtMs: 5_000 }),
		);
		state.manager.record(
			event({
				outcome: "ready",
				eventType: "Stop",
				occurredAtMs: 5_002,
				previousEventType: "Start",
				previousEventAtMs: 5_001,
			}),
		);
		await tick();
		expect(state.sent).toHaveLength(0);

		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 5_000,
		});
		await tick();
		expect(state.retracted).toEqual([readyAlertIdFor(5_000)]);
	});

	it("keeps its silence for a generation only THIS process could have minted", async () => {
		// Same restart evidence, but the read names an instant past the epoch: any
		// alert for it would have been minted here and would still be in the map.
		const state = setup({
			startAtMs: 4_000,
			proofEpochs: [["terminal-1", 5_000]],
		});
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 5_001,
		});
		await tick();
		expect(state.retracted).toHaveLength(0);
	});

	it("does not let one terminal's epoch silence ANOTHER terminal's read", async () => {
		// The epoch is per terminal. A busy terminal sitting on a high generation
		// must not suppress a different terminal's blind retraction, nor claim
		// proof on its behalf.
		const state = setup({
			startAtMs: 4_000,
			proofEpochs: [["terminal-busy", 9_000]],
		});
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-busy",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 9_000,
		});
		await tick();
		expect(state.retracted).toEqual([readyAlertIdFor(9_000, "terminal-busy")]);
	});

	it("stops trusting the wall clock for UNKNOWN terminals once it is behind", async () => {
		// A terminal with no epoch row is normally answered by the wall-clock test
		// — but a persisted instant at or beyond this process's start is the
		// signature of a backstep, and no wall-clock comparison here can be
		// trusted while that holds.
		const behind = setup({
			startAtMs: 4_000,
			proofEpochs: [["terminal-other", 5_000]],
		});
		behind.manager.markLifecycleSeen({
			hostTerminalId: "terminal-unknown",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 4_500,
		});
		await tick();
		expect(behind.retracted).toHaveLength(1);

		// With the timeline behind the clock — the ordinary restart — the
		// blind-broadcast guard is untouched.
		const ahead = setup({
			startAtMs: 4_000,
			proofEpochs: [["terminal-other", 3_000]],
		});
		ahead.manager.markLifecycleSeen({
			hostTerminalId: "terminal-unknown",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 4_500,
		});
		await tick();
		expect(ahead.retracted).toHaveLength(0);
	});

	it("claims no proof at all when there is no restart evidence", async () => {
		// `null` is a composition root saying it cannot establish restart
		// ordering. A blind `c` the phone drops is the safe failure.
		const state = setup({ proofEpochs: null });
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-never-alerted",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 5_000,
		});
		await tick();
		expect(state.retracted).toHaveLength(1);
	});

	it("disables the proof, loudly, when the epoch cannot be read", async () => {
		const state = setup({
			proofEpochs: [],
			epochThrows: true,
		});
		expect(
			state.errors.some((line) =>
				line.message.includes("could not read the lifecycle proof epoch"),
			),
		).toBe(true);
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-never-alerted",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 5_000,
		});
		await tick();
		expect(state.retracted).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// (ALERT-RETIRE-ON-EXIT) the three retirement triggers
// ---------------------------------------------------------------------------

/**
 * (ALERT-RETIRE-ON-EXIT) A notification must not outlive the thing it points
 * at. Three ways the desktop can make one moot that the hook stream cannot
 * report on its own: the terminal process died, the app relaunched, or the user
 * took the thread off their sidebar.
 */
describe("(ALERT-RETIRE-ON-EXIT) retireTerminal", () => {
	it("deletes a HELD alert in silence", async () => {
		const state = setup({ present: true });
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toEqual([]);

		state.manager.retireTerminal("terminal-1");
		state.setPresent(false);
		await sweep();
		// Never reached a device, so nothing to take down and nothing to send.
		expect(state.sent).toEqual([]);
		expect(state.retracted).toEqual([]);
		expect(
			state.infos.some((line) => line.message.includes("cancelled a held")),
		).toBe(true);
	});

	it("retracts a SENDING alert the moment its delivery lands", async () => {
		const state = setup();
		let release = () => {};
		state.setGate(
			new Promise<void>((resolve) => {
				release = () => resolve();
			}),
		);
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(1);
		expect(state.retracted).toEqual([]);

		state.manager.retireTerminal("terminal-1");
		state.setGate(null);
		release();
		await tick();
		await tick();
		expect(state.retracted).toEqual([state.sent[0]?.alertId ?? ""]);
	});

	it("retracts a SENT alert once", async () => {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(1);

		state.manager.retireTerminal("terminal-1");
		state.manager.retireTerminal("terminal-1");
		await tick();
		expect(state.retracted).toEqual([state.sent[0]?.alertId ?? ""]);
	});

	it("retracts a STANDING alert — the card is still on the handset", async () => {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		// A newer cycle leaves the delivered alert standing rather than retracted.
		state.manager.record(event({ occurredAtMs: 3_000 }));
		await tick();
		expect(state.retracted).toEqual([]);

		state.manager.retireTerminal("terminal-1");
		await tick();
		expect(state.retractions).toEqual([
			{
				alertId: state.sent[0]?.alertId ?? "",
				terminalHandle: TERMINAL_HANDLE,
				outcomeAtMs: 2_000,
			},
		]);
	});

	it("is inert against an already RETRACTED alert", async () => {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		state.manager.record(
			event({ outcome: "session-end", occurredAtMs: 3_000 }),
		);
		await tick();
		expect(state.retracted).toHaveLength(1);

		state.manager.retireTerminal("terminal-1");
		await tick();
		expect(state.retracted).toHaveLength(1);
	});

	it("takes down the ERROR card too — a dead terminal opens nothing", async () => {
		const state = setup();
		for (const e of failedCycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent[0]?.kind).toBe("e");

		state.manager.retireTerminal("terminal-1");
		await tick();
		expect(state.retracted).toEqual([state.sent[0]?.alertId ?? ""]);
		// (ALERT-RETIRE-ON-EXIT) and with no handle, so it cannot cancel a ready
		// card keyed by the same terminal.
		expect(state.retractions[0]?.terminalHandle).toBe("");
	});

	it("leaves OTHER terminals alone", async () => {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		for (const e of cycle(1_000, { hostTerminalId: "terminal-2" })) {
			state.manager.record(e);
		}
		await tick();
		expect(state.sent).toHaveLength(2);

		state.manager.retireTerminal("terminal-1");
		await tick();
		expect(state.retracted).toEqual([state.sent[0]?.alertId ?? ""]);
	});
});

describe("(ALERT-RETIRE-ON-EXIT) retireReadyBefore", () => {
	it("is boundary-EXCLUSIVE: a finish stamped at the boundary survives", async () => {
		const state = setup();
		// Two finishes on two terminals: 2_000 and 4_000.
		for (const e of cycle(1_000)) state.manager.record(e);
		for (const e of cycle(3_000, { hostTerminalId: "terminal-2" })) {
			state.manager.record(e);
		}
		await tick();
		expect(state.sent).toHaveLength(2);

		expect(state.manager.retireReadyBefore(4_000)).toBe(1);
		await tick();
		expect(state.retracted).toEqual([state.sent[0]?.alertId ?? ""]);
	});

	it("leaves ERROR alerts standing — a relaunch does not answer a crash", async () => {
		const state = setup();
		for (const e of failedCycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent[0]?.kind).toBe("e");

		expect(state.manager.retireReadyBefore(9_000)).toBe(0);
		await tick();
		expect(state.retracted).toEqual([]);
	});

	it("INCLUDES held alerts — the desktop seeded them as read", async () => {
		const state = setup({ present: true });
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toEqual([]);

		expect(state.manager.retireReadyBefore(9_000)).toBe(1);
		state.setPresent(false);
		await sweep();
		// Deleted in silence: it never reached a device.
		expect(state.sent).toEqual([]);
		expect(state.retracted).toEqual([]);
	});

	it("retracts a STANDING alert and counts it once", async () => {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		state.manager.record(event({ occurredAtMs: 3_000 }));
		await tick();
		expect(state.retracted).toEqual([]);

		expect(state.manager.retireReadyBefore(9_000)).toBe(1);
		// A second relaunch report finds nothing left to do.
		expect(state.manager.retireReadyBefore(9_000)).toBe(0);
		await tick();
		expect(state.retracted).toEqual([state.sent[0]?.alertId ?? ""]);
	});
});

describe("(ALERT-RETIRE-ON-EXIT) retireCuratedOffAlerts", () => {
	/** One delivered alert in `workspace-1`. */
	async function oneLiveAlert() {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(1);
		return state;
	}

	/** Two delivered alerts, one per workspace, on their own terminals. */
	async function twoLiveWorkspaces() {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		for (const e of cycle(1_000, {
			hostTerminalId: "terminal-2",
			hostWorkspaceId: "workspace-2",
		})) {
			state.manager.record(e);
		}
		await tick();
		expect(state.sent).toHaveLength(2);
		return state;
	}

	it("retires the live alerts of a thread the user put away", async () => {
		const state = await twoLiveWorkspaces();
		state.setCuratedOff(() => true);
		expect(state.manager.retireCuratedOffAlerts()).toBe(2);
		await tick();
		expect(state.retracted).toHaveLength(2);
	});

	it("retires nothing while the thread is still on the sidebar", async () => {
		const state = await twoLiveWorkspaces();
		expect(state.manager.retireCuratedOffAlerts()).toBe(0);
		await tick();
		expect(state.retracted).toEqual([]);
	});

	/**
	 * The mirror sink fires on EVERY sidebar write — a pin, a rename, a reorder,
	 * another workspace being snoozed — so a walk that finds a thread still put
	 * away must be a no-op. It is, structurally: the first walk left every row
	 * `retracted`, and the push path refuses to mint a new one for a curated-off
	 * thread, so there is nothing live left to find.
	 */
	it("does not re-retract on later writes while the thread stays put away", async () => {
		const state = await twoLiveWorkspaces();
		state.setCuratedOff(() => true);
		expect(state.manager.retireCuratedOffAlerts()).toBe(2);
		expect(state.manager.retireCuratedOffAlerts()).toBe(0);
		expect(state.manager.retireCuratedOffAlerts()).toBe(0);
		await tick();
		expect(state.retracted).toHaveLength(2);
	});

	it("is scoped to the workspace that is curated off", async () => {
		const state = await twoLiveWorkspaces();
		state.setCuratedOff((hostWorkspaceId) => hostWorkspaceId === "workspace-2");
		expect(state.manager.retireCuratedOffAlerts()).toBe(1);
		await tick();
		expect(state.retracted).toEqual([state.sent[1]?.alertId ?? ""]);
	});

	it("PRESERVES held alerts — the claim path releases them when the snooze ends", async () => {
		const state = setup({ present: true });
		state.setCuratedOff(() => true);
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toEqual([]);

		// Nothing is live, so the curation read is not even consulted.
		expect(state.manager.retireCuratedOffAlerts()).toBe(0);
		expect(state.curationAsks).toEqual([]);

		// And the held alert still fires when presence lapses.
		state.setPresent(false);
		await sweep();
		expect(state.sent).toHaveLength(1);
	});

	/**
	 * ONE READ PER WALK, not one per workspace. Answering means reading the whole
	 * sidebar mirror off host.db on the host-service's only thread and rebuilding
	 * the curation from it, and the sink fires on every sidebar write.
	 */
	it("asks the fresh curation read ONCE, for the whole live set", async () => {
		const state = await twoLiveWorkspaces();
		state.manager.retireCuratedOffAlerts();
		expect(state.curationAsks).toHaveLength(1);
		expect([...(state.curationAsks[0] ?? [])].sort()).toEqual([
			"workspace-1",
			"workspace-2",
		]);
	});

	it("retires nothing for a workspace the curation read could not judge", async () => {
		const state = await twoLiveWorkspaces();
		// Fail-closed is the read's own job: an unjudgeable workspace is simply
		// absent from the set it answers with.
		state.setCuratedOff((hostWorkspaceId) => hostWorkspaceId === "workspace-1");
		expect(state.manager.retireCuratedOffAlerts()).toBe(1);
		await tick();
		expect(state.retracted).toEqual([state.sent[0]?.alertId ?? ""]);
	});

	/**
	 * THE SEQUENCE A FLIP TEST LOST, start to finish.
	 *
	 * Snooze expiry is PASSIVE: it writes nothing to the sidebar mirror, so no
	 * walk runs when a snooze runs out. A verdict remembered from the first
	 * snooze therefore survived into the second one, read as "no flip", and left
	 * the re-fired card standing on a thread the user had just put away again.
	 * The state test cannot lose it: it never remembers anything.
	 */
	it("retires the alert a passive snooze expiry let back through", async () => {
		const state = await oneLiveAlert();

		// The user snoozes the thread. The mirror write walks, and the card comes
		// down.
		state.setCuratedOff(() => true);
		expect(state.manager.retireCuratedOffAlerts()).toBe(1);
		await tick();
		expect(state.retracted).toHaveLength(1);

		// The snooze expires on its own. NOTHING is written to the mirror, so
		// there is no walk and this manager hears nothing at all.
		state.setCuratedOff(() => false);

		// The thread is back, and a second finish alerts the phone again.
		state.setNow(20_000);
		for (const e of cycle(20_000, { hostTerminalId: "terminal-2" })) {
			state.manager.record(e);
		}
		await tick();
		expect(state.sent).toHaveLength(2);

		// The user snoozes it a second time. THIS is the retirement a remembered
		// verdict used to skip.
		state.setCuratedOff(() => true);
		expect(state.manager.retireCuratedOffAlerts()).toBe(1);
		await tick();
		expect(state.retracted).toHaveLength(2);
		expect(state.retracted[1]).toBe(state.sent[1]?.alertId ?? "");
	});

	it("logs the workspace's OWN count, not the walk's running total", async () => {
		const state = await twoLiveWorkspaces();
		// A second alert in workspace-1 so the two workspaces differ: 2 and 1.
		state.setNow(20_000);
		for (const e of cycle(20_000, { hostTerminalId: "terminal-3" })) {
			state.manager.record(e);
		}
		await tick();
		state.setCuratedOff(() => true);
		expect(state.manager.retireCuratedOffAlerts()).toBe(3);
		const lines = state.infos.filter((line) =>
			line.message.includes("took a thread off their sidebar"),
		);
		expect(
			lines.map((line) => [line.fields?.hostWorkspaceId, line.fields?.retired]),
		).toEqual([
			["workspace-1", 2],
			["workspace-2", 1],
		]);
	});

	it("takes down an ERROR card with no handle when its thread is put away", async () => {
		const state = setup();
		for (const e of failedCycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent[0]?.kind).toBe("e");

		state.setCuratedOff(() => true);
		expect(state.manager.retireCuratedOffAlerts()).toBe(1);
		await tick();
		expect(state.retractions).toEqual([
			{
				alertId: state.sent[0]?.alertId ?? "",
				terminalHandle: "",
				outcomeAtMs: 2_000,
			},
		]);
	});
});

/**
 * (ALERT-RETIRE-ON-EXIT) The three new reasons are all LOUD and all rank above
 * `new-cycle`, which is the only silent one. Pinned through behaviour rather
 * than by reaching at the private helpers: a reason that silently stopped
 * notifying the phone would strand a card for six hours with nothing to show
 * for it.
 */
describe("(ALERT-RETIRE-ON-EXIT) every new reason is loud and outranks new-cycle", () => {
	type State = ReturnType<typeof setup>;
	const drive: Array<[string, (state: State) => unknown]> = [
		["terminal-gone", (state) => state.manager.retireTerminal("terminal-1")],
		["desktop-relaunch", (state) => state.manager.retireReadyBefore(9_000)],
		[
			"curated-off",
			(state) => {
				state.setCuratedOff(() => true);
				return state.manager.retireCuratedOffAlerts();
			},
		],
	];

	for (const [reason, retire] of drive) {
		it(`${reason} retracts a delivered ready alert`, async () => {
			const state = setup();
			for (const e of cycle(1_000)) state.manager.record(e);
			await tick();
			retire(state);
			await tick();
			expect(state.retracted).toEqual([state.sent[0]?.alertId ?? ""]);
		});

		it(`${reason} upgrades a silent in-flight new-cycle retirement`, async () => {
			// RANK. A new cycle flags the in-flight send silently; the loud reason
			// arriving behind it must still take the notification down when the
			// send lands, rather than being masked by the silent one.
			const state = setup();
			let release = () => {};
			state.setGate(
				new Promise<void>((resolve) => {
					release = () => resolve();
				}),
			);
			for (const e of cycle(1_000)) state.manager.record(e);
			await tick();
			expect(state.sent).toHaveLength(1);

			state.manager.record(event({ occurredAtMs: 3_000 }));
			retire(state);
			state.setGate(null);
			release();
			await tick();
			await tick();
			expect(state.retracted).toEqual([state.sent[0]?.alertId ?? ""]);
		});
	}
});
