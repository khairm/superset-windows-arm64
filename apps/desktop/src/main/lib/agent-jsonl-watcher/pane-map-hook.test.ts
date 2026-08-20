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
		expect(
			recordsWithAction("hook-candidate-manifest-dead-pid"),
		).toHaveLength(1);
		expect(recordsWithAction("post-error")).toHaveLength(1);
	}, 30_000);

	it("keeps a manifest whose host process is alive", async () => {
		const live = makeSink("accept");
		writeHostManifest("org-live-pid", live.endpoint, process.pid);

		await runHook({
			SUPERSET_HOST_AGENT_HOOK_URL: `${deadEndpoint()}/trpc/notifications.hook`,
		});

		expect(live.hits).toEqual(["Start"]);
		expect(
			recordsWithAction("hook-candidate-manifest-dead-pid"),
		).toHaveLength(0);
		expect(recordsWithAction("posted")[0]?.deliveredUrl).toBe(live.url);
	}, 30_000);
});
