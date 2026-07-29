/**
 * (COMPANION-BRIDGE) — the audit log (§14).
 *
 * Not optional. The residual race of §11.7 is only acceptable because incidents
 * are reconstructable, and that reconstruction is this file.
 *
 * Two lines per write: `attempted` BEFORE execution, then the terminal outcome.
 * The plaintext body is HASHED, never stored — the log must not become a
 * transcript of everything typed into terminals. The log is never sent to a client.
 *
 * Durability and ordering, both load-bearing:
 *  - every append opens, writes, `fsync`s and closes before it resolves, so an
 *    `attempted` line is on the platter before the keystroke reaches the pty;
 *  - appends are serialised through one promise chain, so two concurrent writes
 *    can never interleave a partial line or race a rotation.
 *
 * All of that runs on `node:fs/promises` (libuv threadpool). It must NEVER be
 * converted to the sync API: blocking fs on the main thread starves the
 * renderer's `superset-app://` loader and the window stays blank for minutes.
 *
 * Rotation: one file per UTC day, rolled to `YYYY-MM-DD.NN.jsonl` past a size
 * cap, pruned at 90 days. Daily files alone do not bound the log — a runaway
 * caller could fill the disk inside one day — so both limits exist.
 */

import { createHash } from "node:crypto";
import { open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { AUDIT_RETENTION_DAYS, fileSizeBytes, LOG_PREFIX } from "./config";
import type { AuditEntry } from "./types";

/** Roll to a new segment past this many bytes. 30–80 writes/day never reach it. */
export const AUDIT_SEGMENT_MAX_BYTES = 8 * 1024 * 1024;

/** `YYYY-MM-DD.jsonl` or `YYYY-MM-DD.7.jsonl`. Nothing else is ours; nothing else is pruned. */
const AUDIT_FILE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?\.jsonl$/;

const DAY_MS = 86_400_000;

export interface AuditLog {
	/** Appends one line to `audit/YYYY-MM-DD.jsonl` and fsyncs BEFORE returning. */
	append(entry: AuditEntry): Promise<void>;
	/** Deletes files older than the 90-day retention. */
	prune(nowMs: number): Promise<number>;
}

export function createAuditLog(auditDir: string): AuditLog {
	if (typeof auditDir !== "string" || auditDir.length === 0) {
		throw new Error(`${LOG_PREFIX} createAuditLog requires an audit directory`);
	}

	// One chain, so appends are strictly ordered and a rotation decision can
	// never be made concurrently with the write it is deciding about.
	let tail: Promise<void> = Promise.resolve();

	const appendSerialised = (line: string): Promise<void> => {
		const next = tail.then(() => writeLine(auditDir, line));
		// Keep the chain alive after a rejection; the caller still sees the error.
		tail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};

	return {
		async append(entry: AuditEntry): Promise<void> {
			assertAuditEntry(entry);
			await appendSerialised(`${JSON.stringify(entry)}\n`);
		},

		async prune(nowMs: number): Promise<number> {
			if (!Number.isFinite(nowMs)) {
				throw new Error(`${LOG_PREFIX} audit prune requires a finite nowMs`);
			}
			const cutoffMs = nowMs - AUDIT_RETENTION_DAYS * DAY_MS;
			let removed = 0;
			const names = await readdir(auditDir);
			for (const name of names) {
				const match = AUDIT_FILE_PATTERN.exec(name);
				if (!match) continue;
				const dayMs = Date.UTC(
					Number(match[1]),
					Number(match[2]) - 1,
					Number(match[3]),
				);
				if (Number.isNaN(dayMs) || dayMs >= cutoffMs) continue;
				await unlink(join(auditDir, name));
				removed += 1;
			}
			return removed;
		},
	};
}

/** SHA-256 of the plaintext body, base64url. */
export function hashPayload(plaintext: Uint8Array): string {
	if (!(plaintext instanceof Uint8Array)) {
		throw new Error(`${LOG_PREFIX} hashPayload requires a Uint8Array`);
	}
	return createHash("sha256").update(plaintext).digest("base64url");
}

/** Convenience for callers holding a JSON body rather than the sealed plaintext. */
export function hashJsonPayload(body: unknown): string {
	return hashPayload(new TextEncoder().encode(JSON.stringify(body)));
}

// ---------------------------------------------------------------------------

async function writeLine(auditDir: string, line: string): Promise<void> {
	const file = await resolveSegment(auditDir, utcDayStamp(Date.now()));
	const handle = await open(file, "a", 0o600);
	try {
		await handle.write(line, null, "utf8");
		// The whole point of the `attempted` line is that it survives the crash
		// the injection might cause. Without the fsync it is a hint, not a record.
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function resolveSegment(auditDir: string, day: string): Promise<string> {
	const base = join(auditDir, `${day}.jsonl`);
	if ((await fileSizeBytes(base)) < AUDIT_SEGMENT_MAX_BYTES) return base;
	for (let index = 1; index < 10_000; index += 1) {
		const candidate = join(auditDir, `${day}.${index}.jsonl`);
		if ((await fileSizeBytes(candidate)) < AUDIT_SEGMENT_MAX_BYTES) {
			return candidate;
		}
	}
	throw new Error(
		`${LOG_PREFIX} audit rotation exhausted 10000 segments for ${day} — refusing to write`,
	);
}

function utcDayStamp(atMs: number): string {
	return new Date(atMs).toISOString().slice(0, 10);
}

/**
 * Validate at the boundary: a malformed audit entry must fail the WRITE it
 * describes, not be silently normalised into an unreadable record. Every field
 * of §14 is required and present — `null` is a value, absence is a bug.
 */
function assertAuditEntry(entry: AuditEntry): void {
	const required: Array<[string, boolean]> = [
		["tsMs", Number.isInteger(entry.tsMs)],
		["kind", typeof entry.kind === "string" && entry.kind.length > 0],
		[
			"deviceId",
			typeof entry.deviceId === "string" && entry.deviceId.length > 0,
		],
		["surface", entry.surface === "phone" || entry.surface === "watch"],
		[
			"requestId",
			typeof entry.requestId === "string" && entry.requestId.length > 0,
		],
		["leaseId", entry.leaseId === null || typeof entry.leaseId === "string"],
		[
			"questionId",
			entry.questionId === null || typeof entry.questionId === "string",
		],
		[
			"terminalId",
			entry.terminalId === null || typeof entry.terminalId === "string",
		],
		["guards", entry.guards === null || typeof entry.guards === "object"],
		[
			"payloadHash",
			typeof entry.payloadHash === "string" && entry.payloadHash.length > 0,
		],
		["outcome", typeof entry.outcome === "string" && entry.outcome.length > 0],
		[
			"failureCode",
			entry.failureCode === null || typeof entry.failureCode === "string",
		],
	];
	const bad = required.filter(([, ok]) => !ok).map(([name]) => name);
	if (bad.length > 0) {
		throw new Error(
			`${LOG_PREFIX} refusing to append a malformed audit entry — invalid field(s): ${bad.join(", ")}`,
		);
	}
}
