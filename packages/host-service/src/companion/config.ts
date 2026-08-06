/**
 * (COMPANION-BRIDGE) — constants and resolved paths for the companion bridge.
 *
 * Every value here is normative in PROTOCOL.md §15. Changing one is a protocol
 * change, not a tuning knob. Secrets are NEVER in this file: they live outside
 * both repos under `~/.superset/companion/` and are read at runtime.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Capability, NegotiatedLimits, ProtocolRange } from "./types";

const execFileAsync = promisify(execFile);

// --- §15 network -----------------------------------------------------------

export const PUBLIC_ORIGIN = "https://superset.khaira.family";
/** Fixed. If taken at startup the bridge FAILS LOUD; it never picks another port. */
export const BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_PORT = 47610;
/** A different socket, 120 s, single use (§4.2). */
export const PAIRING_BIND_HOST = "0.0.0.0";
export const PAIRING_PORT = 47611;

// --- §2 Cloudflare Access (public identifiers only — never the secret) ------

export const ACCESS_TEAM_DOMAIN = "khairm.cloudflareaccess.com";
export const ACCESS_ISSUER = "https://khairm.cloudflareaccess.com";
export const ACCESS_JWKS_URL =
	"https://khairm.cloudflareaccess.com/cdn-cgi/access/certs";
export const ACCESS_AUD =
	"40d388403c3555b6fdc75302c99c24dffa5503fa5ac2a8f7774f30ac221ccf29";
export const ACCESS_CLIENT_ID = "c6d1295b4ed520de15de3446b9ec736b.access";
export const ACCESS_JWKS_CACHE_MS = 3_600_000;
export const ACCESS_JWKS_REFETCH_MIN_INTERVAL_MS = 60_000;
export const ACCESS_CLOCK_LEEWAY_MS = 30_000;

// --- §3 envelope -----------------------------------------------------------

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_HEADER_BYTES = 39;
export const GCM_TAG_BYTES = 16;
export const NONCE_BYTES = 12;
export const NONCE_PREFIX_BYTES = 4;
export const NONCE_COUNTER_BYTES = 8;
export const MIN_ENVELOPE_BYTES =
	ENVELOPE_HEADER_BYTES + GCM_TAG_BYTES; /* 55 */
export const MAX_SEALED_PLAINTEXT_BYTES = 262_144;
export const FRESHNESS_WINDOW_MS = 60_000;
/** MUST be >= 2x the window width and never < 300 000. Persisted to disk. */
export const NONCE_CACHE_RETENTION_MS = 900_000;
export const NONCE_CACHE_COMPACT_INTERVAL_MS = 300_000;

// --- §4 pairing ------------------------------------------------------------

export const PAIRING_CODE_BYTES = 32;
export const PAIRING_SALT_BYTES = 16;
export const PAIRING_WINDOW_MS = 120_000;
export const PAIRING_MAX_BAD_MACS = 3;
export const PAIRING_HKDF_SALT_PREFIX = "superset-companion/pair/v1";
export const HKDF_LABEL_DEVICE = "sc/v1 device ";
export const HKDF_LABEL_CONFIRM_PHONE = "sc/v1 confirm-phone";
export const HKDF_LABEL_CONFIRM_DESKTOP = "sc/v1 confirm-desktop";
export const HKDF_LABEL_SEAL_C2S = "sc/v1 seal c2s";
export const HKDF_LABEL_SEAL_S2C = "sc/v1 seal s2c";
export const HKDF_LABEL_SEAL_EVT = "sc/v1 seal evt ";
export const PAIRING_TRANSCRIPT_PREFIX = "sc/v1";

// --- §6 protocol -----------------------------------------------------------

export const BRIDGE_PROTOCOL_RANGE: ProtocolRange = { min: 0, max: 1 };
export const SESSION_TTL_MS = 3_600_000;

/**
 * Protocol 0 is FROZEN FOREVER and has no write path at all (§6.1). The set of
 * paths a protocol-0 session may reach is `PROTOCOL_0_PATHS` in `http.ts`,
 * declared next to the gate that enforces it.
 *
 * A second copy used to live here and nothing read it, so nothing could ever
 * notice the two disagreeing — an unenforced duplicate of a frozen protocol
 * surface is worse than no copy at all. Kept as this pointer instead.
 */

/**
 * What THIS bridge can do.
 *
 * Every token here must be one this build can honour END TO END. A capability
 * granted ahead of its wiring is worse than an ungranted one: the client enables
 * the surface, the request 501s or the feature silently does nothing, and the
 * user reads it as a broken phone rather than an incomplete desktop.
 *
 * DELIBERATELY ABSENT, and why:
 *  - `events.ws` — needs TWO things this build does not have, and granting it
 *    with only one is the failure this comment exists to prevent:
 *      1. a real `EventSnapshotSource`. `createSnapshotSource()` in `index.ts`
 *         still throws, and §9.2 requires a snapshot as frame 1, so a socket
 *         would open and immediately close 1011;
 *      2. `EventStreamServer.publish` reaching the socket. The bridge DOES
 *         publish question lifecycle frames now, but with (1) missing nothing
 *         can attach to receive them.
 *    Add this token in the commit that supplies (1). Until then `/v1/heartbeat`
 *    (capability-exempt, 60 s in foreground) is the client's live signal.
 *  - `agent.codex` — NEVER in v1; the Codex byte contract is not established.
 *
 * `push.fcm` IS granted: `/v1/device/register` stores the token and the bridge
 * arms `PushSender.schedule()` on question capture and retracts on resolve
 * (`companion/index.ts`). Do not remove it without also unwiring those, or the
 * phone registers a token nothing will ever send to.
 *
 * `panic.write_disable` / `panic.unpair` are listed for completeness, but the
 * kill switch does NOT depend on this list: `/v1/panic` is exempt from the
 * capability gate in `http.ts`. A remote kill switch that a failed negotiation
 * can disable is not a kill switch.
 */
export const BRIDGE_CAPABILITIES: readonly Capability[] = [
	"tree.read",
	"transcript.read",
	"question.read",
	"answer.single",
	"answer.multi_question",
	"answer.multiselect",
	"answer.freetext",
	"message.send",
	"push.fcm",
	"panic.write_disable",
	"panic.unpair",
	"agent.claude",
];

// --- §12 / §15 limits ------------------------------------------------------

export const LIMITS: NegotiatedLimits = {
	writesPerMin: 10,
	readsPerMin: 120,
	maxBodyBytes: MAX_SEALED_PLAINTEXT_BYTES,
	transcriptPageMax: 100,
	answerLeaseTtlMs: 15_000,
	heartbeatIntervalMs: 60_000,
};

export const PANIC_PER_MIN = 3;
export const PING_PER_MIN = 30;
export const PREAUTH_PER_MIN = 600;
export const PAIRING_ATTEMPTS_PER_WINDOW = 5;
export const HEARTBEAT_INTERVAL_FOREGROUND_MS = 60_000;
export const HEARTBEAT_INTERVAL_BACKGROUND_MS = 300_000;

// --- §9 event stream -------------------------------------------------------

export const EVENT_TICKET_TTL_MS = 60_000;
export const EVENT_RING_BUFFER_EVENTS = 1_024;
export const EVENT_RING_BUFFER_MS = 600_000;
export const EVENT_WS_PING_INTERVAL_MS = 30_000;
export const EVENT_MAX_CONNECTIONS_PER_DEVICE = 1;

// --- §13 push --------------------------------------------------------------

/**
 * (PUSH-PRESENCE) How recent a presence signal has to be for the user to count
 * as AT THE DESK, and therefore for a blocked question to be held rather than
 * pushed.
 *
 * THE UX CONTRACT THIS NUMBER ENCODES. A question buzzes the phone if and only
 * if the user cannot already see it. Away at the moment of capture -> the push
 * fires IMMEDIATELY, with no delay of any kind, because latency is the entire
 * value of the feature. Present -> it is held, indefinitely, and is either
 * cancelled when they answer at the desk or fired the moment presence lapses.
 *
 * This replaced a blanket 180 000 ms delay (`PUSH_DELAY_MS`, deleted). That
 * delay was wrong in both directions at once: three minutes of dead air when
 * nobody was there to answer, and a buzz at 3:00 for a question the user was
 * reading at 2:59.
 *
 * 60 s is the width of "still here" for BOTH signals — a keystroke inside the
 * last minute, or an OS idle time under a minute. Long enough that reading a
 * paragraph of agent output does not read as absence; short enough that walking
 * away is noticed before the question goes stale.
 */
export const PRESENCE_WINDOW_MS = 60_000;

/**
 * (PUSH-PRESENCE) How old the desktop's presence beacon may be before it stops
 * counting as evidence of anything.
 *
 * The beacon is a POST from the Electron main process on its keep-awake tick
 * (15 s). Three missed ticks is a desktop that is gone, suspended, or on a build
 * that does not send them — none of which are proof the user is present, so past
 * this the decision degrades to keystrokes alone. That under-reports presence,
 * i.e. it errs towards PUSHING, which is the correct direction: an unnecessary
 * buzz is an annoyance, a suppressed question is a blocked agent nobody knows
 * about.
 *
 * Deliberately a little under 3 x 15 s so an ordinary late tick does not
 * straddle the boundary on every cycle.
 */
export const BEACON_FRESH_MS = 45_000;

export const PUSH_TTL_MS = 900_000;
/**
 * How long a captured question stays worth buzzing about, measured from the
 * moment it was ASKED.
 *
 * `PushSender.schedule` needs an expiry, and the two obvious candidates are both
 * wrong: `PUSH_TTL_MS` is the FCM message's lifetime measured from SEND, and the
 * store's 24 h retention is about `already_resolved` answerability, not about
 * noise. Past this horizon an armed entry is dropped UNSENT — a question the
 * desktop slept through for six hours is answered at the desk, not buzzed about.
 */
export const PUSH_QUESTION_EXPIRY_MS = 21_600_000;
/**
 * (PUSH-CURATION-GATE) How long a curation verdict about a held push may be
 * reused before it is re-read from the sidebar mirror.
 *
 * The fire-time gate is asked once per armed question per sweep — every 2 s, for
 * up to the 6 h above — and answering it means reading the whole mirror
 * synchronously off host.db. Uncached that is ~10,800 full mirror reads per held
 * question on the host-service's only thread. The price of the cache is latency
 * in ONE direction only: a snooze that expires can hold the buzz for up to this
 * long afterwards, which is immaterial beside the presence lapse the push is
 * already waiting on. It cannot delay anything in the other direction, because a
 * question that is not held is not cached.
 */
export const CURATION_RECHECK_MS = 30_000;
/**
 * (RETRACT-TTL) How long a RETRACTION frame stays valid, measured from the
 * moment it is minted.
 *
 * §13's `x` field is one thing on the wire and the client applies it uniformly:
 * `isExpired(now)` runs BEFORE the `k` switch, so an already-elapsed `x`
 * discards the frame without ever reaching the retract branch. A retraction
 * stamped with `now` is therefore self-cancelling — it is expired on arrival by
 * construction — and the notification it was sent to clear survives on the
 * handset.
 *
 * A retraction must instead OUTLIVE ANY PLAUSIBLE DELIVERY DELAY: a handset that
 * was off the network, in Doze, or powered down when the answer landed gets the
 * frame whenever it next reconnects, and that gap is measured in hours, not
 * seconds. Twenty-four hours covers a phone left in a drawer overnight and is
 * still short enough that a retraction cannot be replayed into a later day.
 *
 * OVER-LONG IS SAFE HERE, and that asymmetry is why this is generous. The phone
 * independently drops a retraction naming a notification it no longer shows, so
 * a late one is inert; a retraction that expires early leaves a live
 * notification about a question that is already answered, which is the failure
 * §13.3 exists to prevent.
 */
export const RETRACT_TTL_MS = 86_400_000;
/**
 * (PUSH-GONE-CORROBORATION) How long a "this terminal is gone" verdict must
 * keep being true, at fire time, before the push sender forgets the question.
 *
 * The same argument `QUESTION_EXPIRY_CORROBORATION_MS` makes for `settle(stale)`
 * applies here, because the consequence is the same shape: `forget()` drops the
 * fence row, so a question dropped on one observation can never buzz again, at
 * any later moment, for any reason. One daemon listing is one fallible
 * observation — a mid-restart daemon, a partially adopted registry, a snapshot
 * taken between a terminal's rows — and the sweep had been acting on exactly
 * one, then discarding the entry silently.
 *
 * Much shorter than reconcile's five minutes, and deliberately so: this runs on
 * the 2 s sweep rather than on the heartbeat, so a minute is ~30 independent
 * observations, and the cost of waiting is only that a genuinely dead
 * terminal's question keeps a fence row for another minute. The cost of not
 * waiting is a blocked agent that never buzzes.
 */
export const PUSH_GONE_CORROBORATION_MS = 60_000;
/**
 * (PUSH-ARMED-ORPHAN) How long the sweep will hold a reconstructed push while
 * its transcript check is still in flight.
 *
 * The check is one bounded tail read of a JSONL file and normally returns in
 * milliseconds, so this is not a latency budget — it is the ceiling on what a
 * READ THAT NEVER RETURNS may cost. A transcript on a disconnected network
 * share, or a handle held by something that has stopped, must not be able to
 * silence a blocked agent indefinitely, which is what an unbounded hold would
 * allow.
 *
 * Past it the entry fires. That is the same rule the check itself follows:
 * unreadable is not resolved, and this feature buzzes when it cannot tell.
 */
export const ORPHAN_VERIFY_DEADLINE_MS = 30_000;
export const PUSH_DATA_HARD_CAP_BYTES = 160;
/** No natural-language string can satisfy this — that is the point (§13.1). */
export const PUSH_VALUE_PATTERN = /^[A-Za-z0-9_-]{1,43}$/;
export const FCM_PROJECT_ID = "metal-complex-352812";

// --- §14 audit -------------------------------------------------------------

export const AUDIT_RETENTION_DAYS = 90;
/**
 * How long a ledger TOMBSTONE is kept. Rows recording a real attempt are never
 * dropped — see `(LEDGER-KEEP-ATTEMPTS)` in `attempt-ledger.ts` for why the two
 * classes have opposite retention.
 */
export const ANSWER_ATTEMPT_RETENTION_MS = 86_400_000;

// --- on-disk layout (OUTSIDE both repos) -----------------------------------

/**
 * All companion state lives under `~/.superset/companion/`. Secrets
 * (`fcm-service-account.json`, `cloudflare-access.json`) are read from there at
 * runtime and are NEVER logged, echoed, or written into a repo file.
 */
export interface CompanionPaths {
	root: string;
	devices: string;
	nonces: string;
	audit: string;
	fcmServiceAccount: string;
	cloudflareAccess: string;
}

/**
 * The bridge is OFF unless this env var is exactly "1". Explicit opt-in, not
 * presence-of-a-file inference: an internet-exposed listener that can type into
 * terminals must never be enabled as a side effect of a file appearing on disk.
 */
export const COMPANION_ENABLE_ENV = "SUPERSET_COMPANION_BRIDGE";

/**
 * The same override every other Superset component honours (`packages/cli`'s
 * `SUPERSET_HOME_DIR`). The desktop's keep-awake companion gate used to be the
 * third reader — it read `$SUPERSET_HOME_DIR/companion/devices/devices.json`
 * to count pairings — but (DEVICE-INDEX-DB) retired that file and the gate now
 * asks the `companion.gate` tRPC query, so the count comes from host.db through
 * the bridge and no desktop code resolves companion paths at all.
 *
 * Hardcoding `homedir()` here made the processes that DO share these paths
 * disagree about a directory they both own the moment the variable was set:
 * one resolved one path while every bridge path resolved under another.
 */
export const SUPERSET_HOME_ENV = "SUPERSET_HOME_DIR";

export const LOG_PREFIX = "[companion-bridge]";

export function isCompanionBridgeEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env[COMPANION_ENABLE_ENV] === "1";
}

/** `$SUPERSET_HOME_DIR`, or `~/.superset`. One resolver, used by every caller. */
export function resolveSupersetHome(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string {
	const override = env[SUPERSET_HOME_ENV]?.trim();
	if (override) return override;
	if (typeof home !== "string" || home.length === 0) {
		throw new Error(
			`${LOG_PREFIX} cannot resolve the home directory — os.homedir() returned an empty value and ${SUPERSET_HOME_ENV} is unset`,
		);
	}
	return join(home, ".superset");
}

export function resolveCompanionPaths(
	supersetHome: string = resolveSupersetHome(),
): CompanionPaths {
	if (typeof supersetHome !== "string" || supersetHome.length === 0) {
		throw new Error(
			`${LOG_PREFIX} cannot resolve the Superset home directory — got an empty value`,
		);
	}
	const root = join(supersetHome, "companion");
	return {
		root,
		devices: join(root, "devices"),
		nonces: join(root, "nonces"),
		audit: join(root, "audit"),
		fcmServiceAccount: join(root, "fcm-service-account.json"),
		cloudflareAccess: join(root, "cloudflare-access.json"),
	};
}

/**
 * Creates `root`, `devices`, `nonces` and `audit` if absent and restricts the
 * tree to the current user. `K_dev` for every paired device lives under
 * `devices/`, so a world-readable directory is a total compromise of the
 * envelope, not a hygiene nit — an ACL failure therefore THROWS.
 *
 * mode 0o700 is honoured on POSIX and ignored on Windows, which is why the
 * win32 branch shells out to `icacls`.
 *
 * (ACL-REVERIFY) THERE IS NO MARKER. An earlier revision wrote `.acl-hardened`
 * once the first `icacls` call succeeded and then SKIPPED the hardening on
 * every subsequent start. A marker records that the ACL was correct once; it
 * says nothing about whether it is correct now, and the ACL on this directory is
 * the only thing standing between another local account and every paired
 * device's `K_dev`. Anything can move it afterwards — a `takeown`, a restore
 * from a backup that carried its own ACLs, a profile migration, an installer
 * that re-inherits the parent's permissions — and the marker would keep
 * asserting a past success while the keys sat readable.
 *
 * So the DACL is READ on every start and compared against what this function
 * requires. If it has drifted, it is re-applied and the drift is reported. If it
 * cannot be read or cannot be re-applied, this THROWS and the bridge does not
 * start: an unverifiable ACL on a directory full of device keys is exactly the
 * "cannot prove it is safe" case that must fail closed.
 */
export async function ensureCompanionDirs(
	paths: CompanionPaths,
): Promise<void> {
	for (const dir of [paths.root, paths.devices, paths.nonces, paths.audit]) {
		await mkdir(dir, { recursive: true, mode: 0o700 });
	}

	if (process.platform !== "win32") return;

	const { username } = userInfo();
	if (!username) {
		throw new Error(
			`${LOG_PREFIX} cannot harden ${paths.root}: os.userInfo() returned no username`,
		);
	}

	const drift = await describeAclDrift(paths, username);
	if (drift === null) return;

	console.warn(
		`${LOG_PREFIX} the ACL protecting the companion tree is not the expected owner-only ACL (${drift}) — re-applying it now`,
	);
	await applyOwnerOnlyAcl(paths, username);

	const remaining = await describeAclDrift(paths, username);
	if (remaining !== null) {
		throw new Error(
			`${LOG_PREFIX} ${paths.root} still does not carry an owner-only ACL after re-applying it (${remaining}) — device keys would be readable by other accounts`,
		);
	}
}

/**
 * `null` when the tree carries the expected owner-only ACL; otherwise a short
 * description of what is wrong.
 *
 * Checks the ROOT (inheritance disabled, one full-control entry for this
 * account) and `devices/` (which must inherit that and carry nothing else).
 * `devices/` is verified explicitly because it is the directory holding `K_dev`
 * for every paired device — a root-only check would miss an entry granted
 * directly on it.
 */
async function describeAclDrift(
	paths: CompanionPaths,
	username: string,
): Promise<string | null> {
	const rootDrift = await describeTargetAclDrift(paths.root, username, true);
	if (rootDrift !== null) return `${paths.root}: ${rootDrift}`;
	const devicesDrift = await describeTargetAclDrift(
		paths.devices,
		username,
		false,
	);
	if (devicesDrift !== null) return `${paths.devices}: ${devicesDrift}`;
	return null;
}

/**
 * A read failure is NOT reported as "fine". It THROWS, because the whole point
 * of this check is that an unverifiable ACL must never be treated as a verified
 * one.
 */
async function describeTargetAclDrift(
	target: string,
	username: string,
	mustNotInherit: boolean,
): Promise<string | null> {
	let stdout: string;
	try {
		({ stdout } = await execFileAsync("icacls", [target]));
	} catch (error) {
		throw new Error(
			`${LOG_PREFIX} cannot read the ACL on ${target} via icacls, so it cannot be confirmed to protect device keys: ${describe(error)}`,
		);
	}

	// `icacls <dir>` prints "<path> <ACE>" on the first line, one indented ACE per
	// line after it, then a "Successfully processed" summary.
	const aces = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !/^Successfully|^Failed/.test(line))
		.map((line) =>
			line.startsWith(target) ? line.slice(target.length).trim() : line,
		)
		.filter((line) => line.includes(":"));

	if (aces.length === 0) {
		return "icacls reported no access-control entries";
	}
	if (mustNotInherit && /\(I\)/.test(stdout)) {
		return "inherited entries are still present";
	}

	const lowerUser = username.toLowerCase();
	const foreign = aces.filter((ace) => {
		const principal = ace.slice(0, ace.indexOf(":")).toLowerCase();
		// DOMAIN\user, MACHINE\user and a bare user all name this account.
		const leaf = principal.slice(principal.lastIndexOf("\\") + 1);
		return leaf !== lowerUser;
	});
	if (foreign.length > 0) {
		return `${foreign.length} entr${foreign.length === 1 ? "y" : "ies"} for other principals`;
	}
	if (!aces.some((ace) => /\(F\)/.test(ace))) {
		return "this account does not hold full control";
	}
	return null;
}

/**
 * TWO CALLS, AND THE SECOND ONE IS NOT OPTIONAL.
 *
 * The obvious single call — `icacls <root> /inheritance:r /grant:r
 * user:(OI)(CI)F /T` — is WRONG, and wrong in the worst possible direction. `/T`
 * pushes that same `(OI)(CI)` entry onto every EXISTING file, and on a leaf those
 * inheritance flags leave an entry that applies only to children the file does
 * not have. Measured on this machine: after that single call every existing file
 * in the tree became `EPERM: operation not permitted` TO ITS OWN OWNER — both
 * secrets, `devices.json`, and every `<keyRef>.key.json`. The bridge could not
 * read the device keys it had just "protected"; only newly created files worked,
 * because they inherited correctly from the directory.
 *
 * So: set the inheritance template on the ROOT only, then make every existing
 * child re-inherit it. Children end up `(I)(F)` — inherited full control for this
 * account and nothing else — which is both readable and exclusive.
 *
 * The wildcard always matches something: `ensureCompanionDirs` creates
 * `devices`, `nonces` and `audit` before this runs.
 */
async function applyOwnerOnlyAcl(
	paths: CompanionPaths,
	username: string,
): Promise<void> {
	try {
		await execFileAsync("icacls", [
			paths.root,
			"/inheritance:r",
			"/grant:r",
			`${username}:(OI)(CI)F`,
		]);
	} catch (error) {
		throw new Error(
			`${LOG_PREFIX} failed to restrict ${paths.root} to ${username} via icacls — device keys would be readable by other accounts: ${describe(error)}`,
		);
	}
	try {
		await execFileAsync("icacls", [
			join(paths.root, "*"),
			"/reset",
			"/T",
			"/C",
			"/Q",
		]);
	} catch (error) {
		throw new Error(
			`${LOG_PREFIX} failed to make the existing contents of ${paths.root} re-inherit the owner-only ACL, so files written before this start would keep their old permissions: ${describe(error)}`,
		);
	}
}

/**
 * Reads the Cloudflare service-token secret from disk and validates EVERY field
 * against the identifiers this build was compiled against. A mismatch is fatal:
 * a token minted for a different Access application would be rejected at the
 * edge on every request and present to the user as an unexplained "offline".
 *
 * The secret is returned (pairing step 4 is the one message that carries it) and
 * is never logged, never included in an error message, and never written into a
 * repo file.
 */
export function loadAccessServiceToken(paths: CompanionPaths): {
	clientId: string;
	clientSecret: string;
} {
	const raw = readJsonFile(paths.cloudflareAccess);
	const clientId = requireString(raw, "client_id", paths.cloudflareAccess);
	const clientSecret = requireString(
		raw,
		"client_secret",
		paths.cloudflareAccess,
	);
	const appAud = requireString(raw, "app_aud", paths.cloudflareAccess);
	const teamDomain = requireString(raw, "team_domain", paths.cloudflareAccess);

	requireEqual(clientId, ACCESS_CLIENT_ID, "client_id", paths.cloudflareAccess);
	requireEqual(appAud, ACCESS_AUD, "app_aud", paths.cloudflareAccess);
	requireEqual(
		teamDomain,
		ACCESS_TEAM_DOMAIN,
		"team_domain",
		paths.cloudflareAccess,
	);
	if (!/^[0-9a-f]{64}$/.test(clientSecret)) {
		// Length/charset only — the value itself never reaches this message.
		throw new Error(
			`${LOG_PREFIX} ${paths.cloudflareAccess}: "client_secret" must be 64 lowercase hex characters (got ${clientSecret.length} chars)`,
		);
	}

	return { clientId, clientSecret };
}

/**
 * Validates the FCM service account WITHOUT surfacing its private key. push.ts
 * takes a PATH and does its own signing; this exists so a missing or wrong-project
 * key fails at start-up instead of 180 s later, silently, on the first push.
 */
export function loadFcmServiceAccountMeta(paths: CompanionPaths): {
	path: string;
	projectId: string;
	clientEmail: string;
} {
	const raw = readJsonFile(paths.fcmServiceAccount);
	const type = requireString(raw, "type", paths.fcmServiceAccount);
	const projectId = requireString(raw, "project_id", paths.fcmServiceAccount);
	const clientEmail = requireString(
		raw,
		"client_email",
		paths.fcmServiceAccount,
	);
	const privateKey = requireString(raw, "private_key", paths.fcmServiceAccount);

	requireEqual(type, "service_account", "type", paths.fcmServiceAccount);
	requireEqual(
		projectId,
		FCM_PROJECT_ID,
		"project_id",
		paths.fcmServiceAccount,
	);
	if (!privateKey.startsWith("-----BEGIN PRIVATE KEY-----")) {
		throw new Error(
			`${LOG_PREFIX} ${paths.fcmServiceAccount}: "private_key" is not a PEM private key`,
		);
	}
	if (!clientEmail.includes("@")) {
		throw new Error(
			`${LOG_PREFIX} ${paths.fcmServiceAccount}: "client_email" is not an email address`,
		);
	}

	return { path: paths.fcmServiceAccount, projectId, clientEmail };
}

// --- loader helpers (fail loud, never default, never echo a value) ----------

function readJsonFile(file: string): Record<string, unknown> {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		throw new Error(
			`${LOG_PREFIX} required file ${file} is unreadable — it lives outside both repos and must be provisioned by hand: ${describe(error)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(
			`${LOG_PREFIX} ${file} is not valid JSON: ${describe(error)}`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${LOG_PREFIX} ${file} must contain a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

function requireString(
	source: Record<string, unknown>,
	key: string,
	file: string,
): string {
	const value = source[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(
			`${LOG_PREFIX} ${file}: required field "${key}" is missing or not a non-empty string`,
		);
	}
	return value;
}

/** Only ever called on NON-secret fields — the value appears in the message. */
function requireEqual(
	actual: string,
	expected: string,
	key: string,
	file: string,
): void {
	if (actual !== expected) {
		throw new Error(
			`${LOG_PREFIX} ${file}: "${key}" is ${actual} but this build is compiled against ${expected}`,
		);
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Exported for the audit-log rotation check; `stat` is re-exported nowhere else. */
export async function fileSizeBytes(file: string): Promise<number> {
	try {
		const info = await stat(file);
		return info.size;
	} catch {
		return 0;
	}
}
