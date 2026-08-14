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
const sink = Bun.serve({
	port: 0,
	async fetch(request) {
		const body = (await request.json()) as {
			json?: {
				eventType?: string;
				companionLifecycleOutcome?: string;
			};
		};
		posts.push({
			eventType: body.json?.eventType ?? "",
			lifecycleOutcome: body.json?.companionLifecycleOutcome,
		});
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
