import { describe, expect, it } from "bun:test";
import {
	cleanupRoutingKey,
	createReopenTrigger,
	createSweepQueue,
	localHostFingerprint,
} from "./cleanupTriggers";

describe("createReopenTrigger", () => {
	it("fires on the FIRST open when the host was down to begin with", () => {
		// The regression this exists for. A workspace exited while its owning
		// machine is off subscribes to a socket that is not up, so the machine
		// coming back is the ONLY open that subscription will ever see — and
		// suppressing it left the cleanup waiting for the next app start.
		const isRetryTrigger = createReopenTrigger(false);
		expect(isRetryTrigger("connecting")).toBe(false);
		expect(isRetryTrigger("open")).toBe(true);
	});

	it("suppresses the baseline of a host that was ALREADY open", () => {
		const isRetryTrigger = createReopenTrigger(true);
		expect(isRetryTrigger("open")).toBe(false);
	});

	it("fires again when an already-open host drops and comes back", () => {
		const isRetryTrigger = createReopenTrigger(true);
		expect(isRetryTrigger("open")).toBe(false);
		expect(isRetryTrigger("reconnecting")).toBe(false);
		expect(isRetryTrigger("open")).toBe(true);
	});

	it("fires once per open, however many statuses repeat it", () => {
		const isRetryTrigger = createReopenTrigger(false);
		expect(isRetryTrigger("open")).toBe(true);
		expect(isRetryTrigger("open")).toBe(false);
		expect(isRetryTrigger("open")).toBe(false);
	});

	it("does not fire for a host that never comes up", () => {
		const isRetryTrigger = createReopenTrigger(false);
		for (const state of ["connecting", "reconnecting", "closed"] as const) {
			expect(isRetryTrigger(state)).toBe(false);
		}
	});
});

describe("localHostFingerprint", () => {
	it("changes when a host-service is replaced on the SAME port", () => {
		// The regression this exists for: a restart reuses the preferred port, so
		// its URL — and a ports-only key — never moves, and the cleanup that was
		// waiting for exactly this event would never retry.
		const before = localHostFingerprint([{ port: 51234, secret: "old" }]);
		const after = localHostFingerprint([{ port: 51234, secret: "new" }]);
		expect(after).not.toBe(before);
	});

	it("is stable across reorderings and a re-read of the same hosts", () => {
		expect(
			localHostFingerprint([
				{ port: 2, secret: "b" },
				{ port: 1, secret: "a" },
			]),
		).toBe(
			localHostFingerprint([
				{ port: 1, secret: "a" },
				{ port: 2, secret: "b" },
			]),
		);
	});

	it("reads empty when no host-service is running", () => {
		expect(localHostFingerprint([])).toBe("");
		expect(localHostFingerprint(undefined)).toBe("");
	});
});

describe("cleanupRoutingKey", () => {
	function routing(
		entries: readonly (readonly [string, string | null])[],
	): Map<string, { ownerHostUrl: string | null }> {
		return new Map(entries.map(([id, url]) => [id, { ownerHostUrl: url }]));
	}

	it("changes when a SECOND owner resolves after the first already had", () => {
		// The regression this exists for. A boolean "some owner resolved" was
		// already true from ws-1's machine, so ws-2's machine coming back an hour
		// later moved nothing the sweep effect could see, and that debt waited for
		// the next app start.
		const before = cleanupRoutingKey(
			routing([
				["ws-1", "http://host-a"],
				["ws-2", null],
			]),
		);
		const after = cleanupRoutingKey(
			routing([
				["ws-1", "http://host-a"],
				["ws-2", "http://host-b"],
			]),
		);
		expect(after).not.toBe(before);
	});

	it("changes when an owner that HAD resolved goes away", () => {
		expect(cleanupRoutingKey(routing([["ws-1", null]]))).not.toBe(
			cleanupRoutingKey(routing([["ws-1", "http://host-a"]])),
		);
	});

	it("tells an unresolved owner apart from a workspace that is no longer pending", () => {
		// Omitting the id rather than reading its URL as empty would collapse these
		// two into one key, and the sweep would miss the owner coming back.
		expect(cleanupRoutingKey(routing([["ws-1", null]]))).not.toBe(
			cleanupRoutingKey(routing([])),
		);
	});

	it("is stable across reorderings and a re-read of the same routing", () => {
		expect(
			cleanupRoutingKey(
				routing([
					["ws-2", "http://host-b"],
					["ws-1", "http://host-a"],
				]),
			),
		).toBe(
			cleanupRoutingKey(
				routing([
					["ws-1", "http://host-a"],
					["ws-2", "http://host-b"],
				]),
			),
		);
	});

	it("changes when a pending workspace is added or exited", () => {
		const one = cleanupRoutingKey(routing([["ws-1", "http://host-a"]]));
		const two = cleanupRoutingKey(
			routing([
				["ws-1", "http://host-a"],
				["ws-2", "http://host-a"],
			]),
		);
		expect(two).not.toBe(one);
	});

	it("reads empty when nothing is pending", () => {
		expect(cleanupRoutingKey(routing([]))).toBe("");
	});
});

describe("createSweepQueue", () => {
	it("runs a rerun for a trigger that lands mid-sweep", async () => {
		const runs: string[][] = [];
		let release: (() => void) | undefined;
		const firstRun = new Promise<void>((resolve) => {
			release = resolve;
		});
		const sweep = createSweepQueue(
			async (ids) => {
				runs.push([...ids]);
				if (runs.length === 1) await firstRun;
			},
			() => ["ws-1", "ws-2"],
		);

		const inFlight = sweep(["ws-1"]);
		// The reconnect arrives while the pre-reconnect attempt is still failing.
		await sweep(["ws-1"]);
		expect(runs).toEqual([["ws-1"]]);

		release?.();
		await inFlight;

		// Reran once, with the ids as they stand NOW rather than as queued.
		expect(runs).toEqual([["ws-1"], ["ws-1", "ws-2"]]);
	});

	it("collapses a burst of mid-sweep triggers into one rerun", async () => {
		const runs: string[][] = [];
		let release: (() => void) | undefined;
		const firstRun = new Promise<void>((resolve) => {
			release = resolve;
		});
		const sweep = createSweepQueue(
			async (ids) => {
				runs.push([...ids]);
				if (runs.length === 1) await firstRun;
			},
			() => ["ws-1"],
		);

		const inFlight = sweep(["ws-1"]);
		await Promise.all([sweep(["ws-1"]), sweep(["ws-1"]), sweep(["ws-1"])]);
		release?.();
		await inFlight;

		expect(runs).toHaveLength(2);
	});

	it("accepts a new sweep once the previous one has settled", async () => {
		const runs: string[][] = [];
		const sweep = createSweepQueue(
			async (ids) => {
				runs.push([...ids]);
			},
			() => [],
		);

		await sweep(["ws-1"]);
		await sweep(["ws-2"]);

		expect(runs).toEqual([["ws-1"], ["ws-2"]]);
	});

	it("stays usable after a sweep throws", async () => {
		let attempt = 0;
		const sweep = createSweepQueue(
			async () => {
				attempt++;
				if (attempt === 1) throw new Error("host exploded");
			},
			() => [],
		);

		await expect(sweep(["ws-1"])).rejects.toThrow("host exploded");
		await sweep(["ws-1"]);

		expect(attempt).toBe(2);
	});
});
