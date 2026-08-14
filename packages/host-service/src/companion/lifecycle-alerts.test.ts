import { describe, expect, it } from "bun:test";
import {
	createLifecycleAlertManager,
	createLifecycleCurationProbe,
} from "./lifecycle-alerts";
import type { HostDbReader } from "./read-api";

const HANDLE = "w".repeat(22);

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
	const errors: LogLine[] = [];
	const infos: LogLine[] = [];
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
		},
		workspaceHandle: () => HANDLE,
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
		errors,
		infos,
		setNow: (value: number) => (now = value),
		setPresent: (value: boolean) => (present = value),
		setFailSends: (value: boolean) => (failSends = value),
		setGate: (value: Promise<void> | null) => (gate = value),
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
