/**
 * (KEEP-AWAKE) Whether the companion feature is actually in use — the gate on
 * the power request.
 *
 * WHY THIS EXISTS
 * ---------------
 * The blocker is held for ONE reason: the companion phone must be able to reach
 * this machine while an agent is working. A fork user who never installs the
 * companion gets no benefit from it and a real cost — an unanswered
 * AskUserQuestion would otherwise pin a laptop out of sleep for up to the
 * `STALE_ACTIVITY_MS` cap, every night, for a feature they do not have.
 *
 * FEATURES.md is explicit that the hold lasts "for exactly as long as the
 * companion bridge is enabled AND at least one device is paired, released the
 * moment either stops being true". This module is that predicate; agent
 * activity only decides whether to hold WITHIN an open gate.
 *
 * WHERE THE PAIRED COUNT COMES FROM, AND WHY IT IS ASKED FOR OVER HTTP
 * --------------------------------------------------------------------
 * The device index is rows in the host-service's host.db — `(DEVICE-INDEX-DB)`
 * retired the `devices.json` file this module used to read, and the migration
 * unlinks it after import, so a file read here would answer "nothing has ever
 * paired" forever on any machine that has actually paired. Only the bridge's
 * device store can read those rows, and it lives in the host-service CHILD.
 *
 * So this module asks the child, over the exact channel `agent-activity.ts`
 * already crosses every tick the gate is open: the coordinator names the
 * running host-services, `readManifest` supplies each one's loopback endpoint
 * and PSK bearer token, and the `companion.gate` tRPC query answers with the
 * authoritative count. The env var check still short-circuits first — it is
 * inherited by the child from main's `process.env`
 * (`host-service-coordinator.ts` spawns it with `...process.env`), so main and
 * the bridge necessarily agree on it, and with the bridge off — the default
 * for every fork user — a poll costs one string comparison and no I/O at all.
 *
 * Failure semantics are the caller's contract (`keep-awake/index.ts`): an
 * `ok: false` read can never ACQUIRE the hold, and never releases one that an
 * earlier authoritative read proved open.
 */

import log from "electron-log/main";
import { getHostServiceCoordinator } from "../host-service-coordinator";
import {
	type HostServiceManifest,
	readManifest,
} from "../host-service-manifest";

/**
 * Mirror of `COMPANION_ENABLE_ENV` in
 * `packages/host-service/src/companion/config.ts`.
 *
 * WHY IT IS COPIED AND NOT IMPORTED — checked, not assumed:
 *   - `@superset/host-service`'s `exports` map has no `./companion` subpath, so
 *     `@superset/host-service/companion/config` does not resolve, and adding one
 *     means editing `package.json` — which puts the whole tree under the nightly
 *     `(LOCK-REGEN)` lockfile gate for one string constant;
 *   - the package root (`src/index.ts`) re-exports no companion module at all,
 *     and importing it would pull the entire host-service runtime into the
 *     Electron main process;
 *   - `config.ts` cannot be reached type-only either: `COMPANION_ENABLE_ENV` is
 *     a VALUE, and that module's top level imports `node:child_process` and
 *     builds a promisified `execFile`, so any import of it is real runtime code
 *     in main — the opposite of what this file exists to avoid.
 *
 * So the two MUST stay in step by hand: the bridge is off unless this is exactly
 * "1", and so is the blocker.
 */
export const COMPANION_ENABLE_ENV = "SUPERSET_COMPANION_BRIDGE";

/**
 * Per-request budget. Loopback; a slower answer than this means trouble. Same
 * value as `agent-activity.ts`'s `REQUEST_TIMEOUT_MS`, which is deliberately
 * module-private there — a shared constant would couple the two polls' budgets
 * for no reason beyond the numbers currently agreeing.
 */
const REQUEST_TIMEOUT_MS = 4_000;

/**
 * A gate read either produced an authoritative answer or it did not. Never
 * both, and never a fabricated "closed" standing in for "could not tell" — the
 * caller treats those differently.
 */
export type CompanionGatePoll =
	| {
			ok: true;
			/** True iff ALL THREE hold: enabled, a running bridge, >=1 live pairing. */
			open: boolean;
			bridgeEnabled: boolean;
			/**
			 * Whether any host-service reported a RUNNING bridge. Surfaced so a
			 * closed gate is attributable: `pairedDeviceCount` below is only
			 * meaningful when this is true.
			 */
			bridgeRunning: boolean;
			/**
			 * Devices that are paired right now — revoked records do not count.
			 * When `bridgeRunning` is false the production router cannot read the
			 * device store (it lives inside a started bridge) and necessarily
			 * answers 0 — so 0 there means "unknowable", never "none paired".
			 */
			pairedDeviceCount: number;
	  }
	| { ok: false; error: string };

/**
 * What one host-service's `companion.gate` query answered. Mirrors
 * `CompanionGateStatus` in `trpc/router/companion/companion.ts`; copied, not
 * imported, for the same reasons as `COMPANION_ENABLE_ENV` above — and safely,
 * because `parseGateStatus` re-validates every field at this boundary, so the
 * copies cannot drift silently.
 */
interface ChildGateStatus {
	bridgeEnabled: boolean;
	bridgeRunning: boolean;
	pairedDeviceCount: number;
}

/**
 * Injected for tests only; production always passes nothing (same pattern as
 * `KeepAwakeManagerDeps.now`).
 *
 * `fetchFn` is typed as the call shape this module actually uses rather than
 * `typeof fetch` — Bun's `fetch` type carries extras (`preconnect`) that a
 * test stub has no business implementing.
 */
export interface CompanionGateDeps {
	env: NodeJS.ProcessEnv;
	listOrgIds: () => string[];
	readManifestFn: (organizationId: string) => HostServiceManifest | null;
	fetchFn: (input: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Validate at the boundary. The host-service is ours, but this is still a
 * network response being turned into a decision about whether the machine may
 * sleep — an unexpected shape is a hard error for the whole tick, never a
 * silently-defaulted field.
 */
function parseGateStatus(payload: unknown, endpoint: string): ChildGateStatus {
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
	if (typeof json !== "object" || json === null) {
		throw new Error(`${endpoint}: \`result.data.json\` is not an object`);
	}
	const { bridgeEnabled, bridgeRunning, pairedDeviceCount } = json as Record<
		string,
		unknown
	>;
	if (typeof bridgeEnabled !== "boolean") {
		throw new Error(`${endpoint}: \`bridgeEnabled\` is not a boolean`);
	}
	if (typeof bridgeRunning !== "boolean") {
		throw new Error(`${endpoint}: \`bridgeRunning\` is not a boolean`);
	}
	if (
		typeof pairedDeviceCount !== "number" ||
		!Number.isInteger(pairedDeviceCount) ||
		pairedDeviceCount < 0
	) {
		throw new Error(
			`${endpoint}: \`pairedDeviceCount\` is not a non-negative integer`,
		);
	}
	return { bridgeEnabled, bridgeRunning, pairedDeviceCount };
}

async function fetchGateStatus(
	fetchFn: CompanionGateDeps["fetchFn"],
	endpoint: string,
	authToken: string,
): Promise<ChildGateStatus> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetchFn(`${endpoint}/trpc/companion.gate`, {
			method: "GET",
			signal: controller.signal,
			headers: { Authorization: `Bearer ${authToken}` },
		});
		if (!res.ok) {
			throw new Error(`${endpoint}: HTTP ${res.status}`);
		}
		return parseGateStatus(await res.json(), endpoint);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Evaluate the gate.
 *
 * The env check comes first and short-circuits: with the bridge off — the
 * default for every fork user — this costs one string comparison every poll and
 * makes no request at all.
 */
export async function pollCompanionGate(
	deps: Partial<CompanionGateDeps> = {},
): Promise<CompanionGatePoll> {
	const env = deps.env ?? process.env;
	const bridgeEnabled = env[COMPANION_ENABLE_ENV] === "1";
	if (!bridgeEnabled) {
		return {
			ok: true,
			open: false,
			bridgeEnabled: false,
			bridgeRunning: false,
			pairedDeviceCount: 0,
		};
	}

	const listOrgIds =
		deps.listOrgIds ??
		(() => getHostServiceCoordinator().getActiveOrganizationIds());
	const readManifestFn = deps.readManifestFn ?? readManifest;
	const fetchFn = deps.fetchFn ?? fetch;

	// Zero running host-services is a real "closed", not a failure: with no
	// host-service there is no answer path, so there is nothing to hold the
	// machine awake FOR. The same REAL limitation `pollAgentActivity` states
	// applies here: PTYs survive under the detached pty-daemon, so an agent can
	// still be working while this app has no host-service to ask — the blocker
	// is released in that window and the phone's liveness watchdog (§7.7) is
	// the backstop.
	const orgIds = listOrgIds();
	if (orgIds.length === 0) {
		return {
			ok: true,
			open: false,
			bridgeEnabled: true,
			bridgeRunning: false,
			pairedDeviceCount: 0,
		};
	}

	// If ANY host-service fails to answer, the whole read is `ok: false` — a
	// partial sum would look identical to "fewer devices are paired" and could
	// release the machine to sleep mid-question.
	let pairedDeviceCount = 0;
	let anyBridgeRunning = false;
	for (const orgId of orgIds) {
		const manifest = readManifestFn(orgId);
		if (!manifest) {
			return {
				ok: false,
				error: `host-service ${orgId} is running but has no manifest`,
			};
		}
		let status: ChildGateStatus;
		try {
			status = await fetchGateStatus(
				fetchFn,
				manifest.endpoint,
				manifest.authToken,
			);
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		// A child THIS main spawned inherits main's env (`...process.env` in the
		// coordinator's spawn), so the two agree on the enable flag. An ADOPTED
		// host-service (`owned: false` — spawned by another app instance, which
		// on Windows may predate the user persisting the env var) does not, and
		// honestly reports disabled. The gate cannot tell adoption from a real
		// inheritance break, so both are a hard error, never quietly folded into
		// "closed" — and the error names the benign cause so a diagnosis is not
		// sent hunting for an impossibility. Self-heals when the foreign
		// service exits.
		if (!status.bridgeEnabled) {
			return {
				ok: false,
				error:
					`host-service ${orgId} reports ${COMPANION_ENABLE_ENV} unset while ` +
					`main's environment has it set to "1" — either it was adopted from ` +
					`another app instance started before the variable was set (benign; ` +
					`clears when that instance exits), or env inheritance is broken`,
			};
		}
		anyBridgeRunning ||= status.bridgeRunning;
		pairedDeviceCount += status.pairedDeviceCount;
	}

	// Only ONE bridge can exist per machine — a second fails loud binding 47610
	// — but the sum is taken anyway rather than short-circuiting on the first
	// running bridge: if that invariant ever breaks, a count is still a count.
	if (pairedDeviceCount > 0 && !anyBridgeRunning) {
		// UNREACHABLE against the production router, which answers 0 whenever the
		// bridge is not running (the device store lives inside a started bridge,
		// so a down bridge has no count to give). Kept as a tripwire for that
		// invariant breaking: a positive count with no running bridge means the
		// answer path is gone while the user believes they are covered. The REAL
		// paired-but-down state reaches this gate as running:false + count 0 —
		// which is why `bridgeRunning` is part of the poll result and of the
		// gate-transition log line, and the host-service's own [companion-bridge]
		// start-failure log is where the reason lives.
		log.warn(
			"[keep-awake] companion devices are paired but no bridge is running — " +
				"the gate is closed; the host-service log carries the reason " +
				"(search for [companion-bridge])",
			{ pairedDeviceCount },
		);
	}
	return {
		ok: true,
		open: anyBridgeRunning && pairedDeviceCount > 0,
		bridgeEnabled: true,
		bridgeRunning: anyBridgeRunning,
		pairedDeviceCount,
	};
}
