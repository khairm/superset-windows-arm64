import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import childProcess from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
	NOTIFY_HOOK_TIMEOUT_SECONDS,
	notifyDaemonRunToken,
} from "./notify-daemon";
import {
	armCommandTransportFallback,
	type HookEntry,
	mirrorHooksIntoProfiles,
	NOTIFY_SCRIPT,
	type NotifyTransport,
	stopNotifyHookDaemon,
	withNotifyHooks,
} from "./pane-map-hook";

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

		append([{ tool_use_id: "tu-taskstop", type: "tool_result" }]);
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

// (HOOK-HTTP-DAEMON) The daemon half: ONE long-lived python serving Claude's
// native "http" hook entries. Everything below drives a real daemon over a real
// loopback socket, because the transport IS the feature — validation, the
// per-terminal FIFO and the bounded log rotation only exist in that process.
describe("superset-notify http daemon", () => {
	interface DaemonSink {
		/** {terminalId, eventType} of every POST, in arrival order. */
		hits: Array<{ terminalId: string; eventType: string; at: number }>;
		url: string;
		endpoint: string;
		/** The most POSTs this sink ever had in flight at once. */
		peak: () => number;
	}

	const sinks: Array<{ stop: (force?: boolean) => unknown }> = [];
	let daemonHome = "";
	let daemonPort = 0;
	let daemon: childProcess.ChildProcess | null = null;
	const SECRET = "daemon-suite-secret";

	/**
	 * Records every POST. `holdMs` keeps a request open — the first one, or
	 * every one — so a test can read the gap between arrivals or how many
	 * overlapped.
	 */
	function makeDaemonSink(
		holdMs = 0,
		hold: "first" | "every" = "first",
	): DaemonSink {
		const hits: DaemonSink["hits"] = [];
		let served = 0;
		let inFlight = 0;
		let peak = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as {
					json?: { eventType?: string; terminalId?: string };
				};
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				// Recorded on ARRIVAL, before the hold below: the FIFO test reads
				// the gap between arrivals, not between completions.
				hits.push({
					at: Date.now(),
					eventType: body.json?.eventType ?? "",
					terminalId: body.json?.terminalId ?? "",
				});
				if (holdMs > 0 && (hold === "every" || served === 0)) {
					await Bun.sleep(holdMs);
				}
				served += 1;
				inFlight -= 1;
				return Response.json({
					result: { data: { json: { ignored: false, success: true } } },
				});
			},
		});
		sinks.push(server);
		const endpoint = `http://127.0.0.1:${server.port}`;
		return {
			endpoint,
			hits,
			peak: () => peak,
			url: `${endpoint}/trpc/notifications.hook`,
		};
	}

	function deadDaemonEndpoint(): string {
		const probe = Bun.serve({ fetch: () => new Response("x"), port: 0 });
		const endpoint = `http://127.0.0.1:${probe.port}`;
		probe.stop(true);
		return endpoint;
	}

	function daemonManifest(organizationId: string, endpoint: string): void {
		const dir = path.join(daemonHome, ".superset", "host", organizationId);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "manifest.json"),
			JSON.stringify({
				authToken: "token",
				endpoint,
				organizationId,
				pid: process.pid,
				startedAt: Date.now(),
			}),
		);
	}

	function daemonLogPath(): string {
		return path.join(daemonHome, ".superset", "agent-notify-hook.log");
	}

	function daemonLogActions(): string[] {
		if (!fs.existsSync(daemonLogPath())) return [];
		const actions: string[] = [];
		for (const line of fs.readFileSync(daemonLogPath(), "utf-8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const record = JSON.parse(line) as { action?: unknown };
				if (typeof record.action === "string") actions.push(record.action);
			} catch {
				// padding written by the rotation test
			}
		}
		return actions;
	}

	async function daemonServed(): Promise<number> {
		const response = await fetch(
			`http://127.0.0.1:${daemonPort}/superset-notify/health`,
			{ headers: { "X-Superset-Notify-Secret": SECRET } },
		);
		const body = (await response.json()) as { served?: number };
		return body.served ?? -1;
	}

	/**
	 * A status line read straight off the wire. Bun's `fetch` answers a refused
	 * POST with ECONNRESET instead of the status the daemon sent often enough to
	 * make a loaded machine's suite red, so every refusal is asserted on a socket
	 * this test owns and closes itself.
	 */
	function rawStatus(
		requestLine: string,
		headers: Record<string, string>,
		writeBody: (socket: net.Socket) => void,
	): Promise<number> {
		return new Promise((resolve, reject) => {
			const lines = [requestLine, `Host: 127.0.0.1:${daemonPort}`];
			for (const [name, value] of Object.entries(headers)) {
				lines.push(`${name}: ${value}`);
			}
			let seen = "";
			const socket = net.connect(daemonPort, "127.0.0.1", () => {
				socket.write(`${lines.join("\r\n")}\r\n\r\n`);
				writeBody(socket);
			});
			socket.on("data", (chunk) => {
				seen += String(chunk);
			});
			socket.on("error", reject);
			socket.on("close", () => {
				const status = /^HTTP\/1\.[01] (\d{3})/.exec(seen);
				if (!status) {
					reject(new Error(`no status line in ${JSON.stringify(seen)}`));
					return;
				}
				resolve(Number(status[1]));
			});
		});
	}

	function rawPostStatus(
		urlPath: string,
		headers: Record<string, string>,
		body: string,
	): Promise<number> {
		return rawStatus(
			`POST ${urlPath} HTTP/1.1`,
			{ ...headers, "Content-Length": String(Buffer.byteLength(body)) },
			(socket) => socket.write(body),
		);
	}

	/** A POST framed the way a streaming client sends it: no Content-Length. */
	function postChunked(
		payload: unknown,
		overrides: Record<string, string> = {},
	): Promise<number> {
		const body = JSON.stringify(payload);
		return rawStatus(
			"POST /superset-notify/hook HTTP/1.1",
			{ ...daemonHeaders(overrides), "Transfer-Encoding": "chunked" },
			(socket) =>
				socket.write(
					`${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`,
				),
		);
	}

	function daemonHeaders(
		overrides: Record<string, string> = {},
	): Record<string, string> {
		return {
			"Content-Type": "application/json",
			"X-Superset-Agent-Id": "claude",
			"X-Superset-Agent-Watcher-Debug": "1",
			"X-Superset-Host-Agent-Hook-Url": "",
			"X-Superset-Notify-Secret": SECRET,
			"X-Superset-Organization-Id": "",
			"X-Superset-Terminal-Id": "daemonterminal",
			...overrides,
		};
	}

	async function post(
		payload: unknown,
		overrides: Record<string, string> = {},
		rawBody?: BodyInit,
	): Promise<number> {
		const response = await fetch(
			`http://127.0.0.1:${daemonPort}/superset-notify/hook`,
			{
				body: rawBody ?? JSON.stringify(payload),
				headers: daemonHeaders(overrides),
				method: "POST",
			},
		);
		return response.status;
	}

	beforeAll(async () => {
		daemonHome = fs.mkdtempSync(path.join(root, "daemon-home-"));
		const secretFile = path.join(daemonHome, "secret");
		fs.writeFileSync(secretFile, SECRET);
		const probe = Bun.serve({ fetch: () => new Response("x"), port: 0 });
		daemonPort = probe.port ?? 0;
		probe.stop(true);
		if (!daemonPort) throw new Error("probe socket has no port");
		// childProcess.spawn, not Bun.spawn: Bun's test runner reaps a Bun.spawn
		// child as a "dangling process" between tests, which killed the daemon
		// half way through the suite.
		daemon = childProcess.spawn(
			PYTHON,
			[
				"-I",
				"-S",
				scriptPath,
				"--serve",
				String(daemonPort),
				"--secret-file",
				secretFile,
			],
			{
				env: {
					...process.env,
					HOME: daemonHome,
					NO_PROXY: "*",
					SUPERSET_AGENT_WATCHER_DEBUG: "1",
					// The suite runs INSIDE Superset, whose own SUPERSET_HOME_DIR
					// would point the manifest failover at this machine's live
					// hosts. Scoped to the throwaway HOME instead.
					SUPERSET_HOME_DIR: path.join(daemonHome, ".superset"),
					TEMP: daemonHome,
					TMP: daemonHome,
					TMPDIR: daemonHome,
					USERPROFILE: daemonHome,
				},
				stdio: [
					"pipe",
					fs.openSync(path.join(daemonHome, "daemon.stdout.log"), "a"),
					fs.openSync(path.join(daemonHome, "daemon.stderr.log"), "a"),
				],
				windowsHide: true,
			},
		);
		const deadline = Date.now() + 20_000;
		for (;;) {
			const ok = await fetch(
				`http://127.0.0.1:${daemonPort}/superset-notify/health`,
				{ headers: { "X-Superset-Notify-Secret": SECRET } },
			)
				.then((response) => response.status === 200)
				.catch(() => false);
			if (ok) break;
			if (Date.now() > deadline) throw new Error("daemon never became healthy");
			await Bun.sleep(100);
		}
	}, 40_000);

	afterAll(() => {
		// A daemon that dies mid-suite takes every later test with it, and the
		// traceback it printed on the way out is the only thing that says why.
		const stderrLog = path.join(daemonHome, "daemon.stderr.log");
		const noise = fs.existsSync(stderrLog)
			? fs
					.readFileSync(stderrLog, "utf-8")
					.split("\n")
					.filter((line) => line.trim() && !line.startsWith("listening on "))
			: [];
		if (noise.length > 0) console.log(noise.join("\n"));
		daemon?.kill();
	});

	afterEach(() => {
		for (const sink of sinks.splice(0)) sink.stop(true);
	});

	it("delivers events for several terminals and orgs at once", async () => {
		const orgA = makeDaemonSink();
		const orgB = makeDaemonSink();
		const plan = [
			{ org: "orgconcurrenta", sink: orgA, terminal: "daemonconcurrent1" },
			{ org: "orgconcurrenta", sink: orgA, terminal: "daemonconcurrent2" },
			{ org: "orgconcurrentb", sink: orgB, terminal: "daemonconcurrent3" },
			{ org: "orgconcurrentb", sink: orgB, terminal: "daemonconcurrent4" },
		];
		const statuses = await Promise.all(
			plan.map(({ org, sink, terminal }) =>
				post(
					{ hook_event_name: "UserPromptSubmit", session_id: `s-${terminal}` },
					{
						"X-Superset-Host-Agent-Hook-Url": sink.url,
						"X-Superset-Organization-Id": org,
						"X-Superset-Terminal-Id": terminal,
					},
				),
			),
		);

		expect(statuses).toEqual([204, 204, 204, 204]);
		expect(orgA.hits.map((hit) => hit.terminalId).sort()).toEqual([
			"daemonconcurrent1",
			"daemonconcurrent2",
		]);
		expect(orgB.hits.map((hit) => hit.terminalId).sort()).toEqual([
			"daemonconcurrent3",
			"daemonconcurrent4",
		]);
		expect(
			[...orgA.hits, ...orgB.hits].every((hit) => hit.eventType === "Start"),
		).toBe(true);
	}, 30_000);

	it("serializes two events for the SAME terminal in arrival order", async () => {
		// The first POST is held open past the second's arrival. Without the
		// per-terminal FIFO both would reach the sink at once and the second
		// decision would read marker state the first had not written yet.
		const slow = makeDaemonSink(900);
		const terminal = "daemonfifo";
		const first = post(
			{ hook_event_name: "UserPromptSubmit", session_id: "s-fifo" },
			{
				"X-Superset-Host-Agent-Hook-Url": slow.url,
				"X-Superset-Terminal-Id": terminal,
			},
		);
		await Bun.sleep(150);
		const second = post(
			{ hook_event_name: "Stop", session_id: "s-fifo" },
			{
				"X-Superset-Host-Agent-Hook-Url": slow.url,
				"X-Superset-Terminal-Id": terminal,
			},
		);

		expect(await Promise.all([first, second])).toEqual([204, 204]);
		expect(slow.hits.map((hit) => hit.eventType)).toEqual(["Start", "Stop"]);
		const gap = (slow.hits[1]?.at ?? 0) - (slow.hits[0]?.at ?? 0);
		expect(gap).toBeGreaterThan(500);
	}, 30_000);

	it("fails over to the org manifest when the host restarts onto a new port", async () => {
		const restarted = makeDaemonSink();
		daemonManifest("orgrestarted", restarted.endpoint);
		const started = Date.now();

		const status = await post(
			{ hook_event_name: "UserPromptSubmit", session_id: "s-restart" },
			{
				"X-Superset-Host-Agent-Hook-Url": `${deadDaemonEndpoint()}/trpc/notifications.hook`,
				"X-Superset-Organization-Id": "orgrestarted",
				"X-Superset-Terminal-Id": "daemonrestart",
			},
		);

		expect(status).toBe(204);
		expect(restarted.hits.map((hit) => hit.eventType)).toEqual(["Start"]);
		expect(Date.now() - started).toBeLessThan(5_000);
	}, 30_000);

	it("answers 502 when nothing anywhere accepts the event", async () => {
		const status = await post(
			{ hook_event_name: "UserPromptSubmit", session_id: "s-unreachable" },
			{
				"X-Superset-Host-Agent-Hook-Url": `${deadDaemonEndpoint()}/trpc/notifications.hook`,
				"X-Superset-Organization-Id": "orgunreachable",
				"X-Superset-Terminal-Id": "daemonunreachable",
			},
		);
		expect(status).toBe(502);
	}, 30_000);

	it("answers 204 for an event it has nothing to deliver", async () => {
		expect(
			await post(
				{ hook_event_name: "UserPromptSubmit", session_id: "s-noterm" },
				{ "X-Superset-Terminal-Id": "" },
			),
		).toBe(204);
		const live = makeDaemonSink();
		expect(
			await post(
				{
					hook_event_name: "PreToolUse",
					session_id: "s-unmapped",
					tool_name: "Read",
				},
				{
					"X-Superset-Host-Agent-Hook-Url": live.url,
					"X-Superset-Terminal-Id": "daemonunmapped",
				},
			),
		).toBe(204);
		expect(live.hits).toEqual([]);
	}, 30_000);

	it("rejects an unauthenticated or wrongly-keyed caller", async () => {
		expect(
			await rawPostStatus(
				"/superset-notify/hook",
				daemonHeaders({ "X-Superset-Notify-Secret": "no" }),
				JSON.stringify({ hook_event_name: "Stop" }),
			),
		).toBe(401);
		expect(
			await rawPostStatus(
				"/superset-notify/hook",
				{ "Content-Type": "application/json" },
				"{}",
			),
		).toBe(401);
		const bareHealth = await fetch(
			`http://127.0.0.1:${daemonPort}/superset-notify/health`,
		);
		expect(bareHealth.status).toBe(401);
	}, 30_000);

	it("rejects every malformed header rather than guessing at it", async () => {
		const cases: Array<[string, Record<string, string>]> = [
			["unknown x-superset header", { "X-Superset-Bogus": "1" }],
			[
				"path traversal in the terminal id",
				{ "X-Superset-Terminal-Id": "../escape" },
			],
			["separator in the org id", { "X-Superset-Organization-Id": "a/b" }],
			[
				"non-loopback hook url",
				{ "X-Superset-Host-Agent-Hook-Url": "http://example.com:80/x" },
			],
			[
				"https hook url",
				{ "X-Superset-Host-Agent-Hook-Url": "https://127.0.0.1:1/x" },
			],
			[
				"portless hook url",
				{ "X-Superset-Host-Agent-Hook-Url": "http://127.0.0.1/x" },
			],
			// Claude cannot carry a Windows profile path in a header value
			// (ERR_INVALID_CHAR above U+00FF), so the daemon takes the home dir
			// from its own environment and refuses the header outright.
			[
				"a home-dir header at all",
				{ "X-Superset-Home-Dir": "C:/Users/someone/.superset" },
			],
		];
		for (const [label, overrides] of cases) {
			expect([
				label,
				await rawPostStatus(
					"/superset-notify/hook",
					daemonHeaders(overrides),
					JSON.stringify({ hook_event_name: "Stop" }),
				),
			]).toEqual([label, 400]);
		}
	}, 30_000);

	it("reads an unrecognised debug flag as the variable being unset", async () => {
		const live = makeDaemonSink();
		const status = await post(
			{ hook_event_name: "UserPromptSubmit", session_id: "s-debugflag" },
			{
				"X-Superset-Agent-Watcher-Debug": "true",
				"X-Superset-Host-Agent-Hook-Url": live.url,
				"X-Superset-Terminal-Id": "daemondebugflag",
			},
		);
		expect(status).toBe(204);
		expect(live.hits.map((hit) => hit.eventType)).toEqual(["Start"]);
	}, 30_000);

	it("reads an uninterpolated $VAR as the variable being unset", async () => {
		const live = makeDaemonSink();
		const status = await post(
			{ hook_event_name: "UserPromptSubmit", session_id: "s-placeholder" },
			{
				"X-Superset-Agent-Watcher-Debug": "$SUPERSET_AGENT_WATCHER_DEBUG",
				"X-Superset-Host-Agent-Hook-Url": live.url,
				"X-Superset-Organization-Id": "$SUPERSET_ORGANIZATION_ID",
				"X-Superset-Terminal-Id": "daemonplaceholder",
			},
		);
		expect(status).toBe(204);
		expect(live.hits.map((hit) => hit.eventType)).toEqual(["Start"]);
	}, 30_000);

	it("rejects a body that is oversized, not UTF-8, or not a JSON object", async () => {
		expect(
			await post({ hook_event_name: "Stop", pad: "x".repeat(9_000_000) }),
		).toBe(413);
		expect(
			await post(null, {}, new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])),
		).toBe(400);
		expect(await post(null, {}, "{not json")).toBe(400);
		expect(await post([1, 2, 3])).toBe(400);
	}, 30_000);

	// Claude POSTs the same hook input it used to write to stdin, and the stdin
	// path had no size limit at all: tool_input and tool_response carry whole
	// file contents, and the largest single tool result in this machine's own
	// transcripts is 478KB. Refusing one loses the event for good.
	it("accepts a hook body the size Claude's real tool results reach", async () => {
		const live = makeDaemonSink();
		const bulk = "x".repeat(500_000);

		expect(
			await post(
				{
					hook_event_name: "UserPromptSubmit",
					prompt: bulk,
					session_id: "s-bulky",
				},
				{
					"X-Superset-Host-Agent-Hook-Url": live.url,
					"X-Superset-Terminal-Id": "daemonbulky",
				},
			),
		).toBe(204);
		expect(live.hits.map((hit) => hit.terminalId)).toEqual(["daemonbulky"]);

		expect(
			await post(
				{
					hook_event_name: "PostToolUse",
					session_id: "s-bulky",
					tool_name: "Read",
					tool_response: bulk,
				},
				{
					"X-Superset-Host-Agent-Hook-Url": live.url,
					"X-Superset-Terminal-Id": "daemonbulky",
				},
			),
		).toBe(204);
	}, 30_000);

	it("refuses a relative transcript path instead of resolving it against its own cwd", async () => {
		const live = makeDaemonSink();
		const status = await post(
			{
				hook_event_name: "Stop",
				session_id: "s-relative",
				transcript_path: "relative/transcript.jsonl",
			},
			{
				"X-Superset-Host-Agent-Hook-Url": live.url,
				"X-Superset-Terminal-Id": "daemonrelative",
			},
		);
		expect(status).toBe(400);
		expect(live.hits).toEqual([]);
	}, 30_000);

	// SUPERSET_HOME_DIR cannot travel in a header, so an ADOPTED daemon's own
	// environment names the OTHER instance's home. The terminal's transcript is
	// what says whose host manifests to read.
	it("fails over through the host root the terminal's own transcript names", async () => {
		const otherInstance = makeDaemonSink();
		const otherHome = path.join(
			fs.mkdtempSync(path.join(root, "other-instance-")),
			"superset-dev-data",
		);
		const organizationId = "orgotherinstance";
		const manifestDir = path.join(otherHome, "host", organizationId);
		fs.mkdirSync(manifestDir, { recursive: true });
		fs.writeFileSync(
			path.join(manifestDir, "manifest.json"),
			JSON.stringify({
				authToken: "token",
				endpoint: otherInstance.endpoint,
				organizationId,
				pid: process.pid,
				startedAt: Date.now(),
			}),
		);

		const status = await post(
			{
				hook_event_name: "UserPromptSubmit",
				session_id: "s-other-instance",
				transcript_path: path.join(
					manifestDir,
					"claude-profiles",
					"6f1b2c3d-0000-4000-8000-00000000d1",
					"projects",
					"-c-work",
					"session.jsonl",
				),
			},
			{
				"X-Superset-Host-Agent-Hook-Url": `${deadDaemonEndpoint()}/trpc/notifications.hook`,
				"X-Superset-Organization-Id": organizationId,
				"X-Superset-Terminal-Id": "daemonotherinstance",
			},
		);

		expect(status).toBe(204);
		expect(otherInstance.hits.map((hit) => hit.eventType)).toEqual(["Start"]);
	}, 30_000);

	// ThreadingHTTPServer caps neither threads nor connections, so a client that
	// announces a body and then stalls has to be timed out at the socket or it
	// parks a handler thread for the life of a process meant to run for days.
	it("hangs up on a client that announces a body and then stalls", async () => {
		const lines = [
			"POST /superset-notify/hook HTTP/1.1",
			`Host: 127.0.0.1:${daemonPort}`,
			"Content-Length: 1048576",
		];
		for (const [name, value] of Object.entries(daemonHeaders())) {
			lines.push(`${name}: ${value}`);
		}

		const closedAfterMs = await new Promise<number>((resolve) => {
			const started = Date.now();
			const socket = net.connect(daemonPort, "127.0.0.1", () => {
				socket.write(`${lines.join("\r\n")}\r\n\r\n{`);
			});
			const hungUp = (): void => resolve(Date.now() - started);
			socket.on("error", hungUp);
			socket.on("close", hungUp);
		});

		expect(closedAfterMs).toBeGreaterThan(3_000);
		expect(closedAfterMs).toBeLessThan(25_000);
		// The thread it held is back, and the daemon is still serving.
		expect(await post({ hook_event_name: "Stop" })).toBe(204);
	}, 40_000);

	it("404s any path but its own two", async () => {
		expect(await rawPostStatus("/hook", daemonHeaders(), "{}")).toBe(404);
	}, 30_000);

	it("keeps rotating the debug log in a long-lived process, but bounded", async () => {
		const live = makeDaemonSink();
		const backup = `${daemonLogPath()}.1`;
		fs.rmSync(backup, { force: true });
		fs.mkdirSync(path.dirname(daemonLogPath()), { recursive: true });
		fs.writeFileSync(daemonLogPath(), `${"x".repeat(1_100_000)}\n`);
		// Past the rotation interval since whatever the tests above last
		// checked: the daemon has already served every one of them, so the
		// once-per-process check this replaced would never fire again.
		await Bun.sleep(6_000);

		await post(
			{ hook_event_name: "UserPromptSubmit", session_id: "s-rotate-1" },
			{
				"X-Superset-Host-Agent-Hook-Url": live.url,
				"X-Superset-Terminal-Id": "daemonrotate",
			},
		);

		expect(fs.existsSync(backup)).toBe(true);
		expect(fs.statSync(backup).size).toBeGreaterThan(1_000_000);
		expect(fs.statSync(daemonLogPath()).size).toBeLessThan(100_000);
		expect(daemonLogActions()).toContain("posted");

		// And it is bounded: a second oversized log inside the interval is NOT
		// re-checked, so the backup still holds the first one.
		fs.writeFileSync(daemonLogPath(), `${"y".repeat(1_100_000)}\n`);
		await post(
			{ hook_event_name: "UserPromptSubmit", session_id: "s-rotate-2" },
			{
				"X-Superset-Host-Agent-Hook-Url": live.url,
				"X-Superset-Terminal-Id": "daemonrotate",
			},
		);
		expect(fs.readFileSync(backup, "utf-8").startsWith("x")).toBe(true);
		expect(fs.existsSync(`${daemonLogPath()}.2`)).toBe(false);
	}, 30_000);

	it("accepts a body sent as chunks, and counts what it was sent", async () => {
		const live = makeDaemonSink();
		const before = await daemonServed();
		expect(before).toBeGreaterThanOrEqual(0);

		const status = await postChunked(
			{ hook_event_name: "UserPromptSubmit", session_id: "s-chunked" },
			{
				"X-Superset-Host-Agent-Hook-Url": live.url,
				"X-Superset-Terminal-Id": "daemonchunked",
			},
		);

		expect(status).toBe(204);
		expect(live.hits.map((hit) => hit.eventType)).toEqual(["Start"]);
		// The count is the supervisor's proof that Claude is really POSTing.
		expect(await daemonServed()).toBe(before + 1);
	}, 30_000);

	it("serves more terminals at once than its starting worker count", async () => {
		const holding = makeDaemonSink(700, "every");
		const terminals = ["a", "b", "c", "d", "e", "f", "g", "h"].map(
			(suffix) => `daemonwide${suffix}`,
		);

		const statuses = await Promise.all(
			terminals.map((terminal) =>
				post(
					{ hook_event_name: "UserPromptSubmit", session_id: `s-${terminal}` },
					{
						"X-Superset-Host-Agent-Hook-Url": holding.url,
						"X-Superset-Terminal-Id": terminal,
					},
				),
			),
		);

		expect(statuses).toEqual(terminals.map(() => 204));
		expect(holding.hits).toHaveLength(terminals.length);
		expect(holding.peak()).toBeGreaterThan(4);
	}, 30_000);
});

// (HOOK-HTTP-DAEMON) The hook-entry rewrite, without a real ~/.claude.
describe("superset-notify hook registration", () => {
	const httpTransport: NotifyTransport = {
		kind: "http",
		port: 46817,
		secret: "registration-secret",
		pythonPath: null,
	};
	const commandTransport: NotifyTransport = {
		kind: "command",
		pythonPath: null,
	};

	function specs(
		hooks: Record<string, HookEntry[]>,
		event: string,
	): Array<Record<string, unknown>> {
		return (hooks[event] ?? []).flatMap(
			(entry) =>
				(entry.hooks ?? []) as unknown as Array<Record<string, unknown>>,
		);
	}

	function readProfileHooks(dir: string): Record<string, HookEntry[]> {
		return (
			JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")) as {
				hooks: Record<string, HookEntry[]>;
			}
		).hooks;
	}

	function stopHeaders(): Record<string, string> {
		return specs(withNotifyHooks({}, httpTransport), "Stop")[0]
			?.headers as Record<string, string>;
	}

	it("registers one http entry per lifecycle event, keyed and env-scoped", () => {
		const hooks = withNotifyHooks({}, httpTransport);

		expect(Object.keys(hooks).sort()).toEqual([
			"Notification",
			"PostToolUse",
			"PostToolUseFailure",
			"PreCompact",
			"PreToolUse",
			"SessionEnd",
			"SessionStart",
			"Stop",
			"StopFailure",
			"SubagentStart",
			"SubagentStop",
			"UserPromptSubmit",
		]);
		expect(specs(hooks, "Stop")).toEqual([
			{
				allowedEnvVars: [
					"SUPERSET_TERMINAL_ID",
					"SUPERSET_AGENT_ID",
					"SUPERSET_ORGANIZATION_ID",
					"SUPERSET_HOST_AGENT_HOOK_URL",
					"SUPERSET_AGENT_WATCHER_DEBUG",
				],
				headers: {
					"X-Superset-Agent-Id": "$SUPERSET_AGENT_ID",
					"X-Superset-Agent-Watcher-Debug": "$SUPERSET_AGENT_WATCHER_DEBUG",
					"X-Superset-Host-Agent-Hook-Url": "$SUPERSET_HOST_AGENT_HOOK_URL",
					"X-Superset-Notify-Secret": "registration-secret",
					"X-Superset-Organization-Id": "$SUPERSET_ORGANIZATION_ID",
					"X-Superset-Terminal-Id": "$SUPERSET_TERMINAL_ID",
				},
				timeout: 15,
				type: "http",
				url: "http://127.0.0.1:46817/superset-notify/hook",
			},
		]);
		expect(hooks.Notification?.[0]?.matcher).toBe("permission_prompt");
		expect(hooks.PreToolUse?.[0]?.matcher).toBe("AskUserQuestion");
	});

	// Claude Code filters SessionStart (and Setup) to command hooks and silently
	// skips an http one, so an http SessionStart entry means superset-notify.py
	// never runs that branch: no manual-/compact green, no stale-.askq cleanup,
	// no fresh team cache. Eleven http entries beside one command SessionStart is
	// the healthy daemon shape.
	it("keeps SessionStart on the command transport while the daemon serves the rest", () => {
		const hooks = withNotifyHooks({}, httpTransport);
		const sessionStart = specs(hooks, "SessionStart");

		expect(sessionStart).toHaveLength(1);
		expect(sessionStart[0]?.type).toBe("command");
		expect(sessionStart[0]?.command).toContain("superset-notify.py");
		for (const event of Object.keys(hooks).filter(
			(name) => name !== "SessionStart",
		)) {
			expect(specs(hooks, event)[0]?.type).toBe("http");
		}
		expect(
			Object.keys(hooks).filter((name) => name !== "SessionStart"),
		).toHaveLength(11);

		// A hand-back puts all twelve back on the command transport.
		const handedBack = withNotifyHooks(hooks, commandTransport);
		expect(Object.keys(handedBack)).toHaveLength(12);
		for (const event of Object.keys(handedBack)) {
			expect(specs(handedBack, event)).toHaveLength(1);
			expect(specs(handedBack, event)[0]?.type).toBe("command");
		}
	});

	// An upgrade inherited from a build that DID register SessionStart over http
	// has to heal back to a command entry rather than keep both.
	it("heals an older build's http SessionStart entry", () => {
		const legacy = {
			SessionStart: [
				{
					hooks: [
						{
							type: "http",
							url: "http://127.0.0.1:46817/superset-notify/hook",
						},
					],
				},
			],
		} as unknown as Record<string, HookEntry[]>;

		const healed = specs(
			withNotifyHooks(legacy, httpTransport),
			"SessionStart",
		);

		expect(healed).toHaveLength(1);
		expect(healed[0]?.type).toBe("command");
	});

	it("names exactly the headers the daemon parses", () => {
		// The two sides carry their own copy of the mapping; a header added on
		// one side only would be silently dropped at the boundary.
		const declared = Object.keys(stopHeaders()).map((name) =>
			name.toLowerCase(),
		);
		const parsed = [
			...new Set(
				[...NOTIFY_SCRIPT.matchAll(/"(x-superset-[a-z-]+)"/g)].map(
					(match) => match[1] ?? "",
				),
			),
		];
		expect(parsed.length).toBe(declared.length);
		expect(parsed.sort()).toEqual(declared.sort());
	});

	it("replaces the old per-event command entries with daemon entries", () => {
		const upgraded = withNotifyHooks(
			withNotifyHooks({}, commandTransport),
			httpTransport,
		);
		expect(specs(upgraded, "Stop")).toHaveLength(1);
		expect(specs(upgraded, "Stop")[0]?.type).toBe("http");

		const downgraded = withNotifyHooks(upgraded, commandTransport);
		expect(specs(downgraded, "Stop")).toHaveLength(1);
		expect(specs(downgraded, "Stop")[0]?.type).toBe("command");
		expect(specs(downgraded, "Stop")[0]?.command).toContain(
			"superset-notify.py",
		);
	});

	it("leaves another tool's localhost hook alone", () => {
		const foreign = {
			Stop: [
				{
					hooks: [
						{ type: "http", url: "http://127.0.0.1:46817/hook" },
						{
							type: "command",
							command: "uv run python superset-ask-marker.py",
						},
					],
				},
			],
		} as unknown as Record<string, HookEntry[]>;

		const kept = specs(withNotifyHooks(foreign, httpTransport), "Stop");

		expect(kept).toHaveLength(2);
		expect(kept[0]?.url).toBe("http://127.0.0.1:46817/hook");
		// The retired ask-marker hook IS ours, and is self-healed away.
		expect(JSON.stringify(kept)).not.toContain("superset-ask-marker.py");
	});

	it("keeps the interpreter the daemon proved when it hands the hooks back", () => {
		// The traffic gate and a quit say nothing about python, and `uv run`
		// costs a resolve on every hook event for the rest of the run.
		const command = specs(
			withNotifyHooks({}, { kind: "command", pythonPath: "C:/python.exe" }),
			"Stop",
		)[0]?.command;

		expect(command).toContain('"C:/python.exe" -I -S');
		expect(command).not.toContain("uv run");
		// Only a machine with no working interpreter falls back to uv.
		expect(
			specs(withNotifyHooks({}, commandTransport), "Stop")[0]?.command,
		).toContain("uv run python");
	});

	it("rewrites the profile copies a running session actually reads", async () => {
		const profilesRoot = fs.mkdtempSync(path.join(root, "claude-profiles-"));
		const pinned = path.join(
			profilesRoot,
			"6f1b2c3d-0000-4000-8000-00000000c1",
		);
		const unminted = path.join(
			profilesRoot,
			"6f1b2c3d-0000-4000-8000-00000000c2",
		);
		fs.mkdirSync(pinned);
		fs.mkdirSync(unminted);
		fs.writeFileSync(
			path.join(pinned, "settings.json"),
			JSON.stringify({
				hooks: {
					SessionStart: [
						{ hooks: [{ type: "command", command: "someone-elses-hook" }] },
					],
					Stop: [
						{
							hooks: [
								{
									type: "command",
									command: "uv run python superset-notify.py",
								},
							],
						},
					],
				},
			}),
		);

		const mirrored = await mirrorHooksIntoProfiles(
			"C:/python.exe",
			httpTransport,
			[pinned, unminted],
		);

		expect(mirrored).toEqual([pinned]);
		const rewritten = JSON.parse(
			fs.readFileSync(path.join(pinned, "settings.json"), "utf8"),
		) as { hooks: Record<string, HookEntry[]> };
		expect(specs(rewritten.hooks, "Stop")).toEqual([
			{
				allowedEnvVars: expect.any(Array),
				headers: expect.any(Object),
				timeout: 15,
				type: "http",
				url: "http://127.0.0.1:46817/superset-notify/hook",
			},
		]);
		const sessionStart = specs(rewritten.hooks, "SessionStart");
		expect(sessionStart[0]?.command).toBe("someone-elses-hook");
		expect(sessionStart).toHaveLength(3);
		expect(fs.existsSync(path.join(unminted, "settings.json"))).toBe(false);
	});

	// The mirror walks every Claude profile on the machine off the main thread,
	// so the 60s resweep can land on top of a downgrade. Both write the same
	// `<file>.pending`, and a profile left holding half a settings.json would
	// cost every session under it every hook it has.
	it("serializes overlapping profile mirrors instead of interleaving writes", async () => {
		const profilesRoot = fs.mkdtempSync(path.join(root, "claude-mirror-race-"));
		const profiles = ["a", "b", "c"].map((name) => {
			const dir = path.join(
				profilesRoot,
				`6f1b2c3d-0000-4000-8000-0000000${name}`,
			);
			fs.mkdirSync(dir);
			fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({}));
			return dir;
		});

		const [first, second] = await Promise.all([
			mirrorHooksIntoProfiles("C:/python.exe", httpTransport, profiles),
			mirrorHooksIntoProfiles("C:/python.exe", commandTransport, profiles),
		]);

		expect(first).toEqual(profiles);
		expect(second).toEqual(profiles);
		for (const dir of profiles) {
			const settings = JSON.parse(
				fs.readFileSync(path.join(dir, "settings.json"), "utf8"),
			) as { hooks: Record<string, HookEntry[]> };
			// The LAST mirror queued is the one on disk, for every profile.
			expect(specs(settings.hooks, "Stop")).toEqual([
				{
					command: expect.stringContaining("superset-notify.py"),
					type: "command",
				},
			]);
			expect(fs.existsSync(path.join(dir, "settings.json.pending"))).toBe(
				false,
			);
		}
	});

	it("puts the hooks back on the command transport before the daemon dies", async () => {
		// Claude's settings.json outlives the app: quitting with http entries
		// aimed at a dead port costs every hook event a refused connection.
		const reasons: string[] = [];
		armCommandTransportFallback((reason) => reasons.push(reason));

		await stopNotifyHookDaemon();
		expect(reasons).toEqual(["daemon-stopped"]);

		// ...and only once, so a downgrade that already happened is not undone.
		await stopNotifyHookDaemon();
		expect(reasons).toEqual(["daemon-stopped"]);
	});

	// A job still running when Claude has already timed out writes its response
	// into a socket nobody is reading, which socketserver answers with a full
	// traceback in the daemon log.
	it("gives up on a slow job before Claude gives up on the request", () => {
		const wait = Number(
			/_JOB_WAIT_SECONDS = ([\d.]+)/.exec(NOTIFY_SCRIPT)?.[1],
		);

		expect(wait).toBeGreaterThan(0);
		expect(wait).toBeLessThan(NOTIFY_HOOK_TIMEOUT_SECONDS);
	});

	// A profile the rewrite never reached still reads the old transport, and
	// naming it here lets its sessions speak for the new one: the traffic gate
	// reads no POSTs and tears a working daemon down for every other profile.
	it("leaves a profile whose rewrite could not land out of the mirrored list", async () => {
		const profilesRoot = fs.mkdtempSync(path.join(root, "claude-mirror-fail-"));
		const [written, unparsable] = ["d1", "d2"].map((name) => {
			const dir = path.join(
				profilesRoot,
				`6f1b2c3d-0000-4000-8000-000000000${name}`,
			);
			fs.mkdirSync(dir);
			return dir;
		}) as [string, string];
		fs.writeFileSync(path.join(written, "settings.json"), "{}");
		fs.writeFileSync(path.join(unparsable, "settings.json"), "{not json");

		const mirrored = await mirrorHooksIntoProfiles(
			"C:/python.exe",
			httpTransport,
			[written, unparsable],
		);

		expect(mirrored).toEqual([written]);
	});

	// The notify script itself did not land on disk (locked, EACCES), so the
	// shared settings.json carries no notify entries: the profile copies must not
	// grow twelve of their own aimed at a file that is missing or stale.
	it("registers no notify entries in the profile copies without a notify script", async () => {
		const profilesRoot = fs.mkdtempSync(
			path.join(root, "claude-mirror-nonotify-"),
		);
		const fresh = path.join(
			profilesRoot,
			"6f1b2c3d-0000-4000-8000-0000000000e1",
		);
		const stale = path.join(
			profilesRoot,
			"6f1b2c3d-0000-4000-8000-0000000000e2",
		);
		fs.mkdirSync(fresh);
		fs.mkdirSync(stale);
		fs.writeFileSync(path.join(fresh, "settings.json"), "{}");
		fs.writeFileSync(
			path.join(stale, "settings.json"),
			JSON.stringify({
				hooks: {
					Stop: [
						{
							hooks: [
								{
									type: "command",
									command: "uv run python superset-notify.py",
								},
							],
						},
					],
				},
			}),
		);

		const mirrored = await mirrorHooksIntoProfiles("C:/python.exe", null, [
			fresh,
			stale,
		]);

		expect(mirrored).toEqual([fresh, stale]);
		const freshHooks = readProfileHooks(fresh);
		expect(Object.keys(freshHooks)).toEqual(["SessionStart"]);
		expect(specs(freshHooks, "SessionStart")[0]?.command).toContain(
			"superset-pane-map.py",
		);
		// An entry already there is left exactly as it was found.
		expect(specs(readProfileHooks(stale), "Stop")).toEqual([
			{ command: "uv run python superset-notify.py", type: "command" },
		]);
	});

	// A quit inside the handshake has to invalidate the in-flight registration
	// BEFORE the downgrade runs: a downgrade the upgrade then overwrites leaves
	// every Claude session on the machine POSTing a port nothing serves.
	it("cancels the registration run before it puts the hooks back", async () => {
		const tokensWhenHandedBack: number[] = [];
		armCommandTransportFallback(() =>
			tokensWhenHandedBack.push(notifyDaemonRunToken()),
		);
		const before = notifyDaemonRunToken();

		await stopNotifyHookDaemon();

		expect(tokensWhenHandedBack).toEqual([before + 1]);
	});

	// A run that was force-killed leaves its http entries on disk. If the next
	// launch cannot write the notify script, no daemon is started either, so
	// those entries POST a port nothing serves for the whole run and every event
	// aimed at it is lost. The command entries name a script that is still there.
	it("strips a dead run's daemon entries when there is no transport", () => {
		const stale = withNotifyHooks({}, httpTransport);
		stale.Stop = [
			...(stale.Stop ?? []),
			{ hooks: [{ type: "command", command: "someone-elses-hook" }] },
		];

		const cleared = withNotifyHooks(stale, null);

		expect(specs(cleared, "Stop")).toEqual([
			{ command: "someone-elses-hook", type: "command" },
		]);
		expect(specs(cleared, "UserPromptSubmit")).toEqual([]);
		// An event whose only entry was ours goes back to having no key at all,
		// rather than leaving an empty list behind in a user-owned file. The
		// command SessionStart entry stays for the same reason the Stop one above
		// would have: its script is still on disk and still works.
		expect(Object.keys(cleared)).toEqual(["Stop", "SessionStart"]);
		expect(specs(cleared, "SessionStart")).toHaveLength(1);
		expect(specs(cleared, "SessionStart")[0]?.type).toBe("command");
		expect(
			specs(
				withNotifyHooks(withNotifyHooks({}, commandTransport), null),
				"Stop",
			).length,
		).toBe(1);
	});

	it("clears a dead run's daemon entries out of the profile copies", async () => {
		const profilesRoot = fs.mkdtempSync(
			path.join(root, "claude-mirror-stalehttp-"),
		);
		const profile = path.join(
			profilesRoot,
			"6f1b2c3d-0000-4000-8000-0000000000e3",
		);
		fs.mkdirSync(profile);
		fs.writeFileSync(
			path.join(profile, "settings.json"),
			JSON.stringify({ hooks: withNotifyHooks({}, httpTransport) }),
		);

		expect(
			await mirrorHooksIntoProfiles("C:/python.exe", null, [profile]),
		).toEqual([profile]);

		const hooks = readProfileHooks(profile);
		expect(specs(hooks, "Stop")).toEqual([]);
		// The notify SessionStart command entry, whose script the daemon's death
		// says nothing about, plus pane-map.
		expect(specs(hooks, "SessionStart")).toHaveLength(2);
		expect(specs(hooks, "SessionStart")[0]?.command).toContain(
			"superset-notify.py",
		);
		expect(specs(hooks, "SessionStart")[1]?.command).toContain(
			"superset-pane-map.py",
		);
		expect(
			fs.readFileSync(path.join(profile, "settings.json"), "utf-8"),
		).not.toContain("/superset-notify/");
	});

	it("is idempotent across repeated merges", () => {
		const once = JSON.stringify(withNotifyHooks({}, httpTransport));
		const twice = JSON.stringify(
			withNotifyHooks(
				JSON.parse(once) as Record<string, HookEntry[]>,
				httpTransport,
			),
		);
		expect(twice).toBe(once);
	});
});
