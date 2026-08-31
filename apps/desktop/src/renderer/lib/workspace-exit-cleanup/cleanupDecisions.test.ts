import { describe, expect, it } from "bun:test";
import {
	classifyRetirement,
	decideCleanupOutcome,
	describeCleanupToast,
	type HostRetirementOutcome,
	isCleanupStampCurrent,
	type HostRetirementReply,
	resolveRetirementCallUrl,
} from "./cleanupDecisions";

function owner(
	overrides: Partial<HostRetirementOutcome> = {},
): HostRetirementReply {
	return {
		kind: "answered",
		outcome: {
			foundWorkspace: true,
			terminated: ["term-1"],
			failed: [],
			accountReleased: true,
			...overrides,
		},
	};
}

/** A host that answered, and does not have this workspace. */
const stranger: HostRetirementReply = {
	kind: "answered",
	outcome: {
		foundWorkspace: false,
		terminated: [],
		failed: [],
		accountReleased: false,
	},
};

/** Nothing came back at all: the machine is off. */
const silent: HostRetirementReply = { kind: "unreachable" };

/** The machine responded, with an error. It is there and it failed. */
const errored: HostRetirementReply = { kind: "failed" };

describe("classifyRetirement", () => {
	it("confirms when the owning host tore everything down", () => {
		expect(
			classifyRetirement({
				owner: owner(),
				others: [stranger],
				absenceProven: false,
			}),
		).toBe("confirmed");
	});

	it("confirms when the owner answered from the broadcast alone", () => {
		expect(
			classifyRetirement({
				owner: null,
				others: [silent, owner()],
				absenceProven: false,
			}),
		).toBe("confirmed");
	});

	it("names a disposal failure separately from an outage", () => {
		expect(
			classifyRetirement({
				owner: owner({ failed: ["term-2"] }),
				others: [],
				absenceProven: false,
			}),
		).toBe("owner-failed");
	});

	it("keeps the stamp when two hosts claim it and one failed", () => {
		expect(
			classifyRetirement({
				owner: null,
				others: [owner(), owner({ failed: ["term-9"] })],
				absenceProven: false,
			}),
		).toBe("owner-failed");
	});

	it("does NOT confirm on a non-owner's polite 'not mine'", () => {
		expect(
			classifyRetirement({
				owner: null,
				others: [stranger, stranger],
				absenceProven: false,
			}),
		).toBe("unreachable");
	});

	it("does NOT confirm when no host answered at all", () => {
		expect(
			classifyRetirement({
				owner: silent,
				others: [silent],
				absenceProven: false,
			}),
		).toBe("unreachable");
	});

	it("confirms when the RESOLVED owner says the workspace is gone", () => {
		// The machine the workspace is filed under answered "not mine": the row
		// was destroyed, so there is no runtime left to retire.
		expect(
			classifyRetirement({
				owner: stranger,
				others: [stranger],
				absenceProven: false,
			}),
		).toBe("confirmed");
	});

	it("confirms a vanished owner: nobody has it and nobody is missing", () => {
		// The owning host was decommissioned. Every host that could be asked
		// answered, none of them has the workspace, so the debt is undischargeable
		// and meaningless — clearing it is what stops permanent toast debt.
		expect(
			classifyRetirement({
				owner: null,
				others: [stranger, stranger],
				absenceProven: true,
			}),
		).toBe("confirmed");
	});

	it("keeps the stamp when absence is claimed but a host stayed silent", () => {
		// `absenceProven` is only ever passed true when every asked host answered,
		// but a silent host must lose to the debt regardless.
		expect(
			classifyRetirement({
				owner: null,
				others: [silent, stranger],
				absenceProven: false,
			}),
		).toBe("unreachable");
	});

	it("calls an owner that ANSWERED WITH AN ERROR a fault, not an outage", () => {
		// The machine is right there and the call blew up on it. Nothing was
		// retired, so the user is told and the Retry button means something —
		// exactly as when the owner answered and could not dispose a terminal.
		expect(
			classifyRetirement({
				owner: errored,
				others: [],
				absenceProven: false,
			}),
		).toBe("owner-failed");
	});

	it("still says unreachable when the owner never responded", () => {
		expect(
			classifyRetirement({
				owner: silent,
				others: [errored],
				absenceProven: false,
			}),
		).toBe("unreachable");
	});

	it("lets a live claimant outrank an owner that errored", () => {
		// A second host has the workspace and tore it down. The owner's error says
		// nothing about work another machine has demonstrably finished.
		expect(
			classifyRetirement({
				owner: errored,
				others: [owner()],
				absenceProven: false,
			}),
		).toBe("confirmed");
	});
});

describe("resolveRetirementCallUrl", () => {
	const SANDBOX = "https://sandbox.example";

	it("calls a normal host whenever it resolved", () => {
		expect(
			resolveRetirementCallUrl({
				ownerHostUrl: "http://host-a",
				isSandbox: false,
				isAwake: false,
			}),
		).toBe("http://host-a");
	});

	it("calls a sandbox that something else is already holding open", () => {
		expect(
			resolveRetirementCallUrl({
				ownerHostUrl: SANDBOX,
				isSandbox: true,
				isAwake: true,
			}),
		).toBe(SANDBOX);
	});

	it("leaves a SLEEPING sandbox alone rather than waking it", () => {
		// The request itself would spin the VM up and bill for it, to retire
		// terminals that died with the sandbox's last suspend. No target means the
		// debt is simply retained.
		expect(
			resolveRetirementCallUrl({
				ownerHostUrl: SANDBOX,
				isSandbox: true,
				isAwake: false,
			}),
		).toBeNull();
	});

	it("has nothing to call when the owner did not resolve", () => {
		expect(
			resolveRetirementCallUrl({
				ownerHostUrl: null,
				isSandbox: false,
				isAwake: true,
			}),
		).toBeNull();
	});
});

describe("isCleanupStampCurrent", () => {
	it("allows teardown only while the same cleanup debt is still pending", () => {
		expect(isCleanupStampCurrent(100, 100)).toBe(true);
		expect(isCleanupStampCurrent(100, null)).toBe(false);
		expect(isCleanupStampCurrent(100, 200)).toBe(false);
	});
});

describe("decideCleanupOutcome", () => {
	it("clears the stamp when the owner confirmed and nothing moved underneath", () => {
		expect(
			decideCleanupOutcome({
				stampBefore: 100,
				stampAfter: 100,
				verdict: "confirmed",
			}),
		).toBe("clear");
	});

	it("retries an outage and a disposal failure alike", () => {
		for (const verdict of ["unreachable", "owner-failed"] as const) {
			expect(
				decideCleanupOutcome({ stampBefore: 100, stampAfter: 100, verdict }),
			).toBe("retry");
		}
	});

	it("abandons a confirmation for a cleanup the user cancelled mid-flight", () => {
		expect(
			decideCleanupOutcome({
				stampBefore: 100,
				stampAfter: null,
				verdict: "confirmed",
			}),
		).toBe("abandon");
	});

	it("abandons when the user exited again while the attempt was in flight", () => {
		// Timestamp stability is the whole guard: one exit action reads
		// `Date.now()` once, so a stamp that differs is a DIFFERENT debt this
		// attempt never spoke for.
		expect(
			decideCleanupOutcome({
				stampBefore: 100,
				stampAfter: 200,
				verdict: "confirmed",
			}),
		).toBe("abandon");
	});
});

describe("describeCleanupToast", () => {
	it("says nothing when nothing is owed", () => {
		expect(describeCleanupToast({ blocked: 0, waiting: 0 })).toBeNull();
	});

	it("leads with the fault when both kinds are outstanding", () => {
		expect(describeCleanupToast({ blocked: 1, waiting: 4 })?.title).toBe(
			"Couldn't finish closing 1 workspace",
		);
	});

	it("reads as a wait when only the owner is offline", () => {
		expect(describeCleanupToast({ blocked: 0, waiting: 2 })?.title).toBe(
			"Still closing 2 workspaces",
		);
	});
});
