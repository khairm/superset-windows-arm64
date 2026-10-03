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
 * The daemon and the shell resolver are the only things stubbed. Everything
 * else — the real host DB and migrations, the real session bookkeeping — is
 * the production code path, so this asserts the broadcast happens where the
 * session really becomes real, not where a mock says it does.
 */

import { Database } from "bun:sqlite";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { ClaudeAccountsService } from "../claude-accounts";
import { registerClaudeAccountsService } from "../claude-accounts-runtime";
import type { HostDb } from "../db";
import * as schema from "../db/schema";
import { projects, workspaces } from "../db/schema";
import { DaemonOpenError } from "./DaemonClient/index.ts";
import type { SessionShellResolverForTesting } from "./shell-launch.ts";
import {
	buildCmdFallbackLaunch,
	type ShellResolution,
} from "./windows-shell.ts";

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
const openedLaunches = new Map<
	string,
	{ argv: string[]; env: Record<string, string> }
>();
/** Ids the fake daemon reports as already-alive, driving the adopt path. */
const aliveSessions = new Map<string, { pid: number }>();
let openImpl: ((id: string) => Promise<{ pid: number }>) | null = null;
let listGate: { entered: () => void; release: Promise<void> } | null = null;

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
		open: async (
			id: string,
			meta: { argv: string[]; env: Record<string, string> },
		) => {
			opened.push(id);
			openedLaunches.set(id, { argv: meta.argv, env: meta.env });
			if (openImpl) return openImpl(id);
			return { pid: 4242 };
		},
		list: async () => {
			if (listGate) {
				listGate.entered();
				await listGate.release;
			}
			return Array.from(aliveSessions.entries()).map(([id, entry]) => ({
				id,
				pid: entry.pid,
				alive: true,
				cols: 120,
				rows: 40,
			}));
		},
		// Subscribe is called once per session; the callbacks are never driven
		// here (no PTY exists to produce bytes).
		subscribe: () => () => {},
		input: () => {},
		resize: () => {},
		close: async () => {},
	}),
}));

const { __setSessionShellResolverForTesting, initTerminalBaseEnv } =
	await import("./env.ts");
const {
	__resetSessionsForTesting,
	createTerminalSessionInternal,
	disposeSessionAndWait,
	isLiveTerminalSession,
} = await import("./terminal.ts");

const FOUND: ShellResolution = {
	kind: "found",
	shell: "/bin/sh",
	source: "configured",
};
const REFUSED_MESSAGE = "PowerShell 7 could not be checked";
const REFUSED: ShellResolution = {
	kind: "refused",
	message: REFUSED_MESSAGE,
};

function useResolver(
	resolve: () => Promise<ShellResolution>,
): SessionShellResolverForTesting | undefined {
	return __setSessionShellResolverForTesting({
		resolve,
		adoptedShell: () => null,
	});
}

let previousShellResolver: SessionShellResolverForTesting | undefined;

let accountsManaged = false;
const ensureProfileForLaunch = mock(async () => "/profiles/unused");
const fakeClaudeAccounts = {
	getCapability: () => ({ managed: accountsManaged, configured: true }),
	withWorkspaceLock: <T>(_workspaceId: string, fn: () => Promise<T>) => fn(),
	ensureProfileForLaunch,
} as unknown as ClaudeAccountsService;

function gate(): { promise: Promise<void>; release: () => void } {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

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
	registerClaudeAccountsService(db, fakeClaudeAccounts);
	previousShellResolver = useResolver(async () => FOUND);
});

afterEach(() => {
	useResolver(async () => FOUND);
	openImpl = null;
	listGate = null;
	accountsManaged = false;
});

afterAll(() => {
	__setSessionShellResolverForTesting(previousShellResolver);
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

describe("(PWSH-RESOLVE) shell resolution in createTerminalSessionInternal", () => {
	test("adoptOnly never resolves the shell and keeps the command scanner", async () => {
		let resolveCalls = 0;
		useResolver(async () => {
			resolveCalls += 1;
			return FOUND;
		});
		const terminalId = `adopt-only-${randomUUID().slice(0, 8)}`;
		aliveSessions.set(terminalId, { pid: 501 });

		const result = await createTerminalSessionInternal({
			terminalId,
			workspaceId,
			db,
			eventBus,
			adoptOnly: true,
		});

		aliveSessions.delete(terminalId);
		if ("error" in result) throw new Error(result.error);
		expect(resolveCalls).toBe(0);
		expect(result.launchShellName).toBe("unknown");
		expect(result.cdScanState).not.toBeNull();
	});

	test("a refused shell adopts a live session instead of opening one", async () => {
		useResolver(async () => REFUSED);
		const terminalId = `refused-live-${randomUUID().slice(0, 8)}`;
		aliveSessions.set(terminalId, { pid: 502 });

		const result = await createTerminalSessionInternal({
			terminalId,
			workspaceId,
			db,
			eventBus,
		});

		aliveSessions.delete(terminalId);
		if ("error" in result) throw new Error(result.error);
		expect(opened).not.toContain(terminalId);
		expect(result.launchShellName).toBe("unknown");
		expect(result.cdScanState).not.toBeNull();
	});

	test("a refused shell with no live session fails before the profile or the open", async () => {
		useResolver(async () => REFUSED);
		accountsManaged = true;
		ensureProfileForLaunch.mockClear();
		const terminalId = `refused-${randomUUID().slice(0, 8)}`;

		const result = await createTerminalSessionInternal({
			terminalId,
			workspaceId,
			db,
			eventBus,
		});

		expect(result).toMatchObject({
			kind: "TERMINAL_START_FAILED",
			error: REFUSED_MESSAGE,
			code: "shell-unresolved",
		});
		expect(opened).not.toContain(terminalId);
		expect(ensureProfileForLaunch).not.toHaveBeenCalled();
	});

	test("an absent PowerShell launches cmd.exe printing the notice", async () => {
		useResolver(async () => ({
			kind: "absent",
			shell: "/bin/sh",
			checked: [],
			skipped: ["H:\\tools"],
		}));
		const terminalId = `absent-${randomUUID().slice(0, 8)}`;

		const result = await createTerminalSessionInternal({
			terminalId,
			workspaceId,
			db,
			eventBus,
		});

		if ("error" in result) throw new Error(result.error);
		expect(openedLaunches.get(terminalId)).toMatchObject(
			buildCmdFallbackLaunch(["H:\\tools"]),
		);
	});

	test("a dispose during resolution cancels both racing creates", async () => {
		const resolution = gate();
		useResolver(async () => {
			await resolution.promise;
			return FOUND;
		});
		const terminalId = `race-${randomUUID().slice(0, 8)}`;

		const first = createTerminalSessionInternal({
			terminalId,
			workspaceId,
			db,
			eventBus,
		});
		const firstDispose = disposeSessionAndWait(terminalId, db);
		const second = createTerminalSessionInternal({
			terminalId,
			workspaceId,
			db,
			eventBus,
		});
		const secondDispose = disposeSessionAndWait(terminalId, db);
		resolution.release();

		expect(await first).toMatchObject({
			kind: "SESSION_EXITED",
			code: "session-gone",
		});
		expect(await second).toMatchObject({
			kind: "SESSION_EXITED",
			code: "session-gone",
		});
		await Promise.all([firstDispose, secondDispose]);
		expect(opened).not.toContain(terminalId);
	});

	test("a shell spawn failure stops; a cwd spawn failure keeps today's result", async () => {
		const shellFailureId = `espawn-shell-${randomUUID().slice(0, 8)}`;
		openImpl = async (id) => {
			throw new DaemonOpenError(
				id,
				"spawn failed (shell=/bin/sh cwd=/tmp errno=EACCES): boom",
				"ESPAWN",
			);
		};
		expect(
			await createTerminalSessionInternal({
				terminalId: shellFailureId,
				workspaceId,
				db,
				eventBus,
			}),
		).toMatchObject({
			kind: "TERMINAL_START_FAILED",
			code: "shell-spawn-failed",
		});

		const cwdFailureId = `espawn-cwd-${randomUUID().slice(0, 8)}`;
		openImpl = async (id) => {
			throw new DaemonOpenError(
				id,
				"spawn: cwd does not exist: /tmp/gone (workspace may have been deleted or moved)",
				"ESPAWN",
			);
		};
		const cwdResult = await createTerminalSessionInternal({
			terminalId: cwdFailureId,
			workspaceId,
			db,
			eventBus,
		});
		expect(cwdResult).toMatchObject({ kind: "TERMINAL_START_FAILED" });
		expect("code" in cwdResult ? cwdResult.code : undefined).toBeUndefined();
	});

	test("a dispose during the refused create's daemon list is not undone by the adopt", async () => {
		useResolver(async () => REFUSED);
		const terminalId = `refused-race-${randomUUID().slice(0, 8)}`;
		aliveSessions.set(terminalId, { pid: 503 });
		const entered = gate();
		const release = gate();
		listGate = { entered: entered.release, release: release.promise };

		const create = createTerminalSessionInternal({
			terminalId,
			workspaceId,
			db,
			eventBus,
		});
		await entered.promise;
		const dispose = disposeSessionAndWait(terminalId, db);
		release.release();

		expect(await create).toMatchObject({
			kind: "SESSION_EXITED",
			code: "session-gone",
		});
		await dispose;
		aliveSessions.delete(terminalId);
		expect(opened).not.toContain(terminalId);
		expect(isLiveTerminalSession(terminalId)).toBe(false);
	});
});
