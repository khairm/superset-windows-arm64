/**
 * (CLOUD-SEVERANCE-P2) FORK_LOCAL_ORG — the frozen local organization id.
 *
 * WHY THIS EXISTS AT ALL. Phase 2 removes cloud sign-in, and with it the only
 * thing that ever told this machine which organization it belongs to. Every
 * piece of local state is keyed by that id: the host-service database
 * (`~/.superset/host/<orgId>/host.db`, which is also where the companion's
 * paired-device tables live), the localStorage collections (kanban, snooze,
 * archive, recycle bin, sidebar order), the IndexedDB workspace snapshots, the
 * pty-daemon's addressing, and the bundled CLI's manifest discovery. An id that
 * changes is not a cosmetic reset — it is a different machine as far as all of
 * that is concerned.
 *
 * WHY MINTING A FRESH ID IS FORBIDDEN, stated precisely, because the failure is
 * worse than "the sidebar looks empty". The companion bridge splits its state
 * across the org boundary on purpose: the device INDEX lives in the org-scoped
 * host.db, while the anti-rollback ANCHOR (`~/.superset/companion/
 * state-anchor.json`) and the key material (`~/.superset/companion/devices/`)
 * do NOT. Point the app at an empty host.db and the index reads sequence 0
 * while the anchor still says 17 — the anchor LEADS the index, which is exactly
 * the shape of a state-rollback attack, so `assertNoRollback` refuses to start
 * the bridge and, by design, refuses FOREVER rather than deleting the anchor.
 * The one feature this whole phase is meant to preserve would be the first
 * casualty of a fresh uuid. So: ADOPT, never mint, unless there is provably
 * nothing to adopt.
 *
 * WHY THE DISK IS THE SOURCE OF TRUTH AND NOT `auth-token.enc`. The encrypted
 * token file also carries organization ids, but it carries them PLURAL with no
 * way to say which one holds the user's work, it is quarantined wholesale on
 * decrypt failure, and phase 2 deletes the sign-in path that maintained it — so
 * it decays into a stale cache the moment this ships. The host directories are
 * the actual state; a `host.db` sitting in one is proof that this machine did
 * real work under that id. The token file is consulted only to break a tie.
 *
 * THE ANSWER IS DECIDED ONCE AND WRITTEN DOWN. After the first resolution the
 * id comes from `~/.superset/fork-local-org.json` and the scan never runs
 * again. Re-deriving on every boot would make the identity a function of
 * directory mtimes, and a stray `host.db` (a restored backup, a second profile)
 * could silently move the whole app onto different data between two launches.
 */

import { randomUUID } from "node:crypto";
import {
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	SUPERSET_HOME_DIR,
	SUPERSET_HOME_DIR_MODE,
	SUPERSET_SENSITIVE_FILE_MODE,
} from "../app-environment";

/**
 * Paths are resolved per call rather than captured at import. `app-environment`
 * publishes the home directory into the environment as it loads, and reading it
 * back each time keeps this module honest about where it is looking instead of
 * freezing an answer at module-load order — which also lets a test point a case
 * at its own directory without the import graph deciding for it.
 */
function homeDir(): string {
	return process.env.SUPERSET_HOME_DIR || SUPERSET_HOME_DIR;
}

/** Where the decision is recorded. Fork-owned; upstream never reads it. */
function localOrgFile(): string {
	return join(homeDir(), "fork-local-org.json");
}

/** The directory the host-service coordinator scopes per organization. */
function hostRootDir(): string {
	return join(homeDir(), "host");
}

/**
 * `packages/host-service/src/env.ts` validates ORGANIZATION_ID with
 * `z.string().uuid()`, and the coordinator additionally requires a path-safe
 * id. A resolved id that fails either would take down the host-service — and
 * with it every terminal — so it is checked here, at the one place the value
 * is produced.
 *
 * DELIBERATELY NO VERSION OR VARIANT CONSTRAINT. An earlier form of this
 * pattern accepted only RFC-4122 v1–v5, which is STRICTER than the zod check
 * it claims to mirror (zod accepts the RFC-9562 additions and the nil uuid).
 * Being stricter here is not a safe direction to err in: a host directory the
 * platform considers perfectly valid would be skipped as though it did not
 * exist, the scan would find nothing to adopt, and the resolver would mint a
 * fresh id — which is the one outcome that permanently refuses to start the
 * companion bridge. Directories are filtered by whether they hold a `host.db`,
 * not by which uuid version named them.
 */
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LocalOrgDecision {
	organizationId: string;
	/** How the id was arrived at. Diagnostic only — never re-read as logic. */
	source: "persisted" | "adopted" | "adopted-tiebreak" | "minted";
	decidedAt: string;
}

let cached: LocalOrgDecision | null = null;

function isUsableOrgId(value: unknown): value is string {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * Host directories that contain a `host.db`. A directory holding only a
 * pty-daemon log is not a candidate: the daemon writes one under a default
 * all-zero uuid on machines that never signed in, and adopting that would
 * point the app at an organization that has never held any data.
 */
function isDirectoryEntry(root: string, entry: Dirent): boolean {
	if (entry.isDirectory()) return true;
	if (!entry.isSymbolicLink()) return false;
	try {
		return statSync(join(root, entry.name)).isDirectory();
	} catch {
		// A link with no target is not a candidate.
		return false;
	}
}

function findAdoptableOrgIds(): { organizationId: string; mtimeMs: number }[] {
	const root = hostRootDir();
	if (!existsSync(root)) return [];
	const candidates: { organizationId: string; mtimeMs: number }[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!isUsableOrgId(entry.name)) continue;
		// `isDirectory()` is FALSE for a symlink or a Windows junction that
		// points at one, and relocating a multi-gigabyte host directory to
		// another drive with `mklink /J` is an ordinary thing to do. Treating
		// that as "no candidate" would mint a fresh id and strand the data the
		// junction points at.
		if (!isDirectoryEntry(root, entry)) continue;
		try {
			// One stat, not an exists-then-stat pair: a missing host.db throws
			// ENOENT here and lands in the same catch as an unreadable one,
			// which is the behaviour either way. An unreadable candidate is not
			// a candidate; skipping it can only narrow the field, and a field
			// narrowed to nothing still fails loud below rather than guessing.
			candidates.push({
				organizationId: entry.name,
				mtimeMs: statSync(join(root, entry.name, "host.db")).mtimeMs,
			});
		} catch {
			// Not a candidate.
		}
	}
	return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function readPersistedDecision(): LocalOrgDecision | null {
	const file = localOrgFile();
	if (!existsSync(file)) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf-8"));
	} catch (error) {
		throw new Error(
			`[local-org] ${file} is unreadable (${String(error)}). ` +
				"Refusing to re-derive the local organization id: a wrong answer " +
				"here points the app at a different host.db and refuses to start " +
				"the companion bridge. Repair or delete the file deliberately.",
		);
	}
	const organizationId = (raw as { organizationId?: unknown })?.organizationId;
	if (!isUsableOrgId(organizationId)) {
		throw new Error(
			`[local-org] ${file} does not contain a usable ` +
				"organizationId. Repair or delete the file deliberately.",
		);
	}
	return {
		organizationId,
		source: "persisted",
		decidedAt:
			typeof (raw as { decidedAt?: unknown })?.decidedAt === "string"
				? (raw as { decidedAt: string }).decidedAt
				: "unknown",
	};
}

function persistDecision(decision: LocalOrgDecision): void {
	mkdirSync(homeDir(), { recursive: true, mode: SUPERSET_HOME_DIR_MODE });
	writeFileSync(localOrgFile(), `${JSON.stringify(decision, null, 2)}\n`, {
		encoding: "utf-8",
		mode: SUPERSET_SENSITIVE_FILE_MODE,
	});
}

/**
 * Resolve the local organization id, deciding and recording it on first call.
 *
 * `readStoredOrganizationIds` reads the membership the pre-severance app
 * cached in `auth-token.enc`. It is passed as a FUNCTION, and awaited only in
 * the one branch that needs it, for a reason that matters on this boot path:
 * reading that file derives a key with `scryptSync`, which costs roughly 400ms
 * of fully blocked main thread, and this resolver runs before any window
 * exists. Taking the value eagerly would have spent that on every launch to
 * feed an argument that is unreachable unless the machine holds two host
 * databases — which is to say, essentially never.
 *
 * It is a TIEBREAK ONLY: with several adoptable directories, the id the last
 * real session belonged to is the right one. Ambiguity that survives the
 * tiebreak throws — picking the newest mtime there would be a coin flip whose
 * losing side silently strands the user's workspaces and permanently refuses
 * to start their paired devices' bridge.
 */
export async function resolveLocalOrgId(
	readStoredOrganizationIds: () => Promise<
		readonly string[] | null
	> = async () => null,
): Promise<LocalOrgDecision> {
	if (cached) return cached;

	const persisted = readPersistedDecision();
	if (persisted) {
		cached = persisted;
		return cached;
	}

	const candidates = findAdoptableOrgIds();

	let decision: LocalOrgDecision;
	if (candidates.length === 1) {
		decision = {
			organizationId: candidates[0].organizationId,
			source: "adopted",
			decidedAt: new Date().toISOString(),
		};
	} else if (candidates.length === 0) {
		decision = {
			organizationId: randomUUID(),
			source: "minted",
			decidedAt: new Date().toISOString(),
		};
	} else {
		const stored = new Set((await readStoredOrganizationIds()) ?? []);
		const matches = candidates.filter((candidate) =>
			stored.has(candidate.organizationId),
		);
		if (matches.length !== 1) {
			throw new Error(
				`[local-org] ${candidates.length} host databases exist ` +
					`(${candidates.map((c) => c.organizationId).join(", ")}) and the ` +
					"last signed-in session does not single one out. Refusing to " +
					"guess: the wrong choice strands your workspaces and permanently " +
					`refuses to start the companion bridge. Write the correct id to ` +
					`${localOrgFile()} as {"organizationId":"<id>"} to decide.`,
			);
		}
		decision = {
			organizationId: matches[0].organizationId,
			source: "adopted-tiebreak",
			decidedAt: new Date().toISOString(),
		};
	}

	persistDecision(decision);
	console.info(
		`[local-org] local organization id ${decision.organizationId} (${decision.source})`,
	);
	cached = decision;
	return cached;
}

/** Test seam. Production code resolves once and caches for the process. */
export function resetLocalOrgCacheForTests(): void {
	cached = null;
}
