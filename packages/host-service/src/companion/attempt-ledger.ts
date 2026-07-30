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

import { and, eq, lt, sql } from "drizzle-orm";
import type { HostDb } from "../db";
import { answerAttempts, answerCoverageEpoch } from "../db";
import type { AnswerAttemptStatus } from "../db";
import { ANSWER_ATTEMPT_RETENTION_MS, LOG_PREFIX } from "./config";
import { base64UrlEncode, isCanonicalWireId, randomBytes } from "./crypto";
import type {
	AnswerGuardName,
	AttemptFailureCode,
	DurationMs,
	EpochMs,
	RequestId,
} from "./types";

/** Bytes of randomness in a coverage epoch. 16 matches the install generation. */
const COVERAGE_EPOCH_BYTES = 16;

/** The single-row epoch table's only key. */
const EPOCH_ROW_ID = 1;

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
	failureCode: AttemptFailureCode | null;
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
		leaseId: string;
		startedAtMs: EpochMs;
	}): ClaimOutcome;
	/**
	 * Records the outcome of an attempt THIS process claimed.
	 *
	 * Only ever advances an `in_flight` row. It cannot overwrite a tombstone (that
	 * is the fence) and it cannot resurrect a pruned row.
	 */
	recordOutcome(outcome: {
		requestId: RequestId;
		status: Exclude<AnswerAttemptStatus, "in_flight" | "closed_not_received">;
		resolvedAtMs: EpochMs | null;
		failureCode: AttemptFailureCode | null;
		guardsPassed: readonly AnswerGuardName[];
	}): void;
	/** A plain read. Null when there is no row, or the row failed validation. */
	get(requestId: RequestId): LedgerRecord | null;
	/**
	 * The status path. `capturedEpoch` is what the client captured before it
	 * submitted; a mismatch can never produce a terminal negative.
	 */
	resolveStatus(requestId: RequestId, capturedEpoch: string | null): StatusOutcome;
	/** Drops rows past the retention, rotating the epoch if anything went. */
	prune(nowMs: EpochMs): number;
	/** Rotates the epoch. Use when continuity is lost for any other reason. */
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
	retentionMs?: DurationMs;
	now?: () => EpochMs;
}): AttemptLedger {
	const { db } = options;
	const retentionMs = options.retentionMs ?? ANSWER_ATTEMPT_RETENTION_MS;
	const now = options.now ?? (() => Date.now() as EpochMs);
	const log = options.log;
	if (typeof log !== "function") {
		throw new TypeError(
			`${LOG_PREFIX} createAttemptLedger requires a \`log\` function; got ${typeof log}. The ledger reports on ordinary opens, so there is no path that runs without it.`,
		);
	}

	/**
	 * THE DURABILITY THIS MODULE'S WHOLE ARGUMENT RESTS ON, ASSERTED RATHER THAN
	 * ASSUMED.
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
	 * `createDb` does not set `synchronous`, so this is checking SQLite's own
	 * default rather than a value the bridge chose. It fails LOUD instead of
	 * quietly setting it, because this connection is shared with the rest of the
	 * host service: if someone lowers it for write throughput, that is a
	 * deliberate decision which must be made with the knowledge that it breaks the
	 * answer fence, not silently undone here.
	 *
	 * (WAL also means a reader never blocks a writer, which is why the CAS below
	 * can be a short transaction without starving the status path.)
	 */
	const synchronous = db.$client.pragma("synchronous", { simple: true });
	if (Number(synchronous) !== 2) {
		throw new Error(
			`${LOG_PREFIX} the answer ledger requires PRAGMA synchronous = FULL (2), found ${String(synchronous)}. At NORMAL a committed claim can be lost to power loss, which is the exact rollback the answer fence exists to prevent. Refusing to serve answers under it.`,
		);
	}

	const mintEpoch = (): string => base64UrlEncode(randomBytes(COVERAGE_EPOCH_BYTES));

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
					existing === undefined ? "first use" : "the stored epoch was not usable",
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
		return { id: EPOCH_ROW_ID, epoch, rotatedAtMs, rotations: 0, lastRotateReason: null };
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
	const validate = (row: typeof answerAttempts.$inferSelect): LedgerRecord | null => {
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
			return reject(`status ${JSON.stringify(status)} is not one this build knows`);
		}
		if (typeof row.createdAtMs !== "number" || row.createdAtMs < 0) {
			return reject("createdAtMs is missing or negative");
		}
		if (typeof row.coverageEpoch !== "string" || row.coverageEpoch.length === 0) {
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
		if (status === "closed_not_received") {
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
			row.leaseId === null ||
			row.startedAtMs === null
		) {
			return reject(
				"an attempt row is missing fields only a tombstone may omit",
			);
		}
		let guardsPassed: AnswerGuardName[];
		try {
			const parsed: unknown = JSON.parse(row.guardsPassedJson);
			if (!Array.isArray(parsed) || parsed.some((g) => typeof g !== "string")) {
				return reject("guardsPassed is not an array of strings");
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
			failureCode: row.failureCode as AttemptFailureCode | null,
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

	return {
		currentEpoch() {
			return db.transaction((tx) => readEpochRow(tx).epoch);
		},

		claimForAnswer(claim) {
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
						leaseId: claim.leaseId,
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
				})
				// ONLY an `in_flight` row, which is the one this process claimed. The
				// predicate is the safety property, not an optimisation: without it an
				// outcome could overwrite a tombstone and erase the fence, or revive a
				// row a concurrent prune had already dropped.
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
					why: "no in_flight row was there to advance — it was pruned, fenced, or already resolved",
				});
			}
		},

		get(requestId) {
			const row = selectRow(db, requestId);
			return row === undefined ? null : validate(row);
		},

		resolveStatus(requestId, capturedEpoch) {
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
					// has. Something rotated it — a prune, or an acknowledged gap — so
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

		prune(nowMs) {
			return db.transaction((tx) => {
				const inner: Queryable = tx;
				const cutoff = nowMs - retentionMs;
				const deleted = inner
					.delete(answerAttempts)
					.where(lt(answerAttempts.createdAtMs, cutoff))
					.run();
				if (deleted.changes > 0) {
					// ROTATED IN THE SAME TRANSACTION AS THE DELETE, which is the only
					// ordering that is safe. Pruning destroys the evidence that made
					// absence meaningful, so any client holding the old token must stop
					// getting negatives at the instant those rows go — not on the next
					// tick, and not if the process dies in between.
					const epoch = mintEpoch();
					inner
						.update(answerCoverageEpoch)
						.set({
							epoch,
							rotatedAtMs: nowMs,
							rotations: sql`${answerCoverageEpoch.rotations} + 1`,
							lastRotateReason: "records passed the retention window",
						})
						.where(eq(answerCoverageEpoch.id, EPOCH_ROW_ID))
						.run();
					log({
						event: "companion.answer.coverage_epoch_rotated",
						pruned: deleted.changes,
						why: "records passed the 24 h retention, so absence no longer proves a request never arrived",
					});
				}
				return deleted.changes;
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
