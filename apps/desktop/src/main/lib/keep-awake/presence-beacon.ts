/**
 * (PUSH-PRESENCE) The desktop half of presence-gated companion push.
 *
 * WHAT IT SENDS AND WHY THE HOST-SERVICE CANNOT WORK IT OUT ITSELF
 * ----------------------------------------------------------------
 * The bridge decides whether a blocked agent's question buzzes the phone, and
 * that decision needs one thing the host-service cannot see: whether the person
 * is at the machine. The host-service is a plain Node child. It sees terminal
 * keystrokes — which prove presence but miss a user reading a long agent
 * transcript, working in another window, or watching Superset on a second
 * monitor — and it has no access to `powerMonitor` at all. Only the Electron
 * main process can ask the OS how long since ANY input and whether the session
 * is locked.
 *
 * So main POSTs it. `idleSeconds` covers every gap the keystroke signal has, and
 * `locked` is the one unambiguous declaration of absence there is (see
 * `companion/presence.ts`, which treats it as an override rather than as one
 * more vote).
 *
 * WHY IT PIGGYBACKS ON THE KEEP-AWAKE TICK
 * ---------------------------------------
 * That timer already exists, already runs only while the companion is enabled,
 * and already crosses to every running host-service over exactly this channel —
 * the coordinator names the orgs, `readManifest` supplies each loopback endpoint
 * and its PSK bearer token, and `agent-activity.ts` has been using it every 15 s
 * since keep-awake shipped. A second timer would be a second thing to start,
 * stop, leak and reason about, for data that is only interesting at the same
 * cadence.
 *
 * The four powerMonitor events are the exception, and they are the whole reason
 * this is not tick-only: a lock or a wake is a step change in presence, and
 * waiting up to 15 s to report it means up to 15 s of a phone not buzzing for a
 * question the user has just walked away from.
 *
 * FAILURE IS NEVER FATAL, AND NEVER NOISY
 * ---------------------------------------
 * A beacon that does not arrive costs exactly one thing: the bridge falls back
 * to keystroke evidence alone, which under-reports presence and therefore errs
 * towards PUSHING. That is the safe direction, so a failure here must never
 * break the keep-awake tick it rides on and must never turn into a log line
 * every 15 s. Nothing in this module throws: every path resolves to an outcome,
 * and repeated failures are logged once until one succeeds.
 */

import log from "electron-log/main";
import { getHostServiceCoordinator } from "../host-service-coordinator";
import {
	type HostServiceManifest,
	readManifest,
} from "../host-service-manifest";
import { COMPANION_ENABLE_ENV } from "./companion-gate";

/**
 * Mirrors the `event` enum on `companion.presenceBeacon`. Copied rather than
 * imported for the reasons `companion-gate.ts` sets out for
 * `COMPANION_ENABLE_ENV`: the host-service package publishes no `./companion`
 * subpath, and the tRPC boundary re-validates the value anyway, so the copies
 * cannot drift silently — a renamed member is a 400 on the very first beacon.
 */
export type PresenceBeaconEvent = "tick" | "lock" | "unlock" | "resume";

/**
 * Per-request budget. Loopback; a slower answer than this means trouble. Same
 * value as the two sibling polls, and module-private there and here for the same
 * reason: a shared constant would couple three budgets for no reason beyond the
 * numbers currently agreeing.
 */
const REQUEST_TIMEOUT_MS = 4_000;

/**
 * The `powerMonitor` slice this module uses.
 *
 * INJECTED, NEVER IMPORTED — the same rule `keep-awake.ts` states for
 * `powerSaveBlocker`, and here it is load-bearing rather than stylistic: a
 * top-level `import { powerMonitor } from "electron"` makes this module
 * unloadable outside an Electron runtime, and `bun test` fails on the import
 * before a single case runs. `index.ts` owns the Electron surface and hands it
 * down; everything below is plain Node and therefore testable.
 */
export interface PowerMonitorLike {
	/** Seconds since ANY system input. Whole seconds. */
	getSystemIdleTime(): number;
	getSystemIdleState(
		idleThreshold: number,
	): "active" | "idle" | "locked" | "unknown";
}

export interface PresenceBeaconDeps {
	/** REQUIRED. See `PowerMonitorLike` for why there is no default. */
	powerMonitor: PowerMonitorLike;
	env?: NodeJS.ProcessEnv;
	listOrgIds?: () => string[];
	readManifestFn?: (organizationId: string) => HostServiceManifest | null;
	fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
	logger?: {
		info(message: string, meta?: unknown): void;
		warn(message: string, meta?: unknown): void;
	};
}

/** Every field settled — what the body below actually runs against. */
interface ResolvedDeps extends Required<PresenceBeaconDeps> {}

/**
 * What one call did. Never a thrown error — see the header.
 *
 * `skipped` is not a failure: the bridge being off is the normal state for every
 * fork user, and having no host-service running is the normal state between
 * workspaces.
 */
export type PresenceBeaconOutcome =
	| { skipped: "disabled" | "no-host-service" }
	| { sent: number; failed: number; idleSeconds: number; locked: boolean };

/**
 * The last lock state we were TOLD about, as opposed to inferred.
 *
 * `getSystemIdleState` answers `"unknown"` on platforms and moments where it
 * cannot tell, and guessing "not locked" there would silently suppress exactly
 * the push a locked machine most needs. So the lock/unlock events latch here and
 * the latch is what an `"unknown"` reading falls back to.
 */
let lockedLatch = false;

/** One-shot failure reporting: true once a failure has been logged, false after a success. */
let failureLogged = false;

function resolveDeps(deps: PresenceBeaconDeps): ResolvedDeps {
	if (
		deps.powerMonitor === null ||
		deps.powerMonitor === undefined ||
		typeof deps.powerMonitor.getSystemIdleTime !== "function"
	) {
		// Validate at the boundary. Without it every beacon would carry a fabricated
		// idle time, which is worse than sending none at all.
		throw new TypeError(
			"(PUSH-PRESENCE) sendPresenceBeacon requires a powerMonitor with getSystemIdleTime/getSystemIdleState",
		);
	}
	return {
		env: deps.env ?? process.env,
		powerMonitor: deps.powerMonitor,
		listOrgIds:
			deps.listOrgIds ??
			(() => getHostServiceCoordinator().getActiveOrganizationIds()),
		readManifestFn: deps.readManifestFn ?? readManifest,
		fetchFn: deps.fetchFn ?? fetch,
		logger: deps.logger ?? {
			info: (message, meta) => log.info(message, meta),
			warn: (message, meta) => log.warn(message, meta),
		},
	};
}

/**
 * Seed the latch from the OS at startup.
 *
 * Without this, an app launched while the screen is locked (an unattended
 * restart, a reboot into a locked session) would report `locked: false` until
 * the user's first unlock — i.e. it would claim presence for a machine nobody is
 * at, which is the one direction this feature must never fail in.
 */
export function initialisePresenceLockState(deps: PresenceBeaconDeps): boolean {
	const { powerMonitor: monitor, logger } = resolveDeps(deps);
	try {
		lockedLatch = monitor.getSystemIdleState(1) === "locked";
	} catch (error) {
		// Unreadable is not "unlocked". Left as-is (false at first call) and SAID,
		// because a wrong latch here is a suppressed push.
		logger.warn("[keep-awake] could not read the initial system idle state", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return lockedLatch;
}

/** Exposed for tests and for `stopKeepAwake`, so state never leaks across runs. */
export function resetPresenceBeaconState(): void {
	lockedLatch = false;
	failureLogged = false;
}

/**
 * Whether the session is locked for the purposes of THIS beacon.
 *
 * A `lock`/`unlock` event IS the fact and decides on its own — polling the OS in
 * the same millisecond can still answer `"active"`, and a lock beacon that says
 * `locked: false` is worse than no beacon at all. Every other event asks the OS
 * and falls back to the latch only when the OS says it cannot tell.
 */
function resolveLocked(
	event: PresenceBeaconEvent,
	monitor: PowerMonitorLike,
): boolean {
	if (event === "lock") {
		lockedLatch = true;
		return true;
	}
	if (event === "unlock") {
		lockedLatch = false;
		return false;
	}
	const state = monitor.getSystemIdleState(1);
	if (state === "locked") {
		lockedLatch = true;
		return true;
	}
	if (state === "unknown") return lockedLatch;
	lockedLatch = false;
	return false;
}

async function postBeacon(
	fetchFn: ResolvedDeps["fetchFn"],
	manifest: HostServiceManifest,
	body: { idleSeconds: number; locked: boolean; event: PresenceBeaconEvent },
): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetchFn(
			`${manifest.endpoint}/trpc/companion.presenceBeacon`,
			{
				method: "POST",
				signal: controller.signal,
				headers: {
					Authorization: `Bearer ${manifest.authToken}`,
					"content-type": "application/json",
				},
				// superjson transformer: a plain object input is wrapped as { json }.
				body: JSON.stringify({ json: body }),
			},
		);
		if (!res.ok) {
			throw new Error(`${manifest.endpoint}: HTTP ${res.status}`);
		}
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Send one beacon to every running host-service.
 *
 * NEVER REJECTS AND NEVER THROWS. The keep-awake tick awaits this inline, and a
 * beacon is advisory data about a feature most users do not have; a rejected
 * promise here would abort a tick whose actual job is deciding whether the
 * machine may sleep.
 */
export async function sendPresenceBeacon(
	event: PresenceBeaconEvent,
	deps: PresenceBeaconDeps,
): Promise<PresenceBeaconOutcome> {
	const {
		env,
		powerMonitor: monitor,
		listOrgIds,
		readManifestFn,
		fetchFn,
		logger,
	} = resolveDeps(deps);

	// The same short-circuit `pollCompanionGate` opens with: with the bridge off —
	// the default for every fork user — this costs one string comparison and makes
	// no request at all.
	if (env[COMPANION_ENABLE_ENV] !== "1") return { skipped: "disabled" };

	let orgIds: string[];
	let idleSeconds: number;
	let locked: boolean;
	try {
		orgIds = listOrgIds();
		if (orgIds.length === 0) return { skipped: "no-host-service" };
		const rawIdle = monitor.getSystemIdleTime();
		if (!Number.isFinite(rawIdle) || rawIdle < 0) {
			// Validate before it crosses the wire: the tRPC boundary would refuse a
			// non-integer anyway, and sending garbage would be one 400 per tick.
			throw new Error(`getSystemIdleTime returned ${String(rawIdle)}`);
		}
		idleSeconds = Math.floor(rawIdle);
		locked = resolveLocked(event, monitor);
	} catch (error) {
		reportFailure(logger, event, error);
		return { skipped: "no-host-service" };
	}

	let sent = 0;
	let failed = 0;
	let lastError: unknown = null;
	for (const orgId of orgIds) {
		try {
			const manifest = readManifestFn(orgId);
			// A running host-service with no manifest is a real problem, but it is
			// `agent-activity.ts`'s problem — it reports it as a failed tick that
			// keeps the machine awake. Here it is one missing beacon.
			if (!manifest) {
				failed += 1;
				lastError = new Error(`host-service ${orgId} has no manifest`);
				continue;
			}
			await postBeacon(fetchFn, manifest, { idleSeconds, locked, event });
			sent += 1;
		} catch (error) {
			failed += 1;
			lastError = error;
		}
	}

	if (failed > 0) {
		reportFailure(logger, event, lastError);
	} else if (failureLogged) {
		failureLogged = false;
		logger.info("[keep-awake] presence beacon recovered", { event });
	}

	return { sent, failed, idleSeconds, locked };
}

/** Log-once. A 15 s timer must not be able to fill the log with the same line. */
function reportFailure(
	logger: ResolvedDeps["logger"],
	event: PresenceBeaconEvent,
	error: unknown,
): void {
	if (failureLogged) return;
	failureLogged = true;
	logger.warn(
		"[keep-awake] presence beacon failed — the companion push falls back to " +
			"terminal keystrokes alone, which errs towards notifying",
		{ event, error: error instanceof Error ? error.message : String(error) },
	);
}
