/**
 * (ANSWER-LEDGER) §11.4/§11.5 — the durable answer ledger and its fence.
 *
 * This replaces `answer-attempts.json` and its rise-only witness, and the reason
 * is not that the file was insufficiently durable. It was durable. It could not
 * DECIDE.
 *
 * ---------------------------------------------------------------------------
 * THE RACE A FILE CANNOT CLOSE
 * ---------------------------------------------------------------------------
 * `handleAnswer` looked up the attempt record, then spent ~195 lines and several
 * awaits evaluating six guards and taking the terminal lock, and only then
 * durably wrote `in_flight`. A status read arriving in that window saw no record,
 * satisfied the coverage proof, and told the phone "the desktop never saw this
 * request — it was not sent". The original request then resumed and typed the
 * answer.
 *
 * Read that ordering again, because it is the whole design rationale: the status
 * read was not WRONG about the past. There genuinely was no record. It was wrong
 * about the FUTURE — it asserted that nothing would be typed, and nothing had
 * given it the right to. §11.4 records a second answer against a picker as
 * unrecoverable, so that assertion sends the user to corrupt their own agent
 * session.
 *
 * No amount of durable-state attestation fixes a claim made without a fence. The
 * witness proved the file on disk was the newest version that was ever durable —
 * a true and useful statement, and completely beside the point. What is needed is
 * for the two paths to RACE, atomically, for the right to decide, and for the
 * loser to be permanently bound by the result:
 *
 *   existing row          | /v1/answer                 | /v1/answer/status
 *   ----------------------|----------------------------|-------------------------
 *   absent                | CAS to `in_flight`, type   | CAS to tombstone, report
 *                         |                            | "never received"
 *   `in_flight`/outcome   | idempotent replay          | report that status
 *   `closed_not_received` | REFUSE TO TYPE, forever    | report "never received"
 *
 * Whichever side wins has persisted its claim BEFORE the other can act on the
 * opposite one. That requires an atomic compare-and-set, which requires a real
 * transaction, which a read-modify-rewrite of a JSON file structurally is not —
 * two processes, or one process and its own overtaken request, cannot be
 * serialised by rewriting a file.
 *
 * ---------------------------------------------------------------------------
 * WHY SQLITE, AND WHAT IT BUYS BEYOND THE TRANSACTION
 * ---------------------------------------------------------------------------
 * The file store's durability rested on an INFERENCE about NTFS: that a content
 * `fsync` publishes an earlier rename in the same directory, because both sit in
 * the volume metadata log. Microsoft documents `FlushFileBuffers` as flushing the
 * SPECIFIED FILE, and the documented durable-rename primitive
 * (`MoveFileEx(MOVEFILE_WRITE_THROUGH)`) is one libuv never passes. The whole
 * witness mechanism existed to detect the consequence of that inference being
 * wrong, and could not detect the case where both files rolled back together.
 *
 * SQLite's durability is documented rather than inferred — see the `synchronous`
 * assertion below, which is load-bearing and checked rather than assumed.
 *
 * A second, quieter win: the JSON file was validated as a WHOLE, so ONE
 * incoherent record failed the file schema and quarantined every other record's
 * 24 hours with it. Rows are validated individually here, so a corrupt row costs
 * exactly one `requestId` its status.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not decide what the CLIENT renders. It returns discriminated outcomes
 * and the honest-state discipline stays where it was: the five statuses mean
 * exactly what §11.5 says, nothing collapses into a vague "sent", and a state
 * this module cannot prove is never reported as terminal.
 */

import { and, eq, sql } from "drizzle-orm";
import type { AnswerAttemptStatus, HostDb } from "../db";
import { answerAttempts, answerCoverageEpoch } from "../db";
import { LOG_PREFIX } from "./config";
import {
	assertDurableSqlite,
	base64UrlEncode,
	isCanonicalWireId,
	randomBytes,
} from "./crypto";
import type {
	AnswerGuardName,
	EpochMs,
	RequestId,
	SealedErrorCode,
} from "./types";
import { ANSWER_GUARD_NAMES } from "./types";

/** Bytes of randomness in a coverage epoch. 16 matches the install generation. */
const COVERAGE_EPOCH_BYTES = 16;

/** The single-row epoch table's only key. */
const EPOCH_ROW_ID = 1;

/**
 * Every failure code the ledger may PERSIST, and the set the read boundary
 * enforces.
 *
 * Wider than the old JSON store's two codes (`guard_failed`, `internal`) on
 * purpose. Since the claim moved to the top of `handleAnswer`, a request can be
 * refused for a reason the store never used to see — the panic write-disable, a
 * stale question, a lost lease, an unusable agent binding — and §11.4 says a replay
 * returns the RECORDED outcome. Recording `internal` for a `write_disabled`
 * refusal would make that replay lie about why, so the real code is stored and
 * rethrown verbatim.
 *
 * Every member is a §10 sealed code, so a stored value is always something a client
 * already knows how to render.
 */
const LEDGER_FAILURE_CODES = [
	"stale_question",
	"already_resolved",
	"request_closed",
	"lease_held",
	"guard_failed",
	"picker_open",
	"capability_unsupported",
	"write_disabled",
	"bad_request",
	"internal",
] as const satisfies readonly SealedErrorCode[];

/** A code the ledger can store, narrowed from §10's sealed set. */
export type LedgerFailureCode = (typeof LEDGER_FAILURE_CODES)[number];

/**
 * The query surface this module uses, which BOTH the database and a transaction
 * satisfy.
 *
 * Deliberately structural rather than `tx as HostDb`: a transaction genuinely is
 * not a `HostDb` — it has no `$client` — and casting one to the other would have
 * been a lie that compiled. Every helper below takes this, so the same code runs
 * inside and outside a transaction and cannot accidentally reach for a
 * connection-level method (like the `synchronous` pragma) from inside one.
 */
type Queryable = Pick<HostDb, "select" | "insert" | "update" | "delete">;

/**
 * A ledger row this module has validated. Anything reaching a caller has crossed
 * the read boundary below, so a caller may trust the shape and nothing else.
 */
export interface LedgerRecord {
	requestId: RequestId;
	status: AnswerAttemptStatus;
	questionId: string | null;
	deviceId: string | null;
	surface: "phone" | "watch" | null;
	leaseId: string | null;
	startedAtMs: EpochMs | null;
	createdAtMs: EpochMs;
	resolvedAtMs: EpochMs | null;
	failureCode: LedgerFailureCode | null;
	guardsPassed: AnswerGuardName[];
	coverageEpoch: string;
}

/** What `claimForAnswer` decided. Exhaustive on purpose. */
export type ClaimOutcome =
	/** This request now owns an `in_flight` row. It MAY type. */
	| { kind: "claimed"; coverageEpoch: string }
	/** A row already existed: §11.4 replay. Return its recorded outcome, type nothing. */
	| { kind: "replay"; record: LedgerRecord }
	/**
	 * A status read already told a client nothing was received. Typing now would
	 * make that answer retroactively false, so it is REFUSED — permanently, not
	 * deferred.
	 */
	| { kind: "fenced"; record: LedgerRecord };

/** What the authoritative status path decided. */
export type StatusOutcome =
	/** A row exists. Report its status verbatim; coverage plays no part. */
	| { kind: "known"; record: LedgerRecord }
	/**
	 * No row existed and this call planted the tombstone, so "nothing was ever
	 * received" is now a durable fact that the answer path is bound by.
	 */
	| { kind: "not_received" }
	/**
	 * Nothing can be asserted. The client MUST render this as unconfirmed and
	 * never as failed. `why` is diagnostic, never shown as a verdict.
	 */
	| { kind: "unconfirmed"; why: string };

export interface AttemptLedger {
	/** The epoch a client should capture before submitting. */
	currentEpoch(): string;
	claimForAnswer(claim: {
		requestId: RequestId;
		questionId: string;
		deviceId: string;
		surface: "phone" | "watch";
		startedAtMs: EpochMs;
	}): ClaimOutcome;
	/**
	 * Records the outcome of an attempt THIS process claimed.
	 *
	 * Only ever advances an `in_flight` row. It cannot overwrite a tombstone — that
	 * is the fence — and, because nothing deletes rows, the row it advances is
	 * necessarily the one this process claimed: there is no way for a successor to
	 * hold the same requestId, so the ABA where a late outcome lands on someone
	 * else's claim cannot occur.
	 */
	recordOutcome(outcome: {
		requestId: RequestId;
		status: Exclude<AnswerAttemptStatus, "in_flight" | "closed_not_received">;
		resolvedAtMs: EpochMs | null;
		failureCode: LedgerFailureCode | null;
		guardsPassed: readonly AnswerGuardName[];
		/** Known only by outcome time; the claim predates the lease. */
		leaseId: string | null;
	}): void;
	/** A plain read. Null when there is no row, or the row failed validation. */
	get(requestId: RequestId): LedgerRecord | null;
	/**
	 * The status path. `capturedEpoch` is what the client captured before it
	 * submitted; a mismatch can never produce a terminal negative.
	 */
	resolveStatus(
		requestId: RequestId,
		capturedEpoch: string | null,
	): StatusOutcome;
	/**
	 * (LEDGER-KEEP-ATTEMPTS) Rotates the epoch. THE MANDATORY COMPANION TO ANY
	 * DELETION — nothing in this build deletes, so nothing calls it.
	 *
	 * There was a `prune(nowMs)` here that dropped rows past a 24 h retention. It
	 * is gone, because EVERY row in this table is a fence and forgetting any of
	 * them un-decides something that was announced as permanent:
	 *
	 *   - forget a CONFIRMED row and the next status read sees absence. With a
	 *     matching epoch it reports `not_received` — for keystrokes that
	 *     demonstrably landed. The phone re-asks under a fresh requestId and the
	 *     agent is answered TWICE, the one unrecoverable outcome in this system.
	 *   - forget an `in_flight` row and a second claim on the same requestId wins,
	 *     so two callers can type; worse, the first one's late `recordOutcome`
	 *     matches the SUCCESSOR's row (ABA) and serves one phone the other's
	 *     answer.
	 *   - forget a TOMBSTONE and a delayed answer for that requestId gets a fresh
	 *     claim and types, retroactively falsifying the terminal `not_received`
	 *     this bridge already promised.
	 *
	 * Rotating the epoch was supposed to cover the first of those, and does for a
	 * client that captures its epoch before submitting and never substitutes
	 * another. It does NOT cover a client that adopts the epoch `hello` publishes
	 * and re-polls an older request: the adopted epoch matches, so absence reads as
	 * authoritative. The server cannot tell the two apart — the token is opaque and
	 * the row that would have dated the request is exactly what was deleted. Nor
	 * does rotation touch the second and third cases at all, which are about a
	 * requestId becoming claimable again rather than about coverage.
	 *
	 * So the table only grows. A row is a couple of hundred bytes and needs a human
	 * to answer a question, which at this app's rate is a megabyte or so a year:
	 * the cost of unbounded growth is far below the cost of any of the above.
	 *
	 * This is kept, exported and uncalled so that a future compaction has the
	 * correct primitive to hand and no excuse for a bare DELETE: whatever discards
	 * rows must rotate in the SAME transaction, or it publishes a coverage claim it
	 * cannot honour.
	 */
	rotateEpoch(reason: string): string;
}

/**
 * Opens the ledger.
 *
 * `nowMs` is injected so tests can drive the retention deterministically; every
 * caller in the bridge passes the real clock.
 */
export function createAttemptLedger(options: {
	db: HostDb;
	/** Structured diagnostics. Never carries question or answer text. */
	log: (event: Record<string, unknown>) => void;
	now?: () => EpochMs;
}): AttemptLedger {
	const { db } = options;
	const now = options.now ?? (() => Date.now() as EpochMs);
	const log = options.log;
	if (typeof log !== "function") {
		throw new TypeError(
			`${LOG_PREFIX} createAttemptLedger requires a \`log\` function; got ${typeof log}. The ledger reports on ordinary opens, so there is no path that runs without it.`,
		);
	}

	/**
	 * THE DURABILITY THIS MODULE'S WHOLE ARGUMENT RESTS ON, ASSERTED RATHER THAN
	 * ASSUMED. Both pragmas, and the reasoning for each, live in
	 * `assertDurableSqlite` — shared with the replay cache, which makes the same
	 * claim on the same connection.
	 *
	 * The claim above is that SQLite's durability is DOCUMENTED where the file
	 * store's was inferred. That is only true at `synchronous = FULL`. In WAL mode
	 * — which `createDb` sets — `NORMAL` means a commit is durable against a
	 * process crash but NOT against power loss or a hard reset: the WAL write may
	 * still be in the OS page cache, and transactions committed since the last
	 * checkpoint can be lost. Losing a committed `in_flight` claim is precisely the
	 * rollback this design exists to make impossible, so a bridge running at
	 * `NORMAL` would have swapped an undocumented inference for a documented
	 * weakness.
	 *
	 * (COMPANION-DB-FULL) The connection is the bridge's OWN — the mount opens
	 * it and sets `synchronous = FULL` explicitly, because the SHARED host-service
	 * connection runs at the binding's WAL default (NORMAL under better-sqlite3's
	 * standard build), which is exactly what the first installed build died on.
	 * This assert still fails LOUD rather than re-setting the pragma: a wrong
	 * value here means the ledger was handed a connection the mount did not
	 * configure — a wiring bug to surface, not a tuning to quietly correct.
	 *
	 * (WAL also means a reader never blocks a writer, which is why the CAS below
	 * can be a short transaction without starving the status path.)
	 */
	const assertDurable = (when: string): void => assertDurableSqlite(db, when);

	/**
	 * (LEDGER-SYNC-RECHECK) Re-asserted before each of the two decisions, not just
	 * at open.
	 *
	 * Checking once at open would only prove the pragma was right when the module
	 * loaded. The pragma is connection-scoped and settable at any time on the
	 * bridge's own connection too, and a single
	 * `PRAGMA synchronous = NORMAL` anywhere — a future migration, an import-time
	 * tuning line, a REPL — would silently un-anchor every claim written after it
	 * while an open-time check kept reporting green.
	 *
	 * So the two writes the fence rests on re-read it first. A pragma read is an
	 * in-memory field access on the connection, no I/O and no statement to prepare,
	 * against a path that is already doing a durable commit.
	 *
	 * `recordOutcome` deliberately does NOT re-check: an outcome lost to power loss
	 * leaves the row `in_flight`, and `(LEDGER-REHYDRATE)` turns that into
	 * `unconfirmed` at the next open. Losing it weakens a claim, which is safe. The
	 * two paths below are the ones where losing a write would STRENGTHEN one.
	 */
	assertDurable("when opening the answer ledger");

	const mintEpoch = (): string =>
		base64UrlEncode(randomBytes(COVERAGE_EPOCH_BYTES));

	/**
	 * (LEDGER-REHYDRATE) Every `in_flight` row from a PREVIOUS lifetime becomes
	 * `unconfirmed`, once, at open.
	 *
	 * `in_flight` means "keystrokes are landing right now". That is only ever true of
	 * the process that claimed the row. A row still saying it after this process
	 * starts belongs to a lifetime that is gone — it crashed mid-sequence, or was
	 * killed, or refused the request after claiming it — and the honest report for a
	 * sequence whose outcome nobody recorded is `unconfirmed`: it may have landed, it
	 * may not, and the desk is the only place that knows.
	 *
	 * Without this, PROTOCOL §11.5's promise that "an in_flight row that outlives its
	 * process is reported as unconfirmed on the next read" was simply false — the row
	 * was served verbatim, so a crash mid-type told the phone its answer was being
	 * typed for up to the full 24 h retention. The old JSON store did do this
	 * (it collapsed `in_flight` at hydration); the promise survived the rewrite and
	 * the mechanism did not.
	 *
	 * SOUND BECAUSE OF THE LIFETIME ARGUMENT, not because crashes are rare: no
	 * attempt from a prior lifetime can still be typing, since typing happens inside
	 * a lock held by a process that no longer exists. It is deliberately NOT a
	 * heuristic on age or a timeout.
	 *
	 * It also drains the residue of any refusal that recorded no outcome, so a fault
	 * that leaves a claim behind cannot outlive one restart even if a future edit
	 * reintroduces one.
	 */
	const rehydrated = db
		.update(answerAttempts)
		.set({ status: "unconfirmed" })
		.where(eq(answerAttempts.status, "in_flight"))
		.run();
	if (rehydrated.changes > 0) {
		log({
			event: "companion.answer.ledger_rehydrated_in_flight",
			count: rehydrated.changes,
			why: "rows still marked in_flight belonged to a lifetime that is gone; a sequence whose outcome nobody recorded is unconfirmed, never confirmed and never never-received",
		});
	}

	/**
	 * Reads the epoch, minting one on first use.
	 *
	 * Synchronous and inside whatever transaction the caller is already in, so a
	 * rotate and the delete that caused it cannot be separated by a crash.
	 */
	const readEpochRow = (tx: Queryable) => {
		const rows = tx
			.select()
			.from(answerCoverageEpoch)
			.where(eq(answerCoverageEpoch.id, EPOCH_ROW_ID))
			.all();
		const existing = rows[0];
		if (existing !== undefined && isCanonicalWireId(existing.epoch)) {
			return existing;
		}
		// Absent on a fresh install; non-canonical means the row was tampered with
		// or written by something else, and either way it cannot be compared for
		// equality meaningfully. Replacing it is the conservative move: every
		// client's captured token stops matching, so every status read degrades to
		// unconfirmed rather than to a negative.
		const epoch = mintEpoch();
		const rotatedAtMs = now();
		tx.insert(answerCoverageEpoch)
			.values({
				id: EPOCH_ROW_ID,
				epoch,
				rotatedAtMs,
				rotations: existing === undefined ? 0 : (existing.rotations ?? 0) + 1,
				lastRotateReason:
					existing === undefined
						? "first use"
						: "the stored epoch was not usable",
			})
			.onConflictDoUpdate({
				target: answerCoverageEpoch.id,
				set: {
					epoch,
					rotatedAtMs,
					rotations: sql`${answerCoverageEpoch.rotations} + 1`,
					lastRotateReason: "the stored epoch was not usable",
				},
			})
			.run();
		if (existing !== undefined) {
			log({
				event: "companion.answer.coverage_epoch_replaced",
				why: "the stored coverage epoch was not a canonical id, so it could not be compared; a fresh one was minted and every in-flight client's captured token now degrades to unconfirmed",
			});
		}
		return {
			id: EPOCH_ROW_ID,
			epoch,
			rotatedAtMs,
			rotations: 0,
			lastRotateReason: null,
		};
	};

	/**
	 * THE READ BOUNDARY. A row is untrusted exactly as the JSON file's records
	 * were: it is on disk, this process may not have written it, and a shape that
	 * cannot be true is more dangerous than a missing row because it gets SERVED.
	 *
	 * Returns null rather than throwing, and logs: one unusable row costs one
	 * requestId its status, which is the improvement over quarantining the whole
	 * file. A null read is indistinguishable from "no row" to the caller, and that
	 * is correct — neither proves anything, and neither may become a negative
	 * unless the caller can plant the fence itself.
	 */
	const validate = (
		row: typeof answerAttempts.$inferSelect,
	): LedgerRecord | null => {
		const reject = (why: string): null => {
			log({
				event: "companion.answer.ledger_row_rejected",
				requestId: row.requestId,
				why,
				effect:
					"this requestId reports as unconfirmed; every other row is unaffected",
			});
			return null;
		};
		const status = row.status;
		if (
			status !== "in_flight" &&
			status !== "confirmed" &&
			status !== "failed" &&
			status !== "unconfirmed" &&
			status !== "closed_not_received"
		) {
			return reject(
				`status ${JSON.stringify(status)} is not one this build knows`,
			);
		}
		if (typeof row.createdAtMs !== "number" || row.createdAtMs < 0) {
			return reject("createdAtMs is missing or negative");
		}
		if (
			typeof row.coverageEpoch !== "string" ||
			row.coverageEpoch.length === 0
		) {
			return reject("coverageEpoch is missing");
		}
		// Cross-field, because field-by-field validation let incoherent records
		// through and the status handler then served them as truth.
		if (status === "confirmed" && row.resolvedAtMs === null) {
			return reject(
				"a confirmed attempt with no resolvedAtMs says the answer landed but not when; nothing this bridge writes produces it",
			);
		}
		if (status === "failed" && row.failureCode === null) {
			return reject("a failed attempt carries no failureCode");
		}
		// `in_flight` means "keystrokes are landing right now". A row that says that
		// AND carries an outcome is two contradictory claims, and the dangerous half
		// is the one a status read repeats verbatim.
		if (
			status === "in_flight" &&
			(row.resolvedAtMs !== null || row.failureCode !== null)
		) {
			return reject(
				"an in_flight attempt already carries an outcome; it cannot both be mid-flight and resolved",
			);
		}
		// MEMBERSHIP, not just presence. The schema commit claimed "the runtime check
		// lives at the read boundary" and this is the half that was missing: a
		// failureCode was checked for existence and then plain-cast, so a corrupt or
		// foreign-writer string flowed through `handleAnswer`'s replay rethrow into a
		// sealed response as a wire code no client has ever heard of. A client degrades
		// an unknown code safely, so it was bounded — but "bounded by the other side's
		// tolerance" is not the same as validated, and this boundary exists to reject
		// exactly this.
		if (
			row.failureCode !== null &&
			!(LEDGER_FAILURE_CODES as readonly string[]).includes(row.failureCode)
		) {
			return reject(
				`failureCode ${JSON.stringify(row.failureCode)} is not a code this bridge writes`,
			);
		}
		// (LEDGER-COHERENCE) A tombstone describes the ABSENCE of an attempt, so
		// every field that could only come from one must be null. Checking the
		// timestamps alone let a row asserting "nothing ever arrived" also carry the
		// question it arrived for, the device that sent it, the lease it held and the
		// guards it passed — a shape nothing can produce, which `toWireOutcome` then
		// served to the phone as a terminal `not_received`. An impossible row that
		// gets SERVED is worse than a missing one, which is this boundary's whole
		// premise; enforcing only half of it was the gap.
		if (status === "closed_not_received") {
			if (
				row.questionId !== null ||
				row.deviceId !== null ||
				row.surface !== null ||
				row.leaseId !== null ||
				row.failureCode !== null
			) {
				return reject(
					"a closed_not_received tombstone carries attempt identity or a failure code; it asserts nothing ever arrived, so there is no attempt to describe",
				);
			}
			// The tombstone describes no attempt, so an attempt's fields being
			// populated means it is not the row this build wrote.
			if (row.startedAtMs !== null || row.resolvedAtMs !== null) {
				return reject(
					"a closed_not_received tombstone carries attempt timestamps; it asserts nothing ever arrived, so there is no attempt to describe",
				);
			}
		} else if (
			row.questionId === null ||
			row.deviceId === null ||
			row.surface === null ||
			row.startedAtMs === null
		) {
			return reject(
				"an attempt row is missing fields only a tombstone may omit",
			);
		}
		// `leaseId` is deliberately NOT in that list. The claim is made BEFORE the
		// answer-wide lease is acquired — it has to be, or a status read could still
		// see "absent" for an answer already admitted — so an `in_flight` row
		// legitimately has no lease yet. It is filled in when the outcome is
		// recorded, by which time the lease has been held and released.
		let guardsPassed: AnswerGuardName[];
		try {
			const parsed: unknown = JSON.parse(row.guardsPassedJson);
			if (!Array.isArray(parsed) || parsed.some((g) => typeof g !== "string")) {
				return reject("guardsPassed is not an array of strings");
			}
			// MEMBERSHIP, not just "is a string". `guardsPassed` is the audit answer to
			// "what actually permitted this write", and `ANSWER_GUARD_NAMES` is the
			// same list the guard stack evaluates — so an unknown name here means the
			// row was written by a build with a different stack, and this build cannot
			// honestly say what it proved.
			const unknownGuard = parsed.find(
				(g) => !(ANSWER_GUARD_NAMES as readonly string[]).includes(g as string),
			);
			if (unknownGuard !== undefined) {
				return reject(
					`guardsPassed names ${JSON.stringify(unknownGuard)}, which is not a guard this build evaluates`,
				);
			}
			guardsPassed = parsed as AnswerGuardName[];
		} catch (error) {
			return reject(
				`guardsPassed is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
			);
		}
		return {
			requestId: row.requestId as RequestId,
			status,
			questionId: row.questionId,
			deviceId: row.deviceId,
			surface: row.surface,
			leaseId: row.leaseId,
			startedAtMs: row.startedAtMs as EpochMs | null,
			createdAtMs: row.createdAtMs as EpochMs,
			resolvedAtMs: row.resolvedAtMs as EpochMs | null,
			failureCode: row.failureCode as LedgerFailureCode | null,
			guardsPassed,
			coverageEpoch: row.coverageEpoch,
		};
	};

	const selectRow = (tx: Queryable, requestId: RequestId) => {
		const rows = tx
			.select()
			.from(answerAttempts)
			.where(eq(answerAttempts.requestId, requestId))
			.all();
		return rows[0];
	};

	/**
	 * (LEDGER-EPOCH-EAGER) The epoch row is minted AT OPEN, not on first use.
	 *
	 * `readEpochRow` mints lazily, which is correct but was the only thing creating
	 * the row — so a freshly migrated database had an empty `answer_coverage_epoch`
	 * until something happened to ask, and the boot harness reported exactly that:
	 * tables present, epoch absent. Whether that was harmless depended entirely on
	 * `hello` asking before any status read did, which is the kind of ordering
	 * nothing enforces and nobody notices until a poll degrades.
	 *
	 * Minting here makes the epoch a property of the DATABASE rather than of
	 * whichever request arrived first, keeps it off the first hello's path, and makes
	 * it observable: an operator or a boot check can see the token exists without
	 * having to provoke one.
	 */
	db.transaction((tx) => {
		readEpochRow(tx);
	});

	return {
		currentEpoch() {
			return db.transaction((tx) => readEpochRow(tx).epoch);
		},

		claimForAnswer(claim) {
			assertDurable("before claiming the right to type");
			return db.transaction((tx): ClaimOutcome => {
				const inner: Queryable = tx;
				const epoch = readEpochRow(inner).epoch;
				// ONE STATEMENT DECIDES. `ON CONFLICT DO NOTHING` plus the primary key
				// makes this a decision procedure rather than a race: exactly one
				// concurrent caller sees a row inserted, and the losers see zero. A
				// SELECT-then-INSERT here would be the very bug this module replaces.
				const inserted = inner
					.insert(answerAttempts)
					.values({
						requestId: claim.requestId,
						questionId: claim.questionId,
						deviceId: claim.deviceId,
						surface: claim.surface,
						// Null on purpose: the lease is taken after this claim. See the
						// read boundary's note on `leaseId`.
						leaseId: null,
						startedAtMs: claim.startedAtMs,
						createdAtMs: claim.startedAtMs,
						status: "in_flight",
						resolvedAtMs: null,
						failureCode: null,
						guardsPassedJson: "[]",
						coverageEpoch: epoch,
					})
					.onConflictDoNothing({ target: answerAttempts.requestId })
					.run();
				if (inserted.changes === 1) {
					return { kind: "claimed", coverageEpoch: epoch };
				}
				const row = selectRow(inner, claim.requestId);
				if (row === undefined) {
					// The insert lost the conflict yet no row is there: impossible inside
					// one transaction, so treat it as corruption rather than retrying into
					// a loop. Refusing is the safe direction — nothing has been typed.
					throw new Error(
						`${LOG_PREFIX} answer ledger: the claim for ${claim.requestId} conflicted with a row that then could not be read. Refusing to type under state that cannot be read back.`,
					);
				}
				const record = validate(row);
				if (record === null) {
					// An unusable row still OCCUPIES the key, so this request can neither
					// claim nor be replayed. Refusing to type is the only safe answer.
					throw new Error(
						`${LOG_PREFIX} answer ledger: ${claim.requestId} is occupied by a row this build cannot validate. Refusing to type; the row is reported above.`,
					);
				}
				if (record.status === "closed_not_received") {
					return { kind: "fenced", record };
				}
				return { kind: "replay", record };
			});
		},

		recordOutcome(outcome) {
			const updated = db
				.update(answerAttempts)
				.set({
					status: outcome.status,
					resolvedAtMs: outcome.resolvedAtMs,
					failureCode: outcome.failureCode,
					guardsPassedJson: JSON.stringify(outcome.guardsPassed),
					leaseId: outcome.leaseId,
				})
				// ONLY an `in_flight` row, which is the one this process claimed. The
				// predicate is the safety property, not an optimisation: without it an
				// outcome could overwrite a tombstone and erase the fence, or revive a
				// row that was never there to begin with.
				.where(
					and(
						eq(answerAttempts.requestId, outcome.requestId),
						eq(answerAttempts.status, "in_flight"),
					),
				)
				.run();
			if (updated.changes === 0) {
				// Never thrown: by the time an outcome exists the keystrokes may already
				// have landed, and reporting a landed answer as failed is the worse lie.
				// Logged loudly instead, because it means something moved the row under a
				// request that believed it owned it.
				log({
					event: "companion.answer.ledger_outcome_orphaned",
					requestId: outcome.requestId,
					status: outcome.status,
					why: "no in_flight row was there to advance — it was fenced or already resolved",
				});
			}
		},

		get(requestId) {
			const row = selectRow(db, requestId);
			return row === undefined ? null : validate(row);
		},

		resolveStatus(requestId, capturedEpoch) {
			assertDurable("before deciding a request never arrived");
			return db.transaction((tx): StatusOutcome => {
				const inner: Queryable = tx;
				const existing = selectRow(inner, requestId);
				if (existing !== undefined) {
					const record = validate(existing);
					// A PRESENT row is served regardless of coverage, and always was —
					// the epoch governs only what an ABSENT row is allowed to mean.
					return record === null
						? {
								kind: "unconfirmed",
								why: "a row exists for this requestId but this build cannot validate it",
							}
						: { kind: "known", record };
				}
				const epoch = readEpochRow(inner).epoch;
				if (capturedEpoch === null) {
					return {
						kind: "unconfirmed",
						why: "the client captured no coverage epoch, so absence cannot be bounded",
					};
				}
				if (capturedEpoch !== epoch) {
					// The coverage the client captured is not the coverage this bridge
					// has. Something rotated it — an acknowledged coverage gap — so
					// rows from before it may have gone and absence proves nothing.
					return {
						kind: "unconfirmed",
						why: "the coverage epoch rotated since this request was submitted, so absence no longer proves it never arrived",
					};
				}
				// PLANTING THE FENCE IS WHAT EARNS THE NEGATIVE. Inside this same
				// transaction, so an answer that has been admitted but has not yet
				// claimed will find this row and refuse to type. Without this insert the
				// negative would be exactly the unfenced claim about the future that
				// made the old design unsound.
				const planted = inner
					.insert(answerAttempts)
					.values({
						requestId,
						questionId: null,
						deviceId: null,
						surface: null,
						leaseId: null,
						startedAtMs: null,
						createdAtMs: now(),
						status: "closed_not_received",
						resolvedAtMs: null,
						failureCode: null,
						guardsPassedJson: "[]",
						coverageEpoch: epoch,
					})
					.onConflictDoNothing({ target: answerAttempts.requestId })
					.run();
				if (planted.changes === 1) {
					return { kind: "not_received" };
				}
				// Lost the race to an answer claiming in the same instant. It won, so it
				// may type, and this read reports what it wrote rather than a negative.
				const row = selectRow(inner, requestId);
				const record = row === undefined ? null : validate(row);
				return record === null
					? {
							kind: "unconfirmed",
							why: "a concurrent claim took this requestId and its row could not be read back",
						}
					: { kind: "known", record };
			});
		},

		rotateEpoch(reason) {
			return db.transaction((tx) => {
				const inner: Queryable = tx;
				readEpochRow(inner);
				const epoch = mintEpoch();
				inner
					.update(answerCoverageEpoch)
					.set({
						epoch,
						rotatedAtMs: now(),
						rotations: sql`${answerCoverageEpoch.rotations} + 1`,
						lastRotateReason: reason,
					})
					.where(eq(answerCoverageEpoch.id, EPOCH_ROW_ID))
					.run();
				log({
					event: "companion.answer.coverage_epoch_rotated",
					why: reason,
				});
				return epoch;
			});
		},
	};
}
