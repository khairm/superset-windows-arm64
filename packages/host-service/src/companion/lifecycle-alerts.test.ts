import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	createLifecycleAlertManager,
	createLifecycleCurationProbe,
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

function setup(options: { present?: boolean } = {}) {
	let now = 1_000;
	let present = options.present ?? false;
	/** Set to reject the next send; cleared by the test when it wants success. */
	let failSends = false;
	/** When set, a send parks on this promise instead of resolving. */
	let gate: Promise<void> | null = null;
	const sent: Array<{ kind: string; alertId: string }> = [];
	const retracted: string[] = [];
	const errors: LogLine[] = [];
	const infos: LogLine[] = [];
	/** (ALERT-CONTEXT-NAMES) What the injected resolver answers, per test. */
	let context: PushAlertContext | null = null;
	/** Every context the manager asked for, in order — retry freshness proof. */
	const contextCalls: Array<{ hostTerminalId: string }> = [];
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
				if (gate !== null) await gate;
				if (failSends) throw new Error("fcm refused every device");
			},
			sendLifecycleRetraction: async (input) => {
				retracted.push(input.alertId);
			},
		},
		workspaceHandle: () => HANDLE,
		terminalHandle: () => TERMINAL_HANDLE,
		resolveContext: (input) => {
			contextCalls.push({ hostTerminalId: input.hostTerminalId });
			return context;
		},
		isCuratedOff: () => false,
		logger: {
			info: (message, fields) => infos.push({ message, fields }),
			warn: () => {},
			error: (message, fields) => errors.push({ message, fields }),
		},
		now: () => now,
	});
	return {
		manager,
		sent,
		retracted,
		contextCalls,
		errors,
		infos,
		setNow: (value: number) => (now = value),
		setPresent: (value: boolean) => (present = value),
		setFailSends: (value: boolean) => (failSends = value),
		setGate: (value: Promise<void> | null) => (gate = value),
		setContext: (value: PushAlertContext | null) => (context = value),
	};
}

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
		state.manager.stop();
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
		state.manager.stop();
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
		state.manager.stop();
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
		state.manager.stop();
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
		state.manager.stop();
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
		state.manager.stop();
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
		failed.manager.stop();

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
		ready.manager.stop();
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
		state.manager.stop();
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
		state.manager.stop();
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
		state.manager.stop();
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
	it("retracts a SENT alert when the terminal moves on, exactly once", async () => {
		const state = setup();
		for (const e of cycle(1_000)) state.manager.record(e);
		await tick();
		expect(state.sent).toHaveLength(1);

		state.manager.record(event({ occurredAtMs: 3_000 }));
		await tick();
		expect(state.retracted).toEqual([state.sent[0]?.alertId ?? ""]);

		// STORM GUARD: everything after `retracted` is a no-op, however much
		// progress the terminal reports.
		for (let i = 0; i < 20; i++) {
			state.manager.record(event({ occurredAtMs: 4_000 + i }));
		}
		await tick();
		expect(state.retracted).toHaveLength(1);
		expect(state.sent).toHaveLength(1);
	});

	it("does NOT re-mint the same cycle after it has been retracted", async () => {
		const state = setup();
		const events = cycle(1_000);
		for (const e of events) state.manager.record(e);
		await tick();
		state.manager.record(event({ occurredAtMs: 3_000 }));
		await tick();
		expect(state.retracted).toHaveLength(1);

		// A redelivery of the same Stop under a fresh producer id. The retracted
		// row is KEPT precisely so this cannot buzz again.
		const stop = events[1];
		if (stop === undefined) throw new Error("cycle() must yield a stop event");
		state.manager.record({ ...stop, producerEventId: producerEventId() });
		await tick();
		expect(state.sent).toHaveLength(1);
		expect(state.retracted).toHaveLength(1);
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

	it("retracts an alert superseded MID-FLIGHT once FCM accepts it", async () => {
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

		// Superseded while the broadcast is still in flight.
		state.manager.record(event({ occurredAtMs: 3_000 }));
		await tick();
		expect(state.retracted).toHaveLength(0);

		state.setGate(null);
		release();
		await tick();
		await tick();
		// It LANDED on the phone and the thing it reports is stale, so it comes
		// straight back off. Before this, the flag was dropped in silence.
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

	it("does not touch an ERROR alert — reading a chat does not un-kill an agent", async () => {
		const state = setup();
		state.manager.record(event({ occurredAtMs: 1_000 }));
		state.manager.record(
			event({
				outcome: "failed",
				eventType: "StopFailure",
				occurredAtMs: 2_000,
				previousEventType: "Start",
				previousEventAtMs: 1_000,
			}),
		);
		await tick();
		expect(state.sent[0]?.kind).toBe("e");
		state.manager.markLifecycleSeen({
			hostTerminalId: "terminal-1",
			hostWorkspaceId: "workspace-1",
			seenThroughAt: 2_000,
		});
		await tick();
		// The `c` that went out names the `g` id, which nothing holds. The error
		// notification stands.
		expect(state.retracted).not.toContain(state.sent[0]?.alertId ?? "");
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
