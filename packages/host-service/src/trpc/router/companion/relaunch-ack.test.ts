import { afterEach, describe, expect, it } from "bun:test";
import { COMPANION_ENABLE_ENV } from "../../../companion/config";
import {
	createLifecycleAlertManager,
	type LifecycleAlertManager,
} from "../../../companion/lifecycle-alerts";
import {
	clearCompanionLifecycleReadSink,
	clearCompanionRelaunchBoundarySink,
	recordCompanionLifecycleRead,
	setCompanionLifecycleReadSink,
	setCompanionRelaunchBoundarySink,
} from "../../../companion/registry";
import type { HostServiceContext } from "../../../types";
import { companionRouter } from "./companion";

/**
 * (ALERT-RETIRE-ON-EXIT) The relaunch report's acknowledgement, end to end:
 * alert manager → the bridge's boundary sink → the registry → the tRPC answer
 * the renderer reads.
 *
 * Covered here rather than in either half's own file because the bug this
 * guards was BETWEEN them. The manager refuses a boundary it cannot trust (a
 * future instant, a fractional one), and the renderer latches "reported once
 * per launch" on a truthy answer. While the host answered `accepted: true`
 * regardless of that refusal, one bad first report burned the latch for the
 * whole launch and every stale ready card stayed on the phone for its full TTL.
 * Both halves passed their own tests throughout.
 */

const ctx = { isAuthenticated: true } as unknown as HostServiceContext;

const live: LifecycleAlertManager[] = [];
const registered: Array<(input: { boundaryMs: number }) => boolean> = [];

afterEach(() => {
	for (const sink of registered) clearCompanionRelaunchBoundarySink(sink);
	registered.length = 0;
	for (const manager of live) manager.stop();
	live.length = 0;
});

/**
 * A real manager behind the real registry slot. The sink body is the one the
 * bridge installs: a refusal (`null`) is not an acknowledgement.
 */
function mountManager(hostNowMs: number): void {
	const manager = createLifecycleAlertManager({
		presence: {
			present: () => ({
				present: false,
				reason: "no-signal",
				humanInputAgeMs: null,
				beaconAgeMs: null,
				idleSeconds: null,
				locked: null,
			}),
		},
		push: {
			sendLifecycleAlert: async () => {},
			sendLifecycleRetraction: async () => {},
		},
		workspaceHandle: () => "w".repeat(22),
		terminalHandle: () => "t".repeat(22),
		isCuratedOff: () => false,
		curatedOffAmong: () => new Set<string>(),
		resolveContext: null,
		restartEvidence: null,
		readySettleMs: 0,
		reads: { readThroughAt: () => 0, advance: () => {} },
		logger: { info: () => {}, warn: () => {}, error: () => {} },
		now: () => hostNowMs,
	});
	live.push(manager);

	const sink = (input: { boundaryMs: number }): boolean =>
		manager.retireReadyBefore(input.boundaryMs) !== null;
	setCompanionRelaunchBoundarySink(sink);
	registered.push(sink);
}

describe("companion.retireStaleReadyAlerts acknowledgement", () => {
	it("answers accepted false for a boundary the manager refuses", async () => {
		mountManager(10_000);

		// A renderer whose clock runs ahead of the host's derives a launch instant
		// in the host's future. Retiring "everything before then" would take down
		// every live ready card, so the manager refuses it.
		const result = await companionRouter
			.createCaller(ctx)
			.retireStaleReadyAlerts({ boundaryMs: 20_000 });

		expect(result).toEqual({ accepted: false });
	});

	it("answers accepted true for a boundary it applies", async () => {
		mountManager(10_000);

		const result = await companionRouter
			.createCaller(ctx)
			.retireStaleReadyAlerts({ boundaryMs: 9_000 });

		expect(result).toEqual({ accepted: true });
	});

	it("still accepts a corrected boundary after refusing one", async () => {
		mountManager(10_000);
		const caller = companionRouter.createCaller(ctx);

		// The renderer keeps its latch open on `accepted: false` and re-derives
		// the boundary on the next resync. Nothing about the refusal may poison
		// the retry — that combination is what left the phone stuck.
		await expect(
			caller.retireStaleReadyAlerts({ boundaryMs: 20_000 }),
		).resolves.toEqual({ accepted: false });
		await expect(
			caller.retireStaleReadyAlerts({ boundaryMs: 9_500 }),
		).resolves.toEqual({ accepted: true });
	});

	it("answers accepted false when no bridge is running", async () => {
		const result = await companionRouter
			.createCaller(ctx)
			.retireStaleReadyAlerts({ boundaryMs: 9_000 });

		expect(result).toEqual({ accepted: false });
	});
});

describe("companion.reportLifecycleRead answers", () => {
	const read = {
		terminalId: "terminal-1",
		workspaceId: "workspace-1",
		origin: "user" as const,
		seenThroughAt: 1_700_000_000_000,
	};
	const hostRead = {
		hostTerminalId: read.terminalId,
		hostWorkspaceId: read.workspaceId,
		origin: read.origin,
		seenThroughAt: read.seenThroughAt,
	};

	it("answers bridge-off when configuration disables the bridge", () => {
		expect(recordCompanionLifecycleRead(hostRead, {})).toEqual({
			accepted: false,
			refusal: "bridge-off",
		});
	});

	it("answers a transient refusal while an enabled bridge is not up yet", () => {
		expect(
			recordCompanionLifecycleRead(hostRead, { [COMPANION_ENABLE_ENV]: "1" }),
		).toEqual({ accepted: false, refusal: null });
	});

	it("answers a transient refusal when the bridge's sink throws", async () => {
		const sink = () => {
			throw new Error("host.db is locked");
		};
		setCompanionLifecycleReadSink(sink);
		try {
			await expect(
				companionRouter.createCaller(ctx).reportLifecycleRead(read),
			).resolves.toEqual({ accepted: false, refusal: null });
		} finally {
			clearCompanionLifecycleReadSink(sink);
		}
	});
});
