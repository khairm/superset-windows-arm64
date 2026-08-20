import { describe, expect, test } from "bun:test";
import {
	MASTER_FOLDER_MISSING_REASON,
	type ResolveMasterModeInput,
	resolveMasterMode,
} from "./resolveMasterMode";

/**
 * (MASTER-PLUS-LAUNCH) One test per rung of the decision ladder, plus the two
 * cases that motivated the ladder's ORDER (a missing folder must not be read as
 * "non-git", and a missing master row must not deadlock on "Checking…").
 *
 * The base input is a resolved local NON-GIT single-repo project — i.e. the one
 * shape that yields master mode — so every case below is that base with exactly
 * the field under test flipped.
 */
const MASTER_INPUT: ResolveMasterModeInput = {
	projectId: "project-1",
	selectedHostId: "host-1",
	machineId: "host-1",
	mainWorkspaceId: "workspace-main",
	masterWorktreeExists: true,
	isAbsenceAuthoritative: true,
	isResolved: true,
	isError: false,
	isGitRepo: false,
	isMultiRepo: false,
	hostUrl: "http://127.0.0.1:7777",
	masterName: "acme",
	projectName: "Acme",
};

/** What the base input resolves to; asserted verbatim by several cases. */
const MASTER_RESULT = {
	mode: "master",
	mainWorkspaceId: "workspace-main",
	masterLabel: "acme",
	hostUrl: "http://127.0.0.1:7777",
} as const;

function resolve(overrides: Partial<ResolveMasterModeInput> = {}) {
	return resolveMasterMode({ ...MASTER_INPUT, ...overrides });
}

describe("resolveMasterMode", () => {
	test("the base case is master mode, carrying the launch target", () => {
		expect(resolve()).toEqual(MASTER_RESULT);
	});

	test("rung 1: no project selected falls back to the branch flow", () => {
		expect(resolve({ projectId: null })).toEqual({ mode: "branch" });
	});

	test("rung 2: a cloud workspace is never master mode", () => {
		expect(resolve({ selectedHostId: "cloud" })).toEqual({ mode: "branch" });
	});

	test("rung 2: a remote host is never master mode", () => {
		expect(resolve({ selectedHostId: "host-2" })).toEqual({ mode: "branch" });
	});

	test("rung 2: both ids null is NOT a match — startup must not guess", () => {
		// `null !== null` is false, so an identity-only test let this through
		// and the ladder could resolve master mode against a remote host's
		// master while the local host id was still unknown.
		expect(resolve({ selectedHostId: null, machineId: null })).toEqual({
			mode: "branch",
		});
	});

	test("rung 2: an unknown local machine id is never master mode", () => {
		expect(resolve({ machineId: null })).toEqual({ mode: "branch" });
	});

	test("rung 2: no host picked yet is never master mode", () => {
		expect(resolve({ selectedHostId: null })).toEqual({ mode: "branch" });
	});

	test("rung 3: a multi-repo project keeps the branch fan-out", () => {
		expect(resolve({ isMultiRepo: true })).toEqual({ mode: "branch" });
	});

	test("rung 3 beats rung 4: multi-repo has no master row and must not spin", () => {
		expect(
			resolve({
				isMultiRepo: true,
				mainWorkspaceId: null,
				isAbsenceAuthoritative: false,
			}),
		).toEqual({ mode: "branch" });
	});

	test("rung 4: no master row while the host list is hydrating is loading", () => {
		expect(
			resolve({ mainWorkspaceId: null, isAbsenceAuthoritative: false }),
		).toEqual({ mode: "loading" });
	});

	test("rung 5: a PROVEN missing master row falls back to branch, not a deadlock", () => {
		// The git-ness probe needs a master row to run, so it can never resolve
		// here. Absence is proven by the host's own list instead, which is why
		// this answers at all rather than sitting on "Checking project…".
		expect(
			resolve({
				mainWorkspaceId: null,
				isAbsenceAuthoritative: true,
				isResolved: false,
			}),
		).toEqual({ mode: "branch" });
	});

	test("rung 6: a folder missing from disk blocks with a reason", () => {
		expect(resolve({ masterWorktreeExists: false })).toEqual({
			mode: "blocked",
			reason: MASTER_FOLDER_MISSING_REASON,
		});
	});

	test("rung 6 beats git-ness: a missing folder reads non-git and would navigate then fail", () => {
		expect(resolve({ masterWorktreeExists: false, isGitRepo: false })).toEqual({
			mode: "blocked",
			reason: MASTER_FOLDER_MISSING_REASON,
		});
	});

	test("rung 6 tests === false: an unreported worktree is not a missing one", () => {
		// `undefined` means the owning host did not answer for this row.
		expect(resolve({ masterWorktreeExists: undefined })).toEqual(MASTER_RESULT);
	});

	test("rung 7: a FAILED probe falls back to branch rather than spinning", () => {
		expect(resolve({ isError: true, isResolved: false })).toEqual({
			mode: "branch",
		});
	});

	test("rung 7 does not mask rung 6: a missing folder still blocks", () => {
		expect(resolve({ isError: true, masterWorktreeExists: false })).toEqual({
			mode: "blocked",
			reason: MASTER_FOLDER_MISSING_REASON,
		});
	});

	test("rung 8: a pending probe against a live master row is loading", () => {
		expect(resolve({ isResolved: false })).toEqual({ mode: "loading" });
	});

	test("rung 9: a resolved GIT repo keeps the branch flow", () => {
		expect(resolve({ isGitRepo: true })).toEqual({ mode: "branch" });
	});

	test("rung 9: master mode needs an address to launch against", () => {
		expect(resolve({ hostUrl: null })).toEqual({ mode: "loading" });
	});

	test("rung 9: a nameless master row falls back to the project's name", () => {
		expect(resolve({ masterName: null })).toEqual({
			...MASTER_RESULT,
			masterLabel: "Acme",
		});
	});

	test("rung 9: with neither name, the label is a generic stand-in", () => {
		expect(resolve({ masterName: null, projectName: null })).toEqual({
			...MASTER_RESULT,
			masterLabel: "this project",
		});
	});

	test("rung 9: an EMPTY host url is loading, not a launch at nowhere", () => {
		expect(resolve({ hostUrl: "" })).toEqual({ mode: "loading" });
	});
});
