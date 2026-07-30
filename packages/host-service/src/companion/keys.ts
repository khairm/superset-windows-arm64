/**
 * (COMPANION-BRIDGE) — K_dev custody, directional key derivation, the bridge's
 * own send-nonce counter, and the persisted replay cache (§3.1, §3.4, §3.5).
 *
 * K_dev is NEVER transmitted in either direction, in any form. There is no
 * endpoint that returns it and no diagnostic that prints it. It is stored under
 * `~/.superset/companion/devices/<keyRef>.key.json` — outside both repos.
 *
 * ---------------------------------------------------------------------------
 * THE STATE ANCHOR — why this file grew one
 * ---------------------------------------------------------------------------
 * Nonce, replay and revocation authority used to live in independently
 * rollbackable flat files with no transaction and nothing binding them
 * together. That single root cause produced three separate failures:
 *
 *  - two bridge lifecycles could own the same send-nonce file, each with a
 *    private counter, and a stale owner's `close()` could LOWER the persisted
 *    high-water mark — after which the next owner resumed below it and
 *    re-emitted nonces a previous owner had already used;
 *  - restoring the counter state while retaining K_dev (VM snapshot, profile
 *    restore, disk rollback) reproduced an identical `(prefix, counter)` under
 *    an unchanged key;
 *  - restoring an older `devices.json` reinstated a revoked device, and because
 *    K_dev had deliberately been retained (§5.1) its writes became valid again.
 *
 * `StateAnchor` is the fix, and it is one object with four jobs:
 *  1. it is the SINGLE writer of the send-nonce high-water mark, guarded by an
 *     owner token and a monotonic check performed against the file on disk, so
 *     a stale owner cannot write at all and no write can ever lower the mark;
 *  2. it carries a `generation` minted once per install and stamped into every
 *     key file, so key material and counter state cannot be recombined across
 *     installs;
 *  3. it carries a monotonic `epoch`, bumped once per mount and mirrored into
 *     `devices.json`, so a rollback of EITHER file relative to the other is
 *     detectable;
 *  4. it carries the device index's `(seq, digest)`, so a rollback of the index
 *     alone — the revocation-reversal case — fails closed instead of silently
 *     re-authorising a revoked phone.
 *
 * `send.highWater` gets one more thing on top, an APPEND-ONLY JOURNAL
 * (SEND-JOURNAL), because the anchor could not police its own most important
 * field. `generation` is per install, `epoch` is per mount and `(seq, digest)`
 * move only with the device authority, so reverting `state-anchor.json` to ANY
 * earlier version written during the same mount matched every check while taking
 * the mark backwards with it — and on win32 `syncDirectory` is a no-op, so the
 * most recent rename really can be lost. `send-journal.log` appends the mark and
 * fsyncs the same file before any nonce covered by it is issued, and the highest
 * valid record wins at start. The anchor still carries `highWater`, demoted to a
 * conservative FLOOR that cross-checks the journal and can only ever raise it.
 *
 * WHY AN APPEND AND NOT A SECOND FILE. The mark used to live in a second
 * whole-file record (`send-witness.json`) renamed BEFORE the anchor on every
 * raise, and the claim that made the pair work was that the anchor's own content
 * fsync published the witness's earlier rename — see `writeFileDurable` in
 * `crypto.ts`, which now states plainly that this is an INFERENCE about NTFS's
 * metadata log and not a guarantee the platform offers in writing. If it is wrong,
 * BOTH renames sit in one unflushed window, a hard reset takes both, and the two
 * files roll back TOGETHER to matching values — which looks healthy, logs nothing,
 * and silently rewinds the counter into values already handed out. That is the one
 * state a pair of renamed files cannot detect, and a repeated (key, nonce) pair
 * destroys AES-GCM outright, so the mechanism could not be left resting on it.
 *
 * An append has no directory entry to lose. `FlushFileBuffers` is documented to
 * flush the SPECIFIED FILE, and an append changes only that file's data and its own
 * size, so `appendDurable` needs no inference at all. The replay cache in
 * `crypto.ts` has always been structurally immune for exactly this reason; the
 * counter now uses the same shape, and the ONE rename left anywhere near it is
 * compaction, where losing the rename reverts to a file carrying the
 * byte-identical maximum record.
 *
 * HONEST LIMIT, STATED RATHER THAN PAPERED OVER: a rollback of the WHOLE
 * `~/.superset/companion/` tree at once (a full VM snapshot restore) restores
 * the anchor, the index, the journal and the key files together and is not
 * detectable from inside that tree. Detecting it needs a monotonic reference
 * outside the rolled-back volume, which this design does not have. Every PARTIAL
 * rollback — which is what the reviewer demonstrated, and what a "restore my
 * profile" or "roll back one file" actually does — is caught: a rolled-back
 * index or key file fails closed, and a rolled-back anchor is overridden by the
 * journal and logged loudly (resuming at the higher mark, rather than refusing,
 * because that shape is also an ordinary crash between the two writes).
 *
 * A DELIBERATE EDIT THAT REWINDS THE JOURNAL IS DETECTED, WHICH THE WITNESS COULD
 * NOT MANAGE. Two files tampered together used to be indistinguishable from
 * health. Now the anchor's floor is written AFTER the journal record on every
 * raise, so `anchor.highWater > journalMark` is structurally impossible in normal
 * operation and means the journal demonstrably lost records: the bridge refuses to
 * start. Truncating or rewriting the journal downwards therefore fails closed
 * rather than passing as consistent. Raising it to a merely plausible value is
 * still undetectable and still harmless — it burns counters, it cannot repeat one —
 * and raising it to an impossible one is refused at the parse boundary.
 *
 * (SEND-WITNESS) IS RETIRED, AND `answer.ts` POINTS HERE FOR THE CONTRAST.
 * `send-witness.json` is no longer written. It is still READ once at start, its
 * mark folded into the floor the journal is seeded to, and then deleted — the same
 * carry-then-retire shape `send-nonce.json` gets below, because a file that once
 * held the only durable mark may not simply be abandoned. It was not kept as
 * defence-in-depth: its guarantee was contingent on the very inference being
 * removed, and defence that shares a failure mode with the thing it defends is not
 * depth — it is a second mechanism a reader will over-trust. Two independent
 * records remain regardless (the journal and the anchor's floor), and they are
 * combined with a MAX, so neither can lower the other.
 *
 * THERE IS STILL A WITNESS IN THIS DIRECTORY, AND IT IS DELIBERATELY NOT SHARED
 * WITH THIS FILE. `answer.ts` (ATTEMPT-WITNESS) applies the OLD shape — a
 * generation-bound rise-only mark, written BEFORE the file it guards — to
 * `answer-attempts.json`, and it may keep doing so precisely because its POLICY is
 * opposite where it matters: a rollback here means a repeated AES-GCM nonce, so
 * this one refuses to start (`StateRollbackError`); a rollback there costs only
 * status records, so that one must NEVER refuse to start and instead narrows the
 * window it publishes. Folding both behind a fatal/non-fatal flag would put that
 * distinction one careless argument away from being inverted. What they no longer
 * share is the write-ordering assumption: `answer.ts` is now its ONLY dependent,
 * and it is the dependent that can survive the assumption being false.
 *
 * ---------------------------------------------------------------------------
 * WHY `keyRef` IS RANDOM AND NOT THE deviceId
 * ---------------------------------------------------------------------------
 * §4.8 says re-pairing always mints a NEW deviceId, and `device-store`'s
 * `create()` is the guard that enforces it. If the key file were named after the
 * deviceId, a client that replayed an already-registered deviceId would
 * OVERWRITE a live device's K_dev before `create()` ever got to refuse — the
 * record would keep pointing at a file holding a key nobody has, and the
 * previously working phone would be bricked with no recovery but manual file
 * deletion. A random `keyRef` makes that collision impossible by construction
 * rather than by call ordering.
 *
 * ---------------------------------------------------------------------------
 * ID ENCODING IN HKDF `info`
 * ---------------------------------------------------------------------------
 * Every id suffix contributes its RAW BYTES, never its base64url text. See the
 * INTEROP NOTE in `crypto.ts`; the Android client's `KeyDerivation` implements
 * the same convention, and the two MUST NOT drift.
 */

import type { FileHandle } from "node:fs/promises";
import { open, readdir, readFile, unlink } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import {
	HKDF_LABEL_SEAL_C2S,
	HKDF_LABEL_SEAL_EVT,
	HKDF_LABEL_SEAL_S2C,
	LOG_PREFIX,
	NONCE_COUNTER_BYTES,
	NONCE_PREFIX_BYTES,
} from "./config";
import {
	appendDurable,
	base64UrlDecode,
	base64UrlEncode,
	constantTimeEquals,
	createSerialiser,
	decodeWireId,
	hkdfExpandInfo,
	hkdfExpandLabel,
	hkdfInfoWithSuffix,
	isAllZero,
	isCanonicalWireId,
	randomBytes,
	sha256,
	syncDirectory,
	writeFileDurable,
	zero,
} from "./crypto";
import { KEY_BYTES, WIRE_ID_BYTES } from "./limits";
import type { DeviceId, DirectionalKeys, RevokeReason } from "./types";

const KEY_FILE_SUFFIX = ".key.json";
/** Owner read/write only. Ignored on Windows — `ensureCompanionDirs` owns the ACL. */
const KEY_FILE_MODE = 0o600;

const ANCHOR_FILENAME = "state-anchor.json";
/**
 * (SEND-JOURNAL) The append-only durable record of the send-nonce high-water
 * mark. See `replaySendJournal` for the format and `openSendJournal` for why the
 * mark lives in an append rather than in a renamed file.
 */
const SEND_JOURNAL_FILENAME = "send-journal.log";
/**
 * (SEND-WITNESS) RETIRED. The pre-journal second copy of the mark. Read ONCE, to
 * carry its high-water mark into the journal, then deleted. Never re-created —
 * see the header for why it was not kept as defence-in-depth.
 */
const SEND_WITNESS_FILENAME = "send-witness.json";
/**
 * The pre-anchor send-nonce file. Read ONCE, to carry its high-water mark into
 * the anchor, then deleted. Never re-created.
 */
const LEGACY_SEND_NONCE_FILENAME = "send-nonce.json";

/**
 * §3.4 — counters are reserved on disk in blocks, not one at a time.
 *
 * The safety property the spec demands is "a crash must never let a counter
 * repeat". Reserving a block and fsync'ing the block's high-water mark BEFORE
 * any nonce in it is handed out gives exactly that: a crash burns the remainder
 * of the block. An fsync per nonce would give the same property at the cost of a
 * synchronous disk write on every event frame, and `next()` is called from the
 * synchronous seal path where it cannot await anything.
 */
const NONCE_RESERVATION_BLOCK = 65_536n;
/** Refill this far ahead of exhaustion so the async write lands before the block runs out. */
const NONCE_REFILL_THRESHOLD = 8_192n;
/** Counter 0 is reserved for the pairing step-4 response (`pairing.ts`). */
const NONCE_FIRST_COUNTER = 1n;

/**
 * A state-freshness failure. ALWAYS fatal, never caught to be hidden: it means
 * the bridge cannot prove its own counter/revocation state is current, and §3.4
 * rule 4 is explicit that the only correct response is to refuse and re-pair.
 */
export class StateRollbackError extends Error {
	constructor(message: string) {
		super(
			`${LOG_PREFIX} state freshness cannot be proven: ${message}. ` +
				"REFUSING TO START. This is the §3.4 rule-4 / §4.8 path: delete " +
				"~/.superset/companion/devices/ and pair every device again. Emitting " +
				"under state that may have rolled back would repeat a nonce, which " +
				"destroys AES-GCM outright.",
		);
		this.name = "StateRollbackError";
	}
}

// ---------------------------------------------------------------------------
// (SEND-JOURNAL) — the high-water mark, in records no rename can lose
// ---------------------------------------------------------------------------

/**
 * `"SNJ1"` — a frame marker AND the format version, in the first four bytes of
 * every record. It is what makes "this file is not a send journal" cheap to answer
 * and a hexdump of it legible.
 */
const SEND_JOURNAL_MAGIC = Buffer.from("SNJ1", "ascii");
const SEND_JOURNAL_OFF_GENERATION = SEND_JOURNAL_MAGIC.length;
const SEND_JOURNAL_OFF_PREFIX = SEND_JOURNAL_OFF_GENERATION + WIRE_ID_BYTES;
const SEND_JOURNAL_OFF_HIGH_WATER =
	SEND_JOURNAL_OFF_PREFIX + NONCE_PREFIX_BYTES;
const SEND_JOURNAL_OFF_SEQ = SEND_JOURNAL_OFF_HIGH_WATER + NONCE_COUNTER_BYTES;
const SEND_JOURNAL_OFF_DIGEST = SEND_JOURNAL_OFF_SEQ + 8;
const SEND_JOURNAL_DIGEST_BYTES = 32;
/** 4 magic || 16 generation || 4 prefix || 8 highWater || 8 seq || 32 digest. */
const SEND_JOURNAL_RECORD_BYTES =
	SEND_JOURNAL_OFF_DIGEST + SEND_JOURNAL_DIGEST_BYTES;

const UINT64_MAX = (1n << 64n) - 1n;
/**
 * A mark above this cannot be extended by another reservation without exceeding
 * the 8-byte counter field, so it is not a value this install can have
 * legitimately produced — the same judgement the mount-epoch ceiling makes. It is
 * checked on every byte replayed off disk, so a crafted record cannot saturate the
 * counter and turn the bridge's refusal into an unexplained `writeBigUInt64BE`
 * range error somewhere in the seal path.
 */
const SEND_JOURNAL_MAX_HIGH_WATER = UINT64_MAX - NONCE_RESERVATION_BLOCK;

/**
 * THE GROWTH BOUND, AND WHY THERE IS NO COMPACTION.
 *
 * One record is appended per RESERVATION — that is one per 65 536 nonces — plus
 * one per mount (the mount's `claimSend`; a `close()` that reserved nothing
 * appends nothing). At 72 bytes a record that is 72 bytes per 65 536 sealed
 * responses or event frames, and 72 bytes per host-service restart.
 *
 * Put arithmetic on it: a user restarting host-service twenty times a day writes
 * 526 KB a year, 5.3 MB a decade. Sustaining one hundred event frames per SECOND
 * for a year — far past anything a phone answering questions can produce — writes
 * 3.4 MB. The file cannot become a problem on any timeline this install has.
 *
 * SO IT IS NEVER REWRITTEN, AND THAT IS A CORRECTNESS DECISION, NOT LAZINESS.
 * Compaction means writing a smaller file and renaming it over this one, and a
 * rename is exactly what this mechanism exists to stop depending on. Worse than
 * the general argument: between an unpublished compaction rename and a crash, the
 * records appended AFTER the compaction live in an inode the name no longer
 * resolves to, so a hard reset would drop marks that nonces had already been
 * issued from — reintroducing the precise rewind the journal removes, in the one
 * code path that only ever runs on an install too old to test. An append-only file
 * that is never rewritten has no such window, and the size it buys back is 526 KB
 * a year.
 *
 * IF THE CEILING IS EVER HIT, THE BRIDGE REFUSES TO START. Reaching a million
 * records means either 68 billion nonces, or a million mounts (a crashloop), or a
 * crafted file — and in every one of those a silent rewrite is the wrong answer,
 * for the same reason the replay cache refuses rather than evicting. Fail loud and
 * let a human look. The §3.4 rule-4 remedy applies as it does everywhere else.
 */
const SEND_JOURNAL_MAX_RECORDS = 1_048_576;

interface SendJournalRecord {
	/** The install generation, base64url, as the anchor spells it. */
	generation: string;
	/** 4 raw prefix bytes, base64url, as the anchor spells it. */
	prefix: string;
	highWater: bigint;
	/** 1 for the first record ever written, then exactly one more each time. */
	seq: bigint;
}

/**
 * The bytes of one record. The digest covers everything before it, so the frame,
 * the install binding, the prefix binding, the mark and the sequence are all
 * inside it.
 */
function encodeSendJournalRecord(record: SendJournalRecord): Buffer {
	const bytes = Buffer.alloc(SEND_JOURNAL_RECORD_BYTES);
	SEND_JOURNAL_MAGIC.copy(bytes, 0);
	// `decodeWireId` rather than `base64UrlDecode`: the generation is a canonical
	// §0.1 wire id and must contribute exactly 16 bytes to a fixed-width record.
	bytes.set(decodeWireId(record.generation), SEND_JOURNAL_OFF_GENERATION);
	const prefixBytes = base64UrlDecode(record.prefix);
	if (prefixBytes.length !== NONCE_PREFIX_BYTES) {
		throw new StateRollbackError(
			`cannot journal a ${prefixBytes.length}-byte send-nonce prefix, expected ${NONCE_PREFIX_BYTES}`,
		);
	}
	bytes.set(prefixBytes, SEND_JOURNAL_OFF_PREFIX);
	bytes.writeBigUInt64BE(record.highWater, SEND_JOURNAL_OFF_HIGH_WATER);
	bytes.writeBigUInt64BE(record.seq, SEND_JOURNAL_OFF_SEQ);
	bytes.set(
		sha256(new Uint8Array(bytes.subarray(0, SEND_JOURNAL_OFF_DIGEST))),
		SEND_JOURNAL_OFF_DIGEST,
	);
	return bytes;
}

/**
 * One record, or `null` when its frame or digest does not hold.
 *
 * `null` MEANS "THESE BYTES ARE NOT A RECORD THIS PROCESS WROTE", NOT "IGNORE
 * THEM". The caller decides, and the decision is different for the last record
 * than for any other — see `replaySendJournal`.
 *
 * THE DIGEST IS AN INTEGRITY CHECK, NOT AN AUTHENTICITY ONE, AND THE DIFFERENCE
 * MATTERS. SHA-256 is unkeyed, so anyone who can write this file can also write a
 * digest that verifies; there is no key available at start that an attacker with
 * write access to `~/.superset/companion/` would not also have. What it does prove
 * is that the bytes are not a TORN or corrupted write, which is the failure an
 * append-only file actually has. Tamper is answered elsewhere and deliberately:
 * a record from another install fails the generation binding, a mark below the
 * anchor's floor fails the cross-check in `openStateAnchor`, and an impossible
 * mark fails the range check here.
 */
function parseSendJournalRecord(
	raw: Buffer,
	offset: number,
	journalPath: string,
): SendJournalRecord | null {
	const bytes = raw.subarray(offset, offset + SEND_JOURNAL_RECORD_BYTES);
	if (!bytes.subarray(0, SEND_JOURNAL_MAGIC.length).equals(SEND_JOURNAL_MAGIC)) {
		return null;
	}
	const digest = sha256(
		new Uint8Array(bytes.subarray(0, SEND_JOURNAL_OFF_DIGEST)),
	);
	if (
		!constantTimeEquals(
			digest,
			new Uint8Array(bytes.subarray(SEND_JOURNAL_OFF_DIGEST)),
		)
	) {
		return null;
	}

	// Past this point the bytes are intact, so anything wrong with their VALUES is
	// a statement about what was written rather than about the disk, and is fatal
	// wherever in the file it appears.
	const generation = base64UrlEncode(
		new Uint8Array(
			bytes.subarray(
				SEND_JOURNAL_OFF_GENERATION,
				SEND_JOURNAL_OFF_GENERATION + WIRE_ID_BYTES,
			),
		),
	);
	if (!isCanonicalWireId(generation)) {
		throw new StateRollbackError(
			`${journalPath} record at byte ${offset} carries no usable install generation`,
		);
	}
	const highWater = bytes.readBigUInt64BE(SEND_JOURNAL_OFF_HIGH_WATER);
	if (highWater > SEND_JOURNAL_MAX_HIGH_WATER) {
		throw new StateRollbackError(
			`${journalPath} record at byte ${offset} claims send-nonce high-water ${highWater}, which is not a value this install can have legitimately produced (the ceiling is ${SEND_JOURNAL_MAX_HIGH_WATER})`,
		);
	}
	const seq = bytes.readBigUInt64BE(SEND_JOURNAL_OFF_SEQ);
	if (seq < 1n) {
		throw new StateRollbackError(
			`${journalPath} record at byte ${offset} has sequence ${seq}; the first record ever written is 1`,
		);
	}
	return {
		generation,
		prefix: base64UrlEncode(
			new Uint8Array(
				bytes.subarray(
					SEND_JOURNAL_OFF_PREFIX,
					SEND_JOURNAL_OFF_PREFIX + NONCE_PREFIX_BYTES,
				),
			),
		),
		highWater,
		seq,
	};
}

/** What the previous mounts left in the journal. */
interface SendJournalReplay {
	/** The highest — equivalently the last — valid record, or `null` when none. */
	highest: SendJournalRecord | null;
	/** Valid records replayed. The next one is written at `records * RECORD`. */
	records: number;
	/** Bytes after the last whole record. Overwritten, never appended past. */
	tornTailBytes: number;
	/** A full-width final record whose frame or digest failed. */
	discardedTailRecord: boolean;
}

/**
 * (SEND-JOURNAL) Replays the journal, validating every byte as untrusted input.
 *
 * ABSENT is `null` — a fresh install, or one that predates this file.
 *
 * TORN TAILS ARE EXPECTED AND ARE DISCARDED WITHOUT LOSING A VALID RECORD. Records
 * are FIXED WIDTH and one record is one append, so a crash mid-append can leave at
 * most one incomplete record and it can only be at the end. Anything after the
 * last whole record is therefore a torn write; it is counted, reported and
 * OVERWRITTEN by the next append rather than appended past, because appending
 * after torn bytes would misalign every record that follows and silently change
 * what this function reads back.
 *
 * A FULL-WIDTH FINAL RECORD THAT FAILS ITS DIGEST IS ALSO A TORN WRITE. A 72-byte
 * append can straddle a sector boundary, so a tear can land with the record's
 * length intact and its tail garbage. Discarding it loses nothing: `appendDurable`
 * fsyncs before it returns, `raiseSend` does not resolve until it does, and
 * `reserve` advances `reservedThrough` only after `raiseSend` resolves — so a
 * record whose fsync never completed cannot have had a nonce issued above it.
 *
 * ANY OTHER INVALID RECORD IS FATAL, AND THAT IS PROVABLE RATHER THAN CAUTIOUS. In
 * an append-only file with an fsync per record, the durability of record N+1
 * implies record N was already complete on disk. A bad record with a good record
 * after it therefore cannot be a torn write; it is media damage or an edit. A
 * counter whose rollback repeats a nonce does not get to absorb either quietly.
 *
 * THE SAME LOGIC MAKES THE SEQUENCE EXACT. `seq` starts at 1 and increments only
 * after a successful fsync, and a failed append is retried at the SAME offset, so
 * a gap or a repeat cannot be produced by any crash — only by records having been
 * removed or spliced. Both are refused, which is what stops a truncation that
 * happens to leave a well-formed monotone file from passing as healthy.
 */
async function replaySendJournal(
	journalPath: string,
): Promise<SendJournalReplay | null> {
	let raw: Buffer;
	try {
		raw = await readFile(journalPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}

	const tornTailBytes = raw.length % SEND_JOURNAL_RECORD_BYTES;
	const total = (raw.length - tornTailBytes) / SEND_JOURNAL_RECORD_BYTES;
	if (total > SEND_JOURNAL_MAX_RECORDS) {
		throw new StateRollbackError(
			`${journalPath} holds ${total} records, past the ${SEND_JOURNAL_MAX_RECORDS} ceiling — that is not a file legitimate use produces, and rewriting it silently is how a high-water mark gets lost`,
		);
	}

	let highest: SendJournalRecord | null = null;
	let records = 0;
	let discardedTailRecord = false;
	for (let index = 0; index < total; index += 1) {
		const offset = index * SEND_JOURNAL_RECORD_BYTES;
		const record = parseSendJournalRecord(raw, offset, journalPath);
		if (record === null) {
			if (index === total - 1 && tornTailBytes === 0) {
				discardedTailRecord = true;
				break;
			}
			throw new StateRollbackError(
				`${journalPath} record ${index + 1} of ${total} fails its frame or digest while ${total - index - 1} record(s) and ${tornTailBytes} loose byte(s) follow it — a torn append is always last, so this file was damaged or edited and the mark it should hold is unknown`,
			);
		}
		if (highest === null) {
			if (record.seq !== 1n) {
				throw new StateRollbackError(
					`${journalPath} begins at sequence ${record.seq}, not 1 — records have been removed from the front, so the highest mark this journal once held is unknown`,
				);
			}
		} else {
			if (record.generation !== highest.generation) {
				throw new StateRollbackError(
					`${journalPath} record ${index + 1} was written under install generation ${record.generation} but the record before it under ${highest.generation} — counter state from two installs cannot be recombined`,
				);
			}
			if (record.prefix !== highest.prefix) {
				throw new StateRollbackError(
					`${journalPath} record ${index + 1} changes the send-nonce prefix; the prefix is install-scoped and a journal cannot span two`,
				);
			}
			if (record.seq !== highest.seq + 1n) {
				throw new StateRollbackError(
					`${journalPath} jumps from sequence ${highest.seq} to ${record.seq} — a crash cannot skip or repeat a sequence, so records have been spliced out`,
				);
			}
			if (record.highWater <= highest.highWater) {
				throw new StateRollbackError(
					`${journalPath} record ${index + 1} lowers the send-nonce high-water mark from ${highest.highWater} to ${record.highWater} — every append strictly raises it, so this file was edited`,
				);
			}
		}
		highest = record;
		records += 1;
	}

	return { highest, records, tornTailBytes, discardedTailRecord };
}

/**
 * (SEND-JOURNAL) The live journal: one open handle and the mark it has durably
 * recorded.
 *
 * NOT SERIALISED, DELIBERATELY. Every caller is already inside the state anchor's
 * own serialiser (`claimSend` / `raiseSend`) or inside `openStateAnchor` before the
 * anchor has been handed to anybody. Adding a second mutex here would suggest the
 * ordering between the journal append and the anchor write is negotiable, and it
 * is not: the append comes first, always.
 */
interface SendJournal {
	/** The highest durably recorded mark, or `null` when nothing is recorded. */
	mark(): bigint | null;
	/** The prefix every record is bound to, or `null` when nothing is recorded. */
	prefix(): string | null;
	/**
	 * Records `highWater` durably. A no-op when it is already the mark; throws
	 * rather than lowering it.
	 */
	append(prefix: string, highWater: bigint): Promise<void>;
	close(): Promise<void>;
}

/**
 * Opens the journal for appending, creating it when this install has never had one.
 *
 * THE WRITE OFFSET IS EXPLICIT, NOT AN `"a"` HANDLE. An append-at-EOF handle would
 * write AFTER a torn tail the previous mount left behind, permanently misaligning
 * every subsequent record; positioning each write at `records * RECORD` overwrites
 * those bytes instead. It also means a failed append is retried at the same offset,
 * which is what keeps `seq` exact.
 *
 * A FILE THAT APPEARS BETWEEN THE REPLAY AND THE CREATE IS REFUSED, not adopted.
 * `wx` is the same exclusive-probe idiom `put()` uses below: the only thing that
 * could create this file is another bridge lifecycle, which is the shape of the
 * two-owners bug, and a `w` here would truncate away its records.
 */
async function openSendJournal(
	journalPath: string,
	generation: string,
	replay: SendJournalReplay | null,
): Promise<SendJournal> {
	let handle: FileHandle;
	if (replay === null) {
		try {
			handle = await open(journalPath, "wx", KEY_FILE_MODE);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new StateRollbackError(
					`${journalPath} appeared while the bridge was starting — two lifecycles cannot share the send-nonce counter`,
				);
			}
			throw error;
		}
	} else {
		handle = await open(journalPath, "r+");
	}

	let records = replay?.records ?? 0;
	let mark = replay?.highest?.highWater ?? null;
	let boundPrefix = replay?.highest?.prefix ?? null;
	let nextSeq = (replay?.highest?.seq ?? 0n) + 1n;
	let closed = false;

	return {
		mark: () => mark,
		prefix: () => boundPrefix,

		async append(prefix, highWater): Promise<void> {
			if (closed) {
				throw new Error(`${LOG_PREFIX} the send-nonce journal is closed`);
			}
			if (highWater > SEND_JOURNAL_MAX_HIGH_WATER) {
				throw new StateRollbackError(
					`refusing to journal send-nonce high-water ${highWater}: the counter has no room left for another reservation below the ${SEND_JOURNAL_MAX_HIGH_WATER} ceiling`,
				);
			}
			if (boundPrefix !== null && boundPrefix !== prefix) {
				throw new StateRollbackError(
					`refusing to journal a send-nonce mark under prefix ${prefix} when ${journalPath} is bound to ${boundPrefix} — the prefix is install-scoped`,
				);
			}
			if (mark !== null) {
				// Equal is the ordinary `close()` flush of a block that was already
				// reserved, and writing a record for it would break the strictly-raising
				// invariant the replay depends on.
				if (highWater === mark) return;
				if (highWater < mark) {
					throw new StateRollbackError(
						`refusing to lower the send-nonce high-water mark from ${mark} to ${highWater} — ${journalPath} is the record that proves what was handed out, so it may only ever be raised`,
					);
				}
			}
			if (records >= SEND_JOURNAL_MAX_RECORDS) {
				throw new StateRollbackError(
					`${journalPath} has reached its ${SEND_JOURNAL_MAX_RECORDS}-record ceiling during this mount — refusing to append rather than rewriting the one file whose rollback repeats a nonce`,
				);
			}

			const record = encodeSendJournalRecord({
				generation,
				prefix,
				highWater,
				seq: nextSeq,
			});
			// Durable — content AND the file's own size — before anything derived from
			// the raised mark is handed out. No rename, so nothing here depends on the
			// win32 directory-entry gap documented at `syncDirectory`.
			await appendDurable(
				handle,
				record,
				records * SEND_JOURNAL_RECORD_BYTES,
				journalPath,
			);
			// Only after the fsync returns. A failed append leaves every counter here
			// untouched, so the retry rewrites the same offset with the same sequence.
			records += 1;
			nextSeq += 1n;
			mark = highWater;
			boundPrefix = prefix;
		},

		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			await handle.close();
		},
	};
}


// ---------------------------------------------------------------------------
// the state anchor
// ---------------------------------------------------------------------------

interface StoredAnchorFile {
	v: 1;
	/** 16 random bytes, base64url. Minted once per install, never changed. */
	generation: string;
	/** Monotonic, one per mount. Decimal uint64 text. */
	epoch: string;
	send: {
		/** 4 raw bytes as base64url. Install-scoped (§3.4). */
		prefix: string;
		/**
		 * The first counter NOBODY may use without reserving again.
		 *
		 * NO LONGER AUTHORITATIVE, and the demotion is the point. (SEND-JOURNAL) is
		 * the durable record; this is a conservative FLOOR written AFTER every
		 * journal append. That write order is what makes the two comparable: the
		 * journal can legitimately lead this field (the anchor's rename was lost, or
		 * a crash landed between the two writes) but it can never legitimately trail
		 * it, so `highWater > journalMark` proves the journal lost records and the
		 * bridge refuses to start.
		 */
		highWater: string;
		/** The one lifecycle allowed to raise `highWater`. */
		owner: string;
		/**
		 * (SEND-JOURNAL) Set once, when a journal is known to hold this counter's
		 * mark, and never cleared. It is what distinguishes "this install predates
		 * the journal, seed one" from "the journal existed and is now gone, refuse" —
		 * two states that are otherwise identical on disk and could not be told apart
		 * without it. Absent on a pre-journal anchor; `true` afterwards.
		 *
		 * It is written in the same `mutate` as the mark, which runs AFTER the
		 * journal append, so `journal === true` being durable PROVES at least one
		 * append completed. That is why an empty or missing journal underneath it is
		 * a fault rather than a first run.
		 */
		journal?: true;
	} | null;
	devices: {
		/** Monotonic; bumps only when the AUTHORITY projection of the index changes. */
		seq: string;
		/** base64url sha256 over that projection. */
		digest: string;
	} | null;
}

export interface AnchorSendState {
	prefix: Uint8Array;
	highWater: bigint;
	owner: string;
}

export interface AnchorDevicesState {
	seq: bigint;
	digest: string;
}

export interface StateAnchor {
	/** Install identity. Stamped into every key file; a mismatch fails closed. */
	readonly generation: string;
	/** The epoch THIS mount owns. Already durable before the anchor is returned. */
	readonly epoch: bigint;
	/** The epoch the previous mount owned; `devices.json` may not exceed it. */
	readonly previousEpoch: bigint;
	/** true only when the anchor file did not exist and was just minted. */
	readonly minted: boolean;
	send(): AnchorSendState | null;
	/**
	 * Takes send-nonce ownership and records the high-water mark durably — in the
	 * (SEND-JOURNAL) append first, then in the anchor. Refuses to lower the mark.
	 * Returns the new owner token.
	 */
	claimSend(prefix: Uint8Array, highWater: bigint): Promise<string>;
	/**
	 * Raises the mark, journal first. Throws if `owner` is stale or `through` would
	 * lower it. Does not resolve until the raised mark is durable, which is what
	 * lets `reserve` treat its return as permission to issue.
	 */
	raiseSend(owner: string, through: bigint): Promise<void>;
	devices(): AnchorDevicesState | null;
	/** Records the index authority state. Refuses to lower `seq`. */
	commitDevices(seq: bigint, digest: string): Promise<void>;
	close(): Promise<void>;
}

/**
 * One anchor per path per process, enforced. A second `openStateAnchor` for a
 * live path is the in-process shape of the two-owners bug and is refused loudly
 * rather than allowed to interleave writes.
 *
 * Cross-process exclusion is host-service's daemon singleton (`src/daemon`), and
 * on top of that every `raiseSend` re-reads the file and re-checks the owner
 * token before writing, so a second process would be caught at its first
 * reservation rather than silently sharing a counter.
 */
const OPEN_ANCHORS = new Set<string>();

export async function openStateAnchor(rootDir: string): Promise<StateAnchor> {
	if (typeof rootDir !== "string" || rootDir.length === 0) {
		throw new Error(`${LOG_PREFIX} openStateAnchor requires a root directory`);
	}
	const anchorPath = join(rootDir, ANCHOR_FILENAME);
	const journalPath = join(rootDir, SEND_JOURNAL_FILENAME);
	const witnessPath = join(rootDir, SEND_WITNESS_FILENAME);
	const registryKey = resolvePath(anchorPath);
	if (OPEN_ANCHORS.has(registryKey)) {
		throw new Error(
			`${LOG_PREFIX} the state anchor at ${anchorPath} is already open in this process — two lifecycles cannot own the nonce high-water mark`,
		);
	}
	OPEN_ANCHORS.add(registryKey);

	// Declared out here so the failure path below can release the handle. A leaked
	// journal handle would survive a failed start and make the NEXT start's `r+`
	// open contend with this process for a file it no longer believes it owns.
	let journal: SendJournal | null = null;
	try {
		const existing = await readAnchorFile(anchorPath);
		const minted = existing === null;
		let previousEpoch = existing === null ? 0n : BigInt(existing.epoch);
		let epoch = previousEpoch + 1n;
		if (epoch > 0xff_ff_ff_ff_ff_ff_ffn) {
			throw new StateRollbackError(
				`the mount epoch reached ${epoch}, which is not a value this install can have legitimately produced`,
			);
		}

		let current: StoredAnchorFile =
			existing === null
				? {
						v: 1,
						generation: base64UrlEncode(randomBytes(16)),
						epoch: epoch.toString(10),
						send: readLegacySendNonceState(
							await readLegacySendNonceText(rootDir),
							rootDir,
						),
						devices: null,
					}
				: { ...existing, epoch: epoch.toString(10) };

		let closed = false;
		const serialise = createSerialiser();

		/**
		 * Read-modify-write against the FILE, not against memory.
		 *
		 * Re-reading costs one `readFile` per reservation (once every ~57 000
		 * nonces) and per authority change, and it is what makes the monotonic and
		 * ownership checks true statements about durable state rather than about
		 * this object's beliefs.
		 *
		 * The epoch is checked here too, not just `generation`. It is documented as
		 * "monotonic, one per mount", and before this check `claimSend` and
		 * `commitDevices` stamped the epoch this object was holding over whatever
		 * was on disk — so a duplicate spawn could push the file's epoch BACKWARDS,
		 * after which `devices.json` legitimately led the anchor and the next clean
		 * start refused with "the anchor was rolled back" and sent the maintainer to
		 * re-pair every device. Neither writer stamps an epoch any more (the
		 * `...onDisk` spread carries the durable one); this refuses the regression
		 * outright if a future one tries.
		 */
		const mutate = async (
			apply: (onDisk: StoredAnchorFile) => StoredAnchorFile,
		): Promise<void> => {
			if (closed) {
				throw new Error(`${LOG_PREFIX} the state anchor is closed`);
			}
			const onDisk = await readAnchorFile(anchorPath);
			if (onDisk === null) {
				throw new StateRollbackError(
					`the state anchor at ${anchorPath} disappeared while the bridge was running`,
				);
			}
			if (onDisk.generation !== current.generation) {
				throw new StateRollbackError(
					`the state anchor at ${anchorPath} was replaced by a different install generation while the bridge was running`,
				);
			}
			const next = apply(onDisk);
			if (BigInt(next.epoch) < BigInt(onDisk.epoch)) {
				throw new StateRollbackError(
					`refusing to lower the anchor's mount epoch from ${onDisk.epoch} to ${next.epoch} — the epoch is what proves devices.json and the anchor belong to the same timeline`,
				);
			}
			await writeAnchorFile(anchorPath, next);
			current = next;
		};

		// The epoch is durable BEFORE anything derived from it is used or handed
		// out, so a crash burns an epoch and never repeats one.
		//
		// It goes through `mutate` when a file already exists, rather than writing
		// the snapshot read at the top of this function. That snapshot was captured
		// across an `await`, so blind-writing it discarded anything another writer
		// had committed in between — including a RAISED `send.highWater`, silently,
		// which is precisely the property this module claims is impossible. Mutating
		// re-reads, re-derives the epoch from the durable one and preserves `send`
		// and `devices` exactly as they are on disk.
		if (existing === null) {
			await writeAnchorFile(anchorPath, current);
			// Two processes that both read ENOENT above would both mint, and the
			// later rename would silently discard the earlier generation — after
			// which each believes it owns a counter the other is also using. The
			// mint is the one write with no durable predecessor to compare against,
			// so it is confirmed by re-reading instead: exactly one of the two finds
			// its own generation on disk and continues, and the other refuses here.
			// A losing process that got past this line would still be stopped at its
			// first `mutate` by the generation check, so this only makes the refusal
			// immediate and legible rather than deferred to an unrelated write.
			const confirmed = await readAnchorFile(anchorPath);
			if (confirmed === null || confirmed.generation !== current.generation) {
				throw new StateRollbackError(
					`the state anchor at ${anchorPath} was minted by another process while this one was minting it — two lifecycles cannot share the send-nonce counter`,
				);
			}
		} else {
			await mutate((onDisk) => {
				previousEpoch = BigInt(onDisk.epoch);
				epoch = previousEpoch + 1n;
				if (epoch > 0xff_ff_ff_ff_ff_ff_ffn) {
					throw new StateRollbackError(
						`the mount epoch reached ${epoch}, which is not a value this install can have legitimately produced`,
					);
				}
				return { ...onDisk, epoch: epoch.toString(10) };
			});
		}
		// Only once the mark it carried is durable in the anchor. Retiring it
		// first would let a crash in between lose the high-water mark entirely and
		// restart the counter under the SAME prefix.
		await retireLegacySendNonceState(rootDir);

		// ------------------------------------------------------------------
		// (SEND-JOURNAL) reconcile the durable mark
		// ------------------------------------------------------------------
		//
		// Everything up to `openSendJournal` is READ-ONLY, so a start that refuses
		// never creates the file it is refusing over. It runs after the epoch write
		// so a crash mid-reconcile leaves a shape the next start handles.
		const replay = await replaySendJournal(journalPath);
		const journalled = replay?.highest ?? null;
		if (
			replay !== null &&
			(replay.tornTailBytes > 0 || replay.discardedTailRecord)
		) {
			// Evidence the previous mount died mid-append. Harmless — the discarded
			// record's fsync never returned, so no nonce was issued above it — but it
			// is the only place an unclean shutdown of this file is visible.
			console.error(
				`${LOG_PREFIX} ${journalPath} ends in an incomplete append (${replay.tornTailBytes} loose byte(s)${replay.discardedTailRecord ? " and one record that failed its digest" : ""}) — discarding it and resuming from record ${replay.records}. The previous run did not shut down cleanly.`,
			);
		}
		if (journalled !== null && journalled.generation !== current.generation) {
			throw new StateRollbackError(
				`${journalPath} records install generation ${journalled.generation} but the anchor is ${current.generation} — the anchor was deleted or replaced while the send-nonce journal survived, so nothing can prove the counter is current`,
			);
		}

		// (SEND-WITNESS) The retired second copy of the mark. Read ONCE, folded into
		// what the journal must be seeded to, then deleted at the end of this block.
		const witness = await readSendWitness(witnessPath);
		if (witness !== null && witness.generation !== current.generation) {
			throw new StateRollbackError(
				`${witnessPath} was written under install generation ${witness.generation} but the anchor is ${current.generation} — the anchor was deleted or replaced while the retired send-nonce witness survived, so nothing can prove the counter is current`,
			);
		}

		const anchorMark =
			current.send === null ? null : BigInt(current.send.highWater);
		const witnessMark = witness === null ? null : BigInt(witness.highWater);

		if (journalled !== null) {
			if (current.send !== null && current.send.prefix !== journalled.prefix) {
				throw new StateRollbackError(
					`${journalPath} records send-nonce prefix ${journalled.prefix} but the anchor holds ${current.send.prefix} — counter state from two installs cannot be recombined`,
				);
			}
			/**
			 * THE CHECK THAT CLOSES THE STATE THE OLD PAIR OF RENAMED FILES COULD NOT
			 * SEE, and it is worth being explicit about why it is sound.
			 *
			 * Every raise appends to the journal FIRST and writes the anchor's floor
			 * second. So the journal may legitimately LEAD the anchor — the anchor's
			 * rename was lost, or a crash landed between the two writes — but it can
			 * never legitimately TRAIL it. An anchor ahead of the journal therefore
			 * proves the journal lost records that a completed anchor write says were
			 * reserved, and the only mechanisms that can do that are media damage and
			 * an edit. In both cases the journal's TRUE maximum is unknown, so the
			 * anchor's own value is not a safe floor to resume from either: the real
			 * mark may have been higher than both. Refuse.
			 *
			 * This is what makes a rewind by tampering fail closed rather than pass as
			 * healthy, which is exactly what a pair of files rolled back TOGETHER to
			 * matching values used to do.
			 *
			 * WHAT IT COSTS, STATED RATHER THAN DISCOVERED LATER: installing a build
			 * that PREDATES the journal, letting it raise the anchor, and then coming
			 * back to this one lands here too, because the older build raises the anchor
			 * without appending. That is a refusal on downgrade-then-upgrade, and it is
			 * accepted deliberately — the bridge ships behind an experimental setting
			 * and has no installed base carrying a pre-journal counter, whereas the
			 * detection this check buys is the only thing standing between a truncated
			 * journal and a silently reused nonce. Re-pair per §3.4 rule 4 if it ever
			 * happens; do not soften the check to make the downgrade smooth.
			 */
			if (anchorMark !== null && anchorMark > journalled.highWater) {
				throw new StateRollbackError(
					`the anchor's send-nonce floor is ${anchorMark} but ${journalPath} only records ${journalled.highWater}; the journal is appended BEFORE the anchor on every raise, so it cannot legitimately trail it — records have been lost from the journal and the highest mark actually handed out is unknown`,
				);
			}
		} else if (current.send?.journal === true) {
			/**
			 * A journal was PROVEN to exist and is now gone or empty.
			 *
			 * `journal: true` is written in the same anchor write as the mark, which
			 * happens after the append, so its presence on disk proves at least one
			 * record was durable. The anchor's own floor cannot stand in for what is
			 * missing: if the anchor's most recent rename was also lost, its floor is
			 * an older mark and nonces above it were issued under the journal's
			 * authority. That is unprovable freshness, and §3.4 rule 4 has exactly one
			 * answer for it.
			 */
			throw new StateRollbackError(
				`the anchor records that a send-nonce journal exists but ${journalPath} ${replay === null ? "is missing" : "holds no valid record"} — the one record that proves which counters were handed out is gone, and the anchor's own floor cannot substitute for it`,
			);
		}

		// Past every refusal, so the handle is only taken when this mount is going
		// to run. Created here on a first install; the first record follows from
		// `claimSend`.
		journal = await openSendJournal(journalPath, current.generation, replay);

		/**
		 * SEED THE JOURNAL FROM WHATEVER THE OLDER RECORDS PROVE.
		 *
		 * This is the migration path and it runs at most once per install: an anchor
		 * that predates the journal carries the mark in `send.highWater`, and an
		 * install that ran the retired witness may carry a HIGHER one there (the
		 * witness was written first, so it leads the anchor after a lost rename).
		 * Both are folded in, and the journal is brought up to the maximum before
		 * anything can issue a nonce from it.
		 *
		 * IT IS ALSO THE REPAIR PATH, WHICH IS WHY IT IS NOT GUARDED BY A ONE-SHOT
		 * FLAG. A crash between the seeding append and the anchor write leaves the
		 * flag unset with the journal already seeded; re-running takes a MAX and
		 * appends nothing, so the whole block is idempotent and a partially migrated
		 * install converges rather than needing a special case.
		 */
		let seedTo: bigint | null = null;
		for (const candidate of [anchorMark, witnessMark]) {
			if (candidate === null) continue;
			if (seedTo === null || candidate > seedTo) seedTo = candidate;
		}
		const seedPrefix =
			journal.prefix() ?? current.send?.prefix ?? witness?.prefix ?? null;
		if (seedTo !== null && seedPrefix !== null) {
			const durable = journal.mark();
			if (durable === null || seedTo > durable) {
				console.error(
					`${LOG_PREFIX} seeding ${journalPath} at send-nonce high-water ${seedTo}, carried from ${
						witnessMark !== null && (anchorMark === null || witnessMark > anchorMark)
							? `the retired witness (the anchor says ${String(anchorMark)})`
							: "the anchor"
					}. This is expected exactly once per install, when it first runs a build that journals the mark.`,
				);
				await journal.append(seedPrefix, seedTo);
			}
		}

		/**
		 * BRING THE ANCHOR'S FLOOR UP TO THE JOURNAL, AND STAMP `journal: true`.
		 *
		 * `send()` is what `createSendNonceSource` resumes from, so the resolved mark
		 * has to be in the anchor's send state and not merely known here. Three shapes
		 * arrive at this point and all three are repaired the same way:
		 *
		 *  - the anchor trails the journal — its most recent rename was lost, or a
		 *    crash landed between the append and the anchor write. Logged loudly,
		 *    because a start that reports this EVERY time means anchor writes are not
		 *    reaching disk at all;
		 *  - the anchor has no send state while the journal has records — the same
		 *    loss, on the write that first created the send block. The journal carries
		 *    both the prefix and the mark, so nothing is unproven and there is nothing
		 *    to refuse: rebuilding the block from it is strictly safer than letting
		 *    `createSendNonceSource` see `null` and mint a fresh prefix;
		 *  - the marks already agree and only the flag is missing (the install just
		 *    migrated).
		 *
		 * The producer derives everything INSIDE the write from what is on disk. A
		 * blind write of the `current` snapshot read above is the exact shape of the
		 * bug this module was reviewed for.
		 */
		const resolved = journal.mark();
		const resolvedPrefix = journal.prefix();
		// `mutate` writes unconditionally, so the decision not to write has to be
		// made here. An anchor already carrying the resolved mark and the flag needs
		// nothing, and a pointless rewrite per mount is a pointless rename per mount.
		const needsLift =
			resolved !== null &&
			(current.send === null ||
				BigInt(current.send.highWater) < resolved ||
				current.send.journal !== true);
		if (resolved !== null && resolvedPrefix !== null && needsLift) {
			if (anchorMark === null) {
				console.error(
					`${LOG_PREFIX} the anchor carries no send-nonce state but ${journalPath} records high-water ${resolved} under prefix ${resolvedPrefix}. Rebuilding the anchor's send state from the journal. If this repeats every start, the anchor file is not reaching disk.`,
				);
			} else if (anchorMark < resolved) {
				console.error(
					`${LOG_PREFIX} send-nonce high-water mark restored from the journal: the anchor says ${anchorMark}, the journal records ${resolved}. Resuming from the journal. If this repeats every start, the anchor file is not reaching disk.`,
				);
			}
			await mutate((onDisk) => {
				if (
					onDisk.send !== null &&
					BigInt(onDisk.send.highWater) >= resolved &&
					onDisk.send.journal === true
				) {
					return onDisk;
				}
				if (onDisk.send !== null && onDisk.send.prefix !== resolvedPrefix) {
					throw new StateRollbackError(
						`the anchor's send-nonce prefix changed to ${onDisk.send.prefix} while the journal's mark was being lifted into it`,
					);
				}
				// UNREACHABLE, AND LOUD RATHER THAN SILENT IF IT EVER IS NOT. The
				// cross-check above already refused an anchor ahead of the journal, and
				// nothing writes the anchor between there and here. Preserving the higher
				// value would leave a floor the NEXT start refuses on — a self-bricking
				// anchor written by the repair path — and taking the lower one would drop
				// a mark the anchor proved. Neither is a safe thing to do quietly.
				if (onDisk.send !== null && BigInt(onDisk.send.highWater) > resolved) {
					throw new StateRollbackError(
						`the anchor's send-nonce floor moved to ${onDisk.send.highWater} while the journal's mark ${resolved} was being lifted into it`,
					);
				}
				return {
					...onDisk,
					send: {
						prefix: resolvedPrefix,
						highWater: resolved.toString(10),
						// Not a live owner — the mount's `claimSend` replaces it. A
						// non-empty placeholder keeps the shape valid for `readAnchorFile`.
						owner: onDisk.send?.owner ?? "journal-repair-unowned",
						journal: true,
					},
				};
			});
		}

		/**
		 * RETIRE THE WITNESS, LAST, AND ONLY ONCE THE JOURNAL COVERS IT.
		 *
		 * Same discipline as `retireLegacySendNonceState`: a file that once held the
		 * only durable copy of the mark is deleted only after a record that supersedes
		 * it is durable. A lost `unlink` is harmless — the file reappears, its mark is
		 * folded into the same MAX next start, and it is deleted again — which is the
		 * conservative direction, as every rename-shaped operation left in this module
		 * has to be.
		 */
		if (witness !== null && witnessMark !== null) {
			const durable = journal.mark();
			if (durable !== null && durable >= witnessMark) {
				await retireSendWitness(witnessPath, rootDir);
			}
		}

		/** Journal first, always. See `raiseSend` for why the order is the mechanism. */
		const journalRaise = async (
			prefix: string,
			highWater: bigint,
		): Promise<void> => {
			if (journal === null) {
				throw new Error(`${LOG_PREFIX} the send-nonce journal is not open`);
			}
			await journal.append(prefix, highWater);
		};

		return {
			generation: current.generation,
			epoch,
			previousEpoch,
			minted,

			send(): AnchorSendState | null {
				return current.send === null ? null : decodeSend(current.send);
			},

			claimSend(prefix, highWater) {
				return serialise(async () => {
					if (prefix.length !== NONCE_PREFIX_BYTES) {
						throw new Error(
							`${LOG_PREFIX} send-nonce prefix must be ${NONCE_PREFIX_BYTES} bytes, got ${prefix.length}`,
						);
					}
					const owner = base64UrlEncode(randomBytes(16));
					await journalRaise(base64UrlEncode(prefix), highWater);
					await mutate((onDisk) => {
						if (onDisk.send !== null) {
							const durable = decodeSend(onDisk.send);
							if (highWater < durable.highWater) {
								throw new StateRollbackError(
									`refusing to claim the send-nonce counter at ${highWater} when ${durable.highWater} is already durable — a lower mark re-issues nonces that were handed out`,
								);
							}
							if (base64UrlEncode(durable.prefix) !== base64UrlEncode(prefix)) {
								throw new StateRollbackError(
									"the send-nonce prefix on disk does not match the one being claimed",
								);
							}
						}
						return {
							...onDisk,
							send: {
								prefix: base64UrlEncode(prefix),
								highWater: highWater.toString(10),
								owner,
								journal: true,
							},
						};
					});
					return owner;
				});
			},

			raiseSend(owner, through) {
				return serialise(async () => {
					const held = current.send;
					if (held === null) {
						throw new StateRollbackError(
							"the send-nonce state vanished from the anchor while the bridge was running",
						);
					}
					/**
					 * (SEND-JOURNAL) THE APPEND COMES FIRST, ALWAYS, AND THAT ORDER IS THE
					 * MECHANISM RATHER THAN A PREFERENCE.
					 *
					 * The journal is what proves which counters were handed out, so it has
					 * to be durable before the anchor's floor claims they were — the
					 * reverse order would make an anchor ahead of the journal an ordinary
					 * shape, and it is precisely by being IMPOSSIBLE that it detects a
					 * journal that has been rewound (see the cross-check in
					 * `openStateAnchor`).
					 *
					 * Unlike the retired witness, ordering here needs nothing from the
					 * platform: `appendDurable` fsyncs the journal's own file, so the record
					 * is durable when it returns, whatever happens to the anchor's rename
					 * afterwards. There is no pairing to preserve and no invariant about
					 * what must follow a raise — a journal-only write is now HARMLESS,
					 * where under the witness it silently restored the rewind.
					 *
					 * A raise refused by `mutate` below has therefore already raised the
					 * journal. That is deliberate and safe in the only direction that
					 * matters: it burns counters this bridge will never issue, and a stale
					 * owner poisons its source and emits nothing at all.
					 */
					await journalRaise(held.prefix, through);
					await mutate((onDisk) => {
						if (onDisk.send === null) {
							throw new StateRollbackError(
								"the send-nonce state vanished from the anchor while the bridge was running",
							);
						}
						const durable = decodeSend(onDisk.send);
						if (durable.owner !== owner) {
							throw new StateRollbackError(
								"a newer lifecycle owns the send-nonce counter — this owner is stale and must not write",
							);
						}
						if (through < durable.highWater) {
							throw new StateRollbackError(
								`refusing to lower the send-nonce high-water mark from ${durable.highWater} to ${through}`,
							);
						}
						return {
							...onDisk,
							send: { ...onDisk.send, highWater: through.toString(10) },
						};
					});
				});
			},

			devices(): AnchorDevicesState | null {
				return current.devices === null
					? null
					: {
							seq: BigInt(current.devices.seq),
							digest: current.devices.digest,
						};
			},

			commitDevices(seq, digest) {
				return serialise(async () => {
					await mutate((onDisk) => {
						if (onDisk.devices !== null) {
							const durableSeq = BigInt(onDisk.devices.seq);
							if (seq < durableSeq) {
								throw new StateRollbackError(
									`refusing to lower the device-index sequence from ${durableSeq} to ${seq} — that is how a revoked device comes back`,
								);
							}
							if (seq === durableSeq && digest !== onDisk.devices.digest) {
								throw new StateRollbackError(
									`the device index changed without advancing its sequence (${seq})`,
								);
							}
						}
						return {
							...onDisk,
							devices: { seq: seq.toString(10), digest },
						};
					});
				});
			},

			async close(): Promise<void> {
				if (closed) return;
				closed = true;
				// Drain whatever is still enqueued before releasing the registry slot.
				// The serialiser owns its chain, so the way to wait for it is to queue
				// behind it: this no-op runs strictly after the last pending write has
				// settled, and cannot itself reject.
				await serialise(async () => undefined);
				// After the drain, so a `raiseSend` still in flight cannot lose its
				// handle mid-append. `closed` already refuses anything queued later.
				await journal?.close();
				OPEN_ANCHORS.delete(registryKey);
			},
		};
	} catch (error) {
		await journal?.close().catch(() => {});
		OPEN_ANCHORS.delete(registryKey);
		throw error;
	}
}

function decodeSend(stored: NonNullable<StoredAnchorFile["send"]>): {
	prefix: Uint8Array;
	highWater: bigint;
	owner: string;
} {
	const prefix = base64UrlDecode(stored.prefix);
	if (prefix.length !== NONCE_PREFIX_BYTES) {
		throw new StateRollbackError(
			`the anchor's send-nonce prefix is ${prefix.length} bytes, expected ${NONCE_PREFIX_BYTES}`,
		);
	}
	const highWater = BigInt(stored.highWater);
	if (highWater < 0n) {
		throw new StateRollbackError(
			"the anchor's send-nonce high-water mark is negative",
		);
	}
	return { prefix, highWater, owner: stored.owner };
}

/**
 * Reads the anchor.
 *
 * ABSENT is `null` and is the only tolerated failure — it is the first run.
 * UNPARSABLE or MALFORMED THROWS. An earlier revision responded to corrupt
 * nonce state by minting a fresh random 32-bit prefix, which is failing OPEN on
 * the one input that must never be permissive: a random prefix can collide with
 * one already in use, and a collision plus a counter restarting at 1 is
 * guaranteed nonce reuse.
 */
async function readAnchorFile(
	anchorPath: string,
): Promise<StoredAnchorFile | null> {
	let text: string;
	try {
		text = await readFile(anchorPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new StateRollbackError(
			`${anchorPath} is not valid JSON (${(error as Error).message})`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new StateRollbackError(`${anchorPath} is not a JSON object`);
	}
	const record = parsed as Partial<StoredAnchorFile>;
	if (record.v !== 1) {
		throw new StateRollbackError(
			`${anchorPath} has version ${String(record.v)}, expected 1`,
		);
	}
	if (!isCanonicalWireId(record.generation)) {
		throw new StateRollbackError(`${anchorPath} has no usable generation`);
	}
	if (typeof record.epoch !== "string" || !/^[0-9]+$/.test(record.epoch)) {
		throw new StateRollbackError(`${anchorPath} has no usable epoch`);
	}
	const send = record.send;
	if (send !== null && send !== undefined) {
		if (
			typeof send.prefix !== "string" ||
			typeof send.highWater !== "string" ||
			!/^[0-9]+$/.test(send.highWater) ||
			typeof send.owner !== "string" ||
			send.owner.length === 0
		) {
			throw new StateRollbackError(`${anchorPath} has malformed send state`);
		}
		// Validated as strictly as the rest, because it is the field that decides
		// whether a missing journal is a first run or a fault. Anything other than
		// absent-or-`true` is a file this build did not write, and reading a truthy
		// `"false"` as "the journal exists" would turn that fault into a silent
		// reseed at whatever the anchor happens to say.
		if (send.journal !== undefined && send.journal !== true) {
			throw new StateRollbackError(
				`${anchorPath} has a malformed send-journal marker (${JSON.stringify(send.journal)}); it is absent or true and nothing else`,
			);
		}
	}
	const devices = record.devices;
	if (devices !== null && devices !== undefined) {
		if (
			typeof devices.seq !== "string" ||
			!/^[0-9]+$/.test(devices.seq) ||
			typeof devices.digest !== "string" ||
			devices.digest.length === 0
		) {
			throw new StateRollbackError(`${anchorPath} has malformed device state`);
		}
	}
	return {
		v: 1,
		generation: record.generation,
		epoch: record.epoch,
		send: send ?? null,
		devices: devices ?? null,
	};
}

async function writeAnchorFile(
	anchorPath: string,
	file: StoredAnchorFile,
): Promise<void> {
	const bytes = Buffer.from(`${JSON.stringify(file, null, "\t")}\n`, "utf8");
	await writeFileDurable(anchorPath, bytes, KEY_FILE_MODE);
}

/**
 * (SEND-WITNESS) RETIRED. The pre-journal second copy of the mark — read once at
 * start, folded into what (SEND-JOURNAL) is seeded to, then deleted. Never written.
 *
 * WHAT IT WAS, AND WHY IT IS NOT KEPT. `writeFileDurable` gives content durability
 * and rename ORDER, but `syncDirectory` is a no-op on win32 — libuv maps
 * `fs.rename` to `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)` with no
 * `MOVEFILE_WRITE_THROUGH`, so the most recent rename can sit in the NTFS log for
 * seconds. A hard reset in that window reverts `state-anchor.json` to its PREVIOUS
 * version, and nothing in the anchor's own checks can see it: `generation` is per
 * install, `epoch` is per mount, and `(seq, digest)` only move when the device
 * authority moves. `send.highWater` lived in exactly one file, next to the fields
 * meant to police it, and reverted with them. This file was a second copy of the
 * mark, renamed BEFORE the anchor on every raise, with the higher of the two
 * winning at start.
 *
 * IT WORKED ONLY IF AN INFERENCE HELD. Two renames issued microseconds apart can
 * sit in the same unflushed log window, and writing one first does not separate
 * them; the thing claimed to separate them was the anchor's own content fsync
 * forcing NTFS's metadata log, and thereby publishing the witness's earlier rename.
 * `writeFileDurable` now says plainly that this is an inference from how the
 * metadata log is understood to work and NOT a documented guarantee —
 * `FlushFileBuffers` is specified to flush the SPECIFIED FILE, and the documented
 * durable-rename primitive is one Node never issues. If the inference is wrong,
 * both files roll back TOGETHER to matching values: consistent, silent, and
 * rewound. That is the single state a pair of renamed files cannot detect, and for
 * a counter whose rewind repeats an AES-GCM nonce it was not an acceptable one to
 * carry.
 *
 * THE REPLACEMENT NEEDS NO INFERENCE, WHICH IS ALSO WHY THIS IS NOT KEPT ALONGSIDE
 * IT. `send-journal.log` appends and fsyncs the same file, and an append has no
 * directory entry to lose. Retaining a mechanism whose guarantee is contingent on
 * the very assumption being removed would read as defence-in-depth while sharing
 * the failure mode of the thing it defends; the honest arrangement is one
 * unconditional record plus the anchor's floor, combined with a MAX so that
 * neither can lower the other.
 *
 * ABSENT is `null` — a fresh install, or one that has already retired it.
 * UNPARSABLE or MALFORMED still THROWS. It is being deleted, not ignored: while the
 * file exists it may hold the highest mark this install ever made durable, and a
 * copy that cannot be read cannot be proven not to. Guessing is the failure the
 * whole module exists to prevent.
 */
interface StoredSendWitness {
	v: 1;
	/** Must equal the anchor's install generation. */
	generation: string;
	/** 4 raw bytes as base64url. Must equal the anchor's send prefix. */
	prefix: string;
	/** The first counter NOBODY may use without reserving again. */
	highWater: string;
}

async function readSendWitness(
	witnessPath: string,
): Promise<StoredSendWitness | null> {
	let text: string;
	try {
		text = await readFile(witnessPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new StateRollbackError(
			`${witnessPath} is not valid JSON (${(error as Error).message}), so the send-nonce mark it witnesses is unknown`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new StateRollbackError(`${witnessPath} is not a JSON object`);
	}
	const record = parsed as Partial<StoredSendWitness>;
	if (record.v !== 1) {
		throw new StateRollbackError(
			`${witnessPath} has version ${String(record.v)}, expected 1`,
		);
	}
	if (!isCanonicalWireId(record.generation)) {
		throw new StateRollbackError(`${witnessPath} has no usable generation`);
	}
	if (typeof record.prefix !== "string" || record.prefix.length === 0) {
		throw new StateRollbackError(`${witnessPath} has no usable send prefix`);
	}
	if (
		typeof record.highWater !== "string" ||
		!/^[0-9]+$/.test(record.highWater)
	) {
		throw new StateRollbackError(
			`${witnessPath} has no usable high-water mark`,
		);
	}
	return {
		v: 1,
		generation: record.generation,
		prefix: record.prefix,
		highWater: record.highWater,
	};
}

/**
 * (SEND-WITNESS) Deletes the retired witness, once and for all.
 *
 * The caller has already proven the journal records a mark at or above the one
 * this file carries, so nothing durable is lost. The directory fsync is the same
 * best-effort call `retireLegacySendNonceState` makes: on win32 it is a no-op and
 * the `unlink` can be lost, which brings the file back with a mark the next start
 * folds into the same MAX and then deletes again. Every rename-shaped operation
 * left in this module has to fail in that direction, and this one does.
 */
async function retireSendWitness(
	witnessPath: string,
	rootDir: string,
): Promise<void> {
	try {
		await unlink(witnessPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	await syncDirectory(rootDir);
}

/**
 * Carries a pre-anchor `send-nonce.json` high-water mark into a freshly minted
 * anchor.
 *
 * Skipping it would restart the counter under the SAME install prefix, which is
 * the nonce-reuse this whole module exists to prevent. A file that exists but
 * cannot be read is therefore fatal, not ignorable. Retiring the file is a
 * SEPARATE step (`retireLegacySendNonceState`) that runs only after the anchor
 * carrying the mark is durable.
 */
async function readLegacySendNonceText(
	rootDir: string,
): Promise<string | null> {
	try {
		return await readFile(join(rootDir, LEGACY_SEND_NONCE_FILENAME), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function readLegacySendNonceState(
	text: string | null,
	rootDir: string,
): StoredAnchorFile["send"] {
	if (text === null) return null;
	const legacyPath = join(rootDir, LEGACY_SEND_NONCE_FILENAME);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new StateRollbackError(
			`the pre-anchor ${legacyPath} exists but is unparsable (${(error as Error).message}), so the counter it already handed out is unknown`,
		);
	}
	const record = parsed as Partial<{
		v: number;
		prefix: string;
		reservedThrough: string;
	}>;
	if (
		record.v !== 1 ||
		typeof record.prefix !== "string" ||
		typeof record.reservedThrough !== "string" ||
		!/^[0-9]+$/.test(record.reservedThrough)
	) {
		throw new StateRollbackError(
			`the pre-anchor ${legacyPath} exists but is malformed, so the counter it already handed out is unknown`,
		);
	}
	const prefix = base64UrlDecode(record.prefix);
	if (prefix.length !== NONCE_PREFIX_BYTES) {
		throw new StateRollbackError(
			`the pre-anchor ${legacyPath} holds a ${prefix.length}-byte prefix, expected ${NONCE_PREFIX_BYTES}`,
		);
	}
	return {
		prefix: record.prefix,
		highWater: record.reservedThrough,
		// Not a live owner — the first `claimSend` replaces it. A non-empty
		// placeholder keeps the file shape valid for `readAnchorFile`.
		owner: "legacy-migration-unowned",
	};
}

async function retireLegacySendNonceState(rootDir: string): Promise<void> {
	try {
		await unlink(join(rootDir, LEGACY_SEND_NONCE_FILENAME));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	await syncDirectory(rootDir);
}

// ---------------------------------------------------------------------------
// §3.1 — K_dev custody
// ---------------------------------------------------------------------------

export interface KeyStore {
	/** Persists a freshly derived K_dev for a newly paired device. */
	put(deviceId: DeviceId, deviceKey: Uint8Array): Promise<string>;
	/** Loads K_dev by the record's `keyRef`. Returns null for an unknown device. */
	load(keyRef: string): Promise<Uint8Array | null>;
	/**
	 * Writes the revocation tombstone INTO the key file (§5.1 keeps the key, so
	 * the device can still open its own sealed 403). Idempotent.
	 */
	markRevoked(
		keyRef: string,
		atMs: number,
		reason: RevokeReason,
	): Promise<void>;
	/**
	 * The tombstone, or null when the key file says the device is live. `null`
	 * for a missing key file too — a device with no key material cannot be
	 * authorised by anything, so there is nothing to re-apply.
	 */
	revocationOf(
		keyRef: string,
	): Promise<{ revokedAtMs: number; revokeReason: RevokeReason } | null>;
	/**
	 * Every key file the devices directory ACTUALLY holds, read from the directory
	 * itself rather than from any record of what should be there.
	 *
	 * THIS EXISTS SO AN OBLIGATION CAN BE RE-DERIVED INSTEAD OF WITNESSED. A key
	 * file whose `keyRef` appears in no device record is an orphan: nothing can
	 * authorise it and nothing will ever come back for it. `device-store` proves
	 * that by set difference against the index it has just loaded — which needs no
	 * second file, no write ordering and no crash-consistency assumption. That
	 * matters here specifically: `writeFileDurable` in `crypto.ts` states outright
	 * that it must not acquire a THIRD dependent on its rename ordering, so
	 * "journal the obligation harder" was not available and did not need to be.
	 *
	 * NOTHING IS READ OR PARSED. An orphan must be destroyable even when its
	 * contents are corrupt, its `anchorGeneration` belongs to a previous install,
	 * or it holds a truncated key — every one of which makes `readKeyFile` throw
	 * while leaving `K_dev` bytes sitting on the disk. Names only.
	 *
	 * `<keyRef>.key.json.tmp`, the in-flight name `writeFileDurable` renames from,
	 * does not carry the suffix this filters on, so a crash mid-write can never
	 * present a half-written key file here as though it were a real one.
	 *
	 * A MISSING DEVICES DIRECTORY THROWS. `ensureCompanionDirs` creates it before
	 * the bridge starts, so its absence is a genuine fault; answering "no key
	 * files" would silently turn the sweep that depends on this into a no-op, and
	 * a hygiene mechanism that quietly stops running is the failure mode the
	 * caller exists to close.
	 */
	list(): Promise<KeyFileInventory>;
	/** Wipes a revoked device's key material. */
	destroy(keyRef: string): Promise<void>;
}

/** What `KeyStore.list()` found on disk. */
export interface KeyFileInventory {
	/** The stem of every `<keyRef>.key.json` file, as a canonical keyRef. */
	keyRefs: string[];
	/**
	 * Names carrying the key-file suffix whose stem is NOT a canonical keyRef,
	 * verbatim. `put()` only ever mints a canonical 22-character base64url ref, so
	 * one of these cannot have come from this store. They are REPORTED AND NEVER
	 * ACTED ON: `pathFor` would refuse to turn one into a path anyway, and a name
	 * that cannot be parsed cannot be proven unreferenced either — the caller must
	 * not delete what it cannot reason about.
	 */
	unrecognised: string[];
}

interface StoredKeyFile {
	v: 2;
	keyRef: string;
	deviceId: DeviceId;
	/**
	 * The install generation this key was minted under. Binds key material to the
	 * anchor: a key file and a counter state from different installs can never be
	 * recombined into a "fresh-looking" pair.
	 */
	anchorGeneration: string;
	/** K_dev, 32 raw bytes as base64url. NEVER logged, never returned on the wire. */
	k: string;
	createdAtMs: number;
	/**
	 * (REVOKE-TOMBSTONE) Revocation recorded next to the key, not only in the
	 * index. Restoring an older `devices.json` therefore cannot re-authorise a
	 * revoked device: `device-store` re-applies whatever this says at load.
	 */
	revokedAtMs: number | null;
	revokeReason: RevokeReason | null;
}

export function createKeyStore(
	devicesDir: string,
	anchor: StateAnchor,
): KeyStore {
	if (typeof devicesDir !== "string" || devicesDir.length === 0) {
		throw new Error(
			`${LOG_PREFIX} createKeyStore requires a devices directory`,
		);
	}
	if (!anchor || typeof anchor.generation !== "string") {
		throw new Error(`${LOG_PREFIX} createKeyStore requires the state anchor`);
	}

	const pathFor = (keyRef: string): string => {
		if (!isCanonicalWireId(keyRef)) {
			// Validated at the boundary: a keyRef reaches here from a persisted
			// device record, and a malformed one must never be turned into a path.
			throw new Error(
				`${LOG_PREFIX} malformed keyRef ${JSON.stringify(keyRef)} — expected a canonical 22-character base64url id`,
			);
		}
		return join(devicesDir, `${keyRef}${KEY_FILE_SUFFIX}`);
	};

	const readKeyFile = async (keyRef: string): Promise<StoredKeyFile | null> => {
		let text: string;
		try {
			text = await readFile(pathFor(keyRef), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		const parsed: unknown = JSON.parse(text);
		if (parsed === null || typeof parsed !== "object") {
			throw new Error(
				`${LOG_PREFIX} key file for ${keyRef} is not a JSON object`,
			);
		}
		const record = parsed as Partial<StoredKeyFile>;
		if (record.v !== 2 || typeof record.k !== "string") {
			throw new Error(
				`${LOG_PREFIX} key file for ${keyRef} is malformed (v=${String(record.v)})`,
			);
		}
		if (record.keyRef !== keyRef) {
			// The file was renamed or swapped. Fail loud: silently trusting it
			// would let a mis-filed key decrypt for the wrong device record.
			throw new Error(
				`${LOG_PREFIX} key file for ${keyRef} records a different keyRef`,
			);
		}
		if (record.anchorGeneration !== anchor.generation) {
			throw new StateRollbackError(
				`key file for ${keyRef} was minted under install generation ${String(record.anchorGeneration)} but the state anchor is ${anchor.generation} — key material and counter state are from different installs`,
			);
		}
		if (typeof record.deviceId !== "string") {
			throw new Error(`${LOG_PREFIX} key file for ${keyRef} has no deviceId`);
		}
		const revokedAtMs = record.revokedAtMs ?? null;
		const revokeReason = record.revokeReason ?? null;
		if ((revokedAtMs === null) !== (revokeReason === null)) {
			throw new Error(
				`${LOG_PREFIX} key file for ${keyRef} has revokedAtMs and revokeReason out of step`,
			);
		}
		if (revokedAtMs !== null && typeof revokedAtMs !== "number") {
			throw new Error(
				`${LOG_PREFIX} key file for ${keyRef} has a non-numeric revokedAtMs`,
			);
		}
		if (revokeReason !== null && typeof revokeReason !== "string") {
			throw new Error(
				`${LOG_PREFIX} key file for ${keyRef} has a non-string revokeReason`,
			);
		}
		return {
			v: 2,
			keyRef,
			deviceId: record.deviceId as DeviceId,
			anchorGeneration: record.anchorGeneration,
			k: record.k,
			createdAtMs:
				typeof record.createdAtMs === "number" ? record.createdAtMs : 0,
			revokedAtMs,
			revokeReason,
		};
	};

	const writeKeyFile = async (file: StoredKeyFile): Promise<void> => {
		const bytes = Buffer.from(JSON.stringify(file), "utf8");
		try {
			await writeFileDurable(pathFor(file.keyRef), bytes, KEY_FILE_MODE);
		} finally {
			// The serialised K_dev leaves the heap as soon as it has been written,
			// win or lose.
			bytes.fill(0);
		}
	};

	return {
		async put(deviceId, deviceKey) {
			if (deviceKey.length !== KEY_BYTES) {
				throw new Error(
					`${LOG_PREFIX} K_dev must be ${KEY_BYTES} bytes, got ${deviceKey.length}`,
				);
			}
			// Random, so a repeated deviceId can never address an existing key file.
			const keyRef = base64UrlEncode(randomBytes(16));
			const target = pathFor(keyRef);
			// `wx` first, purely to prove the random keyRef is unused; the durable
			// write then replaces it. Without the exclusive probe a (astronomically
			// unlikely) collision would silently overwrite a live device's key.
			const probe = await open(target, "wx", KEY_FILE_MODE);
			await probe.close();
			await writeKeyFile({
				v: 2,
				keyRef,
				deviceId,
				anchorGeneration: anchor.generation,
				k: base64UrlEncode(deviceKey),
				createdAtMs: Date.now(),
				revokedAtMs: null,
				revokeReason: null,
			});
			return keyRef;
		},

		async load(keyRef) {
			const record = await readKeyFile(keyRef);
			if (record === null) return null;
			const key = base64UrlDecode(record.k);
			if (key.length !== KEY_BYTES) {
				zero(key);
				throw new Error(
					`${LOG_PREFIX} key file for ${keyRef} holds ${key.length} bytes, expected ${KEY_BYTES}`,
				);
			}
			return key;
		},

		async markRevoked(keyRef, atMs, reason) {
			const record = await readKeyFile(keyRef);
			if (record === null) {
				// No key material to invalidate. The index record is still revoked by
				// the caller; there is simply nothing here to stamp.
				return;
			}
			if (record.revokedAtMs !== null) {
				// Idempotent: the first revocation time is the truthful one.
				return;
			}
			await writeKeyFile({
				...record,
				revokedAtMs: atMs,
				revokeReason: reason,
			});
		},

		async revocationOf(keyRef) {
			const record = await readKeyFile(keyRef);
			if (record === null) return null;
			if (record.revokedAtMs === null || record.revokeReason === null) {
				return null;
			}
			return {
				revokedAtMs: record.revokedAtMs,
				revokeReason: record.revokeReason,
			};
		},

		async list() {
			// `withFileTypes` so a DIRECTORY named like a key file can never be
			// reported as one — the caller's next move is to destroy what this
			// returns, and `destroy` opening a directory `r+` would fail in a way
			// that reads as a transient rather than as the anomaly it is.
			const entries = await readdir(devicesDir, { withFileTypes: true });
			const keyRefs: string[] = [];
			const unrecognised: string[] = [];
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(KEY_FILE_SUFFIX)) continue;
				const keyRef = entry.name.slice(
					0,
					entry.name.length - KEY_FILE_SUFFIX.length,
				);
				if (isCanonicalWireId(keyRef)) {
					keyRefs.push(keyRef);
				} else {
					unrecognised.push(entry.name);
				}
			}
			return { keyRefs, unrecognised };
		},

		async destroy(keyRef) {
			const target = pathFor(keyRef);
			// Overwrite before unlink. HONEST LIMIT: on a copy-on-write or
			// log-structured filesystem this does not reach the original blocks; it
			// is a reduction of the window, not an erasure guarantee.
			try {
				const handle = await open(target, "r+");
				try {
					const { size } = await handle.stat();
					if (size > 0) {
						const scrub = Buffer.alloc(size, 0);
						await handle.write(scrub, 0, scrub.length, 0);
						await handle.sync();
					}
				} finally {
					await handle.close();
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return;
			}
			await unlink(target).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
			await syncDirectory(devicesDir);
		},
	};
}

// ---------------------------------------------------------------------------
// §3.1 — steady-state key schedule
// ---------------------------------------------------------------------------

/**
 * Rejects a K_dev that is the wrong length OR all zero.
 *
 * The all-zero test is not decoration. Once `zero()` / `zeroDirectionalKeys`
 * are in use on the request path, an already-wiped buffer is a REAL input this
 * function can receive, and 32 zero bytes are a perfectly valid HKDF PRK: the
 * derivation would succeed and hand back keys that decrypt nothing, presenting
 * as an unexplained storm of `unknown_device` tag failures with no diagnostic
 * pointing anywhere near the wipe. A genuine K_dev is HKDF output, so all-zero
 * is unreachable at 2^-256 and can only mean "this buffer was consumed".
 *
 * Mirrors the all-zero rejection `x25519` already performs in `crypto.ts`, for
 * the same reason: silently agreeing on a key that is not secret is worse than
 * refusing.
 */
function assertDeviceKey(deviceKey: Uint8Array): void {
	if (deviceKey.length !== KEY_BYTES) {
		throw new Error(
			`${LOG_PREFIX} K_dev must be ${KEY_BYTES} bytes, got ${deviceKey.length}`,
		);
	}
	if (isAllZero(deviceKey)) {
		throw new Error(
			`${LOG_PREFIX} K_dev is all zero — the buffer has already been wiped, or the key file was truncated. Load it again; deriving from a wiped buffer would produce keys that silently fail every GCM tag.`,
		);
	}
}

/** §3.1 — K_c2s / K_s2c from K_dev. Cached per device; never persisted separately. */
export function deriveDirectionalKeys(deviceKey: Uint8Array): DirectionalKeys {
	assertDeviceKey(deviceKey);
	return {
		c2s: hkdfExpandLabel(deviceKey, HKDF_LABEL_SEAL_C2S, KEY_BYTES),
		s2c: hkdfExpandLabel(deviceKey, HKDF_LABEL_SEAL_S2C, KEY_BYTES),
	};
}

/**
 * Best-effort wipe of a derived directional pair once a request is done with it.
 *
 * Exists so the sealed pipeline has ONE call to make rather than two `zero()`s
 * it can half-forget; the same honest limit as `zero` applies.
 */
export function zeroDirectionalKeys(keys: DirectionalKeys): void {
	zero(keys.c2s);
	zero(keys.s2c);
}

/**
 * §3.1 — K_evt for one WebSocket stream, bound to the ticket id.
 *
 * Takes the ticket id's RAW 16 BYTES, not its base64url text. The client derives
 * the same key from the same 16 bytes; passing the 22-char string here would
 * produce a 37-byte `info` against the client's 31-byte one and every frame
 * would fail its GCM tag while the sealed HTTP path kept working — a permanent
 * reconnect ladder that looks like a transport bug.
 */
export function deriveEventKey(
	deviceKey: Uint8Array,
	ticketIdBytes: Uint8Array,
): Uint8Array {
	assertDeviceKey(deviceKey);
	if (ticketIdBytes.length !== WIRE_ID_BYTES) {
		throw new Error(
			`${LOG_PREFIX} ticketId must be ${WIRE_ID_BYTES} raw bytes, got ${ticketIdBytes.length}`,
		);
	}
	return hkdfExpandInfo(
		deviceKey,
		hkdfInfoWithSuffix(HKDF_LABEL_SEAL_EVT, ticketIdBytes),
		KEY_BYTES,
	);
}

// ---------------------------------------------------------------------------
// §3.4 — the bridge's own send nonces
// ---------------------------------------------------------------------------

/**
 * The bridge's own send-side nonce state for K_s2c / K_evt, with an independent
 * prefix and counter. Write-ahead persisted: increment and fsync BEFORE use, so
 * a crash burns counters and never repeats one.
 */
export interface SendNonceSource {
	next(): Uint8Array;
	/** Flushes the reservation state and stops the source. */
	close(): Promise<void>;
}

/**
 * The single send-nonce source for one mount.
 *
 * OWNERSHIP IS THE POINT. The source takes an owner token from the anchor at
 * construction and every later write presents it. If a newer lifecycle has
 * claimed the counter, this source's next write throws and the source POISONS
 * itself — a stale owner must not be able to write at all, and must not keep
 * emitting either. The high-water mark can only ever move up: `claimSend` and
 * `raiseSend` both re-read the durable value and refuse anything lower, so the
 * "older source closes last and rewinds the mark" path is closed by the anchor
 * rather than by call ordering.
 */
export async function createSendNonceSource(
	anchor: StateAnchor,
): Promise<SendNonceSource> {
	if (!anchor || typeof anchor.claimSend !== "function") {
		throw new Error(
			`${LOG_PREFIX} createSendNonceSource requires the state anchor`,
		);
	}

	const durable = anchor.send();
	// A fresh random prefix is minted ONLY when there is provably no prior send
	// state (a brand-new install). Corrupt state does not reach here: the anchor
	// throws rather than inventing a prefix.
	const prefix =
		durable === null ? randomBytes(NONCE_PREFIX_BYTES) : durable.prefix;
	// Everything up to the persisted high-water mark may already have been handed
	// out before the crash. Resume AT it, never below it.
	let counter =
		durable === null || durable.highWater < NONCE_FIRST_COUNTER
			? NONCE_FIRST_COUNTER
			: durable.highWater;

	let reservedThrough = counter;
	let closed = false;
	/** Set when this source has provably lost ownership. Never cleared. */
	let poisoned: string | null = null;
	let refilling: Promise<void> | null = null;

	// The first block is reserved, owned and durable BEFORE the source is handed
	// out, so the very first nonce this process emits is already covered.
	const owner = await anchor.claimSend(
		prefix,
		counter + NONCE_RESERVATION_BLOCK,
	);
	reservedThrough = counter + NONCE_RESERVATION_BLOCK;

	const reserve = async (): Promise<void> => {
		const target = counter + NONCE_RESERVATION_BLOCK;
		try {
			await anchor.raiseSend(owner, target);
		} catch (error) {
			if (error instanceof StateRollbackError) {
				poisoned = error.message;
				// Said ONCE, at the moment it becomes true, and in terms of the
				// symptom the operator will actually see. Poisoning is permanent by
				// design, and without this line the only evidence is `503
				// bridge_unavailable` on every sealed response and dropped event
				// sockets, from a process whose last log line says `listening`.
				console.error(
					`${LOG_PREFIX} SEND-NONCE SOURCE POISONED — this bridge can no longer seal any response or event frame. Every sealed request will now answer 503 bridge_unavailable and every event socket will drop, for as long as this process lives. It does not recover on its own: restart host-service. Cause: ${error.message}`,
				);
			}
			throw error;
		}
		if (target > reservedThrough) reservedThrough = target;
	};

	const scheduleRefill = (): void => {
		if (closed || poisoned !== null || refilling !== null) return;
		refilling = reserve()
			.catch((error: unknown) => {
				// Not swallowed: the next `next()` past the reservation throws, and
				// this is the line that says why.
				console.error(
					`${LOG_PREFIX} send-nonce reservation refill failed — the bridge will refuse to seal once the current block is exhausted:`,
					error,
				);
			})
			.finally(() => {
				refilling = null;
			});
	};

	return {
		next(): Uint8Array {
			if (closed) {
				throw new Error(`${LOG_PREFIX} send-nonce source is closed`);
			}
			if (poisoned !== null) {
				throw new Error(
					`${LOG_PREFIX} send-nonce source lost ownership of the counter and refuses to emit: ${poisoned}`,
				);
			}
			if (counter >= reservedThrough) {
				// Refusing is the only safe answer: emitting an unreserved counter
				// would let a crash repeat it, and a repeated (key, nonce) pair
				// destroys AES-GCM outright.
				scheduleRefill();
				throw new Error(
					`${LOG_PREFIX} send-nonce reservation exhausted at ${counter} — refusing to emit an unreserved nonce`,
				);
			}
			const value = counter;
			counter += 1n;
			if (reservedThrough - counter <= NONCE_REFILL_THRESHOLD) {
				scheduleRefill();
			}
			const nonce = new Uint8Array(NONCE_PREFIX_BYTES + NONCE_COUNTER_BYTES);
			nonce.set(prefix, 0);
			Buffer.from(
				nonce.buffer,
				nonce.byteOffset,
				nonce.length,
			).writeBigUInt64BE(value, NONCE_PREFIX_BYTES);
			return nonce;
		},

		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			if (refilling !== null) await refilling;
			try {
				if (poisoned === null) {
					// NEVER below what was already reserved. Burning the unspent tail of
					// the block is free; rewinding into it is the bug this guards.
					await anchor.raiseSend(
						owner,
						counter > reservedThrough ? counter : reservedThrough,
					);
				}
			} finally {
				zero(prefix);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// §3.5 — the replay cache
// ---------------------------------------------------------------------------
//
// It lives ENTIRELY in `crypto.ts` (`ReplayCache` / `createReplayCache`). This
// module used to carry a thin adapter over it whose only job was to hide the
// clock argument; callers pass their own request-instant now, so the adapter is
// gone and there is exactly one admit/compact/retention implementation.
