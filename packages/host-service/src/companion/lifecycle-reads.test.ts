import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runMigrations } from "@superset/shared/sqlite-migrations";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { HostDb } from "../db";
import * as schema from "../db/schema";
import { createLifecycleReads } from "./lifecycle-reads";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../drizzle");

const roots: string[] = [];
const openDbs = new Set<Database>();

/**
 * createDb runs on better-sqlite3, which Bun cannot load, so the migrated
 * schema is opened through bun:sqlite instead. The durability check calls
 * better-sqlite3's `pragma`, so the handle gets that one method.
 */
function openReads() {
	const root = mkdtempSync(join(tmpdir(), "lifecycle-reads-"));
	roots.push(root);
	const sqlite = new Database(join(root, "host.db"));
	openDbs.add(sqlite);
	sqlite.exec("PRAGMA journal_mode = WAL");
	sqlite.exec("PRAGMA synchronous = FULL");
	const client = Object.assign(sqlite, {
		pragma: (source: string, options?: { simple?: boolean }) => {
			const rows = sqlite.prepare(`PRAGMA ${source}`).all() as Record<
				string,
				unknown
			>[];
			return options?.simple ? Object.values(rows[0] ?? {})[0] : rows;
		},
	});
	const bunDb = drizzle(client, { schema });
	runMigrations(bunDb, MIGRATIONS_FOLDER);
	// bun:sqlite's drizzle type differs from the better-sqlite3-based HostDb,
	// but the query surface used here is identical (same cast as other tests).
	const db = bunDb as unknown as HostDb;
	db.insert(schema.terminalSessions).values({ id: "terminal-1" }).run();
	return { sqlite, reads: createLifecycleReads({ db }) };
}

afterEach(() => {
	for (const sqlite of openDbs) sqlite.close();
	openDbs.clear();
	for (const root of roots.splice(0)) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				error.code !== "EBUSY"
			) {
				throw error;
			}
		}
	}
});

describe("lifecycle reads", () => {
	it("rises, and an equal or lower report changes no row", () => {
		const { sqlite, reads } = openReads();
		const totalChanges = () =>
			(sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
		expect(reads.readThroughAt("terminal-1")).toBe(0);

		const changesAtStart = totalChanges();
		reads.advance("terminal-1", 1_790_000_000_000);
		reads.advance("terminal-1", 1_790_000_000_500);
		expect(totalChanges()).toBe(changesAtStart + 2);
		expect(reads.readThroughAt("terminal-1")).toBe(1_790_000_000_500);

		const changesBefore = totalChanges();
		reads.advance("terminal-1", 1_790_000_000_500);
		reads.advance("terminal-1", 1_790_000_000_000);
		expect(totalChanges()).toBe(changesBefore);
		expect(reads.readThroughAt("terminal-1")).toBe(1_790_000_000_500);
	});

	it("refuses a mark that is not a 13-digit ms instant", () => {
		const { reads } = openReads();
		for (const bad of [1, 999_999_999_999, 10_000_000_000_000, 1.5e12 + 0.5]) {
			expect(() => reads.advance("terminal-1", bad)).toThrow(TypeError);
		}
		expect(reads.readThroughAt("terminal-1")).toBe(0);
	});
});
