import { Database as BunDatabase } from "bun:sqlite";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { HostDb } from "../../src/db";
import * as schema from "../../src/db/schema";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../drizzle");

export function createMigratedTestDb(dbPath: string): {
	sqlite: BunDatabase;
	db: HostDb;
} {
	const sqlite = new BunDatabase(dbPath, { create: true, readwrite: true });
	try {
		sqlite.exec("PRAGMA journal_mode = WAL");
		sqlite.exec("PRAGMA foreign_keys = ON");
		const db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
		return { sqlite, db: db as unknown as HostDb };
	} catch (error) {
		sqlite.close();
		throw error;
	}
}
