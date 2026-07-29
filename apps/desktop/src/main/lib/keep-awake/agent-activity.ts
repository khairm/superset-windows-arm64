/**
 * (KEEP-AWAKE) Agent-activity source for the power request.
 *
 * WHERE THE TRUTH LIVES, AND WHY THIS CROSSES A PROCESS BOUNDARY
 * --------------------------------------------------------------
 * The authoritative agent-status signal in this fork is the host-service
 * `TerminalAgentStore`: `superset-notify.py` POSTs every Claude lifecycle event
 * to `notifications.hook` (`SUPERSET_HOST_AGENT_HOOK_URL`), the route maps it
 * through the one `mapEventType` vocabulary and calls
 * `terminalAgentStore.recordEvent`, and the renderer's dot/axes machinery is
 * driven from the same broadcast. Nothing else in this app knows the real state.
 *
 * That store lives in the host-service CHILD process, which is plain Node
 * (`apps/desktop/src/main/host-service/index.ts`) and therefore has no
 * `powerSaveBlocker`. The blocker can only be held by the Electron main
 * process. So main reads the store rather than keeping a parallel copy of it —
 * over the exact local HTTP + PSK-bearer channel `(AUTO-RESUME)` already uses
 * (`readManifest` → `Authorization: Bearer <manifest.authToken>` → `/trpc/...`).
 *
 * Deliberately a poll, not a push:
 *   - releasing needs a periodic evaluation anyway (there is no "everything
 *     went idle" event — an interrupt fires no hook at all);
 *   - a poll re-derives the whole answer from the one store every tick, so it
 *     cannot drift, and it self-heals across a host-service restart;
 *   - the alternative (a second POST from the hook into the desktop's express
 *     server) would have put Claude events on the `/hook/complete` path that
 *     drives chimes and OS notifications, changing dot/notification behaviour.
 *     Additive-only is a hard requirement here.
 *
 * The cost is one loopback GET per running host-service every 15 s — and only
 * while the companion gate is open (`companion-gate.ts`), so a fork user without
 * the companion pays nothing at all.
 */

import type { AgentLifecycleEventType } from "@superset/host-service/events";
import log from "electron-log/main";
import { getHostServiceCoordinator } from "../host-service-coordinator";
import { readManifest } from "../host-service-manifest";
import type { ActiveAgent } from "./keep-awake";

/** How often the blocker decision is re-derived. */
export const POLL_INTERVAL_MS = 15_000;

/** Per-request budget. Loopback; a slower answer than this means trouble. */
const REQUEST_TIMEOUT_MS = 4_000;

/**
 * `lastEventType` values that mean "working, or blocked waiting for a human".
 *
 * Typed as the host-service `AgentLifecycleEventType` union itself, imported
 * TYPE-ONLY (erased at build time, so Electron main gains no runtime dependency
 * on host-service). A member renamed or removed upstream is then a compile
 * error on the literals below rather than a set that silently stops matching
 * and lets the machine sleep mid-turn.
 *
 *   Start             the agent is mid-turn (working)
 *   SubagentActive    the turn ended but teammates/forks/workflows are running
 *   PermissionRequest a permission prompt or an AskUserQuestion is on screen —
 *                     "a question is pending" in the literal sense
 *
 * Deliberately EXCLUDED:
 *   BackgroundRunning is the blue axis: a background SHELL, not an agent turn.
 *                     The fork has already had blue latch on after the thing
 *                     that set it died (BG-STALE); a stuck blue here would pin
 *                     the machine awake forever, which is a worse failure than
 *                     a background shell losing a few minutes to sleep.
 *   Stop / Failed     the turn is over.
 *   Attached          session boot; the agent is idle waiting for input.
 *   Detached          the binding is gone.
 */
const ACTIVE_EVENT_TYPES: ReadonlySet<AgentLifecycleEventType> =
	new Set<AgentLifecycleEventType>([
		"Start",
		"SubagentActive",
		"PermissionRequest",
	]);

/**
 * Bindings older than this are ignored even if their last event says "working".
 *
 * Needed because an interrupt (Esc / Ctrl-C) fires NO hook at all, so a binding
 * can sit on `Start` forever with the agent long since idle — the same leak the
 * renderer's "Clear Status" escape hatch exists for. Six hours is deliberately
 * generous: a single long tool call (a full build, a long test run) emits no
 * hook between `PreToolUse` and `PostToolUse`, and an AskUserQuestion can
 * legitimately sit unanswered all afternoon. Dropping one of those early would
 * cause exactly the false watchdog alarm this feature exists to prevent, so the
 * cap errs towards holding too long, and says so in the log when it trips.
 */
const STALE_ACTIVITY_MS = 6 * 60 * 60 * 1000;

/** A tick either produced an authoritative answer or it did not. Never both. */
export type ActivityPoll =
	| { ok: true; active: ActiveAgent[]; hostServiceCount: number }
	| { ok: false; error: string };

interface RawBinding {
	terminalId: unknown;
	workspaceId: unknown;
	agentId: unknown;
	lastEventAt: unknown;
	lastEventType: unknown;
}

/**
 * Validate at the boundary. The host-service is ours, but this is still a
 * network response being turned into a decision about whether the machine may
 * sleep — an unexpected shape is a hard error for the whole tick, never a
 * silently-dropped row.
 */
function parseBindings(payload: unknown, endpoint: string): RawBinding[] {
	if (typeof payload !== "object" || payload === null) {
		throw new Error(`${endpoint}: response was not an object`);
	}
	const result = (payload as { result?: unknown }).result;
	if (typeof result !== "object" || result === null) {
		throw new Error(`${endpoint}: response has no \`result\``);
	}
	const data = (result as { data?: unknown }).data;
	if (typeof data !== "object" || data === null) {
		throw new Error(`${endpoint}: response has no \`result.data\``);
	}
	const json = (data as { json?: unknown }).json;
	if (!Array.isArray(json)) {
		throw new Error(`${endpoint}: \`result.data.json\` is not an array`);
	}
	return json as RawBinding[];
}

function toActiveAgent(
	binding: RawBinding,
	endpoint: string,
	nowMs: number,
): ActiveAgent | null {
	const { terminalId, workspaceId, agentId, lastEventAt, lastEventType } =
		binding;
	if (typeof terminalId !== "string" || terminalId.length === 0) {
		throw new Error(`${endpoint}: binding has no terminalId`);
	}
	if (typeof workspaceId !== "string" || workspaceId.length === 0) {
		throw new Error(`${endpoint}: binding ${terminalId} has no workspaceId`);
	}
	if (typeof agentId !== "string" || agentId.length === 0) {
		throw new Error(`${endpoint}: binding ${terminalId} has no agentId`);
	}
	if (typeof lastEventAt !== "number" || !Number.isFinite(lastEventAt)) {
		throw new Error(`${endpoint}: binding ${terminalId} has no lastEventAt`);
	}
	// `lastEventType` may be absent on a binding restored from persistence
	// before its first event landed. Absent is unambiguously "no event has
	// proven this agent active", not a shape error — anything else IS.
	if (
		lastEventType !== undefined &&
		lastEventType !== null &&
		typeof lastEventType !== "string"
	) {
		throw new Error(
			`${endpoint}: binding ${terminalId} lastEventType is ${typeof lastEventType}`,
		);
	}
	if (typeof lastEventType !== "string") return null;
	// Widened to `ReadonlySet<string>` for the lookup only: the value on the wire
	// is an arbitrary string until this test passes, and the declaration above is
	// what keeps the MEMBERS honest against an upstream rename.
	if (!(ACTIVE_EVENT_TYPES as ReadonlySet<string>).has(lastEventType)) {
		return null;
	}

	const ageMs = nowMs - lastEventAt;
	if (ageMs > STALE_ACTIVITY_MS) {
		log.warn("[keep-awake] ignoring stale binding", {
			terminalId,
			lastEventType,
			ageMs,
			staleAfterMs: STALE_ACTIVITY_MS,
			note: "agent probably interrupted (interrupts fire no hook)",
		});
		return null;
	}

	// Only what the blocker decision consumes is carried forward. `workspaceId`,
	// `agentId` and `lastEventAt` are still VALIDATED above — a malformed row is
	// a hard error for the whole tick — they are simply not part of the answer.
	return { terminalId, lastEventType };
}

async function fetchBindings(
	endpoint: string,
	authToken: string,
	nowMs: number,
): Promise<ActiveAgent[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetch(`${endpoint}/trpc/terminalAgents.list`, {
			method: "GET",
			signal: controller.signal,
			headers: { Authorization: `Bearer ${authToken}` },
		});
		if (!res.ok) {
			throw new Error(`${endpoint}: HTTP ${res.status}`);
		}
		const bindings = parseBindings(await res.json(), endpoint);
		const active: ActiveAgent[] = [];
		for (const binding of bindings) {
			const agent = toActiveAgent(binding, endpoint, nowMs);
			if (agent) active.push(agent);
		}
		return active;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * One authoritative read across every running host-service.
 *
 * If ANY host-service fails to answer the whole tick is `ok: false`. A partial
 * answer would look identical to "everything went idle" and would release the
 * machine to sleep mid-turn — the failure this feature exists to stop.
 *
 * Zero running host-services is `ok: true` with an empty set, and that is a
 * REAL limitation worth stating: PTYs survive under the detached pty-daemon, so
 * an agent can still be working while this app has no host-service to ask. The
 * blocker is released in that window and the phone's liveness watchdog (§7.7)
 * is the backstop. Holding the machine awake on the strength of a store we can
 * no longer read would be a guess.
 */
export async function pollAgentActivity(
	nowMs: number = Date.now(),
): Promise<ActivityPoll> {
	const orgIds = getHostServiceCoordinator().getActiveOrganizationIds();
	if (orgIds.length === 0) {
		return { ok: true, active: [], hostServiceCount: 0 };
	}

	const active: ActiveAgent[] = [];
	for (const orgId of orgIds) {
		const manifest = readManifest(orgId);
		if (!manifest) {
			return {
				ok: false,
				error: `host-service ${orgId} is running but has no manifest`,
			};
		}
		try {
			active.push(
				...(await fetchBindings(manifest.endpoint, manifest.authToken, nowMs)),
			);
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	return { ok: true, active, hostServiceCount: orgIds.length };
}
