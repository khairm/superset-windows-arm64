import { afterAll, beforeEach, describe, expect, it } from "bun:test";
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
		return Response.json({ result: { data: { json: { success: true } } } });
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

/** Run one hook event; returns the eventType/outcome the host-service received. */
async function hook(
	payload: Record<string, unknown>,
): Promise<Post | undefined> {
	// Async spawn, not spawnSync: the hook POSTs and waits for the response, so a
	// blocked JS loop would stall the sink until the hook's own timeout.
	const proc = Bun.spawn({
		cmd: [PYTHON, scriptPath],
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
			SUPERSET_TERMINAL_ID: TERMINAL_ID,
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
	function spawnTyped(name: string, subagentType: string): void {
		append([
			{
				id: `tu-${name}`,
				input: {
					name,
					prompt: `${PREAMBLE} work assigned to ${name}`,
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

	function entry(id: string): Record<string, unknown> {
		return {
			description: `${PREAMBLE}...`,
			id,
			status: "running",
			type: "teammate",
		};
	}

	/** One turn end carrying the running teammate set. */
	function stop(...ids: string[]): Promise<Post | undefined> {
		return hook({
			background_tasks: ids.map(entry),
			hook_event_name: "Stop",
			transcript_path: transcript,
		});
	}

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
