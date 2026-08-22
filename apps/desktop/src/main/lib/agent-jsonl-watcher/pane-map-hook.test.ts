import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NOTIFY_SCRIPT } from "./pane-map-hook";

// (DEFERRED-FAILURE) The notify hook's turn-end decisions live in embedded
// Python, so they are exercised the way they ship: the real script, a real
// python3, a throwaway HOME (every marker/job path is derived from
// pathlib.Path.home()), and a local HTTP sink standing in for the host-service.

const PYTHON = process.platform === "win32" ? "python" : "python3";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pane-map-hook-"));
const scriptPath = path.join(root, "superset-notify.py");
fs.writeFileSync(scriptPath, NOTIFY_SCRIPT);

type Post = { eventType: string; lifecycleOutcome?: string };

const posts: Post[] = [];
/**
 * Every producer id the host-service saw, in arrival order. Kept OUT of `Post`
 * so the exact-shape assertions above stay readable — the id is random per
 * invocation, so it can only be asserted as a set/shape anyway.
 */
const lifecycleEventIds: string[] = [];
const sink = Bun.serve({
	port: 0,
	async fetch(request) {
		const body = (await request.json()) as {
			json?: {
				eventType?: string;
				companionLifecycleEventId?: string;
				companionLifecycleOutcome?: string;
			};
		};
		posts.push({
			eventType: body.json?.eventType ?? "",
			lifecycleOutcome: body.json?.companionLifecycleOutcome,
		});
		const eventId = body.json?.companionLifecycleEventId;
		if (typeof eventId === "string") lifecycleEventIds.push(eventId);
		// (HOOK-ENDPOINT-HEAL) The exact envelope the real route returns
		// (notifications.ts:357). The hook now treats delivery as POSITIVE
		// acceptance of "ignored": false, so a stand-in sink that answers
		// anything else is an UNDELIVERED event and would send every test in
		// this file down the failover path.
		return Response.json({
			result: { data: { json: { ignored: false, success: true } } },
		});
	},
});

afterAll(() => {
	sink.stop(true);
	fs.rmSync(root, { force: true, recursive: true });
});

let home = "";
let sessionId = "";
const TERMINAL_ID = "terminal-deferred-failure";

beforeEach(() => {
	posts.length = 0;
	lifecycleEventIds.length = 0;
	home = fs.mkdtempSync(path.join(root, "home-"));
	// A per-test session id keeps the codex-job glob (which also scans the OS
	// temp dir) from ever matching a real job on the developer's machine.
	sessionId = `session-${crypto.randomUUID()}`;
});

/**
 * Run one hook event; returns the eventType/outcome the host-service received.
 *
 * `envOverride` wins over every default below, which is how the failover suite
 * points the hook at its own sinks and turns debug logging on.
 */
async function hook(
	payload: Record<string, unknown>,
	envOverride: Record<string, string> = {},
	command: string[] = [PYTHON, scriptPath],
): Promise<Post | undefined> {
	// Async spawn, not spawnSync: the hook POSTs and waits for the response, so a
	// blocked JS loop would stall the sink until the hook's own timeout.
	const proc = Bun.spawn({
		cmd: command,
		env: {
			...process.env,
			HOME: home,
			NO_PROXY: "*",
			USERPROFILE: home,
			TEMP: home,
			TMP: home,
			TMPDIR: home,
			SUPERSET_AGENT_ID: "claude",
			SUPERSET_AGENT_WATCHER_DEBUG: "0",
			SUPERSET_HOST_AGENT_HOOK_URL: `http://127.0.0.1:${sink.port}/hook`,
			// (HOOK-ENDPOINT-HEAL) The suite runs INSIDE Superset, so both of
			// these are set in the real environment and would point the hook's
			// manifest failover at this machine's live hosts. Blanked so every
			// candidate list is built from the throwaway HOME alone.
			SUPERSET_HOME_DIR: "",
			SUPERSET_ORGANIZATION_ID: "",
			SUPERSET_TERMINAL_ID: TERMINAL_ID,
			...envOverride,
		},
		stdin: Buffer.from(JSON.stringify({ session_id: sessionId, ...payload })),
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stderr).text(),
	]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	return posts.pop();
}

/** A codex-companion job record for this session, in the state the hook reads. */
function writeCodexJob(status: "running" | "completed"): void {
	const dir = path.join(
		home,
		".claude",
		"plugins",
		"data",
		"codex",
		"state",
		"s1",
		"jobs",
	);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "job.json"),
		JSON.stringify({ pid: process.pid, sessionId, status }),
	);
}

function pendingFailureExists(): boolean {
	return fs.existsSync(
		path.join(
			home,
			".superset",
			"agent-subagent-running",
			`${TERMINAL_ID}.pendingfailure`,
		),
	);
}

describe("superset-notify deferred StopFailure", () => {
	it("fails immediately when no companion is holding the turn", async () => {
		expect(await hook({ hook_event_name: "StopFailure" })).toEqual({
			eventType: "Failed",
			lifecycleOutcome: "failed",
		});
		expect(pendingFailureExists()).toBe(false);
	});

	it("holds the failure while a codex companion is still running, then releases it as Failed exactly once when the companion finishes", async () => {
		writeCodexJob("running");
		// The Claude API aborted, but codex runs on its own API -> stay yellow and
		// park the failure rather than announce it.
		expect(await hook({ hook_event_name: "StopFailure" })).toEqual({
			eventType: "SubagentActive",
			lifecycleOutcome: "hold",
		});
		expect(pendingFailureExists()).toBe(true);

		writeCodexJob("completed");
		// The held companion is done and nothing else holds the dot -> the parked
		// failure surfaces now, as Failed rather than a false green.
		expect(
			await hook({ hook_event_name: "Stop", background_tasks: [] }),
		).toEqual({
			eventType: "Failed",
			lifecycleOutcome: "failed",
		});
		expect(pendingFailureExists()).toBe(false);

		// Exactly once: the marker is consumed, so a repeat turn-end is a plain green.
		expect(
			await hook({ hook_event_name: "Stop", background_tasks: [] }),
		).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});

	it("releases the held failure as Failed exactly once when the companion finishes via SubagentStop in the same aborted cycle", async () => {
		writeCodexJob("running");
		expect((await hook({ hook_event_name: "StopFailure" }))?.eventType).toBe(
			"SubagentActive",
		);
		expect(pendingFailureExists()).toBe(true);

		writeCodexJob("completed");
		// The companion's own SubagentStop closes the aborted cycle. It must
		// announce the abort, not green over it.
		expect(
			await hook({
				agent_id: "companion-fork",
				background_tasks: [],
				hook_event_name: "SubagentStop",
			}),
		).toEqual({
			eventType: "Failed",
			lifecycleOutcome: "failed",
		});
		expect(pendingFailureExists()).toBe(false);

		// Exactly once: a second SubagentStop finds no cycle left to close.
		expect(
			await hook({
				agent_id: "companion-fork",
				background_tasks: [],
				hook_event_name: "SubagentStop",
			}),
		).toBeUndefined();
	});

	it("holds the failure through a SubagentStop while the companion is still running", async () => {
		writeCodexJob("running");
		expect((await hook({ hook_event_name: "StopFailure" }))?.eventType).toBe(
			"SubagentActive",
		);

		expect(
			(
				await hook({
					agent_id: "companion-fork",
					background_tasks: [],
					hook_event_name: "SubagentStop",
				})
			)?.eventType,
		).toBe("SubagentActive");
		expect(pendingFailureExists()).toBe(true);
	});

	it("lets a new prompt supersede the held failure so a later SubagentStop cannot announce it", async () => {
		writeCodexJob("running");
		expect((await hook({ hook_event_name: "StopFailure" }))?.eventType).toBe(
			"SubagentActive",
		);

		// A new prompt is the ONLY thing that cancels the parked failure.
		await hook({ hook_event_name: "UserPromptSubmit" });
		expect(pendingFailureExists()).toBe(false);

		writeCodexJob("completed");
		expect(
			await hook({
				agent_id: "companion-fork",
				background_tasks: [],
				hook_event_name: "SubagentStop",
			}),
		).toBeUndefined();
	});

	it("keeps holding the failure across further turn-ends while the companion is still running", async () => {
		writeCodexJob("running");
		expect((await hook({ hook_event_name: "StopFailure" }))?.eventType).toBe(
			"SubagentActive",
		);
		expect(
			(await hook({ hook_event_name: "Stop", background_tasks: [] }))
				?.eventType,
		).toBe("SubagentActive");
		expect(pendingFailureExists()).toBe(true);
	});

	it("discards the held failure on a new prompt so a later clean turn stays green", async () => {
		writeCodexJob("running");
		expect((await hook({ hook_event_name: "StopFailure" }))?.eventType).toBe(
			"SubagentActive",
		);
		expect(pendingFailureExists()).toBe(true);

		// Auto-resume (or the user) re-sends: a NEW work cycle starts.
		expect(await hook({ hook_event_name: "UserPromptSubmit" })).toEqual({
			eventType: "Start",
			lifecycleOutcome: "progress",
		});
		expect(pendingFailureExists()).toBe(false);

		writeCodexJob("completed");
		// This cycle succeeded — it must NOT inherit the previous cycle's abort.
		expect(
			await hook({ hook_event_name: "Stop", background_tasks: [] }),
		).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});

	it("discards the held failure when a fresh session takes over the terminal", async () => {
		writeCodexJob("running");
		expect((await hook({ hook_event_name: "StopFailure" }))?.eventType).toBe(
			"SubagentActive",
		);

		await hook({ hook_event_name: "SessionStart", source: "startup" });
		expect(pendingFailureExists()).toBe(false);
	});

	it("discards the held failure when the session ends", async () => {
		writeCodexJob("running");
		expect((await hook({ hook_event_name: "StopFailure" }))?.eventType).toBe(
			"SubagentActive",
		);

		expect(await hook({ hook_event_name: "SessionEnd" })).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "session-end",
		});
		expect(pendingFailureExists()).toBe(false);
	});

	it("parks the failure even when the abort clears the last open question and upgrades the dot to Start", async () => {
		writeCodexJob("running");
		// A main-loop question is open when the API aborts; the abort kills it, so
		// the central red guard upgrades the codex hold to Start. The failure is
		// still only DEFERRED — reporting "failed" here would alert twice.
		await hook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" });
		expect(await hook({ hook_event_name: "StopFailure" })).toEqual({
			eventType: "Start",
			lifecycleOutcome: "hold",
		});
		expect(pendingFailureExists()).toBe(true);

		writeCodexJob("completed");
		expect(
			(await hook({ hook_event_name: "Stop", background_tasks: [] }))
				?.eventType,
		).toBe("Failed");
	});
});

// (TEAM-ENTRY-BIND) A teammate background_tasks entry carries only
// {id, type, status, description}, and the description is the spawn prompt's
// first ~50 characters. Leads template that preamble, so the (TEAM-ENTRY-MATCH)
// prefix join collapses every teammate a session ever spawned into one bucket
// and the "every matching name is idle" rule becomes unsatisfiable — which is
// how a lead latched yellow for 27 minutes with one teammate that had already
// finished (live 2026-08-18, terminal e05d0634, entry tbo5b8zl8: the teammate
// idled at 14:50:35Z, the turn-end Stop fired 6s later with the ledger already
// reading idle, and seven unrelated same-preamble names kept the entry).
describe("superset-notify teammate entry binding", () => {
	// Exactly the shape that broke: 50 characters of identical boilerplate, so
	// every teammate in the session shares one description.
	const PREAMBLE = "Repo: C:\\Users\\khair\\.superset\\worktrees\\648ba672-";

	let transcript = "";

	beforeEach(() => {
		transcript = path.join(home, "lead.jsonl");
		fs.writeFileSync(transcript, "");
	});

	function append(content: unknown): void {
		fs.appendFileSync(
			transcript,
			`${JSON.stringify({ message: { content, role: "assistant" } })}\n`,
		);
	}

	/** A named non-fork Agent spawn, as the lead transcript records it. */
	function spawnTyped(
		name: string,
		subagentType: string,
		description?: string,
		prompt = `${PREAMBLE} work assigned to ${name}`,
	): void {
		append([
			{
				id: `tu-${name}`,
				input: {
					description,
					name,
					prompt,
					subagent_type: subagentType,
				},
				name: "Agent",
				type: "tool_use",
			},
		]);
	}

	function spawn(name: string): void {
		spawnTyped(name, "claude");
	}

	/** The per-terminal ledger cache the hook maintains. */
	function teamStateFile(): string {
		return path.join(
			home,
			".superset",
			"agent-subagent-running",
			`${TERMINAL_ID}.teamstate.json`,
		);
	}

	function writeV5TeamState(input: {
		entryNames: Record<string, string[]>;
		name: string;
		prompt?: string;
		seenIds: string[];
	}): void {
		fs.mkdirSync(path.dirname(teamStateFile()), { recursive: true });
		fs.writeFileSync(
			teamStateFile(),
			JSON.stringify({
				entryNames: input.entryNames,
				forkTools: {},
				offset: fs.statSync(transcript).size,
				path: transcript,
				prompts: { [input.name]: input.prompt ?? PREAMBLE },
				seenIds: input.seenIds,
				state: { [input.name]: "active" },
				version: 5,
			}),
		);
	}

	function say(text: string): void {
		append([{ text, type: "text" }]);
	}

	function reports(name: string): void {
		say(`<agent-message from="${name}">here is my report</agent-message>`);
	}

	function idles(name: string): void {
		say(
			`<teammate-message teammate_id="${name}">{"type":"idle_notification"}</teammate-message>`,
		);
	}

	function entry(
		id: string,
		description = `${PREAMBLE}...`,
	): Record<string, unknown> {
		return {
			description,
			id,
			status: "running",
			type: "teammate",
		};
	}

	function stopEntries(
		...entries: Array<Record<string, unknown>>
	): Promise<Post | undefined> {
		return hook({
			background_tasks: entries,
			hook_event_name: "Stop",
			transcript_path: transcript,
		});
	}

	/** One turn end carrying the running teammate set. */
	function stop(...ids: string[]): Promise<Post | undefined> {
		return stopEntries(...ids.map((id) => entry(id)));
	}

	function stopEntry(
		id: string,
		description: string,
	): Promise<Post | undefined> {
		return stopEntries(entry(id, description));
	}

	async function establishCausalBoundary(
		source: "startup" | "clear" = "startup",
	): Promise<void> {
		const offset = fs.statSync(transcript).size;
		expect(
			await hook({
				hook_event_name: "SessionStart",
				source,
				transcript_path: transcript,
			}),
		).toBeUndefined();
		const cache = JSON.parse(fs.readFileSync(teamStateFile(), "utf8")) as {
			offset: number;
			path: string;
			trustedEntryIds: string[];
			version: number;
		};
		expect(cache).toMatchObject({
			offset,
			path: transcript,
			trustedEntryIds: [],
			version: 7,
		});
	}

	it("finalizes green from the last SubagentStop after a Stop held yellow for a zombie teammate row", async () => {
		// (SENTINEL-HOLD) The 2026-08-22 incident, verbatim: the turn's final
		// Stop holds yellow for a teammate row the ledger cannot drop, then the
		// last SubagentStop arrives after the zombie set has been idle past the
		// (BG-STALE) window. The old code removed .mainstopped during the held
		// Stop, so this SubagentStop silently no-op'd and the dot stayed yellow
		// forever; it must now finalize green.
		expect((await stop("tZOMBIE"))?.eventType).toBe("SubagentActive");

		const bgActive = path.join(
			home,
			".superset",
			"agent-subagent-running",
			`${TERMINAL_ID}.bgactive`,
		);
		const stale = new Date(Date.now() - 20 * 60_000);
		fs.utimesSync(bgActive, stale, stale);

		expect(
			await hook({
				background_tasks: [entry("tZOMBIE")],
				hook_event_name: "SubagentStop",
				transcript_path: transcript,
			}),
		).toEqual({ eventType: "Stop", lifecycleOutcome: "ready" });
	});

	it("marks a TaskStop'd teammate idle once its tool result confirms the stop", async () => {
		// (TEAM-TASKSTOP) A teammate stopped via the TaskStop tool never sends an
		// idle_notification; before the fix its ledger entry latched "active"
		// forever and the lead could never green. The idle lands only on the
		// confirmed (non-error) tool result — the request alone proves nothing.
		await establishCausalBoundary();
		const description = "Implement the finalized plan";
		spawnTyped("implementer", "general-purpose", description);
		reports("implementer");
		expect((await stopEntry("tIMPL", description))?.eventType).toBe(
			"SubagentActive",
		);

		append([
			{
				id: "tu-taskstop",
				input: { task_id: "implementer@team" },
				name: "TaskStop",
				type: "tool_use",
			},
		]);
		// Request alone: still active, still yellow.
		expect((await stopEntry("tIMPL", description))?.eventType).toBe(
			"SubagentActive",
		);

		append([
			{ tool_use_id: "tu-taskstop", type: "tool_result" },
		]);
		expect(await stopEntry("tIMPL", description)).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});

	it("keeps a teammate active when its TaskStop errored", async () => {
		await establishCausalBoundary();
		const description = "Implement the risky plan";
		spawnTyped("survivor", "general-purpose", description);
		expect((await stopEntry("tSURV", description))?.eventType).toBe(
			"SubagentActive",
		);

		append([
			{
				id: "tu-failstop",
				input: { task_id: "survivor" },
				name: "TaskStop",
				type: "tool_use",
			},
		]);
		append([
			{ is_error: true, tool_use_id: "tu-failstop", type: "tool_result" },
		]);
		expect((await stopEntry("tSURV", description))?.eventType).toBe(
			"SubagentActive",
		);
	});

	it("keeps a later same-description row bound to its true spawner despite consumption order", async () => {
		// (TEAM-SPAWN-CREDIT) Slot consumption is front-first but rows are not
		// listed in spawn order: a fast-finishing sibling must not strip a
		// still-working teammate's name from its own candidate set.
		await establishCausalBoundary();
		const description = "Quality review, single angle";
		for (const name of ["simp-a", "simp-b", "simp-c"]) {
			spawnTyped(name, "general-purpose", description);
		}
		expect((await stopEntry("tC", description))?.eventType).toBe(
			"SubagentActive",
		);
		idles("simp-b");
		idles("simp-c");
		// simp-a is still working; its row appears only now and must keep it.
		expect((await stopEntry("tA", description))?.eventType).toBe(
			"SubagentActive",
		);
		idles("simp-a");
		expect(await stopEntry("tA", description)).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});

	it("trusts a row first listed after an earlier turn-end consumed its spawn delta", async () => {
		// (TEAM-SPAWN-CREDIT) The dominant real-session shape: a turn-end fires
		// seconds after the spawn and consumes the transcript delta holding it,
		// while the harness lists the new row only in a LATER payload. The old
		// same-delta rule left such rows permanently untrusted (both 2026-08-22
		// stuck sessions ended with trustedEntryIds=[]).
		await establishCausalBoundary();
		const description = "Pull New Relic logs for alerts";
		spawnTyped("logs-investigator", "general-purpose", description);
		// This turn-end consumes the spawn's delta; the row is not listed yet.
		expect(await stopEntries()).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});

		// The row appears for the first time only now — and must still bind.
		expect((await stopEntry("tLATE", description))?.eventType).toBe(
			"SubagentActive",
		);
		idles("logs-investigator");
		expect(await stopEntry("tLATE", description)).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});

	it("greens the lead when its last teammate idles, despite same-preamble names stuck active", async () => {
		// Three earlier teammates whose last transcript trace is a report, never an
		// idle_notification: the ledger pins them "active" forever, and every one of
		// them shares the running entry's description.
		for (const name of ["fix-planner", "ops-ship-march", "browser-probe"]) {
			spawn(name);
			reports(name);
		}
		expect((await stop("tOLD1", "tOLD2", "tOLD3"))?.eventType).toBe(
			"SubagentActive",
		);

		// Those three finish (their entries leave the payload) and one new teammate
		// starts. Its entry is bound to it because it is the only new id and the
		// only spawn since the last snapshot.
		spawn("grapey-fix");
		expect((await stop("tbo5b8zl8"))?.eventType).toBe("SubagentActive");

		// The last teammate idles. This is the transition that was being missed.
		idles("grapey-fix");
		expect(await stop("tbo5b8zl8")).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});

	it("preserves resume and compact caches, then keeps cache-loss history untrusted", async () => {
		await establishCausalBoundary();
		const description = "Historical cold-scan review";
		spawnTyped("historical-review", "general-purpose", description);
		expect((await stopEntry("tHISTORICAL", description))?.eventType).toBe(
			"SubagentActive",
		);
		idles("historical-review");
		expect(await stopEntry("tHISTORICAL", description)).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});

		const preservedCache = fs.readFileSync(teamStateFile(), "utf8");
		for (const source of ["resume", "compact"] as const) {
			expect(
				await hook({
					hook_event_name: "SessionStart",
					source,
					transcript_path: transcript,
				}),
			).toBeUndefined();
			expect(fs.readFileSync(teamStateFile(), "utf8")).toBe(preservedCache);
		}

		fs.rmSync(teamStateFile());
		expect(
			await hook({
				hook_event_name: "SessionStart",
				source: "resume",
				transcript_path: transcript,
			}),
		).toBeUndefined();
		expect(fs.existsSync(teamStateFile())).toBe(false);

		expect((await stopEntry("tFOREIGNCOLD", description))?.eventType).toBe(
			"SubagentActive",
		);
		const cache = JSON.parse(fs.readFileSync(teamStateFile(), "utf8")) as {
			trustedEntryIds: string[];
		};
		expect(cache.trustedEntryIds).toEqual([]);
	});

	it("matches ordinary, short, and long explicit descriptions", async () => {
		await establishCausalBoundary();
		for (const [name, id, description] of [
			["dose-fixer", "tDOSE", "Fix dose-normalise regression"],
			["short-fixer", "tSHORT", "Fix UI bug"],
			["ellipsis-fixer", "tELLIPSIS", "Review logs..."],
			["long-fixer", "tLONG", "L".repeat(240)],
		] as const) {
			spawnTyped(name, "general-purpose", description);
			expect((await stopEntry(id, description))?.eventType).toBe(
				"SubagentActive",
			);
			idles(name);
			expect(await stopEntry(id, description)).toEqual({
				eventType: "Stop",
				lifecycleOutcome: "ready",
			});
		}
	});

	it("binds a spawn that idles before its first Stop", async () => {
		await establishCausalBoundary();
		const description = "Review and report in one delta";
		spawnTyped("fast-review", "general-purpose", description);
		idles("fast-review");

		expect(await stopEntry("tFAST", description)).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});

	it("starts at offset zero when startup precedes transcript creation", async () => {
		fs.rmSync(transcript);
		expect(
			await hook({
				hook_event_name: "SessionStart",
				source: "startup",
				transcript_path: transcript,
			}),
		).toBeUndefined();
		const cache = JSON.parse(fs.readFileSync(teamStateFile(), "utf8")) as {
			offset: number;
			path: string;
			version: number;
		};
		expect(cache).toMatchObject({ offset: 0, path: transcript, version: 7 });

		const description = "First task after transcript creation";
		spawnTyped("startup-worker", "general-purpose", description);
		idles("startup-worker");
		expect(await stopEntry("tSTARTUP", description)).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});

	it("starts clear sessions after transcript history already present", async () => {
		say("branched transcript history");
		await establishCausalBoundary("clear");
		const description = "First task after clear";
		spawnTyped("clear-worker", "general-purpose", description);
		idles("clear-worker");

		expect(await stopEntry("tCLEAR", description)).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});

	it("defers a description row until a partial spawn record is complete", async () => {
		const description = "Review partial transcript";
		const record = JSON.stringify({
			message: {
				content: [
					{
						id: "tu-partial",
						input: {
							description,
							name: "partial-review",
							prompt: "Review partial transcript in detail",
							subagent_type: "general-purpose",
						},
						name: "Agent",
						type: "tool_use",
					},
				],
				role: "assistant",
			},
		});
		fs.appendFileSync(transcript, record);
		expect((await stopEntry("tPARTIAL", description))?.eventType).toBe(
			"SubagentActive",
		);
		fs.appendFileSync(transcript, "\n");
		expect((await stopEntry("tPARTIAL", description))?.eventType).toBe(
			"SubagentActive",
		);
		idles("partial-review");
		expect(await stopEntry("tPARTIAL", description)).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});

	it("keeps a complete spawn pending while a later transcript record is partial", async () => {
		const description = "Review before partial tail";
		spawnTyped("before-tail", "general-purpose", description);
		fs.appendFileSync(transcript, '{"message":');

		expect((await stopEntry("tBEFORETAIL", description))?.eventType).toBe(
			"SubagentActive",
		);
		fs.appendFileSync(transcript, '{"content":[]}}\n');
		expect((await stopEntry("tBEFORETAIL", description))?.eventType).toBe(
			"SubagentActive",
		);
		idles("before-tail");
		expect(await stopEntry("tBEFORETAIL", description)).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});

	it("keeps a trusted row yellow when a wake precedes a partial tail", async () => {
		await establishCausalBoundary();
		const description = "Wake before partial tail";
		spawnTyped("woken-worker", "general-purpose", description);
		expect((await stopEntry("tWOKEN", description))?.eventType).toBe(
			"SubagentActive",
		);
		idles("woken-worker");
		expect(await stopEntry("tWOKEN", description)).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});

		reports("woken-worker");
		fs.appendFileSync(transcript, '{"message":');
		expect((await stopEntry("tWOKEN", description))?.eventType).toBe(
			"SubagentActive",
		);
		fs.appendFileSync(transcript, '{"content":[]}}\n');
		expect((await stopEntry("tWOKEN", description))?.eventType).toBe(
			"SubagentActive",
		);
	});

	it("keeps match history when a teammate name is reused", async () => {
		await establishCausalBoundary();
		spawnTyped("worker", "general-purpose", "First task");
		expect((await stopEntry("tFIRST", "First task"))?.eventType).toBe(
			"SubagentActive",
		);
		idles("worker");
		expect(await stopEntry("tFIRST", "First task")).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});

		spawnTyped("worker", "general-purpose", "Second task");
		expect(
			(
				await stopEntries(
					entry("tFIRST", "First task"),
					entry("tSECOND", "Second task"),
				)
			)?.eventType,
		).toBe("SubagentActive");
		idles("worker");
		expect(
			await stopEntries(
				entry("tFIRST", "First task"),
				entry("tSECOND", "Second task"),
			),
		).toEqual({ eventType: "Stop", lifecycleOutcome: "ready" });
	});

	it("retains an old description key while its trusted same-name row stays live", async () => {
		await establishCausalBoundary();
		const descriptions = Array.from(
			{ length: 10 },
			(_, index) => `Same-name task ${index + 1}`,
		);
		spawnTyped("worker", "general-purpose", descriptions[0]);
		expect((await stopEntry("tFIRST", descriptions[0]))?.eventType).toBe(
			"SubagentActive",
		);

		for (let index = 1; index < 9; index++) {
			spawnTyped("worker", "general-purpose", descriptions[index]);
			expect(
				(
					await stopEntries(
						entry("tFIRST", descriptions[0]),
						entry(`t${index + 1}`, descriptions[index]),
					)
				)?.eventType,
			).toBe("SubagentActive");
		}

		let cache = JSON.parse(fs.readFileSync(teamStateFile(), "utf8")) as {
			matchKeys: Record<string, { descriptions: string[] }>;
		};
		expect(cache.matchKeys.worker.descriptions).toContain(descriptions[0]);
		expect(cache.matchKeys.worker.descriptions).toHaveLength(9);

		idles("worker");
		expect(await stopEntry("tFIRST", descriptions[0])).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});

		// Once tFIRST leaves the live set, the old key is no longer protected and
		// the normal eight-item cap applies on the next ledger update.
		spawnTyped("worker", "general-purpose", descriptions[9]);
		expect((await stopEntry("tTENTH", descriptions[9]))?.eventType).toBe(
			"SubagentActive",
		);
		cache = JSON.parse(fs.readFileSync(teamStateFile(), "utf8")) as {
			matchKeys: Record<string, { descriptions: string[] }>;
		};
		expect(cache.matchKeys.worker.descriptions).not.toContain(descriptions[0]);
		expect(cache.matchKeys.worker.descriptions).toHaveLength(8);
	});

	it("keeps an unrelated active prompt out of an exact ellipsis match", async () => {
		await establishCausalBoundary();
		const description = "Review release logs...";
		spawnTyped(
			"prompt-holder",
			"claude",
			undefined,
			"Review release logs before publishing",
		);
		spawnTyped("ellipsis-review", "general-purpose", description);
		expect((await stopEntry("tELLIPSIS2", description))?.eventType).toBe(
			"SubagentActive",
		);
		idles("ellipsis-review");
		expect(await stopEntry("tELLIPSIS2", description)).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});

	it("binds a new row to its causal duplicate-description spawn", async () => {
		const sharedDescription = "Shared review description";
		spawnTyped("old-active", "general-purpose", sharedDescription);
		spawnTyped("anchor", "general-purpose", "Anchor task");
		expect((await stopEntry("tANCHOR", "Anchor task"))?.eventType).toBe(
			"SubagentActive",
		);

		spawnTyped("current-review", "general-purpose", sharedDescription);
		expect((await stopEntry("tCURRENT", sharedDescription))?.eventType).toBe(
			"SubagentActive",
		);
		idles("current-review");
		expect(await stopEntry("tCURRENT", sharedDescription)).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});

	it("keeps same-description rows untrusted when one spawn cannot account for the batch", async () => {
		const description = "Shared workflow review";
		spawnTyped("known-review", "general-purpose", description);

		// The second row was created inside a workflow and has no lead-transcript
		// spawn. Exact text alone cannot identify which row belongs to the one
		// observed spawn, so both rows must stay in the safe yellow direction.
		expect(
			(
				await stopEntries(
					entry("tKNOWN", description),
					entry("tWORKFLOW", description),
				)
			)?.eventType,
		).toBe("SubagentActive");
		idles("known-review");
		expect(
			(
				await stopEntries(
					entry("tKNOWN", description),
					entry("tWORKFLOW", description),
				)
			)?.eventType,
		).toBe("SubagentActive");
	});

	it("does not spend one spawn on both exact and legacy first-seen rows", async () => {
		const exactDescription = "Known exact review";
		spawn("older-active");
		reports("older-active");
		expect((await stop("tOLDER"))?.eventType).toBe("SubagentActive");

		// One new spawn produces one exact-description row. A workflow also
		// contributes a legacy prompt-head row in the same first-seen snapshot.
		// The exact binder consumes the only causal spawn; the legacy binder must
		// count both rows and refuse to narrow the second row onto that spawn.
		spawnTyped("known-review", "claude", exactDescription);
		expect(
			(await stopEntries(entry("tEXACT", exactDescription), entry("tLEGACY")))
				?.eventType,
		).toBe("SubagentActive");

		idles("known-review");
		// A wrong legacy binding drops both rows here and false-greens over the
		// still-active older name that shares the legacy prompt prefix.
		expect(
			(await stopEntries(entry("tEXACT", exactDescription), entry("tLEGACY")))
				?.eventType,
		).toBe("SubagentActive");
	});

	it("retains legacy prompt matching without a trailing ellipsis", async () => {
		const prompt = "Review one old prompt";
		spawnTyped("legacy-review", "claude", undefined, prompt);
		expect((await stopEntry("tLEGACY", prompt))?.eventType).toBe(
			"SubagentActive",
		);
		idles("legacy-review");
		expect(await stopEntry("tLEGACY", prompt)).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});

	it("does not match a foreign legacy row against an older prompt for the same name", async () => {
		const firstPrompt = "Review legacy release one";
		const secondPrompt = "Review legacy release two";
		spawnTyped("legacy-worker", "claude", undefined, firstPrompt);
		expect((await stopEntry("tLEGACY1", firstPrompt))?.eventType).toBe(
			"SubagentActive",
		);
		idles("legacy-worker");
		expect(await stopEntry("tLEGACY1", firstPrompt)).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});

		spawnTyped("legacy-worker", "claude", undefined, secondPrompt);
		expect((await stopEntry("tLEGACY2", secondPrompt))?.eventType).toBe(
			"SubagentActive",
		);
		idles("legacy-worker");
		expect(await stopEntry("tLEGACY2", secondPrompt)).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});

		// No new spawn caused this row. Matching the name's historical P1 would
		// inherit its idle state and false-green a workflow-created live row.
		expect((await stopEntry("tFOREIGNP1", firstPrompt))?.eventType).toBe(
			"SubagentActive",
		);
	});

	it("does not bind a row to a historical same-description spawn", async () => {
		const description = "Precommit code review";
		spawnTyped("finished-review", "general-purpose", description);
		idles("finished-review");
		spawnTyped("anchor", "general-purpose", "Anchor current scan");
		expect((await stopEntry("tANCHOR", "Anchor current scan"))?.eventType).toBe(
			"SubagentActive",
		);

		expect((await stopEntry("tSUBSTITUTE", description))?.eventType).toBe(
			"SubagentActive",
		);
	});

	it("keeps an unbound live row yellow when it reuses an old idle description", async () => {
		await establishCausalBoundary();
		const description = "Precommit code review";
		spawnTyped("old-review", "claude", description);
		expect((await stopEntry("tOLD", description))?.eventType).toBe(
			"SubagentActive",
		);
		idles("old-review");
		expect(await stopEntry("tOLD", description)).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});

		// A workflow-created row has no matching Agent spawn in this transcript.
		// Reusing the old description must not inherit its idle state.
		expect((await stopEntry("tFOREIGN", description))?.eventType).toBe(
			"SubagentActive",
		);
	});

	it("stays yellow when one of two running teammates finishes and the other is still working", async () => {
		spawn("first");
		expect((await stop("tA"))?.eventType).toBe("SubagentActive");
		spawn("second");
		expect((await stop("tA", "tB"))?.eventType).toBe("SubagentActive");

		// One down, one still running: the dot must NOT green.
		idles("first");
		expect((await stop("tA", "tB"))?.eventType).toBe("SubagentActive");

		// Only once the second idles too does the lead green.
		idles("second");
		expect(await stop("tA", "tB")).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});

	it("keeps an unbindable entry yellow rather than narrowing onto the wrong name", async () => {
		// An earlier teammate that is still working and shares the preamble.
		spawn("other");
		reports("other");
		expect((await stop("tOTHER"))?.eventType).toBe("SubagentActive");

		// Now TWO new entries appear where only one spawn was observed — the second
		// was created by something the lead transcript never saw (a workflow
		// spawning its own teammate). No assignment of two entries to one spawn is
		// trustworthy, so neither is bound and the prefix rule governs both.
		spawn("known");
		expect((await stop("tKNOWN", "tFOREIGN"))?.eventType).toBe(
			"SubagentActive",
		);

		// Had either entry been narrowed onto "known", idling it would green the
		// lead while the foreign teammate is still running.
		idles("known");
		expect((await stop("tKNOWN", "tFOREIGN"))?.eventType).toBe(
			"SubagentActive",
		);
	});

	it("treats a teammate that reports and idles in one delivered blob as idle", async () => {
		// Both tags arrive in a single injected text block. The pre-v4 ledger
		// scanned every teammate-message first and every agent-message second, so
		// the report won on tag KIND rather than position and the name latched
		// active forever.
		spawn("chatty");
		expect((await stop("tC"))?.eventType).toBe("SubagentActive");

		say(
			`<agent-message from="chatty">final report</agent-message>` +
				`<teammate-message teammate_id="chatty">{"type":"idle_notification"}</teammate-message>`,
		);
		expect(await stop("tC")).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});

	it("re-asserts yellow when a bound teammate is woken again after idling", async () => {
		spawn("worker");
		idles("worker");
		expect(await stop("tW")).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});

		say(
			`<agent-message from="worker">picking the task back up</agent-message>`,
		);
		expect((await stop("tW"))?.eventType).toBe("SubagentActive");
	});

	it("keeps the incident's older entries yellow when the final Stop still lists them", async () => {
		// Same replay as the headline incident, except the harness keeps
		// reporting the finished teammates' entries as "running" — the very
		// premise this whole feature exists for. Nothing proves those three are
		// finished, so their entries must hold the lead yellow even though the
		// one teammate that idled releases its own entry.
		for (const name of ["fix-planner", "ops-ship-march", "browser-probe"]) {
			spawn(name);
			reports(name);
		}
		expect((await stop("tOLD1", "tOLD2", "tOLD3"))?.eventType).toBe(
			"SubagentActive",
		);

		spawn("grapey-fix");
		expect(
			(await stop("tOLD1", "tOLD2", "tOLD3", "tbo5b8zl8"))?.eventType,
		).toBe("SubagentActive");

		idles("grapey-fix");
		expect(
			(await stop("tOLD1", "tOLD2", "tOLD3", "tbo5b8zl8"))?.eventType,
		).toBe("SubagentActive");
	});

	it("expires a spawn that produced no entry instead of folding it into a later binding", async () => {
		spawn("anchor");
		expect((await stop("tA"))?.eventType).toBe("SubagentActive");

		// A teammate that finished inside its own turn: no entry ever appears
		// for it, so the spawn is never consumed by a binding. It must not
		// survive its ledger run — as a stale pending it would join the NEXT
		// entry's batch and, never having idle-notified, hold that entry
		// yellow for the rest of the session.
		spawn("vanisher");
		expect((await stop("tA"))?.eventType).toBe("SubagentActive");

		spawn("worker");
		expect((await stop("tA", "tW"))?.eventType).toBe("SubagentActive");

		idles("anchor");
		idles("worker");
		expect(await stop("tA", "tW")).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});

	it("keeps a never-idling subagent-type spawn out of the binding batch", async () => {
		spawn("anchor");
		expect((await stop("tA"))?.eventType).toBe("SubagentActive");

		// One burst spawns a general-purpose agent (finishes via a tool result,
		// never idle-notifies, so its ledger state stays "active" forever) and a
		// real teammate. Only the teammate may become a binding candidate.
		spawnTyped("probe", "general-purpose");
		spawn("worker");
		expect((await stop("tA", "tW"))?.eventType).toBe("SubagentActive");

		idles("anchor");
		idles("worker");
		expect(await stop("tA", "tW")).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});

	it("never binds an entry id that has been listed before", async () => {
		spawn("solo");
		expect((await stop("tS"))?.eventType).toBe("SubagentActive");

		// tS drops out of one snapshot (an unrelated entry is all that is
		// listed), then the harness lists it again. It is NOT new work.
		expect((await stop("tX"))?.eventType).toBe("SubagentActive");

		spawn("later");
		expect((await stop("tS"))?.eventType).toBe("SubagentActive");

		idles("later");
		// Binding the re-listed tS to the newer spawn would drop it here while
		// "solo" — the teammate it actually belongs to — is still working.
		expect((await stop("tS"))?.eventType).toBe("SubagentActive");
	});

	it("serializes overlapping cache transactions so a stale writer cannot erase a newer binding", async () => {
		await establishCausalBoundary();
		const firstDescription = "First concurrent review";
		const secondDescription = "Second concurrent review";
		const cacheFile = teamStateFile();
		const lockFile = `${cacheFile}.lock`;
		const pauseReady = path.join(home, "stale-writer-ready");
		const pauseRelease = path.join(home, "stale-writer-release");
		const lockAttempted = path.join(home, "new-writer-lock-attempted");
		const newWriterDone = path.join(home, "new-writer-done");
		const pausingWrapper = path.join(home, "pause-before-replace.py");
		const observingWrapper = path.join(home, "observe-lock.py");
		fs.writeFileSync(
			pausingWrapper,
			`import os
import pathlib
import runpy
import sys
import time

real_replace = os.replace
paused = False

def replace(src, dst):
    global paused
    if not paused and os.path.abspath(os.fspath(dst)) == os.path.abspath(os.environ["TEST_CACHE_FILE"]):
        paused = True
        pathlib.Path(os.environ["TEST_PAUSE_READY"]).write_text("ready", encoding="utf-8")
        deadline = time.monotonic() + 5.0
        release = pathlib.Path(os.environ["TEST_PAUSE_RELEASE"])
        while not release.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        if not release.exists():
            raise RuntimeError("timed out waiting to release stale writer")
    return real_replace(src, dst)

os.replace = replace
runpy.run_path(sys.argv[1], run_name="__main__")
`,
		);
		fs.writeFileSync(
			observingWrapper,
			`import builtins
import os
import pathlib
import runpy
import sys

real_open = builtins.open
announced = False

def observed_open(file, *args, **kwargs):
    global announced
    if not announced and os.path.abspath(os.fspath(file)) == os.path.abspath(os.environ["TEST_LOCK_FILE"]):
        announced = True
        pathlib.Path(os.environ["TEST_LOCK_ATTEMPTED"]).write_text("attempted", encoding="utf-8")
    return real_open(file, *args, **kwargs)

builtins.open = observed_open
runpy.run_path(sys.argv[1], run_name="__main__")
pathlib.Path(os.environ["TEST_NEW_WRITER_DONE"]).write_text("done", encoding="utf-8")
`,
		);
		const waitForFile = async (file: string): Promise<void> => {
			const deadline = Date.now() + 5_000;
			while (!fs.existsSync(file)) {
				if (Date.now() >= deadline)
					throw new Error(`Timed out waiting for ${file}`);
				await Bun.sleep(10);
			}
		};

		spawnTyped("first-worker", "general-purpose", firstDescription);
		const staleWriter = hook(
			{
				background_tasks: [entry("tFIRST", firstDescription)],
				hook_event_name: "Stop",
				transcript_path: transcript,
			},
			{
				TEST_CACHE_FILE: cacheFile,
				TEST_PAUSE_READY: pauseReady,
				TEST_PAUSE_RELEASE: pauseRelease,
			},
			[PYTHON, pausingWrapper, scriptPath],
		);
		await waitForFile(pauseReady);

		spawnTyped("second-worker", "general-purpose", secondDescription);
		const newerWriter = hook(
			{
				background_tasks: [
					entry("tFIRST", firstDescription),
					entry("tSECOND", secondDescription),
				],
				hook_event_name: "Stop",
				transcript_path: transcript,
			},
			{
				TEST_LOCK_ATTEMPTED: lockAttempted,
				TEST_LOCK_FILE: lockFile,
				TEST_NEW_WRITER_DONE: newWriterDone,
			},
			[PYTHON, observingWrapper, scriptPath],
		);
		await waitForFile(lockAttempted);
		expect(fs.existsSync(newWriterDone)).toBe(false);

		fs.writeFileSync(pauseRelease, "release");
		await Promise.all([staleWriter, newerWriter]);
		expect(fs.existsSync(newWriterDone)).toBe(true);

		idles("first-worker");
		idles("second-worker");
		expect(
			await stopEntries(
				entry("tFIRST", firstDescription),
				entry("tSECOND", secondDescription),
			),
		).toEqual({ eventType: "Stop", lifecycleOutcome: "ready" });
	});

	it("migrates a v5 causal binding before matching an explicit description", async () => {
		const description = "Fix dose-normalise regression";
		spawnTyped("migrate-worker", "general-purpose", description);
		idles("migrate-worker");
		writeV5TeamState({
			entryNames: { tMIGRATE: ["migrate-worker"] },
			name: "migrate-worker",
			seenIds: ["tMIGRATE"],
		});

		expect(await stopEntry("tMIGRATE", description)).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
		expect(JSON.parse(fs.readFileSync(teamStateFile(), "utf8")).version).toBe(
			7,
		);
	});

	it("preserves a trusted v5 name through same-description history and a partial tail", async () => {
		const description = "Shared migration description";
		spawnTyped("trusted-worker", "general-purpose", description);
		idles("trusted-worker");
		spawnTyped("active-impostor", "general-purpose", description);
		reports("active-impostor");
		writeV5TeamState({
			entryNames: { tMIGRATE: ["trusted-worker"] },
			name: "trusted-worker",
			seenIds: ["tMIGRATE"],
		});
		fs.appendFileSync(transcript, '{"message":');

		// Migration may reconstruct both names for the same text, but it must keep
		// the causal v5 binding. The partial tail keeps this decision yellow while
		// the migrated cache remains intact for the next complete scan.
		expect((await stopEntry("tMIGRATE", description))?.eventType).toBe(
			"SubagentActive",
		);
		const cache = JSON.parse(fs.readFileSync(teamStateFile(), "utf8")) as {
			entryNames: Record<string, string[]>;
			trustedEntryIds: string[];
			version: number;
		};
		expect(cache.version).toBe(7);
		expect(cache.entryNames.tMIGRATE).toEqual(["trusted-worker"]);
		expect(cache.trustedEntryIds).toEqual(["tMIGRATE"]);
	});

	it("keeps an unbound v5 explicit-description row yellow", async () => {
		const description = "Fix dose-normalise regression";
		spawnTyped("unbound-worker", "general-purpose", description);
		idles("unbound-worker");
		writeV5TeamState({
			entryNames: {},
			name: "unbound-worker",
			seenIds: ["tUNBOUNDV5"],
		});

		// The matching spawn is before the v5 cache offset. Reconstructing its
		// description is useful history, but it is not new causal evidence.
		expect((await stopEntry("tUNBOUNDV5", description))?.eventType).toBe(
			"SubagentActive",
		);
	});

	it("rebuilds v5 prompt history in document order before latest-only matching", async () => {
		const firstPrompt = "Review migration prompt one";
		const secondPrompt = "Review migration prompt two";
		spawnTyped("migration-worker", "claude", undefined, firstPrompt);
		idles("migration-worker");
		spawnTyped("migration-worker", "claude", undefined, secondPrompt);
		idles("migration-worker");
		writeV5TeamState({
			entryNames: {},
			name: "migration-worker",
			prompt: secondPrompt,
			seenIds: ["tMIGRATIONSEED"],
		});

		// A foreign row matching stale P1 must not inherit the idle worker state.
		expect((await stopEntry("tFOREIGNP1", firstPrompt))?.eventType).toBe(
			"SubagentActive",
		);
		const cache = JSON.parse(fs.readFileSync(teamStateFile(), "utf8")) as {
			matchKeys: Record<string, { prompts: string[] }>;
		};
		expect(cache.matchKeys["migration-worker"]?.prompts).toEqual([
			firstPrompt,
			secondPrompt,
		]);
	});

	it("never rebinds a previously-seen v5 row to a later same-description spawn", async () => {
		const description = "Unread migration review";
		spawnTyped("historical-worker", "general-purpose", description);
		reports("historical-worker");
		writeV5TeamState({
			entryNames: {},
			name: "historical-worker",
			seenIds: ["tUNBOUNDV5"],
		});

		// This later worker can finish without producing a row. It cannot own the
		// already-seen tUNBOUNDV5 row, whose historical worker is still active.
		spawnTyped("new-worker", "general-purpose", description);
		idles("new-worker");
		expect((await stopEntry("tUNBOUNDV5", description))?.eventType).toBe(
			"SubagentActive",
		);
		const cache = JSON.parse(fs.readFileSync(teamStateFile(), "utf8")) as {
			trustedEntryIds: string[];
		};
		expect(cache.trustedEntryIds).toEqual([]);
	});

	it("trusts a new migration row from an unread causal spawn", async () => {
		const description = "New migration review";
		spawnTyped("historical-worker", "general-purpose", "Historical task");
		idles("historical-worker");
		writeV5TeamState({
			entryNames: {},
			name: "historical-worker",
			seenIds: ["tHISTORICAL"],
		});

		spawnTyped("new-worker", "general-purpose", description);
		expect((await stopEntry("tNEWV5", description))?.eventType).toBe(
			"SubagentActive",
		);
		idles("new-worker");
		expect(await stopEntry("tNEWV5", description)).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});

	it("preserves a trusted v5 row without trusting a foreign live workflow row", async () => {
		const description = "Fix dose-normalise regression";
		spawnTyped("migrate-worker", "general-purpose", description);
		idles("migrate-worker");
		writeV5TeamState({
			entryNames: { tTRUSTEDV5: ["migrate-worker"] },
			name: "migrate-worker",
			seenIds: ["tTRUSTEDV5", "tWORKFLOWV5"],
		});

		expect(
			(
				await stopEntries(
					entry("tTRUSTEDV5", description),
					entry("tWORKFLOWV5", description),
				)
			)?.eventType,
		).toBe("SubagentActive");
		const cache = JSON.parse(fs.readFileSync(teamStateFile(), "utf8")) as {
			trustedEntryIds: string[];
		};
		expect(cache.trustedEntryIds).toEqual(["tTRUSTEDV5"]);
	});

	it("degrades to a coarse keep-everything binding when the ledger cache is lost", async () => {
		spawn("early");
		expect((await stop("tE"))?.eventType).toBe("SubagentActive");
		spawn("late");
		expect((await stop("tE", "tL"))?.eventType).toBe("SubagentActive");

		idles("early");
		fs.rmSync(teamStateFile());

		// The rescan sees the whole spawn history at once, so both entries bind
		// to both names: no narrowing at all, and the still-active "late" holds
		// both. Coarse, never a false green.
		expect((await stop("tE", "tL"))?.eventType).toBe("SubagentActive");

		idles("late");
		expect(await stop("tE", "tL")).toEqual({
			eventType: "Stop",
			lifecycleOutcome: "ready",
		});
	});
});

// (COMPANION-LIFECYCLE-ALERTS) The producer id is the host's duplicate-DELIVERY
// guard: it must be fresh per hook invocation. A seed derived from the payload
// was not — Claude hook payloads carry no timestamp and a Stop payload carries
// no tool_use_id, so every Stop in one session produced an identical id and the
// host dropped every alert after the first as a duplicate.
describe("superset-notify lifecycle producer id", () => {
	const ID_SHAPE = /^[A-Za-z0-9_-]{22}$/;

	it("mints a fresh valid id for every same-session lifecycle event", async () => {
		// Three identical Start/Stop turns in ONE session: the collision case.
		for (let turn = 0; turn < 3; turn++) {
			expect(await hook({ hook_event_name: "UserPromptSubmit" })).toEqual({
				eventType: "Start",
				lifecycleOutcome: "progress",
			});
			expect(
				await hook({ hook_event_name: "Stop", background_tasks: [] }),
			).toEqual({ eventType: "Stop", lifecycleOutcome: "ready" });
		}

		expect(lifecycleEventIds).toHaveLength(6);
		for (const id of lifecycleEventIds) {
			expect(id).toMatch(ID_SHAPE);
		}
		expect(new Set(lifecycleEventIds).size).toBe(6);
	});

	it("mints a fresh id even for byte-identical repeats of one event", async () => {
		// Same event name, same session, no distinguishing payload field at all.
		await hook({ hook_event_name: "Stop", background_tasks: [] });
		await hook({ hook_event_name: "Stop", background_tasks: [] });

		expect(lifecycleEventIds).toHaveLength(2);
		expect(lifecycleEventIds[0]).toMatch(ID_SHAPE);
		expect(lifecycleEventIds[1]).toMatch(ID_SHAPE);
		expect(lifecycleEventIds[0]).not.toBe(lifecycleEventIds[1]);
	});
});

// (HOOK-ENDPOINT-HEAL) The host-service can restart onto a new port; a PTY
// started before that restart keeps the dead URL in its env forever, so every
// dot after the restart is lost unless the hook re-resolves the endpoint from
// the org manifests the host rewrites on every start. Same harness as above —
// real script, real python, throwaway HOME — with several sinks so the probe
// ORDER and the acceptance PREDICATE are observable rather than inferred.
describe("superset-notify hook endpoint failover", () => {
	type SinkMode =
		| "accept"
		| "empty-object"
		| "empty-result"
		| "html"
		| "ignored"
		| "reject-always"
		| "reject-companion"
		| "slow"
		| "truncated";

	interface TestSink {
		/** Whether each POST still carried the companion lifecycle fields. */
		companion: boolean[];
		endpoint: string;
		/** eventType of every POST this sink saw, in arrival order. */
		hits: string[];
		url: string;
	}

	const servers: Array<{ stop: (force?: boolean) => unknown }> = [];

	function makeSink(mode: SinkMode): TestSink {
		const hits: string[] = [];
		const companion: boolean[] = [];
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as {
					json?: {
						companionLifecycleEventId?: string;
						companionQuestion?: unknown;
						eventType?: string;
					};
				};
				hits.push(body.json?.eventType ?? "");
				const carriesCompanion =
					typeof body.json?.companionLifecycleEventId === "string" ||
					body.json?.companionQuestion !== undefined;
				companion.push(carriesCompanion);
				if (mode === "reject-companion" && carriesCompanion) {
					// What the OWNING host does when the capture shape and the
					// route schema disagree: zod rejects the input and tRPC
					// answers 400. It is never a 2xx, which is why the dot's
					// strip-and-retry may not be gated on one.
					return Response.json(
						{ error: { code: -32600, message: "invalid_type" } },
						{ status: 400 },
					);
				}
				if (mode === "reject-always") {
					// The owning host refusing BOTH bodies: the companion one and
					// the stripped dot-only one. Nothing is delivered, whatever
					// else on the machine answers.
					return Response.json(
						{ error: { code: -32600, message: "invalid_type" } },
						{ status: 400 },
					);
				}
				if (mode === "slow") {
					// Longer than the hook's unchanged 1.5s per-request timeout, so
					// the probe budget is exercised deterministically instead of
					// depending on how fast this OS refuses a connection.
					await Bun.sleep(3_000);
				}
				if (mode === "html") {
					return new Response("<html><body>not superset</body></html>", {
						headers: { "content-type": "text/html" },
					});
				}
				if (mode === "truncated") {
					return new Response('{"result":{"data":{"json":{"ignored":fal');
				}
				if (mode === "empty-object") return Response.json({});
				if (mode === "empty-result") return Response.json({ result: {} });
				if (mode === "ignored") {
					return Response.json({
						result: {
							data: {
								json: {
									ignored: true,
									reason: "unknown terminal",
									success: true,
								},
							},
						},
					});
				}
				return Response.json({
					result: { data: { json: { ignored: false, success: true } } },
				});
			},
		});
		servers.push(server);
		const endpoint = `http://127.0.0.1:${server.port}`;
		return {
			companion,
			endpoint,
			hits,
			url: `${endpoint}/trpc/notifications.hook`,
		};
	}

	/** An endpoint nothing listens on: bound to claim the port, then closed. */
	function deadEndpoint(): string {
		const probe = Bun.serve({ fetch: () => new Response("x"), port: 0 });
		const endpoint = `http://127.0.0.1:${probe.port}`;
		probe.stop(true);
		return endpoint;
	}

	afterEach(() => {
		for (const server of servers.splice(0)) server.stop(true);
	});

	/** The manifest the host-service rewrites with its live endpoint on start. */
	function writeHostManifest(
		organizationId: string,
		endpoint: string,
		pid: number = process.pid,
	): void {
		const dir = path.join(home, ".superset", "host", organizationId);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "manifest.json"),
			JSON.stringify({
				authToken: "token",
				endpoint,
				organizationId,
				pid,
				startedAt: Date.now(),
			}),
		);
	}

	function notifyLogPath(): string {
		return path.join(home, ".superset", "agent-notify-hook.log");
	}

	/** Every parsable record in the debug log (rotation pads it with junk). */
	function logRecords(): Array<Record<string, unknown>> {
		if (!fs.existsSync(notifyLogPath())) return [];
		const records: Array<Record<string, unknown>> = [];
		for (const line of fs.readFileSync(notifyLogPath(), "utf-8").split("\n")) {
			if (!line.trim()) continue;
			try {
				records.push(JSON.parse(line));
			} catch {
				// padding written by the rotation test
			}
		}
		return records;
	}

	function recordsWithAction(action: string): Array<Record<string, unknown>> {
		return logRecords().filter((record) => record.action === action);
	}

	function decisionLines(): string[] {
		const file = path.join(home, ".superset", "logs", "dot-decisions.log");
		if (!fs.existsSync(file)) return [];
		return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
	}

	/**
	 * One hook event with an explicit environment, through the same spawn
	 * harness as `hook`. Debug logging is ON (the failover decisions are only
	 * observable through the log); `hook` already blanks SUPERSET_HOME_DIR and
	 * SUPERSET_ORGANIZATION_ID so the real Superset environment this suite runs
	 * inside cannot leak live hosts into the candidate list, and every test here
	 * names its own SUPERSET_HOST_AGENT_HOOK_URL.
	 */
	async function runHook(
		env: Record<string, string>,
		payload: Record<string, unknown> = { hook_event_name: "UserPromptSubmit" },
	): Promise<void> {
		await hook(payload, { SUPERSET_AGENT_WATCHER_DEBUG: "1", ...env });
	}

	it("rotates the debug log at 1MB into a single .1 backup", async () => {
		const live = makeSink("accept");
		fs.mkdirSync(path.join(home, ".superset"), { recursive: true });
		fs.writeFileSync(notifyLogPath(), `${"x".repeat(1_100_000)}\n`);

		await runHook({ SUPERSET_HOST_AGENT_HOOK_URL: live.url });

		const backup = `${notifyLogPath()}.1`;
		expect(fs.existsSync(backup)).toBe(true);
		expect(fs.statSync(backup).size).toBeGreaterThan(1_000_000);
		expect(fs.statSync(notifyLogPath()).size).toBeLessThan(100_000);

		// A second rotation REPLACES the backup rather than growing a chain.
		fs.writeFileSync(notifyLogPath(), `${"y".repeat(1_100_000)}\n`);
		await runHook({ SUPERSET_HOST_AGENT_HOOK_URL: live.url });
		expect(fs.existsSync(backup)).toBe(true);
		expect(fs.existsSync(`${notifyLogPath()}.2`)).toBe(false);
		expect(fs.readFileSync(backup, "utf-8").startsWith("y")).toBe(true);
	}, 20_000);

	it("delivers through an org manifest when the env URL points at a dead port", async () => {
		const live = makeSink("accept");
		writeHostManifest("org-live", live.endpoint);

		await runHook({
			SUPERSET_HOST_AGENT_HOOK_URL: `${deadEndpoint()}/trpc/notifications.hook`,
		});

		expect(live.hits).toEqual(["Start"]);
		const posted = recordsWithAction("posted");
		expect(posted).toHaveLength(1);
		expect(posted[0]?.deliveredUrl).toBe(live.url);
		expect(recordsWithAction("post-error")).toHaveLength(0);
	}, 20_000);

	it("never probes a manifest while the env URL still answers", async () => {
		const live = makeSink("accept");
		const other = makeSink("accept");
		writeHostManifest("org-other", other.endpoint);

		await runHook({ SUPERSET_HOST_AGENT_HOOK_URL: live.url });

		expect(live.hits).toEqual(["Start"]);
		expect(other.hits).toEqual([]);
	}, 20_000);

	it("keeps probing past a host that disowns the terminal and delivers to the one that owns it", async () => {
		const wrongOrg = makeSink("ignored");
		const rightOrg = makeSink("accept");
		writeHostManifest("org-right", rightOrg.endpoint);

		await runHook({
			SUPERSET_HOST_AGENT_HOOK_URL: wrongOrg.url,
			SUPERSET_ORGANIZATION_ID: "org-right",
		});

		expect(wrongOrg.hits).toEqual(["Start"]);
		expect(rightOrg.hits).toEqual(["Start"]);
		expect(recordsWithAction("posted")[0]?.deliveredUrl).toBe(rightOrg.url);
	}, 20_000);

	it("treats every-host-ignored as a delivered no-op: one log line, no error, no companion retry", async () => {
		const envSink = makeSink("ignored");
		const orgSink = makeSink("ignored");
		writeHostManifest("org-ghost", orgSink.endpoint);

		await runHook({ SUPERSET_HOST_AGENT_HOOK_URL: envSink.url });

		// Each candidate probed exactly once — a second hit would mean the
		// companion strip-and-retry fired on an event that was delivered.
		expect(envSink.hits).toEqual(["Start"]);
		expect(orgSink.hits).toEqual(["Start"]);
		expect(envSink.companion).toEqual([true]);
		expect(orgSink.companion).toEqual([true]);

		const ignoredEverywhere = recordsWithAction("ignored-everywhere");
		expect(ignoredEverywhere).toHaveLength(1);
		// (DISPOSE-LIMBO) The host's own reason is the only thing that tells
		// one ghost-terminal cause from another, so the record must carry it.
		expect(ignoredEverywhere[0]?.responseBody).toContain("unknown terminal");
		expect(recordsWithAction("post-error")).toHaveLength(0);
		expect(recordsWithAction("posted")).toHaveLength(0);
		expect(recordsWithAction("companion-rejected-dot-posted")).toHaveLength(0);
	}, 20_000);

	it("rejects malformed and foreign response bodies and keeps probing", async () => {
		const html = makeSink("html");
		const truncated = makeSink("truncated");
		const emptyObject = makeSink("empty-object");
		const emptyResult = makeSink("empty-result");
		const live = makeSink("accept");
		writeHostManifest("org-2-truncated", truncated.endpoint);
		writeHostManifest("org-3-empty-object", emptyObject.endpoint);
		writeHostManifest("org-4-empty-result", emptyResult.endpoint);
		writeHostManifest("org-5-live", live.endpoint);

		await runHook({ SUPERSET_HOST_AGENT_HOOK_URL: html.url });

		for (const sink of [html, truncated, emptyObject, emptyResult, live]) {
			expect(sink.hits).toEqual(["Start"]);
		}
		expect(recordsWithAction("posted")[0]?.deliveredUrl).toBe(live.url);
		expect(recordsWithAction("post-error")).toHaveLength(0);
	}, 20_000);

	it("logs a post-error and one dot-decisions line naming every candidate when nothing answers", async () => {
		const deadEnv = `${deadEndpoint()}/trpc/notifications.hook`;
		const deadOrgA = deadEndpoint();
		const deadOrgB = deadEndpoint();
		writeHostManifest("org-a", deadOrgA);
		writeHostManifest("org-b", deadOrgB);

		await runHook({ SUPERSET_HOST_AGENT_HOOK_URL: deadEnv });

		const errors = recordsWithAction("post-error");
		expect(errors).toHaveLength(1);
		expect(errors[0]?.candidateUrls).toEqual([
			deadEnv,
			`${deadOrgA}/trpc/notifications.hook`,
			`${deadOrgB}/trpc/notifications.hook`,
		]);
		// A stripped-body retry cannot answer where nothing answered at all.
		expect(recordsWithAction("companion-rejected-dot-posted")).toHaveLength(0);

		const failed = decisionLines().filter((line) =>
			line.includes("hook-post-failed"),
		);
		expect(failed).toHaveLength(1);
		for (const url of [deadEnv, deadOrgA, deadOrgB]) {
			expect(failed[0]).toContain(url);
		}
	}, 30_000);

	it("stops probing when the total budget is spent instead of stalling the agent", async () => {
		const slowEnv = makeSink("slow");
		const slowA = makeSink("slow");
		const slowB = makeSink("slow");
		const live = makeSink("accept");
		writeHostManifest("org-1-slow", slowA.endpoint);
		writeHostManifest("org-2-slow", slowB.endpoint);
		writeHostManifest("org-3-live", live.endpoint);

		await runHook({ SUPERSET_HOST_AGENT_HOOK_URL: slowEnv.url });

		// Three 1.5s timeouts spend the 4.0s budget, so the fourth candidate
		// is never attempted.
		expect(slowEnv.hits).toEqual(["Start"]);
		expect(slowA.hits).toEqual(["Start"]);
		expect(slowB.hits).toEqual(["Start"]);
		expect(live.hits).toEqual([]);

		const exhausted = recordsWithAction("hook-probe-budget-exhausted");
		expect(exhausted).toHaveLength(1);
		// Each attempt gets min(1.5s, what is left of the 4.0s budget), so the
		// sweep cannot outlast the budget. Checking the budget only BEFORE each
		// attempt and then handing out a fresh 1.5s overshot it: 4.5s here, and
		// up to ~5.4s when the check lands just under 4.0s.
		expect(exhausted[0]?.elapsedMs as number).toBeLessThanOrEqual(4_200);
		expect(recordsWithAction("post-error")).toHaveLength(1);
		expect(recordsWithAction("posted")).toHaveLength(0);
	}, 30_000);

	it("probes this terminal's own org manifest before the others", async () => {
		const ownOrg = makeSink("accept");
		const otherOrg = makeSink("accept");
		// "org-aaa" sorts first in the glob; the env org id must still win.
		writeHostManifest("org-aaa", otherOrg.endpoint);
		writeHostManifest("org-zzz", ownOrg.endpoint);

		await runHook({
			SUPERSET_HOST_AGENT_HOOK_URL: `${deadEndpoint()}/trpc/notifications.hook`,
			SUPERSET_ORGANIZATION_ID: "org-zzz",
		});

		expect(ownOrg.hits).toEqual(["Start"]);
		expect(otherOrg.hits).toEqual([]);
		expect(recordsWithAction("posted")[0]?.deliveredUrl).toBe(ownOrg.url);
	}, 20_000);

	it("strips the companion fields and retries when the owning host rejects the payload with a 400", async () => {
		const owner = makeSink("reject-companion");

		await runHook({ SUPERSET_HOST_AGENT_HOOK_URL: owner.url });

		// Probed twice: the companion-carrying body (400) and then the
		// dot-only body (accepted). A 4xx is the ONLY way the owning host
		// reports a schema disagreement, so a retry gated on a parsed 2xx
		// never fires and the dot is lost -- the exact regression this retry
		// exists to prevent.
		expect(owner.hits).toEqual(["Start", "Start"]);
		expect(owner.companion).toEqual([true, false]);

		const retried = recordsWithAction("companion-rejected-dot-posted");
		expect(retried).toHaveLength(1);
		expect(retried[0]?.deliveredUrl).toBe(owner.url);
		expect(String(retried[0]?.error)).toContain("400");
		expect(recordsWithAction("post-error")).toHaveLength(0);
		expect(recordsWithAction("ignored-everywhere")).toHaveLength(0);
	}, 20_000);

	it("retries the stripped body when the owner rejects with a 400 and a foreign host answers ignored", async () => {
		const foreign = makeSink("ignored");
		const owner = makeSink("reject-companion");
		writeHostManifest("org-owner", owner.endpoint);

		await runHook({ SUPERSET_HOST_AGENT_HOOK_URL: foreign.url });

		expect(foreign.hits).toEqual(["Start", "Start"]);
		expect(owner.hits).toEqual(["Start", "Start"]);
		expect(owner.companion).toEqual([true, false]);

		// A stranger on this machine saying "ignored": true must never be read
		// as a delivered no-op while the owning host is refusing the body.
		expect(recordsWithAction("ignored-everywhere")).toHaveLength(0);
		const retried = recordsWithAction("companion-rejected-dot-posted");
		expect(retried).toHaveLength(1);
		expect(retried[0]?.deliveredUrl).toBe(owner.url);
		expect(recordsWithAction("post-error")).toHaveLength(0);
	}, 30_000);

	it("reports a post-error when the owner refuses the stripped body too and a foreign host answers ignored", async () => {
		const foreign = makeSink("ignored");
		const owner = makeSink("reject-always");
		writeHostManifest("org-owner", owner.endpoint);

		await runHook({ SUPERSET_HOST_AGENT_HOOK_URL: foreign.url });

		// Both sweeps ran and the owner refused both bodies, so nothing was
		// ever delivered. The retry sweep sees the same shape as the first one
		// -- a stranger's "ignored": true alongside the owner's 400 -- and must
		// promote it identically. Logging it as a delivered no-op would drop
		// the dot with no error anywhere.
		expect(foreign.hits).toEqual(["Start", "Start"]);
		expect(owner.hits).toEqual(["Start", "Start"]);
		expect(owner.companion).toEqual([true, false]);

		expect(
			recordsWithAction("companion-rejected-dot-ignored-everywhere"),
		).toHaveLength(0);
		expect(recordsWithAction("ignored-everywhere")).toHaveLength(0);
		expect(recordsWithAction("companion-rejected-dot-posted")).toHaveLength(0);
		const errors = recordsWithAction("post-error");
		expect(errors).toHaveLength(1);
		expect(String(errors[0]?.error)).toContain("400");
	}, 30_000);

	it("reports a post-error, not a delivered no-op, when only malformed 2xx bodies answer", async () => {
		const html = makeSink("html");
		const emptyObject = makeSink("empty-object");
		writeHostManifest("org-empty", emptyObject.endpoint);

		await runHook({ SUPERSET_HOST_AGENT_HOOK_URL: html.url });

		// A 2xx nobody can parse is not a disown -- it proves only that SOME
		// server answered. So the stripped retry still runs (hence two hits
		// each) and the event is still undelivered.
		expect(html.hits).toEqual(["Start", "Start"]);
		expect(emptyObject.hits).toEqual(["Start", "Start"]);
		expect(recordsWithAction("ignored-everywhere")).toHaveLength(0);
		expect(recordsWithAction("posted")).toHaveLength(0);
		expect(recordsWithAction("post-error")).toHaveLength(1);
	}, 30_000);

	it("skips a stale manifest whose host process is gone", async () => {
		const recycled = makeSink("accept");
		// A pid no OS hands out: rejected by the Windows OpenProcess probe and
		// by POSIX kill alike. It stands in for a crashed host whose port an
		// unrelated process now owns -- the payload carries the companion
		// question text, so it must not be POSTed there.
		writeHostManifest("org-crashed", recycled.endpoint, 2_147_483_647);

		await runHook({
			SUPERSET_HOST_AGENT_HOOK_URL: `${deadEndpoint()}/trpc/notifications.hook`,
		});

		expect(recycled.hits).toEqual([]);
		expect(recordsWithAction("hook-candidate-manifest-dead-pid")).toHaveLength(
			1,
		);
		expect(recordsWithAction("post-error")).toHaveLength(1);
	}, 30_000);

	it("keeps a manifest whose host process is alive", async () => {
		const live = makeSink("accept");
		writeHostManifest("org-live-pid", live.endpoint, process.pid);

		await runHook({
			SUPERSET_HOST_AGENT_HOOK_URL: `${deadEndpoint()}/trpc/notifications.hook`,
		});

		expect(live.hits).toEqual(["Start"]);
		expect(recordsWithAction("hook-candidate-manifest-dead-pid")).toHaveLength(
			0,
		);
		expect(recordsWithAction("posted")[0]?.deliveredUrl).toBe(live.url);
	}, 30_000);
});
