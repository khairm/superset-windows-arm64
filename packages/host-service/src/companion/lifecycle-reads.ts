/**
 * (LIFECYCLE-READ-THROUGH) The durable read mark behind one buzz per chat:
 * per terminal, the largest host-clock instant the user is known to have read
 * through. `0` means never read. Carried on every ready alert as `rg`.
 *
 * Writes go through the bridge's `synchronous = FULL` connection, so a report
 * that does not raise the mark must not write at all.
 */

import { eq, sql } from "drizzle-orm";
import type { HostDb } from "../db";
import { companionLifecycleReads } from "../db";
import { assertDurableSqlite } from "./crypto";
import { isReadInstant } from "./limits";

export interface LifecycleReads {
	readThroughAt(hostTerminalId: string): number;
	/** Raises the stored mark; never lowers it. Throws on a bad id or instant. */
	advance(hostTerminalId: string, readThroughAt: number): void;
}

function assertTerminalId(
	hostTerminalId: unknown,
): asserts hostTerminalId is string {
	if (typeof hostTerminalId !== "string" || hostTerminalId.length === 0) {
		throw new TypeError("a lifecycle read needs a non-empty terminal id");
	}
}

export function createLifecycleReads(deps: { db: HostDb }): LifecycleReads {
	const { db } = deps;
	assertDurableSqlite(db, "opening the companion lifecycle reads");

	return {
		readThroughAt(hostTerminalId) {
			assertTerminalId(hostTerminalId);
			const row = db
				.select({ readThroughAt: companionLifecycleReads.readThroughAt })
				.from(companionLifecycleReads)
				.where(eq(companionLifecycleReads.terminalId, hostTerminalId))
				.get();
			if (row === undefined) return 0;
			if (!isReadInstant(row.readThroughAt)) {
				throw new Error(
					`stored read mark for terminal ${hostTerminalId} is not a 13-digit ms instant`,
				);
			}
			return row.readThroughAt;
		},
		advance(hostTerminalId, readThroughAt) {
			assertTerminalId(hostTerminalId);
			if (!isReadInstant(readThroughAt)) {
				throw new TypeError("a read mark must be a 13-digit ms instant");
			}
			db.insert(companionLifecycleReads)
				.values({ terminalId: hostTerminalId, readThroughAt })
				.onConflictDoUpdate({
					target: companionLifecycleReads.terminalId,
					set: { readThroughAt: sql`excluded.read_through_at` },
					setWhere: sql`excluded.read_through_at > ${companionLifecycleReads.readThroughAt}`,
				})
				.run();
		},
	};
}
