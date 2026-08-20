/**
 * (MASTER-ALWAYS-ACTIVE) The boot sweep has to be able to rebuild a LOST main
 * workspace for a NON-GIT project too.
 *
 * `ensureMainWorkspaceStrict` reads git HEAD before it looks for an existing
 * row, so a sweep that omits `nonGit` throws PRECONDITION_FAILED on a plain
 * folder — and the log-and-continue wrapper swallows it silently, so the
 * project stays main-less forever. These tests assert the sweep DECLARES
 * git-ness rather than assuming it.
 *
 * The probe is TRI-state. A probe that THROWS is not a "no": reading a failed
 * probe as non-git let one broken git binary rewrite every existing git
 * master's branch to `NON_GIT_BRANCH` in a single boot. An unknown answer
 * skips the row and writes nothing.
 *
 * Two layers. `classifyMainSweepRow` is driven directly with a fake probe —
 * that is what it takes one for. `runMainWorkspaceSweep` is driven end-to-end
 * against the REAL probe and the real db; the real strict probe fails
 * deterministically when `repoPath` names a file rather than a directory,
 * which is how the throwing cases stay end-to-end.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { HostDb } from "../db";
import * as schema from "../db/schema";
import { projects, workspaces } from "../db/schema";
import type { EnsureMainWorkspaceContext } from "../trpc/router/project/utils/ensure-main-workspace";
import { NON_GIT_BRANCH } from "./git/non-git";
import {
	classifyMainSweepRow,
	runMainWorkspaceSweep,
} from "./main-workspace-sweep";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../drizzle");

function createTestDb(): HostDb {
	const sqlite = new Database(":memory:");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	// bun:sqlite's drizzle type differs from the better-sqlite3-based HostDb,
	// but the query surface used here is identical (same cast as other tests).
	return db as unknown as HostDb;
}

/**
 * A git object that only answers `symbolic-ref --short HEAD`. Reaching it at
 * all is the assertion: the sweep only takes the git branch-reading path when
 * it has decided the project IS a repo.
 */
function createContext(db: HostDb): {
	ctx: EnsureMainWorkspaceContext;
	gitPaths: string[];
} {
	const gitPaths: string[] = [];
	const eventBus = new Proxy({}, { get: () => () => {} });
	const ctx = {
		db,
		eventBus,
		git: async (path: string) => {
			gitPaths.push(path);
			return { raw: async () => "feature-x\n" };
		},
	} as unknown as EnsureMainWorkspaceContext;
	return { ctx, gitPaths };
}

function createProbe(result: boolean): {
	probe: (path: string) => Promise<boolean>;
	calls: string[];
} {
	const calls: string[] = [];
	const probe = async (path: string) => {
		calls.push(path);
		return result;
	};
	return { probe, calls };
}

/**
 * A probe that FAILS — the broken-git-binary case. Distinct from
 * `createProbe(false)`, which is a probe that succeeded and said "not a repo".
 */
function createThrowingProbe(): {
	probe: (path: string) => Promise<boolean>;
	calls: string[];
} {
	const calls: string[] = [];
	const probe = async (path: string) => {
		calls.push(path);
		throw new Error("git: command not found");
	};
	return { probe, calls };
}

/** A real git repo — the real strict probe answers `true` for it. */
function makeGitDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	execFileSync("git", ["init", "-q", dir]);
	return dir;
}

/** A plain folder — the real strict probe answers `false` for it. */
function makePlainDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A path that EXISTS but is a file, so it clears the existence gate and then
 * makes the real strict probe THROW ("Cannot use simple-git on a directory
 * that does not exist"). Stands in for the broken-git-binary case end-to-end.
 */
function makeProbeFailingPath(prefix: string): string {
	const path = join(makePlainDir(prefix), "not-a-directory");
	writeFileSync(path, "");
	return path;
}

function insertProject(db: HostDb, repoPath: string): string {
	const id = randomUUID();
	db.insert(projects)
		.values({ id, repoPath, name: "Project", updatedAt: 1 })
		.run();
	return id;
}

function setRepoPath(db: HostDb, projectId: string, repoPath: string): void {
	db.update(projects).set({ repoPath }).where(eq(projects.id, projectId)).run();
}

function readMain(db: HostDb, projectId: string) {
	return db
		.select()
		.from(workspaces)
		.where(
			and(eq(workspaces.projectId, projectId), eq(workspaces.type, "main")),
		)
		.all();
}

describe("(MASTER-ALWAYS-ACTIVE) classifyMainSweepRow", () => {
	test("a repo takes the git path", async () => {
		const { probe, calls } = createProbe(true);

		const decision = await classifyMainSweepRow(
			"/repo",
			false,
			() => true,
			probe,
		);

		expect(decision).toEqual({
			action: "ensure",
			repoPath: "/repo",
			nonGit: false,
		});
		expect(calls).toEqual(["/repo"]);
	});

	test("a provably-not-a-repo declares nonGit", async () => {
		const { probe, calls } = createProbe(false);

		const decision = await classifyMainSweepRow(
			"/plain",
			false,
			() => true,
			probe,
		);

		expect(decision).toEqual({
			action: "ensure",
			repoPath: "/plain",
			nonGit: true,
		});
		expect(calls).toEqual(["/plain"]);
	});

	test("a FAILED probe is skipped, never read as non-git", async () => {
		const { probe } = createThrowingProbe();

		const decision = await classifyMainSweepRow(
			"/repo",
			false,
			() => true,
			probe,
		);

		expect(decision).toMatchObject({
			action: "skip",
			reason: "gitness-unknown",
		});
	});

	test("a repoPath that is gone is skipped before the probe runs", async () => {
		const { probe, calls } = createProbe(true);

		const decision = await classifyMainSweepRow(
			"/gone",
			false,
			() => false,
			probe,
		);

		expect(decision).toEqual({ action: "skip", reason: "path-missing" });
		expect(calls).toEqual([]);
	});

	test("an empty repoPath is skipped before anything is touched", async () => {
		const { probe, calls } = createProbe(true);
		const existsCalls: string[] = [];

		const decision = await classifyMainSweepRow(
			"",
			false,
			(path) => {
				existsCalls.push(path);
				return true;
			},
			probe,
		);

		expect(decision).toEqual({ action: "skip", reason: "path-missing" });
		expect(existsCalls).toEqual([]);
		expect(calls).toEqual([]);
	});

	test("an existing git-branch main skips the probe entirely", async () => {
		const { probe, calls } = createThrowingProbe();

		// The row already records a successful git-ness answer, so no git is
		// spawned to re-learn it — and a probe that would have thrown never
		// gets the chance to skip the row.
		const decision = await classifyMainSweepRow(
			"/repo",
			true,
			() => true,
			probe,
		);

		expect(decision).toEqual({
			action: "ensure",
			repoPath: "/repo",
			nonGit: false,
		});
		expect(calls).toEqual([]);
	});
});

describe("(MASTER-ALWAYS-ACTIVE) runMainWorkspaceSweep", () => {
	test("a git project keeps deriving its branch from HEAD", async () => {
		const db = createTestDb();
		const repoPath = makeGitDir("sweep-git-");
		const projectId = insertProject(db, repoPath);
		const { ctx, gitPaths } = createContext(db);

		await runMainWorkspaceSweep(ctx);

		// Git path taken: HEAD was read, and the branch came from it.
		expect(gitPaths).toEqual([repoPath]);
		const rows = readMain(db, projectId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.branch).toBe("feature-x");
		expect(rows[0]?.worktreePath).toBe(repoPath);
	});

	test("a non-git project gets a main workspace instead of a swallowed throw", async () => {
		const db = createTestDb();
		const repoPath = makePlainDir("sweep-nongit-");
		const projectId = insertProject(db, repoPath);
		const { ctx, gitPaths } = createContext(db);

		await runMainWorkspaceSweep(ctx);

		// No git command may be issued for a folder that is not a repo.
		expect(gitPaths).toEqual([]);
		const rows = readMain(db, projectId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.branch).toBe(NON_GIT_BRANCH);
		expect(rows[0]?.name).toBe(basename(repoPath));
	});

	test("mixed projects are each judged on their own path", async () => {
		const db = createTestDb();
		const gitProjectId = insertProject(db, makeGitDir("sweep-mixed-git-"));
		const plainProjectId = insertProject(
			db,
			makePlainDir("sweep-mixed-plain-"),
		);
		const { ctx } = createContext(db);

		await runMainWorkspaceSweep(ctx);

		expect(readMain(db, gitProjectId)[0]?.branch).toBe("feature-x");
		expect(readMain(db, plainProjectId)[0]?.branch).toBe(NON_GIT_BRANCH);
	});

	test("is idempotent — a second sweep adds no second main", async () => {
		const db = createTestDb();
		const projectId = insertProject(db, makePlainDir("sweep-idem-"));
		const { ctx } = createContext(db);

		await runMainWorkspaceSweep(ctx);
		await runMainWorkspaceSweep(ctx);

		expect(readMain(db, projectId)).toHaveLength(1);
	});

	test("a missing repoPath writes nothing", async () => {
		const db = createTestDb();
		const missing = join(tmpdir(), `sweep-missing-${randomUUID()}`);
		const projectId = insertProject(db, missing);
		const { ctx, gitPaths } = createContext(db);

		await runMainWorkspaceSweep(ctx);

		expect(gitPaths).toEqual([]);
		expect(readMain(db, projectId)).toHaveLength(0);
	});

	test("an empty repoPath writes nothing", async () => {
		const db = createTestDb();
		const projectId = insertProject(db, "");
		const { ctx } = createContext(db);

		await runMainWorkspaceSweep(ctx);

		expect(readMain(db, projectId)).toHaveLength(0);
	});

	test("a FAILED probe creates nothing for a project that has no main yet", async () => {
		const db = createTestDb();
		const projectId = insertProject(
			db,
			makeProbeFailingPath("sweep-throws-fresh-"),
		);
		const { ctx, gitPaths } = createContext(db);

		await runMainWorkspaceSweep(ctx);

		expect(gitPaths).toEqual([]);
		expect(readMain(db, projectId)).toHaveLength(0);
	});

	test("a FAILED probe leaves an existing non-git main's row exactly as it was", async () => {
		const db = createTestDb();
		const repoPath = makePlainDir("sweep-probe-throws-");
		const projectId = insertProject(db, repoPath);
		const { ctx } = createContext(db);

		// Boot 1: healthy probe builds the non-git main.
		await runMainWorkspaceSweep(ctx);
		const before = readMain(db, projectId)[0];
		expect(before?.branch).toBe(NON_GIT_BRANCH);

		// Boot 2: the probe blows up. The row must not be touched — and this is
		// the row class the pre-probe fast path can NOT skip, because its branch
		// is the non-git marker rather than a recorded git-ness answer. Only the
		// tri-state protects it.
		setRepoPath(db, projectId, makeProbeFailingPath("sweep-probe-throws-2-"));
		await runMainWorkspaceSweep(ctx);

		const after = readMain(db, projectId);
		expect(after).toHaveLength(1);
		expect(after[0]?.id).toBe(before?.id as string);
		expect(after[0]?.branch).toBe(NON_GIT_BRANCH);
		expect(after[0]?.worktreePath).toBe(repoPath);
		expect(after[0]?.name).toBe(before?.name as string);
	});

	test("one project's failed probe does not stop the next project", async () => {
		const db = createTestDb();
		const brokenProjectId = insertProject(
			db,
			makeProbeFailingPath("sweep-mixed-broken-"),
		);
		const plainProjectId = insertProject(db, makePlainDir("sweep-mixed-ok-"));
		const { ctx } = createContext(db);

		await runMainWorkspaceSweep(ctx);

		expect(readMain(db, brokenProjectId)).toHaveLength(0);
		expect(readMain(db, plainProjectId)[0]?.branch).toBe(NON_GIT_BRANCH);
	});
});
