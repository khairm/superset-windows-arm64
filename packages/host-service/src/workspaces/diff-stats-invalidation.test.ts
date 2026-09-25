import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { HostDb } from "../db";
import * as schema from "../db/schema";
import { workspaces } from "../db/schema";
import type { EventBus } from "../events";
import { emptyGitStatusSnapshot } from "../trpc/router/git/utils/git-status";
import { gitStatusStore } from "../trpc/router/git/utils/git-status-store";
import {
	archiveLocalWorkspace,
	deleteLocalWorkspace,
	unarchiveLocalWorkspace,
} from "./local-workspace-store";

// (DIFFSTATS-COLD-CACHE)
test("idle workspace deletion and archive invalidate cold diff stats", async () => {
	const sqlite = new Database(":memory:");
	const drizzled = drizzle(sqlite, { schema });
	migrate(drizzled, {
		migrationsFolder: resolve(import.meta.dir, "../../drizzle"),
	});
	const db = drizzled as unknown as HostDb;
	const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const eventBus = {
		broadcastWorkspaceChanged: () => {},
	} as unknown as EventBus;
	const insert = () =>
		db
			.insert(workspaces)
			.values({
				id: workspaceId,
				projectId: null,
				worktreePath: "/same/repository",
				branch: "feature",
				name: "feature",
			})
			.run();
	let fullReads = 0;
	const input = {
		workspaceId,
		baseBranch: null,
		coldCache: {
			worktreePath: "/same/repository",
			directoryId: "same-directory",
		},
		computeFull: async () => {
			fullReads++;
			return emptyGitStatusSnapshot();
		},
		computePartial: async () => {
			throw new Error("cold reads must use full snapshots");
		},
	};
	try {
		insert();
		await gitStatusStore.read(input);
		await gitStatusStore.read(input);
		expect(fullReads).toBe(1);

		deleteLocalWorkspace({ db, eventBus }, workspaceId);
		insert();
		await gitStatusStore.read(input);
		expect(fullReads).toBe(2);

		archiveLocalWorkspace({ db, eventBus }, workspaceId, "deleted");
		unarchiveLocalWorkspace({ db, eventBus }, workspaceId);
		await gitStatusStore.read(input);
		expect(fullReads).toBe(3);

		// (DIFFSTATS-COLD-CACHE)
		gitStatusStore.attach(workspaceId);
		const foreground = { ...input, coldCache: undefined };
		await gitStatusStore.read(foreground);
		expect(fullReads).toBe(4);
		archiveLocalWorkspace({ db, eventBus }, workspaceId, "deleted");
		await gitStatusStore.read(foreground);
		expect(fullReads).toBe(4);
	} finally {
		gitStatusStore.drop(workspaceId);
		sqlite.close();
	}
});
