/**
 * (PUSH-PRESENCE) The durable armed/sent fence behind the push scheduler.
 *
 * Rationale for the table itself is on `companionPushFence` in `db/schema.ts`;
 * this module is the only thing that reads or writes it.
 *
 * WHICH CONNECTION, AND WHY IT MATTERS. Every write here goes through the
 * bridge's OWN `synchronous = FULL` handle (COMPANION-DB-FULL), the same one the
 * device store, replay cache and answer ledger use — never the shared host.db
 * handle, which runs at WAL NORMAL. `assertDurableSqlite` is called once at open
 * rather than trusted: at NORMAL a committed `sent` row can be lost to power
 * loss, and a lost `sent` row is a second buzz for a question already answered.
 *
 * ROWS ARE VALIDATED INDIVIDUALLY. A row whose shape cannot be trusted is
 * dropped and REPORTED, costing that one question its push; the alternative —
 * failing the whole load — would cost every question its push because of one
 * bad row, and would do it at bridge start where the only symptom is a bridge
 * that will not come up.
 */

import { eq } from "drizzle-orm";
import type { HostDb } from "../db";
import { companionPushFence } from "../db";
import { assertDurableSqlite } from "./crypto";
import type { QuestionId, WorkspaceId } from "./types";

/** `armed` may still fire. `sent` never fires again and is retractable. */
export type PushFenceState = "armed" | "sent";

export interface PushFenceRecord {
	questionId: QuestionId;
	workspaceId: WorkspaceId;
	questionCount: number;
	expiresAtMs: number;
	armedAtMs: number;
	state: PushFenceState;
	/** Non-null exactly when `state` is `sent`. The loader refuses them out of step. */
	sentAtMs: number | null;
}

export interface PushFence {
	/**
	 * Everything still worth reconstructing, pruning as it reads.
	 *
	 * Pruning happens HERE rather than on a timer because this is the only moment
	 * the whole table is being read anyway, and a fence row that survives its
	 * subject is inert rather than harmful.
	 */
	load(input: { nowMs: number; sentRetentionMs: number }): PushFenceRecord[];
	/** Idempotent: re-arming an existing questionId leaves the row as it is. */
	arm(record: Omit<PushFenceRecord, "state" | "sentAtMs">): void;
	/** Moves `armed` -> `sent`. Written BEFORE the send, like the in-memory record. */
	markSent(questionId: QuestionId, sentAtMs: number): void;
	/** Forgets the question entirely — resolved, expired, or retracted. */
	clear(questionId: QuestionId): void;
}

export interface PushFenceDeps {
	/** The bridge's `synchronous = FULL` handle. Asserted, never assumed. */
	db: HostDb;
	/** Structured diagnostics. Never carries question or option text. */
	log: (event: Record<string, unknown>) => void;
}

function isPositiveInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function createPushFence(deps: PushFenceDeps): PushFence {
	const { db, log } = deps;
	if (typeof log !== "function") {
		throw new TypeError(
			`(PUSH-PRESENCE) createPushFence requires a \`log\` function; got ${typeof log}. It reports dropped rows on ordinary opens, so there is no path that runs without it.`,
		);
	}
	assertDurableSqlite(db, "opening the companion push fence");

	return {
		load({ nowMs, sentRetentionMs }) {
			if (!Number.isFinite(nowMs) || !Number.isFinite(sentRetentionMs)) {
				throw new TypeError(
					"(PUSH-PRESENCE) push fence load requires finite nowMs and sentRetentionMs",
				);
			}
			return db.transaction((tx) => {
				const rows = tx.select().from(companionPushFence).all();
				const kept: PushFenceRecord[] = [];
				const drop: string[] = [];

				for (const row of rows) {
					const state = row.state;
					if (state !== "armed" && state !== "sent") {
						drop.push(row.questionId);
						log({
							event: "push fence row has an unknown state",
							questionId: row.questionId,
							state,
						});
						continue;
					}
					if (
						!isPositiveInt(row.expiresAtMs) ||
						!isPositiveInt(row.armedAtMs) ||
						!isPositiveInt(row.questionCount) ||
						row.workspaceId.length === 0
					) {
						drop.push(row.questionId);
						log({
							event:
								"push fence row is malformed — that question loses its push",
							questionId: row.questionId,
						});
						continue;
					}
					if (state === "sent" && !isPositiveInt(row.sentAtMs)) {
						drop.push(row.questionId);
						log({
							event: "push fence row is `sent` with no sentAtMs",
							questionId: row.questionId,
						});
						continue;
					}
					if (state === "armed" && row.sentAtMs !== null) {
						drop.push(row.questionId);
						log({
							event: "push fence row is `armed` but carries a sentAtMs",
							questionId: row.questionId,
						});
						continue;
					}

					// An armed question past its expiry would be discarded unopened by
					// the client; a sent record past the retraction window can no longer
					// retract anything. Both are inert, so both are reclaimed.
					if (state === "armed" && nowMs >= row.expiresAtMs) {
						drop.push(row.questionId);
						continue;
					}
					if (
						state === "sent" &&
						row.sentAtMs !== null &&
						nowMs - row.sentAtMs > sentRetentionMs
					) {
						drop.push(row.questionId);
						continue;
					}

					kept.push({
						questionId: row.questionId as QuestionId,
						workspaceId: row.workspaceId as WorkspaceId,
						questionCount: row.questionCount,
						expiresAtMs: row.expiresAtMs,
						armedAtMs: row.armedAtMs,
						state,
						sentAtMs: row.sentAtMs,
					});
				}

				for (const questionId of drop) {
					tx.delete(companionPushFence)
						.where(eq(companionPushFence.questionId, questionId))
						.run();
				}
				if (rows.length > 0) {
					log({
						event: "push fence reconstructed",
						armed: kept.filter((r) => r.state === "armed").length,
						sent: kept.filter((r) => r.state === "sent").length,
						pruned: drop.length,
					});
				}
				return kept;
			});
		},

		arm(record) {
			db.insert(companionPushFence)
				.values({
					questionId: record.questionId,
					workspaceId: record.workspaceId,
					questionCount: record.questionCount,
					expiresAtMs: record.expiresAtMs,
					armedAtMs: record.armedAtMs,
					state: "armed",
					sentAtMs: null,
				})
				// DO NOTHING, never DO UPDATE. A row already here is either an armed
				// entry this call is a duplicate of, or a `sent` one — and overwriting
				// a `sent` row with `armed` is precisely how a question buzzes twice.
				.onConflictDoNothing()
				.run();
		},

		markSent(questionId, sentAtMs) {
			if (!isPositiveInt(sentAtMs)) {
				throw new TypeError(
					`(PUSH-PRESENCE) markSent requires a positive epoch, got ${String(sentAtMs)}`,
				);
			}
			db.update(companionPushFence)
				.set({ state: "sent", sentAtMs })
				.where(eq(companionPushFence.questionId, questionId))
				.run();
		},

		clear(questionId) {
			db.delete(companionPushFence)
				.where(eq(companionPushFence.questionId, questionId))
				.run();
		},
	};
}
