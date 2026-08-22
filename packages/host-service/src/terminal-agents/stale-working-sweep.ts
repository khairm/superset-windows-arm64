import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { EventBus } from "../events/event-bus";
import { nextLifecycleInstantMs } from "../events/lifecycle-instant";
import { mapEventType } from "../events/map-event-type";
import {
	agentMarkerRoot,
	askqMarkerDir,
} from "../trpc/router/notifications/agent-status-snapshot";
import { forwardCompanionLifecycle } from "../trpc/router/notifications/companion-lifecycle-sink";
import type { TerminalAgentStore } from "./index";

/**
 * (STALE-WORKING-SWEEP) The dots are event-driven: superset-notify.py decides
 * yellow/green/blue/red INSIDE hook events, and every staleness reap it owns
 * ((BG-STALE) 15-min zombie teammates, the 12h leaked-marker backstop, the 6h
 * codex pid-reuse cap) can therefore only run when SOME hook event arrives.
 * When the last event of a session resolves to a working hold and the agent
 * then goes quiet — the exact shape of a finished agent-team session, whose
 * teammates Claude Code reports as background_tasks `status:"running"`
 * FOREVER — nothing ever re-evaluates and the terminal is yellow until the
 * app restarts (live 2026-08-22: two workspaces pinned yellow for hours after
 * their chats finished; dot-decisions.log showed the final decisions were
 * SubagentActive holds and then silence).
 *
 * This sweep is the structural backstop the hook cannot be: it runs on the
 * host-service clock, not the agent's. Every SWEEP_INTERVAL_MS it looks at
 * each LIVE binding whose last event resolved to a working state
 * (Start / SubagentActive) and has not changed for STALE_AFTER_MS, and
 * corroborates real quiescence against the same on-disk truth the hook
 * maintains (all under `~/.superset/agent-subagent-running/`, the HARDCODED
 * homedir root the snapshot reader also uses). Finalization requires the
 * `.mainstopped` sentinel — POSITIVE evidence the main turn already ended
 * while a hold was live — because a main loop deep inside one long quiet
 * stretch (a usage-limit wait, a long MCP/network tool) posts no hooks and
 * writes no marker, so marker silence alone cannot distinguish it from a
 * stuck hold. Each remaining hold keeps the WINDOW the hook itself grants
 * it — the sweep never invents a shorter one:
 *
 *  - `<t>.askq/` non-empty          -> a question is pending; NEVER touch a red.
 *  - `<t>/` marker under 12h old    -> the hook's own `_MARKER_STALE_SECONDS`
 *    boundary. Run markers are refreshed on every PostToolUse, but a subagent
 *    INSIDE one long tool call refreshes nothing, and the hook already learned
 *    that a short marker timer false-greens exactly that case — so the sweep
 *    honors the full 12h before ignoring a marker (the observed stuck sessions
 *    had EMPTY run dirs, so they still finalize fast).
 *  - `<t>.compacting` under 2h old  -> compaction is a single minutes-long LLM
 *    call that emits no hooks; a live one must hold. 2h bounds a leaked marker
 *    (the hook clears it on every UserPromptSubmit/Stop/SessionEnd).
 *  - `<t>.bgactive` fresh           -> teammate activity inside the stale
 *    window; same accepted trade as the hook's own (BG-STALE) reap.
 *  - a codex-companion job JSON for this binding's agent session with status
 *    queued/running touched <6h    -> delegated work on its OWN API; an
 *    UNREADABLE fresh job file counts as active (mid-write is not evidence of
 *    absence — the Python hook retries for the same reason).
 *
 * Filesystem errors are never quiescence: only ENOENT means a marker is
 * absent. Any other failure (EPERM, EMFILE, ...) skips the binding for this
 * pass — an unreadable marker must not green over a live hold, and an
 * unreadable `.askq` dir must NEVER green over a live red.
 *
 * Only when EVERY hold is provably cold does it finalize the turn: broadcast +
 * record `Stop` (or release a parked `.pendingfailure` as `Failed`, consuming
 * the marker exactly like the hook's own DEFERRED-FAILURE release, so an API
 * abort is still never swallowed). Evaluation is READ-ONLY; the commit path
 * re-reads the binding and then performs marker unlink + broadcast + record
 * synchronously, with no await between the re-read and the mutations, so a
 * hook event that lands mid-sweep always wins (the event loop cannot
 * interleave without an await). A wrong green self-corrects on the next real
 * hook event — any PostToolUse/SubagentStart re-asserts working — while the
 * state it repairs cannot self-correct at all, which is the whole trade.
 * A sweep finalization also feeds the companion lifecycle sink (minting its
 * own producer id), so a phone/watch that was told "working" hears the
 * ready/failed ending instead of showing a stuck chat forever. Every
 * finalization is loud: console.warn plus a line in the same
 * `~/.superset/logs/dot-decisions.log` the Python hook writes, so one file
 * still tells the full story of every dot decision.
 *
 * The threshold is deliberately generous: 30 minutes with ZERO hook events,
 * AND a recorded main-turn end, AND every hook-owned hold cold at its own
 * window. A sweep finalization is therefore essentially always a stuck hold,
 * and the log line proves it either way.
 */
const SWEEP_INTERVAL_MS = 5 * 60_000;
const STALE_AFTER_MS = 30 * 60_000;
const CODEX_JOB_FRESH_MS = 6 * 60 * 60_000;
/** The hook's `_MARKER_STALE_SECONDS` (12h), the window a run marker owns. */
const RUN_MARKER_WINDOW_MS = 12 * 60 * 60_000;
/** Longest believable single compaction; bounds a leaked `.compacting`. */
const COMPACT_WINDOW_MS = 2 * 60 * 60_000;

type MarkerStat =
	| { kind: "missing" }
	| { kind: "mtime"; mtimeMs: number }
	| { kind: "error" };

async function statMarker(path: string): Promise<MarkerStat> {
	try {
		return { kind: "mtime", mtimeMs: (await stat(path)).mtimeMs };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { kind: "missing" };
		}
		return { kind: "error" };
	}
}

/**
 * Newest entry mtime in a run-marker directory. "missing" covers an absent OR
 * empty directory (both mean no markers); any readdir/stat failure that is not
 * ENOENT is an error — unknown is not evidence of quiescence.
 */
async function newestRunMarker(dir: string): Promise<MarkerStat> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { kind: "missing" };
		}
		return { kind: "error" };
	}
	let newest: number | null = null;
	for (const entry of entries) {
		const entryStat = await statMarker(join(dir, entry));
		if (entryStat.kind === "error") return { kind: "error" };
		if (entryStat.kind === "missing") continue; // raced removal
		if (newest === null || entryStat.mtimeMs > newest) {
			newest = entryStat.mtimeMs;
		}
	}
	return newest === null ? { kind: "missing" } : { kind: "mtime", mtimeMs: newest };
}

/**
 * Port of the hook's `_codex_job_active` freshness half (status queued/running
 * + job JSON touched inside the cap). The pid probe is deliberately omitted:
 * this runs on a 30-minute-stale binding, where a job file untouched for the
 * whole window plus the 6h cap is the decision boundary the hook itself
 * documents. A FRESH job file that cannot be read or parsed counts as ACTIVE:
 * the companion rewrites job JSON in place, so a mid-write read proves
 * nothing, and this is a final decision for the pass, not a retryable probe —
 * false "active" only keeps the yellow one more sweep.
 */
async function codexJobActive(agentSessionId: string): Promise<boolean> {
	// Collect job dirs from the two known stores; each shape gets its own
	// plain loop. Every filesystem step below is individually caught.
	const jobDirs: string[] = [];
	const pluginsRoot = join(homedir(), ".claude", "plugins", "data");
	try {
		// codex*/state/*/jobs/*.json
		for (const first of await readdir(pluginsRoot)) {
			if (!first.startsWith("codex")) continue;
			const stateRoot = join(pluginsRoot, first, "state");
			try {
				for (const state of await readdir(stateRoot)) {
					jobDirs.push(join(stateRoot, state, "jobs"));
				}
			} catch {
				// no state dir — not a companion install
			}
		}
	} catch {
		// no plugin data dir
	}
	const tmpRoot = join(tmpdir(), "codex-companion");
	try {
		// */jobs/*.json
		for (const first of await readdir(tmpRoot)) {
			jobDirs.push(join(tmpRoot, first, "jobs"));
		}
	} catch {
		// no tmp store
	}
	const now = Date.now();
	for (const jobDir of jobDirs) {
		let jobs: string[];
		try {
			jobs = await readdir(jobDir);
		} catch {
			continue;
		}
		for (const job of jobs) {
			if (!job.endsWith(".json")) continue;
			const path = join(jobDir, job);
			let fresh = false;
			try {
				fresh = now - (await stat(path)).mtimeMs < CODEX_JOB_FRESH_MS;
			} catch {
				continue; // gone between readdir and stat — not a job any more
			}
			if (!fresh) continue;
			try {
				const record = JSON.parse(await readFile(path, "utf8")) as {
					sessionId?: string;
					status?: string;
				};
				if (record.sessionId !== agentSessionId) continue;
				if (record.status === "queued" || record.status === "running") {
					return true;
				}
			} catch {
				// Fresh but unreadable/mid-write: cannot rule it out — hold.
				return true;
			}
		}
	}
	return false;
}

/**
 * Same file the Python hook's `_decision_log` writes, same line shape, so a
 * stuck dot keeps ONE audit trail across both producers. Best-effort.
 */
async function appendDecisionLog(
	terminalId: string,
	sessionId: string | undefined,
	eventType: string,
	reason: string,
): Promise<void> {
	try {
		const dir = join(homedir(), ".superset", "logs");
		await mkdir(dir, { recursive: true });
		const line = `${new Date().toISOString()} terminal=${terminalId} session=${sessionId ?? "None"} eventType=${eventType} ${reason}\n`;
		await appendFile(join(dir, "dot-decisions.log"), line, "utf8");
	} catch {
		// The broadcast is the load-bearing half; a lost log line is acceptable.
	}
}

/**
 * Decide one binding, READ-ONLY: no marker is touched here. Returns the
 * eventType to finalize with (plus the pending-failure marker to consume at
 * commit time, when applicable), or null to leave the binding alone.
 * Exported for tests.
 */
export async function evaluateStaleWorkingBinding(args: {
	terminalId: string;
	agentSessionId?: string;
	staleAfterMs: number;
	nowMs?: number;
}): Promise<{
	eventType: "Stop" | "Failed";
	pendingFailurePath?: string;
	reason: string;
} | null> {
	const { staleAfterMs } = args;
	const now = args.nowMs ?? Date.now();
	// askqMarkerDir owns the path-segment guard (see its docstring: no caller
	// may hold a path built from an unvalidated id) — a null covers every
	// sibling marker path below too, since they share the same id segment.
	const askqDir = askqMarkerDir(args.terminalId);
	if (askqDir === null) return null;
	const root = agentMarkerRoot();

	// POSITIVE turn-end evidence first (also the cheapest, most selective
	// check). A binding stuck in a working state proves nothing about the MAIN
	// loop: an agent deep inside one long quiet stretch (a usage-limit wait, a
	// long MCP/network tool, a non-Claude CLI) posts no hook for the duration
	// and writes no marker at all, so marker silence alone would green live
	// work. The `.mainstopped` sentinel is the hook's own durable record that
	// the main turn ENDED while a hold was still live — exactly the stuck
	// shape this sweep exists to finalize (every hold result keeps it, see
	// (SENTINEL-HOLD)). No sentinel, no finalization.
	const sentinel = await statMarker(
		join(root, `${args.terminalId}.mainstopped`),
	);
	if (sentinel.kind !== "mtime") return null;

	// A pending question is a red; the sweep may never touch it — and an
	// UNREADABLE marker dir is not "no question", so it holds too.
	try {
		const owners = await readdir(askqDir);
		if (owners.length > 0) return null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
	}

	// Each hold is honored at the window the hook itself grants it (see the
	// file comment for why the run-marker window is 12h, not the stale window).
	const holds: Array<[MarkerStat, number]> = [
		[await newestRunMarker(join(root, args.terminalId)), RUN_MARKER_WINDOW_MS],
		[
			await statMarker(join(root, `${args.terminalId}.compacting`)),
			COMPACT_WINDOW_MS,
		],
		[await statMarker(join(root, `${args.terminalId}.bgactive`)), staleAfterMs],
	];
	for (const [marker, windowMs] of holds) {
		if (marker.kind === "error") return null;
		if (marker.kind === "mtime" && now - marker.mtimeMs < windowMs) {
			return null;
		}
	}

	if (args.agentSessionId && (await codexJobActive(args.agentSessionId))) {
		return null;
	}

	const pendingFailurePath = join(root, `${args.terminalId}.pendingfailure`);
	const pendingFailure = await statMarker(pendingFailurePath);
	if (pendingFailure.kind === "error") return null;
	if (pendingFailure.kind === "mtime") {
		// (DEFERRED-FAILURE) release the parked abort instead of greening past
		// it. The marker is consumed by the COMMIT path, after the re-read
		// guard, so an event landing mid-sweep can never lose the abort.
		return {
			eventType: "Failed",
			pendingFailurePath,
			reason:
				"STALE-SWEEP FAILED: deferred StopFailure released, no events and no live holds (host-service sweep)",
		};
	}

	return {
		eventType: "Stop",
		reason:
			"STALE-SWEEP GREEN: no hook events and no live holds for the stale window (host-service sweep)",
	};
}

/**
 * Start the periodic sweep. Returns a stop function. Mirrors
 * `startTerminalReaper`'s shape: unref'd interval, re-entrancy guard, every
 * failure contained per pass.
 */
export function startStaleWorkingSweep(
	store: TerminalAgentStore,
	eventBus: EventBus,
	options?: { intervalMs?: number; staleAfterMs?: number },
): () => void {
	const intervalMs = options?.intervalMs ?? SWEEP_INTERVAL_MS;
	const staleAfterMs = options?.staleAfterMs ?? STALE_AFTER_MS;
	let running = false;

	const run = async () => {
		if (running) return;
		running = true;
		try {
			const now = Date.now();
			for (const binding of store.list()) {
				const mapped = mapEventType(binding.lastEventType);
				if (mapped !== "Start" && mapped !== "SubagentActive") continue;
				if (now - binding.lastEventAt < staleAfterMs) continue;
				let verdict: Awaited<ReturnType<typeof evaluateStaleWorkingBinding>>;
				try {
					verdict = await evaluateStaleWorkingBinding({
						terminalId: binding.terminalId,
						agentSessionId: binding.agentSessionId,
						staleAfterMs,
						nowMs: now,
					});
				} catch (error) {
					console.warn(
						`[terminal-agents] stale-working sweep failed to evaluate ${binding.terminalId}; leaving it untouched`,
						error,
					);
					continue;
				}
				if (verdict === null) continue;
				// COMMIT, with no await from here to the store mutation: the
				// re-read guard, the failure-marker claim and the mutations sit in
				// one synchronous block, so a hook event that landed during the
				// awaited evaluation above is always newer truth and wins, and no
				// event can interleave after the guard passes. The guard reads
				// `store.get` (the in-memory map `recordEvent` mutates) rather
				// than re-running the DB-joined `list()`: the map is the exact
				// state a racing hook event updates first, which is what this
				// freshness check exists to observe.
				const current = store.get(binding.terminalId);
				if (
					current === undefined ||
					current.lastEventAt !== binding.lastEventAt
				) {
					continue;
				}
				if (verdict.pendingFailurePath !== undefined) {
					// The unlink IS the claim on the parked abort, taken only after
					// the guard proved no hook event superseded this pass. Losing
					// the race means the hook released (and announced) the failure
					// itself — skip, announcing it twice would double-alert.
					try {
						unlinkSync(verdict.pendingFailurePath);
					} catch {
						continue;
					}
				}
				// (ONE-BUZZ-UNTIL-READ) strictly-increasing per-terminal stamp,
				// the same shared rule the notifications hook route applies.
				const occurredAt = nextLifecycleInstantMs(now, binding.lastEventAt);
				console.warn(
					`[terminal-agents] (STALE-WORKING-SWEEP) finalizing stuck '${binding.lastEventType}' on terminal ${binding.terminalId} as ${verdict.eventType}: no events for ${Math.round((now - binding.lastEventAt) / 60000)} min and no live holds`,
				);
				eventBus.broadcastAgentLifecycle({
					workspaceId: binding.workspaceId,
					eventType: verdict.eventType,
					terminalId: binding.terminalId,
					occurredAt,
					// Move the dot; never chime/toast for a turn that actually
					// ended half an hour earlier (renderer skips synthetic).
					synthetic: true,
				});
				store.recordEvent({
					terminalId: binding.terminalId,
					workspaceId: binding.workspaceId,
					eventType: verdict.eventType,
					agentId: binding.agentId,
					...(binding.agentSessionId
						? { agentSessionId: binding.agentSessionId }
						: {}),
					occurredAt,
				});
				// The phone/watch was told "working" by the last real event; a
				// sweep ending must reach it too or the companion shows a stuck
				// chat forever. Minted id, same shape the hook produces (16 random
				// bytes -> exactly 22 base64url chars); the sink dedupes by id, so
				// a fresh random id per finalization applies exactly once.
				forwardCompanionLifecycle({
					payload: {
						companionLifecycleEventId: randomBytes(16).toString("base64url"),
						companionLifecycleOutcome:
							verdict.eventType === "Failed" ? "failed" : "ready",
					},
					eventType: verdict.eventType,
					terminalId: binding.terminalId,
					workspaceId: binding.workspaceId,
					occurredAtMs: occurredAt,
					previousEventType: binding.lastEventType,
					previousEventAtMs: binding.lastEventAt,
				});
				await appendDecisionLog(
					binding.terminalId,
					binding.agentSessionId,
					verdict.eventType,
					verdict.reason,
				);
			}
		} catch (error) {
			console.warn("[terminal-agents] stale-working sweep failed:", error);
		} finally {
			running = false;
		}
	};

	const interval = setInterval(() => void run(), intervalMs);
	interval.unref();
	return () => clearInterval(interval);
}
