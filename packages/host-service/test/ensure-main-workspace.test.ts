import { Database as BunDatabase } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { HostDb } from "../src/db";
import * as schema from "../src/db/schema";
import { projects, workspaces } from "../src/db/schema";
import type { EventBus } from "../src/events";
import { ensureMainWorkspaceStrict } from "../src/trpc/router/project/utils/ensure-main-workspace";
import { adoptExistingWorktree } from "../src/trpc/router/workspace-creation/shared/adopt-existing-worktree";
import type { HostServiceContext } from "../src/types";
import { insertLocalWorkspace } from "../src/workspaces/local-workspace-store";
import { createFakeClaudeAccountsService } from "./helpers/claude-accounts-fixture";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../drizzle");
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const REPO_PATH = "/repo";

function makeDb(): HostDb {
	const dir = mkdtempSync(join(tmpdir(), "ensure-main-"));
	const sqlite = new BunDatabase(join(dir, "host.db"), {
		create: true,
		readwrite: true,
	});
	sqlite.exec("PRAGMA foreign_keys = ON");
	const db = drizzle(sqlite, { schema }) as unknown as HostDb;
	migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
	db.insert(projects).values({ id: "p-1", repoPath: REPO_PATH }).run();
	return db;
}

function makeCtx(db: HostDb) {
	const eventBus = {
		broadcastWorkspaceChanged: mock(() => {}),
	} as unknown as EventBus;
	// Git stub: report a branch so the detached-HEAD guard passes.
	const git = mock(async () => ({
		raw: mock(async () => "feat/main\n"),
		revparse: mock(async () => "feat/main"),
	}));
	// host.ensure resolves; v2Workspace.create echoes the id back so no relink.
	const api = {
		host: { ensure: { mutate: mock(async () => ({ machineId: "m1" })) } },
		v2Workspace: {
			create: {
				mutate: mock(async (input: { id?: string }) => ({
					id: input.id,
					organizationId: ORG_ID,
					projectId: "p-1",
					hostId: "m1",
					name: "feat/main",
					branch: "feat/main",
					type: "main",
					createdByUserId: null,
					taskId: null,
					createdAt: new Date(),
					updatedAt: new Date(),
					txid: 1,
				})),
			},
			updateNameFromHost: { mutate: mock(async () => ({})) },
		},
	} as never;
	return {
		api,
		db,
		git: git as never,
		organizationId: ORG_ID,
		clientMachineId: "m1",
		eventBus,
		claudeAccounts: createFakeClaudeAccountsService({
			pinWorkspaceToMachineDefault: mock(async (workspaceId: string) => {
				expect(eventBus.broadcastWorkspaceChanged).toHaveBeenCalled();
				db.update(workspaces)
					.set({ claudeAccountSlug: "claude123" })
					.where(eq(workspaces.id, workspaceId))
					.run();
			}),
		}),
	};
}

describe("insertLocalWorkspace account activation", () => {
	for (const skipClaudeAccountPin of [undefined, true]) {
		test(`pins after broadcast and returns current state unless opted out: ${skipClaudeAccountPin}`, async () => {
			const ctx = makeCtx(makeDb());
			const row = await insertLocalWorkspace(ctx, {
				projectId: "p-1",
				worktreePath: REPO_PATH,
				branch: "feature",
				name: "feature",
				skipClaudeAccountPin,
			});
			expect(row.claudeAccountSlug).toBe(
				skipClaudeAccountPin === true ? null : "claude123",
			);
			expect(
				ctx.claudeAccounts.pinWorkspaceToMachineDefault,
			).toHaveBeenCalledTimes(skipClaudeAccountPin === true ? 0 : 1);
		});
	}
});

describe("explicit adoption account opt-out", () => {
	for (const existingWorkspaceId of [
		undefined,
		"11111111-1111-4111-8111-111111111111",
	]) {
		test(`keeps newly adopted rows Following: ${existingWorkspaceId}`, async () => {
			const ctx = makeCtx(makeDb());
			const { workspace } = await adoptExistingWorktree({
				ctx: ctx as unknown as HostServiceContext,
				git: {} as never,
				projectId: "p-1",
				branch: "adopted",
				worktreePath: "/adopted",
				workspaceName: "adopted",
				existingWorkspaceId,
				skipClaudeAccountPin: true,
			});
			expect(
				ctx.db.query.workspaces
					.findFirst({ where: eq(workspaces.id, workspace.id) })
					.sync()?.claudeAccountSlug,
			).toBeNull();
			expect(
				ctx.claudeAccounts.pinWorkspaceToMachineDefault,
			).not.toHaveBeenCalled();
		});
	}
});

describe("ensureMainWorkspaceStrict", () => {
	test("creates the main row when none exists", async () => {
		const db = makeDb();
		const { id } = await ensureMainWorkspaceStrict(
			makeCtx(db),
			"p-1",
			REPO_PATH,
		);
		const row = db.query.workspaces
			.findFirst({ where: eq(workspaces.id, id) })
			.sync();
		expect(row?.type).toBe("main");
		expect(row?.projectId).toBe("p-1");
		expect(row?.claudeAccountSlug).toBe("claude123");
	});

	test("idempotent: a second call returns the same main, never a duplicate", async () => {
		const db = makeDb();
		const ctx = makeCtx(db);
		const first = await ensureMainWorkspaceStrict(ctx, "p-1", REPO_PATH);
		const second = await ensureMainWorkspaceStrict(ctx, "p-1", REPO_PATH);
		expect(second.id).toBe(first.id);
		expect(
			ctx.claudeAccounts.pinWorkspaceToMachineDefault,
		).toHaveBeenCalledTimes(1);
		expect(
			db
				.select()
				.from(workspaces)
				.all()
				.filter((w) => w.type === "main").length,
		).toBe(1);
	});

	test("returns the winner instead of throwing when the pre-check misses a concurrent create", async () => {
		const db = makeDb();
		// The race winner already committed a main for this project.
		const ctx = makeCtx(db);
		const winner = await insertLocalWorkspace(ctx, {
			projectId: "p-1",
			worktreePath: REPO_PATH,
			branch: "feat/main",
			name: "feat/main",
			type: "main",
		});

		// Simulate TOCTOU: force the pre-check `findFirst` to miss ONCE (as if
		// the winner hadn't committed yet), so the insert path runs and hits
		// the one-main-per-project unique index. The catch must re-query and
		// return the winner rather than throw the raw SQLITE_CONSTRAINT.
		const realFindFirst = ctx.db.query.workspaces.findFirst;
		let missed = false;
		ctx.db.query.workspaces.findFirst = ((...args: unknown[]) => {
			if (!missed) {
				missed = true;
				return { sync: () => undefined };
			}
			return (realFindFirst as (...a: unknown[]) => unknown).apply(
				ctx.db.query.workspaces,
				args,
			);
		}) as typeof realFindFirst;

		const { id } = await ensureMainWorkspaceStrict(ctx, "p-1", REPO_PATH);
		expect(missed).toBe(true); // the seam actually fired
		expect(id).toBe(winner.id);
		expect(
			db
				.select()
				.from(workspaces)
				.all()
				.filter((w) => w.type === "main" && w.projectId === "p-1").length,
		).toBe(1);
	});
});
