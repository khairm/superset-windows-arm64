import { describe, expect, it } from "bun:test";
import {
	PORT_SCAN_WARMUP_DELAYS_MS,
	planPortScanSync,
	planStaleRowCorrection,
	REAP_INTERVAL_MS,
	STALE_ROW_MIN_AGE_MS,
	shouldReapRow,
} from "./reaper.ts";

const noneLive = () => false;

describe("port-scan warm-up schedule", () => {
	it("re-syncs multiple times after startup so ports recover without a reap tick", () => {
		expect(PORT_SCAN_WARMUP_DELAYS_MS.length).toBeGreaterThanOrEqual(3);
	});

	it("runs strictly increasing offsets", () => {
		for (let i = 1; i < PORT_SCAN_WARMUP_DELAYS_MS.length; i += 1) {
			expect(PORT_SCAN_WARMUP_DELAYS_MS[i]).toBeGreaterThan(
				PORT_SCAN_WARMUP_DELAYS_MS[i - 1] as number,
			);
		}
	});

	it("fully precedes the first scheduled reap so it covers the gap", () => {
		// Every warm-up must fire before the 5-minute reap would otherwise be the
		// first re-sync — that's the window this fix closes.
		for (const delay of PORT_SCAN_WARMUP_DELAYS_MS) {
			expect(delay).toBeLessThan(REAP_INTERVAL_MS);
		}
	});
});

describe("planPortScanSync", () => {
	it("registers alive daemon sessions that map to an active workspace row", () => {
		const plan = planPortScanSync({
			liveSessions: [{ id: "term-1", pid: 4242 }],
			rowById: new Map([
				["term-1", { status: "active", originWorkspaceId: "ws-1" }],
			]),
			registeredTerminalIds: [],
			isLive: noneLive,
		});

		expect(plan.register).toEqual([
			{ terminalId: "term-1", workspaceId: "ws-1", pid: 4242 },
		]);
		expect(plan.unregister).toEqual([]);
	});

	it("skips sessions already owned by a live in-memory session", () => {
		const plan = planPortScanSync({
			liveSessions: [{ id: "term-1", pid: 4242 }],
			rowById: new Map([
				["term-1", { status: "active", originWorkspaceId: "ws-1" }],
			]),
			registeredTerminalIds: [],
			isLive: (id) => id === "term-1",
		});

		expect(plan.register).toEqual([]);
	});

	it("skips sessions without a row, without a workspace, or not active", () => {
		const plan = planPortScanSync({
			liveSessions: [
				{ id: "rowless", pid: 1 },
				{ id: "no-workspace", pid: 2 },
				{ id: "exited", pid: 3 },
				{ id: "disposed", pid: 4 },
			],
			rowById: new Map([
				["no-workspace", { status: "active", originWorkspaceId: null }],
				["exited", { status: "exited", originWorkspaceId: "ws-1" }],
				["disposed", { status: "disposed", originWorkspaceId: "ws-1" }],
			]),
			registeredTerminalIds: [],
			isLive: noneLive,
		});

		expect(plan.register).toEqual([]);
	});

	it("unregisters scanned terminals the daemon no longer reports", () => {
		const plan = planPortScanSync({
			liveSessions: [{ id: "term-1", pid: 4242 }],
			rowById: new Map([
				["term-1", { status: "active", originWorkspaceId: "ws-1" }],
			]),
			registeredTerminalIds: ["term-1", "dead-term"],
			isLive: noneLive,
		});

		expect(plan.unregister).toEqual(["dead-term"]);
	});

	it("clears every adopted scan when the daemon reports no live sessions", () => {
		const plan = planPortScanSync({
			liveSessions: [],
			rowById: new Map(),
			registeredTerminalIds: ["term-1", "term-2"],
			isLive: noneLive,
		});

		expect(plan.unregister).toEqual(["term-1", "term-2"]);
	});

	it("keeps scanning a renderer-attached session momentarily absent from daemon.list", () => {
		const plan = planPortScanSync({
			liveSessions: [],
			rowById: new Map(),
			registeredTerminalIds: ["attached-term"],
			isLive: (id) => id === "attached-term",
		});

		expect(plan.unregister).toEqual([]);
	});
});

describe("shouldReapRow", () => {
	it("reaps rows whose dispose was requested but never confirmed", () => {
		expect(
			shouldReapRow({
				status: "active",
				originWorkspaceId: "ws-1",
				disposeRequestedAt: 1_000,
			}),
		).toBe(true);
	});

	it("keeps live sessions with a workspace and no dispose request", () => {
		expect(shouldReapRow({ status: "active", originWorkspaceId: "ws-1" })).toBe(
			false,
		);
		expect(
			shouldReapRow({
				status: "active",
				originWorkspaceId: "ws-1",
				disposeRequestedAt: null,
			}),
		).toBe(false);
	});

	it("still reaps dead-status and workspace-less rows", () => {
		expect(
			shouldReapRow({ status: "disposed", originWorkspaceId: "ws-1" }),
		).toBe(true);
		expect(shouldReapRow({ status: "exited", originWorkspaceId: "ws-1" })).toBe(
			true,
		);
		expect(shouldReapRow({ status: "active", originWorkspaceId: null })).toBe(
			true,
		);
	});
});

// (BRIDGE-LIVENESS) The reverse walk. Being wrong here costs a LIVE terminal its
// place in the desktop's own session list, so every guard gets its own case.
describe("(BRIDGE-LIVENESS) planStaleRowCorrection", () => {
	const NOW = 10_000_000;
	const OLD = NOW - STALE_ROW_MIN_AGE_MS - 1;

	function row(overrides: Record<string, unknown> = {}) {
		return {
			status: "active",
			originWorkspaceId: "w1",
			createdAt: OLD,
			lastAttachedAt: null,
			...overrides,
		};
	}

	function plan(
		rows: [string, ReturnType<typeof row>][],
		options: {
			alive?: string[];
			previous?: string[];
			live?: (id: string) => boolean;
		} = {},
	) {
		return planStaleRowCorrection({
			aliveIds: new Set(options.alive ?? ["t-alive"]),
			rowById: new Map(rows),
			absentOnPreviousPass: new Set(options.previous ?? []),
			isLive: options.live ?? noneLive,
			nowMs: NOW,
		});
	}

	it("needs TWO consecutive passes — one partially-populated daemon.list() must not condemn a live terminal", () => {
		const first = plan([["t-corpse", row()]]);
		expect(first.correct).toEqual([]);
		expect([...first.absentThisPass]).toEqual(["t-corpse"]);
		const second = plan([["t-corpse", row()]], { previous: ["t-corpse"] });
		expect(second.correct).toEqual(["t-corpse"]);
	});

	it("does nothing at all when the daemon listed nothing — an empty listing is the documented racy-adoption case, never evidence", () => {
		const result = plan([["t-corpse", row()]], {
			alive: [],
			previous: ["t-corpse"],
		});
		expect(result.correct).toEqual([]);
		expect([...result.absentThisPass]).toEqual([]);
	});

	it("spares a row the daemon still lists", () => {
		const result = plan([["t-alive", row()]], {
			alive: ["t-alive"],
			previous: ["t-alive"],
		});
		expect(result.correct).toEqual([]);
	});

	it("spares a row this process holds a live session for — an adopted session is absent from the daemon's view by design", () => {
		const result = plan([["t-attached", row()]], {
			previous: ["t-attached"],
			live: (id) => id === "t-attached",
		});
		expect(result.correct).toEqual([]);
	});

	it("spares a row younger than the age floor, so a session created after the listing cannot lose the race", () => {
		const result = plan([["t-newborn", row({ createdAt: NOW - 1 })]], {
			previous: ["t-newborn"],
		});
		expect(result.correct).toEqual([]);
	});

	it("uses the NEWEST of createdAt and lastAttachedAt", () => {
		const result = plan(
			[["t-reattached", row({ createdAt: OLD, lastAttachedAt: NOW - 1 })]],
			{ previous: ["t-reattached"] },
		);
		expect(result.correct).toEqual([]);
	});

	it("ignores rows that are not active or not workspace-owned — the forward walk owns those", () => {
		const result = plan(
			[
				["t-exited", row({ status: "exited" })],
				["t-orphan", row({ originWorkspaceId: null })],
			],
			{ previous: ["t-exited", "t-orphan"] },
		);
		expect(result.correct).toEqual([]);
	});
});
