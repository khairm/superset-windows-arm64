/**
 * (COMPANION-BRIDGE) — device records and revocation (§5).
 *
 * The watch never pairs: `surface: "watch"` exists only so an answer's
 * provenance can be recorded. Revocation is not retroactive — an answer already
 * injected has already happened.
 *
 * ---------------------------------------------------------------------------
 * Three things about this file that are easy to get wrong
 * ---------------------------------------------------------------------------
 * 1. REVOKING A DEVICE MUST NOT DESTROY ITS KEY. §5.1 requires a revoked
 *    device's request to be answered with a SEALED `403 access_denied
 *    {reason:"revoked"}` — the device still holds a valid key and must be able
 *    to tell its user why it stopped working. Key material is destroyed only
 *    when the record is purged, 30 days later (`purgeExpiredRevocations`).
 * 2. CAPABILITIES ARE SESSION STATE, NOT DEVICE STATE. §6.3 is explicit that a
 *    client MUST NOT carry capabilities across a bridge restart, so the
 *    negotiated set is held in memory here and is deliberately NOT written to
 *    disk. Persisting it would make a stale grant survive exactly the restart
 *    that is supposed to invalidate it.
 * 3. (REVOKE-DURABLE) THE INDEX IS NOT THE ONLY RECORD OF A REVOCATION, AND IT
 *    IS NOT TRUSTED ON ITS OWN. Restoring an older `devices.json` used to
 *    reinstate a revoked device — and because point 1 deliberately RETAINS
 *    `K_dev`, that device's terminal writes became valid again. Two independent
 *    defences now close that:
 *      a. every revoke stamps a tombstone INSIDE the key file, which is the
 *         very file the attack scenario says was retained; the tombstone is
 *         re-applied to the index at load, loudly;
 *      b. the index is bound to the state anchor by `(seq, digest, epoch,
 *         generation)`, so an index that has moved BACKWARDS relative to the
 *         anchor refuses to load at all.
 *    Point 3(a) is why the review's "destroy the key at revoke time" is not
 *    implemented literally: destroying it would break §5.1's sealed 403.
 *    Invalidating it — which is what the tombstone does — achieves the same
 *    authority result without breaking the protocol.
 *
 * On-disk layout: ONE index file, `<devicesDir>/devices.json`, written
 * durably (tmp -> fsync -> rename -> fsync parent). Key material lives in
 * `keys.ts` under `<devicesDir>/<keyRef>.key.json`; a 22-character base64url
 * keyRef can never collide with the literal name `devices`.
 *
 * SCOPE OF `assertNoRollback`, STATED SO IT IS NOT OVER-READ. The checks below
 * bind the INDEX to the anchor. They do not, and cannot, police the anchor's
 * `send.highWater`: `generation` is per install, `epoch` moves once per mount
 * and `(seq, digest)` move only when the device authority moves, so an anchor
 * reverted to an earlier version written during the SAME mount satisfies every
 * check here while taking the send-nonce mark backwards with it. That field is
 * witnessed separately by `keys.ts`'s `send-witness.json` (SEND-WITNESS). Do not
 * add a send-nonce check here: the anchor must keep exactly one writer.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	base64UrlEncode,
	createSerialiser,
	decodeWireId,
	sha256,
	writeFileDurable,
} from "./crypto";
import { type KeyStore, type StateAnchor, StateRollbackError } from "./keys";
import { MAX_LABEL_CHARS } from "./limits";
import type {
	Capability,
	DeviceId,
	DeviceRecord,
	ProtocolVersion,
	RevokeReason,
	Surface,
} from "./types";

const INDEX_FILENAME = "devices.json";
/**
 * (PENDING-DESTROY) keyRefs whose records are already gone but whose key
 * material has not yet been wiped. Written BEFORE the records are dropped, so a
 * failed wipe is a recorded, retried job instead of a silently orphaned K_dev.
 *
 * IT IS NO LONGER THE ONLY RECORD OF THAT OBLIGATION, AND IT MUST NOT BE. On
 * win32 `syncDirectory` is a no-op, so a hard reset can discard this file's most
 * recent rename while the index's survives — leaving the purged records gone from
 * `devices.json`, this journal reverted to a version that never named them, and
 * `K_dev` on disk permanently with nothing left that would ever come back for
 * it. That is the exact failure the journal was introduced to prevent, reproduced
 * one file to the left. `(ORPHAN-SWEEP)` below closes it by re-deriving the
 * obligation instead of witnessing it a second time.
 */
const PENDING_DESTROY_FILENAME = "pending-destroy.json";
const FILE_MODE = 0o600;

/** §4.8 — a revoked record is kept this long so audit entries stay attributable. */
export const REVOKED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * (LASTSEEN-DEBOUNCE) How long a liveness stamp may sit in memory before it is
 * written out on its own.
 *
 * `touchLastSeen` runs on EVERY sealed request, and it used to take the full
 * durable path — serialise the whole index, hash the authority projection,
 * write a temp file, fsync it, rename it, fsync the parent — which doubled the
 * fsyncs per request when §3.5 requires exactly one (the nonce admit, before
 * dispatch). The debounce is a FREQUENCY change only: the write itself is
 * unchanged and every authority change still persists immediately.
 */
const LAST_SEEN_FLUSH_INTERVAL_MS = 60_000;

const SURFACES: ReadonlySet<string> = new Set<Surface>(["phone", "watch"]);
const REVOKE_REASONS: ReadonlySet<string> = new Set<RevokeReason>([
	"user",
	"panic",
	"repair",
	"unknown",
]);

/**
 * A boundary-validation failure or a state violation in this store. Never
 * caught to be hidden: every throw here means the caller asked for something
 * that cannot be true.
 */
export class DeviceStoreError extends Error {
	constructor(message: string) {
		super(`(COMPANION-BRIDGE) device store: ${message}`);
		this.name = "DeviceStoreError";
	}
}

/**
 * §6.2/§6.3 — what one `hello` negotiated. In memory only. A bridge restart
 * drops every session, which is the signal `bridgeStartedMs` reports and the
 * reason the client must re-`hello`.
 */
export interface DeviceSession {
	protocol: ProtocolVersion;
	granted: readonly Capability[];
	negotiatedAtMs: number;
	expiresAtMs: number;
}

export interface DeviceStore {
	get(deviceId: DeviceId): Promise<DeviceRecord | null>;
	list(): Promise<DeviceRecord[]>;
	/** true iff at least one device has ever paired — distinguishes `not_paired`. */
	anyPaired(): Promise<boolean>;
	create(input: {
		deviceId: DeviceId;
		label: string;
		surface: Surface;
		keyRef: string;
		pairedAtMs: number;
	}): Promise<DeviceRecord>;
	/**
	 * (LASTSEEN-DEBOUNCE) Records liveness IN MEMORY and returns. The value
	 * reaches disk on the next authority write, on a >= 60 s debounce, or at
	 * `close()` — never once per sealed request.
	 *
	 * This is safe for exactly one reason, and it is the reason stated in
	 * `authorityDigest`: `lastSeenMs` is EXCLUDED from the authority projection,
	 * so it is not integrity-bearing and the anti-rollback anchor's `(seq, digest)`
	 * does not track it. Everything the anchor DOES track — label, keyRef,
	 * fcmToken, writeEnabled, the revocation pair — still persists durably and
	 * immediately, inside the same serialised critical section as before.
	 */
	touchLastSeen(deviceId: DeviceId, atMs: number): Promise<void>;
	setFcmToken(
		deviceId: DeviceId,
		token: string | null,
		atMs: number,
	): Promise<void>;
	setWriteEnabled(deviceId: DeviceId, enabled: boolean): Promise<void>;
	revoke(deviceId: DeviceId, reason: RevokeReason, atMs: number): Promise<void>;
	revokeAll(reason: RevokeReason, atMs: number): Promise<number>;
	/** Revoked records are retained 30 days so audit entries stay attributable. */
	purgeExpiredRevocations(nowMs: number): Promise<number>;

	/**
	 * (LASTSEEN-DEBOUNCE) Flushes any liveness stamp still held in memory and
	 * disarms the debounce timer. Called from the bridge teardown list.
	 *
	 * It THROWS on a failed flush rather than absorbing it: the teardown wraps
	 * every step in a logging `settle`, and a device index that could not be
	 * written at shutdown is worth saying out loud even though nothing
	 * authority-bearing is lost by it.
	 */
	close(): Promise<void>;

	// --- §6.3 session state: in memory, never persisted --------------------
	setSession(deviceId: DeviceId, session: DeviceSession): void;
	/** null => no live `hello`; the caller must refuse capability-gated work. */
	getSession(deviceId: DeviceId, nowMs: number): DeviceSession | null;
	clearSession(deviceId: DeviceId): void;
}

export interface DeviceStoreDeps {
	/**
	 * The anti-rollback anchor. The index alone is not authoritative: it is bound
	 * to `(generation, epoch, seq, digest)` here, and a backwards move fails
	 * closed rather than quietly re-authorising a revoked device.
	 */
	anchor: StateAnchor;
	/**
	 * Key custody. Used for the revocation tombstone (write at revoke, re-apply
	 * at load) and for the retryable destruction of purged key material. Purge is
	 * the ONLY point at which a device's `K_dev` may be destroyed (see note 1).
	 */
	keys: KeyStore;
	/** Where a re-applied tombstone or a failed key wipe is reported. */
	log?: {
		warn(message: string, fields?: Record<string, unknown>): void;
		error(message: string, fields?: Record<string, unknown>): void;
	};
}

// ---------------------------------------------------------------------------
// boundary validation (global rule 1: validate at API boundaries)
// ---------------------------------------------------------------------------

function assertDeviceId(deviceId: string): void {
	try {
		// `decodeWireId` is the canonical §0.1 test: strict base64url AND exactly
		// 16 bytes. The separate length branch this replaced is subsumed by it.
		decodeWireId(deviceId);
	} catch (error) {
		throw new DeviceStoreError(
			`deviceId is not a canonical §0.1 wire id: ${(error as Error).message}`,
		);
	}
}

function assertEpochMs(value: number, what: string): void {
	if (
		!Number.isInteger(value) ||
		value <= 0 ||
		value > Number.MAX_SAFE_INTEGER
	) {
		throw new DeviceStoreError(
			`${what} must be a positive integer ms, got ${value}`,
		);
	}
}

function assertLabel(label: string): void {
	if (typeof label !== "string" || label.length === 0) {
		throw new DeviceStoreError("label must be a non-empty string");
	}
	if (label.length > MAX_LABEL_CHARS) {
		throw new DeviceStoreError(
			`label must be <= ${MAX_LABEL_CHARS} chars, got ${label.length}`,
		);
	}
}

function assertSurface(surface: string): void {
	if (!SURFACES.has(surface)) {
		throw new DeviceStoreError(`surface must be phone|watch, got ${surface}`);
	}
}

function assertRevokeReason(reason: string): void {
	if (!REVOKE_REASONS.has(reason)) {
		throw new DeviceStoreError(`unknown revoke reason ${reason}`);
	}
}

/**
 * Rehydrates one persisted record. A malformed record is a HARD failure, not a
 * skipped row: silently dropping a device would present as "my phone stopped
 * working" with no explanation, and silently repairing one would invent state.
 */
function parseRecord(value: unknown, index: number): DeviceRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new DeviceStoreError(`record ${index} is not an object`);
	}
	const raw = value as Record<string, unknown>;

	const deviceId = raw.deviceId;
	if (typeof deviceId !== "string") {
		throw new DeviceStoreError(`record ${index} has no deviceId`);
	}
	assertDeviceId(deviceId);

	const label = raw.label;
	if (typeof label !== "string") {
		throw new DeviceStoreError(`record ${deviceId} has no label`);
	}
	const surface = raw.surface;
	if (typeof surface !== "string" || !SURFACES.has(surface)) {
		throw new DeviceStoreError(`record ${deviceId} has an invalid surface`);
	}
	const pairedAtMs = raw.pairedAtMs;
	if (typeof pairedAtMs !== "number") {
		throw new DeviceStoreError(`record ${deviceId} has no pairedAtMs`);
	}
	const keyRef = raw.keyRef;
	if (typeof keyRef !== "string" || keyRef.length === 0) {
		throw new DeviceStoreError(`record ${deviceId} has no keyRef`);
	}
	const writeEnabled = raw.writeEnabled;
	if (typeof writeEnabled !== "boolean") {
		throw new DeviceStoreError(`record ${deviceId} has no writeEnabled`);
	}

	const lastSeenMs = raw.lastSeenMs;
	if (lastSeenMs !== null && typeof lastSeenMs !== "number") {
		throw new DeviceStoreError(`record ${deviceId} has an invalid lastSeenMs`);
	}
	const fcmToken = raw.fcmToken;
	if (fcmToken !== null && typeof fcmToken !== "string") {
		throw new DeviceStoreError(`record ${deviceId} has an invalid fcmToken`);
	}
	const fcmTokenUpdatedMs = raw.fcmTokenUpdatedMs;
	if (fcmTokenUpdatedMs !== null && typeof fcmTokenUpdatedMs !== "number") {
		throw new DeviceStoreError(
			`record ${deviceId} has an invalid fcmTokenUpdatedMs`,
		);
	}
	const revokedAtMs = raw.revokedAtMs;
	if (revokedAtMs !== null && typeof revokedAtMs !== "number") {
		throw new DeviceStoreError(`record ${deviceId} has an invalid revokedAtMs`);
	}
	const revokeReason = raw.revokeReason;
	if (
		revokeReason !== null &&
		(typeof revokeReason !== "string" || !REVOKE_REASONS.has(revokeReason))
	) {
		throw new DeviceStoreError(
			`record ${deviceId} has an invalid revokeReason`,
		);
	}
	if ((revokedAtMs === null) !== (revokeReason === null)) {
		throw new DeviceStoreError(
			`record ${deviceId} has revokedAtMs and revokeReason out of step`,
		);
	}

	return {
		deviceId,
		label,
		surface: surface as Surface,
		pairedAtMs,
		lastSeenMs: lastSeenMs as number | null,
		keyRef,
		fcmToken: fcmToken as string | null,
		fcmTokenUpdatedMs: fcmTokenUpdatedMs as number | null,
		writeEnabled,
		revokedAtMs: revokedAtMs as number | null,
		revokeReason: revokeReason as RevokeReason | null,
	};
}

function clone(record: DeviceRecord): DeviceRecord {
	return { ...record };
}

/**
 * The AUTHORITY projection of the index — everything that decides whether a
 * device may act, or where its notifications go, and nothing that does not.
 *
 * EXACTLY TWO FIELDS ARE EXCLUDED, and only because they churn: `lastSeenMs` and
 * `fcmTokenUpdatedMs`. `touchLastSeen` runs on EVERY sealed request, so
 * including either would force a durable anchor round-trip per request for no
 * authority benefit. (LASTSEEN-DEBOUNCE) leans on this exclusion: holding
 * `lastSeenMs` in memory between flushes is only sound because nothing here
 * attests it. DO NOT ADD IT TO THIS PROJECTION — a debounced field inside the
 * digest would leave the anchor attesting a `(seq, digest)` the index no longer
 * matches.
 *
 * Everything else is in, including `label` and `fcmToken`. They were previously
 * excluded on the same "changes on ordinary traffic" reasoning, which is simply
 * untrue of them: `label` is written once at pairing and `fcmToken` only when a
 * device re-registers. Leaving them out meant a rolled-back index could swap the
 * FCM token a question is pushed to, or the label every audit line attributes an
 * answer to, without the anchor noticing.
 *
 * Sorted by `deviceId`, so map iteration order can never change the digest.
 */
function authorityDigest(records: readonly DeviceRecord[]): string {
	const projection = records
		.map((record) => ({
			deviceId: record.deviceId,
			label: record.label,
			surface: record.surface,
			pairedAtMs: record.pairedAtMs,
			keyRef: record.keyRef,
			fcmToken: record.fcmToken,
			writeEnabled: record.writeEnabled,
			revokedAtMs: record.revokedAtMs,
			revokeReason: record.revokeReason,
		}))
		.sort((a, b) =>
			a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0,
		);
	return base64UrlEncode(
		sha256(new Uint8Array(Buffer.from(JSON.stringify(projection), "utf8"))),
	);
}

interface StoredIndexFile {
	v: 2;
	/** Must equal the anchor's install generation. */
	generation: string;
	/** The mount that last wrote this file. May not exceed the anchor's previous. */
	epoch: string;
	/** Monotonic; advances only when `authorityDigest` changes. */
	seq: string;
	devices: unknown[];
}

interface LoadedIndex {
	records: DeviceRecord[];
	seq: bigint;
	/**
	 * True when the index legitimately LEADS the anchor and the anchor must be
	 * brought up to it: a crash between the index write and the anchor commit
	 * (index exactly one sequence ahead), a pre-anchor index being migrated, or an
	 * index that predates the anchor's device record.
	 *
	 * Consumed at construction. It is NOT decorative: if the anchor is left
	 * behind, it keeps attesting the OLD sequence and the OLD digest, and a later
	 * restore of that older index matches the anchor exactly and passes every
	 * check — silently undoing the last authority change, which for a revocation
	 * means the revoked device is live again.
	 */
	adopt: boolean;
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

/**
 * (ONE-STORE-PER-ANCHOR) One device store per anchor, enforced.
 *
 * Constructing a second store against a live anchor is not a small waste: the
 * first construction stamps THIS mount's epoch into `devices.json`, so the
 * second one reads an index written by the current mount and — correctly, by the
 * rules it is given — reports it as ahead of the previous mount and refuses with
 * "the anchor was rolled back". That message would be flatly wrong and would
 * send a maintainer to unpair every device over a duplicated call. Refuse the
 * duplicate here, in its own words, rather than let it surface as a rollback.
 */
const STORES_BY_ANCHOR = new WeakSet<StateAnchor>();

export async function createDeviceStore(
	devicesDir: string,
	deps: DeviceStoreDeps,
): Promise<DeviceStore> {
	if (!deps || !deps.anchor || !deps.keys) {
		throw new DeviceStoreError(
			"createDeviceStore requires the state anchor and the key store",
		);
	}
	if (STORES_BY_ANCHOR.has(deps.anchor)) {
		throw new DeviceStoreError(
			"a device store already owns this state anchor — a second store would re-read the index this mount just wrote and misreport it as a rollback",
		);
	}
	STORES_BY_ANCHOR.add(deps.anchor);
	const anchor = deps.anchor;
	const keys = deps.keys;
	const log = deps.log ?? {
		warn: (message: string, fields?: Record<string, unknown>) =>
			console.warn(`(COMPANION-BRIDGE) device store: ${message}`, fields ?? {}),
		error: (message: string, fields?: Record<string, unknown>) =>
			console.error(
				`(COMPANION-BRIDGE) device store: ${message}`,
				fields ?? {},
			),
	};

	const indexPath = join(devicesDir, INDEX_FILENAME);
	const pendingDestroyPath = join(devicesDir, PENDING_DESTROY_FILENAME);

	const records = new Map<DeviceId, DeviceRecord>();
	const sessions = new Map<DeviceId, DeviceSession>();
	let seq = 0n;
	/** Serialises read-modify-write; two concurrent revokes must not race. */
	const serialise = createSerialiser();
	/**
	 * (LASTSEEN-DEBOUNCE) True while an in-memory `lastSeenMs` has not reached
	 * disk. Cleared by `persist()` itself — every persist writes the whole record
	 * map, so an authority write (pairing, FCM rotation, revoke, purge) flushes
	 * the pending stamp as a side effect and no separate "flush on pairing
	 * change" path is needed. A failed persist leaves it set, so the next touch
	 * or `close()` retries.
	 */
	let lastSeenDirty = false;
	let lastSeenTimer: NodeJS.Timeout | null = null;
	let closed = false;

	// --- pending key destruction (retryable, never silently dropped) --------

	async function readPendingDestroy(): Promise<string[]> {
		let text: string;
		try {
			text = await readFile(pendingDestroyPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const parsed: unknown = JSON.parse(text);
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed) ||
			(parsed as { v?: unknown }).v !== 1 ||
			!Array.isArray((parsed as { keyRefs?: unknown }).keyRefs)
		) {
			throw new DeviceStoreError(
				`${pendingDestroyPath} is malformed — it names key material that must still be wiped, so it is not something to skip past`,
			);
		}
		const keyRefs = (parsed as { keyRefs: unknown[] }).keyRefs;
		for (const entry of keyRefs) {
			if (typeof entry !== "string" || entry.length === 0) {
				throw new DeviceStoreError(
					`${pendingDestroyPath} contains a non-string keyRef`,
				);
			}
		}
		return keyRefs as string[];
	}

	async function writePendingDestroy(
		keyRefs: readonly string[],
	): Promise<void> {
		await writeFileDurable(
			pendingDestroyPath,
			new Uint8Array(
				Buffer.from(
					`${JSON.stringify({ v: 1, keyRefs }, null, "\t")}\n`,
					"utf8",
				),
			),
			FILE_MODE,
		);
	}

	/**
	 * Retries every outstanding wipe, and — at start — every wipe nobody recorded.
	 *
	 * A wipe that fails stays on the list and is attempted again on the next purge
	 * (daily) and at every start. It is also reported. The failure mode this
	 * replaces was terminal AND silent: the record was deleted first, so a throw
	 * from `destroy` left `K_dev` on disk with nothing left pointing at it and
	 * nothing that would ever try again.
	 *
	 * (ORPHAN-SWEEP) THE JOURNAL IS NOT TRUSTED TO BE COMPLETE, BECAUSE IT CANNOT
	 * BE. `writePendingDestroy` lands before the index write that drops the records
	 * naming the same keyRefs, and on win32 `syncDirectory` is a no-op — so a hard
	 * reset can take the JOURNAL's rename and leave the INDEX's, which is precisely
	 * the orphaned-`K_dev`-forever case the journal exists to prevent. The keys are
	 * revoked and tombstoned, so nothing is AUTHORISED by it; the cost is a revoked
	 * device's key surviving indefinitely, still able to decrypt captured historical
	 * traffic, with nothing on disk that would ever notice.
	 *
	 * A THIRD WITNESS FILE WOULD HAVE BEEN THE WRONG ANSWER. `writeFileDurable` in
	 * `crypto.ts` states outright that its rename ordering — itself an inference
	 * about NTFS rather than a documented guarantee — must not acquire a third
	 * dependent. More importantly it was not needed, and the general form of that
	 * is worth keeping: A WITNESS IS ONLY RIGHT WHERE THE OBLIGATION CANNOT BE
	 * RE-DERIVED. WHERE IT CAN, RE-DERIVATION STRICTLY DOMINATES — it needs no
	 * second file, no write ordering and no crash-consistency assumption. "This key
	 * file is owed a wipe" is re-derivable from ground truth: a key file present on
	 * disk whose keyRef appears in NO index record is an orphan by construction,
	 * whatever any journal says. So the set of keyRefs to destroy is the UNION of
	 * the journal and that difference, and a lost journal rename now costs one
	 * start's delay instead of a permanent leak.
	 *
	 * WHY THE SWEEP RUNS AT START AND NOT ON THE PURGE PATH, WHICH IS NOT
	 * TIMIDITY. `keys.put()` creates the key file BEFORE `create()` records it, and
	 * `put` is not inside this store's serialiser — so between those two calls a
	 * live, brand-new device's key is legitimately unreferenced. A sweep running
	 * then would destroy it and brick a phone mid-pairing. At construction that
	 * window provably does not exist: the store has not been handed out, so no
	 * pairing can be in flight against it, and `(ONE-STORE-PER-ANCHOR)` guarantees
	 * no other store is running one either. That is a structural argument, not a
	 * grace period or an mtime heuristic, and it is the reason `phase` exists
	 * rather than a boolean nobody can audit at the call site. Do not widen it to
	 * `"purge"` without first serialising `put` + `create` into one critical
	 * section.
	 *
	 * IT DOES NOT THROW, and that is deliberate rather than a swallowed error.
	 * This runs at construction, so throwing meant one un-deletable file made the
	 * bridge refuse to start FOREVER — and on this fork's platform an antivirus or
	 * indexer holding a handle open is an ordinary transient, not a corruption.
	 * The device whose key this is has already been revoked AND tombstoned inside
	 * that very key file, so nothing is authorised by the delay; what is left is
	 * hygiene, and taking the whole companion feature down for hygiene is a worse
	 * failure than reporting it. Nothing is hidden: `log.error` fires with the
	 * count, a journalled obligation stays durably in `pending-destroy.json`, an
	 * orphaned one is re-derived from the directory at the next start, and both are
	 * retried until they succeed.
	 */
	async function reclaimPurgedKeyMaterial(
		phase: "start" | "purge",
	): Promise<void> {
		const journalled = await readPendingDestroy();

		// (ORPHAN-SWEEP) The re-derived half. A failure to enumerate does NOT skip
		// the journalled half: the journal is still a valid, independently durable
		// list of work, and one unreadable directory listing must not also cancel
		// the wipes that were recorded properly.
		let orphans: readonly string[] = [];
		if (phase === "start") {
			try {
				const inventory = await keys.list();
				const referenced = new Set<string>();
				for (const record of records.values()) {
					referenced.add(record.keyRef);
				}
				// SET ARITHMETIC, STATED SO THE SAFE DIRECTION IS THE OBVIOUS ONE:
				// on disk MINUS referenced-by-any-record. `referenced` spans EVERY
				// record, live and revoked-but-unpurged alike — a revoked device keeps
				// its key on purpose (§5.1, so it can open its own sealed 403), so
				// filtering on "not revoked" here would destroy exactly the keys the
				// protocol requires to survive. Nothing is ever added to this set; it
				// can only shrink relative to the directory.
				orphans = inventory.keyRefs.filter((keyRef) => !referenced.has(keyRef));
				if (inventory.unrecognised.length > 0) {
					// Cannot have been written by `put()`, which only ever mints
					// canonical refs. Reported and left alone: a name this store cannot
					// parse is also a name it cannot prove unreferenced.
					log.error(
						"the companion devices directory holds key-file names this store cannot have written; they are being left alone, because a name that cannot be parsed cannot be proven unreferenced either",
						{ devicesDir, names: inventory.unrecognised },
					);
				}
			} catch (error) {
				log.error(
					"could not enumerate the key files, so orphaned key material cannot be re-derived on this start; any journalled wipes still run and the sweep is retried at the next start",
					{ devicesDir, error },
				);
			}
		}

		const doomed = [...new Set([...journalled, ...orphans])];
		if (doomed.length === 0) return;

		// THE ONE DIRECTION THAT WOULD BE CATASTROPHIC, REFUSED EXPLICITLY RATHER
		// THAN ARGUED AWAY. Destroying the key of a device that is still LIVE bricks
		// a working phone with no recovery but re-pairing. `orphans` cannot contain
		// such a keyRef by construction (it is the difference against every record),
		// and `journalled` cannot either (a keyRef only ever enters it from
		// `purgeExpiredRevocations`, which requires `revokedAtMs !== null` and 30 days
		// elapsed). So this branch is unreachable unless the journal or the index has
		// been tampered with or corrupted — which is exactly when a cheap check is
		// worth having, and why it reports instead of proceeding.
		const liveOwners = new Map<string, DeviceId>();
		for (const record of records.values()) {
			if (record.revokedAtMs === null) {
				liveOwners.set(record.keyRef, record.deviceId);
			}
		}

		const journalledRefs = new Set(journalled);
		const failures: { keyRef: string; error: unknown }[] = [];
		const remaining: string[] = [];
		let orphansReclaimed = 0;
		for (const keyRef of doomed) {
			const liveOwner = liveOwners.get(keyRef);
			if (liveOwner !== undefined) {
				log.error(
					"refusing to destroy key material that a LIVE, un-revoked device record still points at — this cannot happen from a purge, so either the journal or the device index is corrupt; the device keeps working and the entry is retained for a maintainer",
					{ keyRef, deviceId: liveOwner, journal: pendingDestroyPath },
				);
				if (journalledRefs.has(keyRef)) remaining.push(keyRef);
				continue;
			}
			try {
				await keys.destroy(keyRef);
				if (!journalledRefs.has(keyRef)) orphansReclaimed += 1;
			} catch (error) {
				failures.push({ keyRef, error });
				// Only the journalled half is written back. An orphan that failed to
				// die is deliberately NOT journalled: the next start re-derives it from
				// the directory, which is the whole point — adding it to the journal
				// would re-introduce the dependence on a file whose rename can be lost.
				if (journalledRefs.has(keyRef)) remaining.push(keyRef);
			}
		}

		// `remaining` is an order-preserving subset of `journalled`, so equal lengths
		// means nothing changed and the file does not need rewriting. That also keeps
		// a fresh install from CREATING `pending-destroy.json` for no reason.
		if (remaining.length !== journalled.length) {
			await writePendingDestroy(remaining);
		}
		if (orphansReclaimed > 0) {
			// A real, previously undetectable fault, now repaired — so it is said out
			// loud once rather than fixed in silence. On a healthy install (including
			// a fresh one and a legacy pre-anchor one) this count is 0 and nothing is
			// logged, so the line only ever appears when there was something to find.
			log.warn(
				"(ORPHAN-SWEEP) destroyed key material that no device record referenced — a purge's journal write was lost while its index write survived, which used to leave a revoked device's K_dev on disk permanently",
				{ reclaimed: orphansReclaimed, devicesDir },
			);
		}
		if (failures.length > 0) {
			log.error(
				"key material for purged devices could not be wiped; journalled entries stay on the retry list and orphaned ones are re-derived from the devices directory, and both are attempted again at the next purge and at every start",
				{
					pending: remaining.length,
					failures: failures.length,
					journal: pendingDestroyPath,
					errors: failures.map(({ keyRef, error }) => ({
						keyRef,
						error: error instanceof Error ? error.message : String(error),
					})),
				},
			);
		}
	}

	// --- index I/O ---------------------------------------------------------

	function assertNoRollback(loaded: {
		seq: bigint;
		epoch: bigint | null;
		generation: string | null;
		legacy: boolean;
		absent: boolean;
		digest: string;
	}): boolean {
		const anchored = anchor.devices();

		if (loaded.absent) {
			if (anchored !== null) {
				throw new StateRollbackError(
					`the state anchor records ${anchored.seq} device-index write(s) but ${indexPath} does not exist — the device index was deleted or rolled back`,
				);
			}
			return false;
		}

		if (loaded.legacy) {
			if (anchored !== null) {
				throw new StateRollbackError(
					`${indexPath} is in the pre-anchor format but the state anchor already records device-index sequence ${anchored.seq} — the index was rolled back past the anchor`,
				);
			}
			// First run after the upgrade (or a crash before the first commit):
			// adopt the file as sequence 1.
			return true;
		}

		if (loaded.generation !== anchor.generation) {
			throw new StateRollbackError(
				`${indexPath} was written under install generation ${String(loaded.generation)} but the state anchor is ${anchor.generation}`,
			);
		}
		if (loaded.epoch !== null && loaded.epoch > anchor.previousEpoch) {
			throw new StateRollbackError(
				`${indexPath} was written by mount epoch ${loaded.epoch} but the state anchor has only reached ${anchor.previousEpoch} — the anchor was rolled back`,
			);
		}
		if (anchored === null) {
			if (anchor.minted) {
				throw new StateRollbackError(
					`${indexPath} exists but the state anchor was just minted — the anchor was deleted, so nothing can prove the nonce counter or the revocation set is current`,
				);
			}
			return true;
		}
		if (loaded.seq < anchored.seq) {
			throw new StateRollbackError(
				`${indexPath} is at device-index sequence ${loaded.seq} but the state anchor has committed ${anchored.seq} — the device index was rolled back, which is how a revoked device comes back`,
			);
		}
		if (loaded.seq > anchored.seq + 1n) {
			throw new StateRollbackError(
				`${indexPath} is at device-index sequence ${loaded.seq} but the state anchor has only committed ${anchored.seq} — the anchor was rolled back`,
			);
		}
		if (loaded.seq === anchored.seq && loaded.digest !== anchored.digest) {
			throw new StateRollbackError(
				`${indexPath} does not match the authority digest the state anchor committed for sequence ${loaded.seq}`,
			);
		}
		// Exactly one ahead: a crash between the index write and the anchor commit.
		// The index is written first precisely so this direction is the recoverable
		// one, so adopt it.
		return loaded.seq === anchored.seq + 1n;
	}

	async function load(): Promise<LoadedIndex> {
		let raw: string | null;
		try {
			raw = await readFile(indexPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			raw = null;
		}

		if (raw === null) {
			const adopt = assertNoRollback({
				seq: 0n,
				epoch: null,
				generation: null,
				legacy: false,
				absent: true,
				digest: authorityDigest([]),
			});
			return { records: [], seq: 0n, adopt };
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			// Corrupt index => fail loud at startup. Starting with an empty set
			// would silently unpair every device and read as "pair again".
			throw new DeviceStoreError(
				`${indexPath} is not valid JSON: ${(error as Error).message}`,
			);
		}

		let entries: unknown[];
		let legacy: boolean;
		let fileSeq: bigint;
		let fileEpoch: bigint | null;
		let generation: string | null;
		if (Array.isArray(parsed)) {
			entries = parsed;
			legacy = true;
			fileSeq = 1n;
			fileEpoch = null;
			generation = null;
		} else if (
			parsed !== null &&
			typeof parsed === "object" &&
			(parsed as Partial<StoredIndexFile>).v === 2
		) {
			const file = parsed as Partial<StoredIndexFile>;
			if (
				typeof file.generation !== "string" ||
				typeof file.epoch !== "string" ||
				!/^[0-9]+$/.test(file.epoch) ||
				typeof file.seq !== "string" ||
				!/^[0-9]+$/.test(file.seq) ||
				!Array.isArray(file.devices)
			) {
				throw new DeviceStoreError(
					`${indexPath} is a v2 index but its header is malformed`,
				);
			}
			entries = file.devices;
			legacy = false;
			fileSeq = BigInt(file.seq);
			fileEpoch = BigInt(file.epoch);
			generation = file.generation;
		} else {
			throw new DeviceStoreError(
				`${indexPath} must be a v2 device index object or a pre-anchor JSON array`,
			);
		}

		const parsedRecords: DeviceRecord[] = [];
		const seen = new Set<string>();
		entries.forEach((entry, index) => {
			const record = parseRecord(entry, index);
			if (seen.has(record.deviceId)) {
				throw new DeviceStoreError(
					`${indexPath} contains duplicate deviceId ${record.deviceId}`,
				);
			}
			seen.add(record.deviceId);
			parsedRecords.push(record);
		});

		const adopt = assertNoRollback({
			seq: fileSeq,
			epoch: fileEpoch,
			generation,
			legacy,
			absent: false,
			digest: authorityDigest(parsedRecords),
		});
		return { records: parsedRecords, seq: fileSeq, adopt };
	}

	/**
	 * Writes the index, then commits its authority state to the anchor.
	 *
	 * ORDER IS NORMATIVE: index first, anchor second. A crash in between leaves
	 * the index exactly one sequence AHEAD of the anchor, which `assertNoRollback`
	 * recognises and adopts. The reverse order would leave the index BEHIND the
	 * anchor, which is indistinguishable from a rollback and would (correctly)
	 * refuse to start.
	 *
	 * The sequence advances ONLY when the authority projection changes, which is
	 * what keeps a per-request `touchLastSeen` from forcing a durable anchor write
	 * it has no security reason to make.
	 */
	async function persist(): Promise<void> {
		const list = [...records.values()];
		const digest = authorityDigest(list);
		const anchored = anchor.devices();
		if (anchored === null) {
			if (seq < 1n) seq = 1n;
		} else if (digest !== anchored.digest) {
			if (seq <= anchored.seq) seq = anchored.seq + 1n;
		} else {
			seq = anchored.seq;
		}
		const file: StoredIndexFile = {
			v: 2,
			generation: anchor.generation,
			epoch: anchor.epoch.toString(10),
			seq: seq.toString(10),
			devices: list,
		};
		await writeFileDurable(
			indexPath,
			new Uint8Array(
				Buffer.from(`${JSON.stringify(file, null, "\t")}\n`, "utf8"),
			),
			FILE_MODE,
		);
		// (LASTSEEN-DEBOUNCE) The file just written contains `list`, which is the
		// live record objects — so whatever `touchLastSeen` stamped on them is now
		// on disk, whichever caller asked for this write.
		lastSeenDirty = false;
		if (
			anchored === null ||
			anchored.seq !== seq ||
			anchored.digest !== digest
		) {
			await anchor.commitDevices(seq, digest);
		}
	}

	function mustGet(deviceId: DeviceId): DeviceRecord {
		assertDeviceId(deviceId);
		const record = records.get(deviceId);
		if (!record) {
			throw new DeviceStoreError(`unknown deviceId ${deviceId}`);
		}
		return record;
	}

	/**
	 * (LASTSEEN-DEBOUNCE) Arms the one-shot flush, if it is not already armed.
	 *
	 * The flush runs inside the SAME serialiser every other mutation uses, so it
	 * can never interleave with a revoke's read-modify-write. It is `unref`'d: a
	 * liveness stamp must never be the reason the process refuses to exit, and
	 * `close()` is what guarantees the value is not simply lost on a clean stop.
	 *
	 * A failed flush is reported and left dirty — the next request re-arms it and
	 * `close()` tries once more. It is deliberately not retried in a loop: a
	 * failure here means the device directory is not writable, which every other
	 * durable write in this store will also discover and fail loudly on.
	 */
	function scheduleLastSeenFlush(): void {
		if (closed || lastSeenTimer !== null) return;
		lastSeenTimer = setTimeout(() => {
			lastSeenTimer = null;
			void serialise(async () => {
				if (!lastSeenDirty) return;
				await persist();
			}).catch((error: unknown) => {
				log.error(
					"could not flush the debounced lastSeen stamp; it stays pending and is retried on the next request and at shutdown",
					{ error },
				);
			});
		}, LAST_SEEN_FLUSH_INTERVAL_MS);
		lastSeenTimer.unref();
	}

	const loaded = await load();
	for (const record of loaded.records) {
		records.set(record.deviceId, record);
	}
	seq = loaded.seq;

	// (REVOKE-DURABLE) The key files are the second, independent record of a
	// revocation. Re-apply anything the index has "forgotten" BEFORE the store is
	// handed out, so no request can ever be served against a reinstated device.
	for (const record of records.values()) {
		const tombstone = await keys.revocationOf(record.keyRef);
		if (tombstone === null || record.revokedAtMs !== null) continue;
		record.revokedAtMs = tombstone.revokedAtMs;
		record.revokeReason = tombstone.revokeReason;
		sessions.delete(record.deviceId);
		log.error(
			"device index did not record a revocation that the key file does — re-applying it from the key file",
			{
				deviceId: record.deviceId,
				revokedAtMs: tombstone.revokedAtMs,
				revokeReason: tombstone.revokeReason,
			},
		);
	}

	// Always rewrite. Two reasons, both load-bearing: the mount epoch in the file
	// is the witness that lets the NEXT mount detect an anchor rollback, and a
	// re-applied tombstone or an adopted index has to reach the anchor before any
	// request is served. `persist` advances the sequence iff the authority
	// projection actually changed, so a quiet start costs one index write and no
	// anchor write.
	if (loaded.adopt) {
		// Loud, because reaching here means the previous run died in the window
		// between the index write and the anchor commit (or this is the migration
		// onto the anchor). It is recoverable and is being recovered — but it is
		// the one window in which the two records of authority disagree, so it is
		// reported rather than absorbed.
		log.warn(
			"the device index leads the state anchor — adopting it and bringing the anchor up to it",
			{ indexSeq: seq.toString(10) },
		);
	}
	await persist();

	// (ADOPT-COMMIT) POST-CONDITION, NOT AN ASSUMPTION.
	//
	// `assertNoRollback` returns whether the index legitimately leads the anchor,
	// and `persist()` above is what is supposed to close that gap. Discarding that
	// signal and TRUSTING persist() to have acted on it is precisely how the gap
	// survives: if the anchor is left recording the older `(seq, digest)`, then
	// restoring that older index later matches the anchor exactly, passes every
	// check, and silently undoes the last authority change — a revoked device
	// comes back. So the agreement is CHECKED here rather than assumed, for every
	// start and not only the adopting ones. If a future edit makes `persist()`
	// conditional, this fires immediately instead of years later as a rollback
	// that quietly validated.
	const committed = anchor.devices();
	const projection = authorityDigest([...records.values()]);
	if (
		committed === null ||
		committed.seq !== seq ||
		committed.digest !== projection
	) {
		throw new StateRollbackError(
			`the state anchor does not attest the device index this mount just wrote (anchor=${
				committed === null
					? "<none>"
					: `${committed.seq}/${committed.digest.slice(0, 12)}`
			}, index=${seq}/${projection.slice(0, 12)}) — refusing to serve requests under an index the anchor cannot vouch for`,
		);
	}

	await reclaimPurgedKeyMaterial("start");

	return {
		async get(deviceId) {
			assertDeviceId(deviceId);
			const record = records.get(deviceId);
			return record ? clone(record) : null;
		},

		async list() {
			return [...records.values()].map(clone);
		},

		async anyPaired() {
			// Revoked-but-unpurged records count: that device DID pair, so an
			// unrecognised deviceId is `unknown_device`, not `not_paired`.
			return records.size > 0;
		},

		create(input) {
			return serialise(async () => {
				assertDeviceId(input.deviceId);
				assertLabel(input.label);
				assertSurface(input.surface);
				assertEpochMs(input.pairedAtMs, "pairedAtMs");
				if (typeof input.keyRef !== "string" || input.keyRef.length === 0) {
					throw new DeviceStoreError("keyRef must be a non-empty string");
				}
				if (records.has(input.deviceId)) {
					// §4.8: re-pairing always mints a NEW deviceId. A record is never
					// reused, re-keyed, or "refreshed" — including a revoked one.
					throw new DeviceStoreError(
						`deviceId ${input.deviceId} already exists; re-pairing must mint a new one`,
					);
				}
				// A keyRef whose file already carries a tombstone must never be
				// attached to a live record: that is a revoked key being re-adopted.
				const tombstone = await keys.revocationOf(input.keyRef);
				if (tombstone !== null) {
					throw new DeviceStoreError(
						`keyRef ${input.keyRef} is tombstoned as revoked (${tombstone.revokeReason}) and cannot back a new device`,
					);
				}

				const record: DeviceRecord = {
					deviceId: input.deviceId,
					label: input.label,
					surface: input.surface,
					pairedAtMs: input.pairedAtMs,
					lastSeenMs: null,
					keyRef: input.keyRef,
					fcmToken: null,
					fcmTokenUpdatedMs: null,
					writeEnabled: true,
					revokedAtMs: null,
					revokeReason: null,
				};
				records.set(record.deviceId, record);
				await persist();
				return clone(record);
			});
		},

		touchLastSeen(deviceId, atMs) {
			return serialise(async () => {
				assertEpochMs(atMs, "lastSeenMs");
				const record = mustGet(deviceId);
				record.lastSeenMs = atMs;
				// (LASTSEEN-DEBOUNCE) No durable write here. Both boundary checks
				// above still run on every call — an out-of-range stamp or an unknown
				// deviceId is still a hard, immediate failure.
				lastSeenDirty = true;
				scheduleLastSeenFlush();
			});
		},

		setFcmToken(deviceId, token, atMs) {
			return serialise(async () => {
				assertEpochMs(atMs, "fcmTokenUpdatedMs");
				if (
					token !== null &&
					(typeof token !== "string" || token.length === 0)
				) {
					throw new DeviceStoreError(
						"fcmToken must be a non-empty string or null",
					);
				}
				const record = mustGet(deviceId);
				record.fcmToken = token;
				record.fcmTokenUpdatedMs = atMs;
				await persist();
			});
		},

		setWriteEnabled(deviceId, enabled) {
			return serialise(async () => {
				if (typeof enabled !== "boolean") {
					throw new DeviceStoreError("writeEnabled must be a boolean");
				}
				const record = mustGet(deviceId);
				record.writeEnabled = enabled;
				await persist();
			});
		},

		revoke(deviceId, reason, atMs) {
			return serialise(async () => {
				assertRevokeReason(reason);
				assertEpochMs(atMs, "revokedAtMs");
				const record = mustGet(deviceId);
				if (record.revokedAtMs !== null) {
					// Idempotent: the first revocation time is the truthful one and is
					// never overwritten by a later duplicate.
					return;
				}
				// (REVOKE-DURABLE) Tombstone FIRST. A crash between the two writes must
				// leave the device MORE restricted, never less: the tombstone is
				// re-applied to the index at the next load.
				await keys.markRevoked(record.keyRef, atMs, reason);
				record.revokedAtMs = atMs;
				record.revokeReason = reason;
				// Revocation also ends the negotiated session, but NOT the key: the
				// device must still be able to open the sealed 403 that tells it why.
				sessions.delete(deviceId);
				await persist();
			});
		},

		revokeAll(reason, atMs) {
			return serialise(async () => {
				assertRevokeReason(reason);
				assertEpochMs(atMs, "revokedAtMs");
				let affected = 0;
				for (const record of records.values()) {
					if (record.revokedAtMs !== null) {
						continue;
					}
					await keys.markRevoked(record.keyRef, atMs, reason);
					record.revokedAtMs = atMs;
					record.revokeReason = reason;
					sessions.delete(record.deviceId);
					affected += 1;
				}
				if (affected > 0) {
					await persist();
				}
				return affected;
			});
		},

		purgeExpiredRevocations(nowMs) {
			return serialise(async () => {
				assertEpochMs(nowMs, "nowMs");
				const purged: DeviceRecord[] = [];
				for (const record of records.values()) {
					if (
						record.revokedAtMs !== null &&
						nowMs - record.revokedAtMs > REVOKED_RETENTION_MS
					) {
						purged.push(clone(record));
					}
				}
				if (purged.length === 0) {
					// Still retry anything an earlier purge failed to wipe. No orphan
					// sweep here: see `reclaimPurgedKeyMaterial` — a pairing sitting
					// between `keys.put()` and `create()` legitimately holds an
					// unreferenced key file, and only the construction path can prove
					// none is in flight.
					await reclaimPurgedKeyMaterial("purge");
					return 0;
				}
				// (PENDING-DESTROY) Record the obligation BEFORE dropping the records
				// that name it. Losing the record first is what made a failed wipe
				// terminal and silent.
				const pending = await readPendingDestroy();
				const merged = [
					...new Set([...pending, ...purged.map((r) => r.keyRef)]),
				];
				await writePendingDestroy(merged);

				for (const record of purged) {
					records.delete(record.deviceId);
					sessions.delete(record.deviceId);
				}
				await persist();
				// Only now may the key material go: until this point the device had
				// to be able to open its own sealed revocation notice.
				await reclaimPurgedKeyMaterial("purge");
				return purged.length;
			});
		},

		setSession(deviceId, session) {
			assertDeviceId(deviceId);
			assertEpochMs(session.negotiatedAtMs, "negotiatedAtMs");
			assertEpochMs(session.expiresAtMs, "expiresAtMs");
			if (!records.has(deviceId)) {
				throw new DeviceStoreError(
					`cannot open a session for unknown deviceId ${deviceId}`,
				);
			}
			sessions.set(deviceId, {
				protocol: session.protocol,
				granted: [...session.granted],
				negotiatedAtMs: session.negotiatedAtMs,
				expiresAtMs: session.expiresAtMs,
			});
		},

		getSession(deviceId, nowMs) {
			const session = sessions.get(deviceId);
			if (!session) {
				return null;
			}
			if (nowMs >= session.expiresAtMs) {
				sessions.delete(deviceId);
				return null;
			}
			return { ...session, granted: [...session.granted] };
		},

		clearSession(deviceId) {
			sessions.delete(deviceId);
		},

		close() {
			// Set BEFORE the flush so a touch that lands while the flush is queued
			// cannot re-arm the timer behind the teardown.
			closed = true;
			if (lastSeenTimer !== null) {
				clearTimeout(lastSeenTimer);
				lastSeenTimer = null;
			}
			return serialise(async () => {
				if (!lastSeenDirty) return;
				await persist();
			});
		},
	};
}
