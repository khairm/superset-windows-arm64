/**
 * (CHAT-CONTEXT-NAMES) The three names `/v1/question` reports as `place`, and
 * the `tabTitle` `/v1/tree` reports per terminal.
 *
 * Two things are pinned here that no other suite pins:
 *
 *  - PLACEMENT IDENTITY. `place.projectName` is the project the SIDEBAR puts
 *    the thread under, and the tests assert it against `handleTree`'s own
 *    grouping IN THE SAME TEST rather than against a hardcoded string. The
 *    whole point of the shared display-name helpers is that the sheet's header
 *    and the row the user tapped cannot drift apart, and only an assertion that
 *    reads both outputs can catch a drift.
 *  - PRIVACY. Names are for the wire, never for a log line. The last test
 *    captures the structured logger AND every console channel, makes each
 *    resolver throw an error whose MESSAGE is a name, and asserts no captured
 *    argument contains any name fixture at any depth.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { errorClassName } from "./log-privacy";
import { deriveHandle, type PendingQuestion } from "./question-store";
import {
	type HostWorkspaceRow,
	handleQuestion,
	handleTree,
	type ReadDeps,
} from "./read-api";
import { SESSIONS_PROJECT_NAME } from "./session-project";
import {
	mirrorProject,
	mirrorWorkspace,
	NOW,
	projectRow,
	snapshot,
	type TreeFixture,
	terminalRow,
	treeDeps,
	workspaceRow,
} from "./test-fixtures";
import type {
	QuestionResponse,
	SealedRequestContext,
	TreeResponse,
} from "./types";

const P_OWNER = "p-owner";
const P_PLACEMENT = "p-placement";
const WS = "w-1";
const TERM = "t-1";

/**
 * Deliberately unlikely tokens. The privacy test scans every logged string for
 * each of these, so a name that happened to be a substring of "read" or "error"
 * would make that test pass for the wrong reason.
 */
const OWNER_PROJECT_NAME = "zzowner-repo";
const PLACEMENT_PROJECT_NAME = "zzplacement-repo";
const WORKSPACE_NAME = "zzworkspace-name";
const BRANCH_NAME = "zzbranch-name";
const TAB_TITLE = "zztab-title";
const REPO_BASENAME = "zzbasename-repo";

const NAME_FIXTURES = [
	OWNER_PROJECT_NAME,
	PLACEMENT_PROJECT_NAME,
	WORKSPACE_NAME,
	BRANCH_NAME,
	TAB_TITLE,
	REPO_BASENAME,
];

/**
 * A canonical §0.1 wire id: 16 bytes, base64url, 22 chars, no padding.
 * `requireHandle` tests canonicality rather than shape, so a hand-written
 * 22-character string would be rejected.
 */
function wireId(seed: string): string {
	return createHash("sha256")
		.update(seed)
		.digest()
		.subarray(0, 16)
		.toString("base64url");
}

const QUESTION_HANDLE = wireId("q-1");
const FINGERPRINT = wireId("fp-1");
const DEVICE_ID = wireId("d-1");
/** Derived exactly as the tree derives it, so the two outputs can be compared. */
const TERMINAL_HANDLE = deriveHandle("terminal", TERM);

const CTX = {
	granted: ["tree.read"],
	device: {
		deviceId: DEVICE_ID,
		revokedAtMs: null,
		writesDisabledAtMs: null,
	},
} as unknown as SealedRequestContext;

// ---------------------------------------------------------------------------
// fixture — the shared harness, bound to this suite's one workspace/terminal
// ---------------------------------------------------------------------------

/** The one workspace under test, named so the privacy scan can find its name. */
function namedWorkspaceRow(
	overrides: Partial<HostWorkspaceRow> = {},
): HostWorkspaceRow {
	return workspaceRow(WS, P_OWNER, {
		name: WORKSPACE_NAME,
		branch: BRANCH_NAME,
		...overrides,
	});
}

interface Fixture {
	projects?: TreeFixture["projects"];
	workspaces?: TreeFixture["workspaces"];
	mirror?: TreeFixture["mirror"];
	/** Absent = the default resolver, which knows this one terminal. */
	resolveTabTitle?: ReadDeps["resolveTabTitle"];
	/** Absent = one terminal. Several exist to prove the tree tallies rather than repeats. */
	terminals?: TreeFixture["terminals"];
	/** Absent = read from `workspaces`. */
	findWorkspace?: TreeFixture["findWorkspace"];
	/** Absent = read from `projects`. */
	findProject?: TreeFixture["findProject"];
	log?: (event: Record<string, unknown>) => void;
}

const DEFAULT_TAB_RESOLVER: ReadDeps["resolveTabTitle"] = (w, t) =>
	w === WS && t === TERM ? TAB_TITLE : "";

function makeDeps(fixture: Fixture): ReadDeps {
	const pending = {
		hostWorkspaceId: WS,
		hostTerminalId: TERM,
	} as unknown as PendingQuestion;

	return treeDeps(
		{
			projects: fixture.projects ?? [
				projectRow(P_OWNER, OWNER_PROJECT_NAME),
				projectRow(P_PLACEMENT, PLACEMENT_PROJECT_NAME),
			],
			workspaces: fixture.workspaces ?? [namedWorkspaceRow()],
			terminals: fixture.terminals ?? [terminalRow(TERM, WS)],
			bindings: [],
			mirror:
				fixture.mirror ??
				snapshot(
					[mirrorWorkspace(WS, { projectId: P_OWNER })],
					[mirrorProject(P_OWNER), mirrorProject(P_PLACEMENT)],
				),
			findWorkspace: fixture.findWorkspace,
			findProject: fixture.findProject,
		},
		{
			log: fixture.log ?? (() => {}),
			questions: {
				get: (questionId: string) =>
					questionId === QUESTION_HANDLE ? pending : null,
				byHostTerminal: () => null,
				unanswerableReason: () => null,
				headline: () => "",
				reconcile: async () => [],
				oldestPendingAgeMs: () => null,
				toResponse: async (): Promise<QuestionResponse> => ({
					questionId: QUESTION_HANDLE,
					fingerprint: FINGERPRINT,
					state: "pending",
					askedAtMs: NOW - 5_000,
					resolvedAtMs: null,
					resolvedBy: null,
					source: {
						// The OWNER handle, which is exactly what `place` does not use.
						projectId: deriveHandle("project", P_OWNER),
						workspaceId: deriveHandle("workspace", WS),
						terminalId: TERMINAL_HANDLE,
						agentKind: "claude",
						subagent: null,
					},
					answerable: true,
					unanswerableReason: null,
					questions: [],
					context: [],
				}),
			} as unknown as ReadDeps["questions"],
			resolveTabTitle:
				fixture.resolveTabTitle === undefined
					? DEFAULT_TAB_RESOLVER
					: fixture.resolveTabTitle,
		},
	);
}

async function question(fixture: Fixture = {}): Promise<QuestionResponse> {
	return handleQuestion(makeDeps(fixture), CTX, {
		questionId: QUESTION_HANDLE,
	});
}

async function tree(fixture: Fixture = {}): Promise<TreeResponse> {
	return handleTree(makeDeps(fixture), CTX, { includeIdle: true });
}

/** The project header `/v1/tree` files our one terminal under. */
function treeProjectNameForTerminal(response: TreeResponse): string | null {
	for (const project of response.projects) {
		for (const workspace of project.workspaces) {
			if (workspace.terminals.some((t) => t.terminalId === TERMINAL_HANDLE)) {
				return project.name;
			}
		}
	}
	return null;
}

function treeTerminal(response: TreeResponse) {
	for (const project of response.projects) {
		for (const workspace of project.workspaces) {
			const found = workspace.terminals.find(
				(t) => t.terminalId === TERMINAL_HANDLE,
			);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// /v1/question — place
// ---------------------------------------------------------------------------

describe("(CHAT-CONTEXT-NAMES) /v1/question place", () => {
	it("carries all three names when everything resolves", async () => {
		const response = await question();
		expect(response.place).toEqual({
			projectName: OWNER_PROJECT_NAME,
			workspaceName: WORKSPACE_NAME,
			tabTitle: TAB_TITLE,
		});
	});

	it("names the SIDEBAR PLACEMENT project, and names it identically to the tree's own grouping", async () => {
		// The user dragged this thread under another repo. `workspaces.project_id`
		// still says `p-owner`; the sidebar says otherwise, and the sidebar is what
		// the user is looking at.
		const fixture: Fixture = {
			mirror: snapshot(
				[mirrorWorkspace(WS, { projectId: P_PLACEMENT })],
				[mirrorProject(P_OWNER), mirrorProject(P_PLACEMENT)],
			),
		};
		const response = await question(fixture);
		const treeResponse = await tree(fixture);

		expect(response.place?.projectName).toBe(PLACEMENT_PROJECT_NAME);
		// Not the owner, which is what `source.projectId` still points at.
		expect(response.place?.projectName).not.toBe(OWNER_PROJECT_NAME);
		// The assertion that pins the two paths together: whatever the tree calls
		// the project this terminal sits under, `place` calls it too.
		expect(response.place?.projectName).toBe(
			treeProjectNameForTerminal(treeResponse) ?? "<not grouped>",
		);
	});

	it("falls back to the repo path's basename for an unnamed project, exactly as the tree does", async () => {
		const fixture: Fixture = {
			projects: [projectRow(P_OWNER, "", `C:/repos/${REPO_BASENAME}`)],
			mirror: snapshot(
				[mirrorWorkspace(WS, { projectId: P_OWNER })],
				[mirrorProject(P_OWNER)],
			),
		};
		const response = await question(fixture);
		const treeResponse = await tree(fixture);

		expect(response.place?.projectName).toBe(REPO_BASENAME);
		expect(response.place?.projectName).toBe(
			treeProjectNameForTerminal(treeResponse) ?? "<not grouped>",
		);
	});

	it("falls back to the branch for an unnamed workspace, exactly as the tree does", async () => {
		const fixture: Fixture = {
			workspaces: [namedWorkspaceRow({ name: "" })],
		};
		const response = await question(fixture);
		const treeResponse = await tree(fixture);

		expect(response.place?.workspaceName).toBe(BRANCH_NAME);
		const treeWorkspaceName = treeResponse.projects
			.flatMap((p) => p.workspaces)
			.find((w) =>
				w.terminals.some((t) => t.terminalId === TERMINAL_HANDLE),
			)?.name;
		expect(response.place?.workspaceName).toBe(treeWorkspaceName);
	});

	it("(SESSIONS-PROJECT) names a project-less session workspace 'Sessions'", async () => {
		const response = await question({
			workspaces: [namedWorkspaceRow({ projectId: null, type: "session" })],
			// No mirror row for it, so placement falls through to the synthetic id.
			mirror: snapshot([], [mirrorProject(P_OWNER)]),
		});
		expect(response.place?.projectName).toBe(SESSIONS_PROJECT_NAME);
		expect(response.place?.workspaceName).toBe(WORKSPACE_NAME);
	});

	it("serves the question with empty names when the workspace row has gone", async () => {
		const response = await question({
			findWorkspace: () => null,
			// A workspace host.db cannot find is a workspace the renderer's registry
			// has nothing for either.
			resolveTabTitle: null,
		});
		expect(response.place).toEqual({
			projectName: "",
			workspaceName: "",
			tabTitle: "",
		});
		// The question itself is untouched — names are context, never a gate.
		expect(response.questionId).toBe(QUESTION_HANDLE);
		expect(response.answerable).toBe(true);
	});

	it("reports an empty tabTitle when the bridge has no tab-title registry, and still resolves the other two", async () => {
		const response = await question({ resolveTabTitle: null });
		expect(response.place).toEqual({
			projectName: OWNER_PROJECT_NAME,
			workspaceName: WORKSPACE_NAME,
			tabTitle: "",
		});
	});

	it("survives a tab-title resolver that throws", async () => {
		const response = await question({
			resolveTabTitle: () => {
				throw new Error("registry exploded");
			},
		});
		expect(response.place?.tabTitle).toBe("");
		expect(response.place?.projectName).toBe(OWNER_PROJECT_NAME);
		expect(response.place?.workspaceName).toBe(WORKSPACE_NAME);
		expect(response.questionId).toBe(QUESTION_HANDLE);
	});

	it("loses only the project name when the project read throws", async () => {
		const response = await question({
			findProject: () => {
				throw new Error("db exploded");
			},
		});
		expect(response.place).toEqual({
			projectName: "",
			// Resolved BEFORE the project lookup, so the throw cannot take it.
			workspaceName: WORKSPACE_NAME,
			tabTitle: TAB_TITLE,
		});
	});
});

// ---------------------------------------------------------------------------
// /v1/tree — tabTitle
// ---------------------------------------------------------------------------

/**
 * (EMIT-OPTIONAL-FIELDS) The tree OMITS an unresolved tab title rather than
 * sending `""`. The client defaults the absent field to `""`, so the two say
 * the same thing and only one of them costs a key on every terminal of every
 * poll. `place.tabTitle` above is a fixed-shape object and keeps its `""`.
 */
describe("(CHAT-CONTEXT-NAMES) /v1/tree tabTitle", () => {
	it("reports the renderer's tab title on the terminal", async () => {
		const terminal = treeTerminal(await tree());
		expect(terminal?.tabTitle).toBe(TAB_TITLE);
	});

	it("omits the field when the registry has no entry for the terminal", async () => {
		const terminal = treeTerminal(await tree({ resolveTabTitle: () => "" }));
		expect(terminal).toBeDefined();
		expect(terminal && "tabTitle" in terminal).toBe(false);
	});

	it("serves the tree, without the field, when the bridge has no tab-title registry", async () => {
		const terminal = treeTerminal(await tree({ resolveTabTitle: null }));
		expect(terminal).toBeDefined();
		expect(terminal?.tabTitle).toBeUndefined();
	});

	it("serves the tree when the resolver throws", async () => {
		const response = await tree({
			resolveTabTitle: () => {
				throw new Error("registry exploded");
			},
		});
		const terminal = treeTerminal(response);
		expect(terminal?.tabTitle).toBeUndefined();
		// The rest of the row is intact.
		expect(terminal?.terminalId).toBe(TERMINAL_HANDLE);
		expect(response.counts.idle).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// errorClassName over hostile thrown values
// ---------------------------------------------------------------------------

/**
 * (CHAT-CONTEXT-NAMES) `throw` takes any value, and the never-throw wrappers
 * inspect what they caught.
 *
 * `errorClassName` reads `error.constructor.name`, so a thrown value carrying an
 * accessor on either hop would throw a SECOND time — from inside the catch block,
 * past the wrapper, and out through the whole request. These are not theoretical
 * shapes: a Proxy, a revoked Proxy, and a getter that fails on a half-torn-down
 * object all reach the same place, and a resolver owned by another subsystem is
 * exactly where one comes from.
 *
 * Tested here as a UNIT rather than driven through both handlers with every
 * value: the wrappers' own behaviour over a throwing resolver is pinned once per
 * path above, and what each hostile value does is a fact about this function.
 */
function hostileConstructorGetter(): unknown {
	return Object.defineProperty({}, "constructor", {
		get() {
			throw new Error("secondary");
		},
	});
}

/** The other hop: the constructor is readable, its `name` is not. */
function hostileNameGetter(): unknown {
	return Object.defineProperty({}, "constructor", {
		value: Object.defineProperty({}, "name", {
			get() {
				throw new Error("secondary");
			},
		}),
	});
}

describe("(CHAT-CONTEXT-NAMES) errorClassName", () => {
	it("is total over a constructor getter that throws", () => {
		expect(errorClassName(hostileConstructorGetter())).toBe("unknown");
	});

	it("is total over a constructor.name getter that throws", () => {
		expect(errorClassName(hostileNameGetter())).toBe("unknown");
	});

	it("refuses a non-string constructor.name", () => {
		const thrown = Object.defineProperty({}, "constructor", {
			value: { name: 42 },
		});
		expect(errorClassName(thrown)).toBe("unknown");
	});

	it("is total over null", () => {
		expect(errorClassName(null)).toBe("unknown");
	});

	it("is total over undefined", () => {
		expect(errorClassName(undefined)).toBe("unknown");
	});

	it("names a primitive by its boxed class, and an Error by its own", () => {
		expect(errorClassName("boom")).toBe("String");
		expect(errorClassName(new Error("boom"))).toBe("Error");
		expect(errorClassName(new TypeError("boom"))).toBe("TypeError");
	});
});

/**
 * (CHAT-CONTEXT-NAMES) The never-throw wrappers report their own failures, and
 * reporting is itself something that can fail. A log sink that throws must not
 * convert a missing tab title into a failed request — that is the exact trade
 * the wrappers exist to refuse, one layer further out.
 */
describe("(CHAT-CONTEXT-NAMES) a logger that throws", () => {
	/**
	 * Fails on the wrappers' own diagnostics and nothing else. The handlers'
	 * ordinary log lines are deliberately NOT guarded — a request whose only
	 * problem is that it could not be logged should fail loudly — so a sink that
	 * threw on everything would prove the wrapper works by never reaching it.
	 */
	const deadLog = (event: Record<string, unknown>) => {
		if (String(event.event).startsWith("companion.chat_place.")) {
			throw new Error("log sink is gone");
		}
	};

	it("serves the question when logging the tab-title failure throws", async () => {
		const response = await question({
			log: deadLog,
			resolveTabTitle: () => {
				throw new Error("registry exploded");
			},
		});
		expect(response.questionId).toBe(QUESTION_HANDLE);
		expect(response.place?.tabTitle).toBe("");
	});

	it("serves the tree when logging the tab-title tally throws", async () => {
		const response = await tree({
			log: deadLog,
			resolveTabTitle: () => {
				throw new Error("registry exploded");
			},
		});
		expect(treeTerminal(response)?.tabTitle).toBeUndefined();
		expect(response.counts.idle).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// log volume
// ---------------------------------------------------------------------------

/**
 * (CHAT-CONTEXT-NAMES) `/v1/tree` is polled and resolves a title per pane, so a
 * broken registry used to write one line per pane per poll. One line per read,
 * carrying the count.
 */
describe("(CHAT-CONTEXT-NAMES) tab-title failure logging", () => {
	const THREE = [
		terminalRow("t-1", WS),
		terminalRow("t-2", WS),
		terminalRow("t-3", WS),
	];

	it("emits ONE line for a whole tree read, with the count", async () => {
		const events: Record<string, unknown>[] = [];
		await tree({
			terminals: THREE,
			log: (event) => events.push(event),
			resolveTabTitle: () => {
				throw new Error("registry exploded");
			},
		});

		const failures = events.filter(
			(e) => e.event === "companion.chat_place.tab_title_unresolved",
		);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.terminals).toBe(3);
		expect(failures[0]?.errorName).toBe("Error");
	});

	it("says nothing at all when every title resolves", async () => {
		const events: Record<string, unknown>[] = [];
		await tree({ terminals: THREE, log: (event) => events.push(event) });
		expect(
			events.filter(
				(e) => e.event === "companion.chat_place.tab_title_unresolved",
			),
		).toEqual([]);
	});

	it("keeps the per-call line on the question path, which is one terminal and is not polled", async () => {
		const events: Record<string, unknown>[] = [];
		await question({
			log: (event) => events.push(event),
			resolveTabTitle: () => {
				throw new Error("registry exploded");
			},
		});
		const failure = events.find(
			(e) => e.event === "companion.chat_place.tab_title_unresolved",
		);
		expect(failure).toBeDefined();
		expect(failure?.hostTerminalId).toBe(TERM);
		expect(failure?.errorName).toBe("Error");
	});
});

// ---------------------------------------------------------------------------
// privacy
// ---------------------------------------------------------------------------

/** Every string reachable from a logged argument, including error internals. */
function collectStrings(value: unknown, out: string[], depth = 0): void {
	if (depth > 8 || value === null || value === undefined) return;
	if (typeof value === "string") {
		out.push(value);
		return;
	}
	if (typeof value === "number" || typeof value === "boolean") return;
	if (value instanceof Error) {
		out.push(value.message);
		if (typeof value.stack === "string") out.push(value.stack);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, out, depth + 1);
		return;
	}
	if (typeof value === "object") {
		for (const item of Object.values(value)) {
			collectStrings(item, out, depth + 1);
		}
		return;
	}
	out.push(String(value));
}

describe("(CHAT-CONTEXT-NAMES) privacy", () => {
	it("never logs a name — not on the happy path, and not through an error that carries one as its message", async () => {
		const captured: unknown[] = [];
		const spy = (...args: unknown[]) => {
			captured.push(...args);
		};
		const realLog = console.log;
		const realInfo = console.info;
		const realWarn = console.warn;
		const realError = console.error;
		const realDebug = console.debug;
		console.log = spy;
		console.info = spy;
		console.warn = spy;
		console.error = spy;
		console.debug = spy;

		try {
			// Happy path first: resolving names must not log them either.
			await question({ log: (event) => captured.push(event) });
			await tree({ log: (event) => captured.push(event) });

			// Then the hostile shape: an error whose MESSAGE is a name. Logging the
			// error object, `error.message` or `error.stack` would leak it.
			await question({
				log: (event) => captured.push(event),
				findProject: () => {
					throw new Error(OWNER_PROJECT_NAME);
				},
				resolveTabTitle: () => {
					throw new Error(TAB_TITLE);
				},
			});
			await tree({
				log: (event) => captured.push(event),
				resolveTabTitle: () => {
					throw new Error(TAB_TITLE);
				},
			});
		} finally {
			console.log = realLog;
			console.info = realInfo;
			console.warn = realWarn;
			console.error = realError;
			console.debug = realDebug;
		}

		// Something was captured, or this test proves nothing.
		expect(captured.length).toBeGreaterThan(0);

		const strings: string[] = [];
		for (const entry of captured) collectStrings(entry, strings);
		for (const name of NAME_FIXTURES) {
			const offenders = strings.filter((s) => s.includes(name));
			expect(offenders).toEqual([]);
		}
		// The class name IS allowed, and is the whole diagnostic value of the line.
		expect(strings.some((s) => s === "Error")).toBe(true);
	});

	it("keeps the served-question log line free of the new field", async () => {
		const events: Record<string, unknown>[] = [];
		await question({ log: (event) => events.push(event) });
		const served = events.find((e) => e.event === "companion.question.served");
		expect(served).toBeDefined();
		expect(served && "place" in served).toBe(false);
		expect(served && "projectName" in served).toBe(false);
	});
});
