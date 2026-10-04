import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runMigrations } from "@superset/shared/sqlite-migrations";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

/**
 * createDb runs on better-sqlite3, which Bun cannot load. bun:sqlite drives
 * the identical code path (both are sync sessions on SQLiteSyncDialect), so
 * these arms reproduce what a real host.db does.
 */

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../drizzle");

/**
 * The two migrations HOST-SERVICE-53/54 came in without. A build carrying
 * 0028 but neither of these — a branch cut before they merged — leaves the
 * watermark above both, and drizzle's migrator never runs them again.
 */
const LOST = ["0026_workspace_tags", "0027_workspace_tag_settings"];
const LAST_SHIPPED_WITH_THEM_LOST = "0028_funny_gideon";

type Journal = {
	entries: { idx: number; version: string; when: number; tag: string }[];
};

function readJournal(folder: string): Journal {
	return JSON.parse(
		readFileSync(join(folder, "meta/_journal.json"), "utf8"),
	) as Journal;
}

const tempDirs: string[] = [];

/** The real migration folder, minus `omit`, truncated after `through`. */
function folderWithout(options: { omit: string[]; through: string }): string {
	const journal = readJournal(MIGRATIONS_FOLDER);
	const end = journal.entries.findIndex(
		(entry) => entry.tag === options.through,
	);
	expect(end).toBeGreaterThan(-1);
	return folderOf(
		journal.entries
			.slice(0, end + 1)
			.filter((entry) => !options.omit.includes(entry.tag)),
	);
}

function folderOf(entries: Journal["entries"]): string {
	const dir = mkdtempSync(join(tmpdir(), "host-migrations-"));
	tempDirs.push(dir);
	mkdirSync(join(dir, "meta"));
	for (const entry of entries) {
		copyFileSync(
			join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
			join(dir, `${entry.tag}.sql`),
		);
	}
	writeFileSync(
		join(dir, "meta/_journal.json"),
		JSON.stringify({ version: "7", dialect: "sqlite", entries }),
	);
	return dir;
}

function open(): Database {
	const sqlite = new Database(":memory:");
	// What createDb does while migrating, for the same reason.
	sqlite.exec("PRAGMA foreign_keys = OFF");
	return sqlite;
}

function tables(sqlite: Database): string[] {
	return (
		sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all() as { name: string }[]
	).map((row) => row.name);
}

describe("host.db migrations", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("drizzle's migrator cannot recover a database that lost them", () => {
		const sqlite = open();
		migrate(drizzle(sqlite), {
			migrationsFolder: folderWithout({
				omit: LOST,
				through: LAST_SHIPPED_WITH_THEM_LOST,
			}),
		});
		expect(tables(sqlite)).not.toContain("workspace_tags");

		// Every later release carries both, and both stay below the watermark.
		// 0029 reads workspace_tag_settings to fold it into tag_folder_settings,
		// so from that release on the host-service cannot even start: createDb
		// lets a failed migration throw rather than serve a half-migrated DB.
		expect(() =>
			migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER }),
		).toThrow("workspace_tag_settings");
	});

	test("the runner heals a database that lost them", () => {
		const sqlite = open();
		migrate(drizzle(sqlite), {
			migrationsFolder: folderWithout({
				omit: LOST,
				through: LAST_SHIPPED_WITH_THEM_LOST,
			}),
		});

		runMigrations(drizzle(sqlite), MIGRATIONS_FOLDER);

		// workspace.list and project.list read these two.
		expect(tables(sqlite)).toContain("workspace_tags");
		expect(tables(sqlite)).toContain("tag_folder_settings");
		expect(() =>
			sqlite.prepare("SELECT * FROM workspace_tags").all(),
		).not.toThrow();
	});

	test("the runner applies the whole set to a fresh database", () => {
		const sqlite = open();

		runMigrations(drizzle(sqlite), MIGRATIONS_FOLDER);

		expect(tables(sqlite)).toContain("workspaces");
		expect(tables(sqlite)).toContain("workspace_tags");
		expect(tables(sqlite)).toContain("tag_folder_settings");
	});

	test("every shipped journal entry has a distinct `when`", () => {
		// The runner identifies applied migrations by `when`. Two entries sharing
		// one would let a real migration be mistaken for an applied one.
		const whens = readJournal(MIGRATIONS_FOLDER).entries.map(
			(entry) => entry.when,
		);

		expect(new Set(whens).size).toBe(whens.length);
	});

	test("the fork's claude account controls land on fresh and existing databases", () => {
		const expectControls = (sqlite: Database) => {
			const columns = sqlite.prepare("PRAGMA table_info(workspaces)").all() as {
				name: string;
				notnull: number;
				dflt_value: string | null;
			}[];
			expect(
				columns.find((c) => c.name === "claude_auto_switch"),
			).toMatchObject({ notnull: 1, dflt_value: "1" });
			expect(
				columns.find((c) => c.name === "claude_schedule_fired_at"),
			).toMatchObject({ notnull: 0, dflt_value: null });
			expect(tables(sqlite)).toContain("claude_account_schedules");
			expect(
				sqlite
					.prepare("PRAGMA foreign_key_list(claude_account_schedules)")
					.all(),
			).toMatchObject([
				{
					table: "workspaces",
					from: "workspace_id",
					to: "id",
					on_delete: "CASCADE",
				},
			]);
		};

		const fresh = open();
		runMigrations(drizzle(fresh), MIGRATIONS_FOLDER);
		expectControls(fresh);

		const existing = open();
		runMigrations(
			drizzle(existing),
			folderWithout({ omit: [], through: "0035_local_workspaces" }),
		);
		existing.exec(
			"INSERT INTO projects (id, repo_path, created_at) VALUES ('p1', '/repo', 1)",
		);
		existing.exec(
			"INSERT INTO workspaces (id, project_id, worktree_path, branch, created_at) VALUES ('w1', 'p1', '/repo', 'main', 1)",
		);
		runMigrations(drizzle(existing), MIGRATIONS_FOLDER);
		expectControls(existing);
		expect(
			existing
				.prepare(
					"SELECT claude_auto_switch, claude_schedule_fired_at FROM workspaces WHERE id = 'w1'",
				)
				.get(),
		).toEqual({ claude_auto_switch: 1, claude_schedule_fired_at: null });
	});

	test("later migrations preserve the fork's claude account controls", () => {
		const journal = readJournal(MIGRATIONS_FOLDER);
		const cutoff = journal.entries.find(
			(entry) => entry.tag === "0035_local_workspaces",
		);
		if (!cutoff) throw new Error("0035_local_workspaces is not in the journal");
		const sqlite = open();
		runMigrations(
			drizzle(sqlite),
			folderOf(
				journal.entries.filter(
					(entry) =>
						entry.when <= cutoff.when ||
						entry.tag === "0036_fork_claude_account_controls",
				),
			),
		);
		sqlite.exec(
			"INSERT INTO projects (id, repo_path, created_at) VALUES ('p1', '/repo', 1)",
		);
		sqlite.exec(
			"INSERT INTO workspaces (id, project_id, worktree_path, branch, created_at, claude_auto_switch, claude_schedule_fired_at) VALUES ('w1', 'p1', '/repo', 'main', 1, 0, 1234)",
		);
		sqlite.exec(
			"INSERT INTO claude_account_schedules (workspace_id, schedule_id, target_slug, fire_at, status, failed_at, failure, last_error) VALUES ('w1', 's1', 'claude123', 5678, 'failed', 9012, 'pi-unavailable', 'Pi request /accounts failed')",
		);

		runMigrations(drizzle(sqlite), MIGRATIONS_FOLDER);

		expect(
			sqlite
				.prepare(
					"SELECT claude_auto_switch, claude_schedule_fired_at FROM workspaces WHERE id = 'w1'",
				)
				.get(),
		).toEqual({ claude_auto_switch: 0, claude_schedule_fired_at: 1234 });
		expect(
			sqlite.prepare("SELECT * FROM claude_account_schedules").all(),
		).toEqual([
			{
				workspace_id: "w1",
				schedule_id: "s1",
				target_slug: "claude123",
				fire_at: 5678,
				status: "failed",
				failed_at: 9012,
				failure: "pi-unavailable",
				last_error: "Pi request /accounts failed",
			},
		]);
	});
});
