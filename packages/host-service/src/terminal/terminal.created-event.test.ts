/**
 * (MASTER-PLUS-LAUNCH) A terminal session that is CREATED must say so on the
 * event bus.
 *
 * Before this event the `terminal:lifecycle` union was exit / command-start /
 * command-end, and the two command markers come from an OSC 133 scanner that
 * is only instrumented for zsh/bash/fish/pwsh — cmd.exe, this fork's supported
 * Windows fallback shell, feeds it nothing. So a session minted after its
 * workspace was already open (`agents.run`, the CLI) broadcast NOTHING until it
 * exited, and the renderer's auto-adopt could never learn it existed.
 *
 * The daemon is the only thing stubbed. Everything else — the real host DB and
 * migrations, the real env/shell resolution, the real session bookkeeping — is
 * the production code path, so this asserts the broadcast happens where the
 * session really becomes real, not where a mock says it does.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { HostDb } from "../db";
import * as schema from "../db/schema";
import { projects, workspaces } from "../db/schema";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../drizzle");

interface LifecycleEvent {
	workspaceId: string;
	terminalId: string;
	eventType: string;
	adopted?: boolean;
	occurredAt: number;
}

const broadcasts: LifecycleEvent[] = [];
const opened: string[] = [];
/** Ids the fake daemon reports as already-alive, driving the adopt path. */
const aliveSessions = new Map<string, { pid: number }>();

const realSingleton = await import("./daemon-client-singleton.ts");

/**
 * `mock.module` is PROCESS-GLOBAL with no unmock, so the real module is
 * re-exported whole with a single override — nothing else in a `bun test` run
 * loses an export because of this file. Nothing else under `bun test` connects
 * to a daemon (the end-to-end paths are `*.node-test.ts`, run separately).
 */
mock.module("./daemon-client-singleton.ts", () => ({
	...realSingleton,
	getDaemonClient: async () => ({
		protocol: 0,
		open: async (id: string) => {
			opened.push(id);
			return { pid: 4242 };
		},
		list: async () =>
			Array.from(aliveSessions.entries()).map(([id, entry]) => ({
				id,
				pid: entry.pid,
				alive: true,
				cols: 120,
				rows: 40,
			})),
		// Subscribe is called once per session; the callbacks are never driven
		// here (no PTY exists to produce bytes).
		subscribe: () => () => {},
		input: () => {},
		resize: () => {},
		close: async () => {},
	}),
}));

const { initTerminalBaseEnv } = await import("./env.ts");
const { __resetSessionsForTesting, createTerminalSessionInternal } =
	await import("./terminal.ts");

let db: HostDb;
let workspaceId: string;
let worktreePath: string;
let home: string;

const eventBus = {
	broadcastTerminalLifecycle: (message: LifecycleEvent) => {
		broadcasts.push(message);
	},
} as unknown as Parameters<typeof createTerminalSessionInternal>[0]["eventBus"];

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "created-event-"));
	worktreePath = mkdtempSync(join(tmpdir(), "created-event-wt-"));
	process.env.SUPERSET_HOME_DIR = home;
	process.env.ORGANIZATION_ID = "org-created-event";
	initTerminalBaseEnv({
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? home,
		SHELL: process.env.SHELL ?? "/bin/sh",
	});

	const sqlite = new Database(":memory:");
	// bun:sqlite's drizzle type differs from the better-sqlite3-based HostDb,
	// but the query surface used here is identical (same cast as other tests).
	db = drizzle(sqlite, { schema }) as unknown as HostDb;
	migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });

	const projectId = randomUUID();
	workspaceId = randomUUID();
	db.insert(projects)
		.values({ id: projectId, repoPath: worktreePath, updatedAt: 1 })
		.run();
	db.insert(workspaces)
		.values({ id: workspaceId, projectId, worktreePath, branch: "main" })
		.run();
});

afterAll(() => {
	__resetSessionsForTesting();
	for (const dir of [home, worktreePath]) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
});

describe("(MASTER-PLUS-LAUNCH) createTerminalSessionInternal broadcasts created", () => {
	test("a fresh create announces the session on the lifecycle channel", async () => {
		broadcasts.length = 0;
		const terminalId = `created-${randomUUID().slice(0, 8)}`;

		const result = await createTerminalSessionInternal({
			terminalId,
			workspaceId,
			db,
			eventBus,
		});

		expect("error" in result).toBe(false);
		expect(broadcasts).toHaveLength(1);
		expect(broadcasts[0]).toMatchObject({
			workspaceId,
			terminalId,
			eventType: "created",
			adopted: false,
		});
		expect(typeof broadcasts[0]?.occurredAt).toBe("number");
	});

	test("an ADOPTED session announces itself too, flagged as adopted", async () => {
		broadcasts.length = 0;
		const terminalId = `adopted-${randomUUID().slice(0, 8)}`;
		aliveSessions.set(terminalId, { pid: 909 });

		const result = await createTerminalSessionInternal({
			terminalId,
			workspaceId,
			db,
			eventBus,
			adoptOnly: true,
		});

		expect("error" in result).toBe(false);
		expect(opened).not.toContain(terminalId);
		expect(broadcasts).toHaveLength(1);
		expect(broadcasts[0]).toMatchObject({
			terminalId,
			eventType: "created",
			adopted: true,
		});
		aliveSessions.delete(terminalId);
	});

	test("re-requesting a live session is not a create and stays silent", async () => {
		const terminalId = `resused-${randomUUID().slice(0, 8)}`;
		await createTerminalSessionInternal({
			terminalId,
			workspaceId,
			db,
			eventBus,
		});
		broadcasts.length = 0;

		await createTerminalSessionInternal({
			terminalId,
			workspaceId,
			db,
			eventBus,
		});

		expect(broadcasts).toEqual([]);
	});

	test("a refused create broadcasts nothing", async () => {
		broadcasts.length = 0;

		const result = await createTerminalSessionInternal({
			terminalId: `missing-ws-${randomUUID().slice(0, 8)}`,
			workspaceId: randomUUID(),
			db,
			eventBus,
		});

		expect("error" in result).toBe(true);
		expect(broadcasts).toEqual([]);
	});
});
