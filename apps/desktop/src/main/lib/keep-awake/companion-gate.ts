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
 * WHY BOTH HALVES ARE READ HERE RATHER THAN ASKED OF THE BRIDGE
 * ------------------------------------------------------------
 * The bridge lives in the host-service CHILD (`packages/host-service/src/
 * companion/`) and has no channel into Electron main. Both halves of its own
 * enablement are, however, plainly readable from main:
 *
 *   - the env var is inherited by the child from main's `process.env`
 *     (`host-service-coordinator.ts` spawns it with `...process.env`), so main
 *     and the bridge necessarily agree on it;
 *   - `devices.json` is the bridge's own persisted index, written atomically
 *     (tmp -> fsync -> rename) by `device-store.ts`, so a reader can never see
 *     a torn document.
 *
 * Read-only, always async — the fork's live footgun list is explicit that
 * synchronous fs on the main thread starves the `superset-app://` renderer
 * loader.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SUPERSET_HOME_DIR } from "../app-environment";

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
 * The bridge's device index: `$SUPERSET_HOME_DIR/companion/devices/devices.json`
 * (`resolveCompanionPaths` + `device-store.ts`'s `INDEX_FILENAME`). Both
 * processes resolve `SUPERSET_HOME_DIR` from the same env var, which is the
 * agreement `config.ts` documents.
 *
 * Copied for the reasons above, and for one more that is unfixable from here:
 * `INDEX_FILENAME` is module-private to `device-store.ts` and not exported, so
 * even an export path for `companion/` would not reach it.
 */
export const COMPANION_DEVICES_INDEX_PATH = join(
	SUPERSET_HOME_DIR,
	"companion",
	"devices",
	"devices.json",
);

/**
 * A gate read either produced an authoritative answer or it did not. Never
 * both, and never a fabricated "closed" standing in for "could not tell" — the
 * caller treats those differently.
 */
export type CompanionGatePoll =
	| {
			ok: true;
			/** True iff BOTH halves hold: bridge enabled and >=1 live pairing. */
			open: boolean;
			bridgeEnabled: boolean;
			/** Devices that are paired right now — revoked records do not count. */
			pairedDeviceCount: number;
	  }
	| { ok: false; error: string };

interface RawDeviceRecord {
	deviceId: unknown;
	revokedAtMs: unknown;
}

/**
 * Validate at the boundary. This file decides whether the machine may sleep, so
 * an unexpected shape is a hard error for the whole read — never a silently
 * skipped row, which would under-count pairings and release the blocker on a
 * paired machine.
 *
 * Deliberately validates only what the decision rests on. The bridge's
 * `parseRecord` is the full validator and owns the record contract; duplicating
 * it here would rot, and a record this reader cannot fully understand is still
 * unambiguously a pairing.
 */
function countPairedDevices(payload: unknown, file: string): number {
	if (!Array.isArray(payload)) {
		throw new Error(`${file}: expected a JSON array of device records`);
	}
	let paired = 0;
	for (const [index, entry] of payload.entries()) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`${file}: record ${index} is not an object`);
		}
		const { deviceId, revokedAtMs } = entry as RawDeviceRecord;
		if (typeof deviceId !== "string" || deviceId.length === 0) {
			throw new Error(`${file}: record ${index} has no deviceId`);
		}
		if (revokedAtMs !== null && typeof revokedAtMs !== "number") {
			throw new Error(
				`${file}: record ${deviceId} has an invalid revokedAtMs (${typeof revokedAtMs})`,
			);
		}
		// Revoked records are retained 30 days so audit entries stay
		// attributable (§4.8). A retained record is NOT a pairing: `unpair_all`
		// must drop the hold immediately, not in a month.
		if (revokedAtMs === null) paired += 1;
	}
	return paired;
}

/**
 * Evaluate the gate.
 *
 * The env check comes first and short-circuits: with the bridge off — the
 * default for every fork user — this costs one string comparison every poll and
 * touches the disk not at all.
 *
 * `env` and `indexPath` are injected for tests only; production always passes
 * neither (same pattern as `KeepAwakeManagerDeps.now`).
 */
export async function pollCompanionGate(
	env: NodeJS.ProcessEnv = process.env,
	indexPath: string = COMPANION_DEVICES_INDEX_PATH,
): Promise<CompanionGatePoll> {
	const bridgeEnabled = env[COMPANION_ENABLE_ENV] === "1";
	if (!bridgeEnabled) {
		return {
			ok: true,
			open: false,
			bridgeEnabled: false,
			pairedDeviceCount: 0,
		};
	}

	let raw: string;
	try {
		raw = await readFile(indexPath, "utf8");
	} catch (error) {
		// A missing index is not a failure: it is the bridge's own representation
		// of "nothing has ever paired". Any OTHER errno is a real read failure and
		// must not masquerade as an empty device list.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				ok: true,
				open: false,
				bridgeEnabled: true,
				pairedDeviceCount: 0,
			};
		}
		return {
			ok: false,
			error: `${indexPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			ok: false,
			error: `${indexPath} is not valid JSON: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}

	let pairedDeviceCount: number;
	try {
		pairedDeviceCount = countPairedDevices(parsed, indexPath);
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	return {
		ok: true,
		open: pairedDeviceCount > 0,
		bridgeEnabled: true,
		pairedDeviceCount,
	};
}
