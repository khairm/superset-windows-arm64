import { randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeAccountsService } from "../../src/claude-accounts";
import { ClaudeProfileJanitor } from "../../src/claude-accounts/janitor";
import { WorkspaceLocks } from "../../src/claude-accounts/locks";
import {
	ClaudeProfileManager,
	credentialsFromToken,
} from "../../src/claude-accounts/profile-manager";
import type {
	ClaudeAccountEvent,
	ClaudeAccountsLogger,
	ManagedCredentials,
} from "../../src/claude-accounts/types";
import type { HostDb } from "../../src/db";
import { workspaces } from "../../src/db/schema";
import { createMigratedTestDb } from "./migrated-test-db";

export const WORKSPACE_IDS = [
	"11111111-1111-4111-8111-111111111111",
	"22222222-2222-4222-8222-222222222222",
	"33333333-3333-4333-8333-333333333333",
] as const;
export const DB_INSTANCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OTHER_DB_INSTANCE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export interface LogEntry {
	message: string;
	fields?: Record<string, unknown>;
}

export interface RecordingLogger extends ClaudeAccountsLogger {
	infoEntries: LogEntry[];
	warnEntries: LogEntry[];
	errorEntries: LogEntry[];
}

export function createFakeClaudeAccountsService(
	overrides: Partial<ClaudeAccountsService> = {},
): ClaudeAccountsService {
	const service: ClaudeAccountsService = {
		start: async () => {},
		stop: () => {},
		mintProfileForNewWorkspace: async () => {},
		ensureProfileForLaunch: async () => "",
		profileDirFor: () => "",
		configDirCandidatesFor: () => [],
		setWorkspaceAccount: async () => {},
		retireWorkspaceRuntime: async () => ({
			foundWorkspace: false,
			terminated: [],
			failed: [],
			accountReleased: false,
		}),
		getWorkspaceState: async () => ({
			state: "following",
			slug: null,
			warning: null,
		}),
		getWorkspaceStates: async () => [],
		getRoster: async () => ({ trayDefaultSlug: null, accounts: [] }),
		getCapability: () => ({ managed: false, configured: false }),
		withWorkspaceDeletion: async <T>(
			_targets: Parameters<ClaudeAccountsService["withWorkspaceDeletion"]>[0],
			fn: () => Promise<T>,
			_options: Parameters<ClaudeAccountsService["withWorkspaceDeletion"]>[2],
		) => fn(),
		withWorkspaceLocks: async <T>(
			_workspaceIds: string[],
			fn: () => Promise<T>,
		) => fn(),
		withWorkspaceLock: async <T>(_workspaceId: string, fn: () => Promise<T>) =>
			fn(),
	};
	return Object.assign(service, overrides);
}

export interface ClaudeTestWorld {
	root: string;
	home: string;
	dbPath: string;
	profilesRoot: string;
	db: HostDb;
	log: RecordingLogger;
	events: ClaudeAccountEvent[];
	dispose(): Promise<void>;
}

export async function createClaudeTestWorld(
	prefix = "claude-accounts-test-",
): Promise<ClaudeTestWorld> {
	const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	const home = join(root, "home");
	await mkdir(home, { recursive: true });
	const previous = {
		USERPROFILE: process.env.USERPROFILE,
		HOME: process.env.HOME,
		SUPERSET_HOME_DIR: process.env.SUPERSET_HOME_DIR,
		SUPERSET_PTY_DAEMON_SOCKET: process.env.SUPERSET_PTY_DAEMON_SOCKET,
		CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
	};
	const dbPath = join(root, "host.db");
	let migrated: ReturnType<typeof createMigratedTestDb>;
	try {
		migrated = createMigratedTestDb(dbPath);
	} catch (error) {
		await rm(root, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
	const { sqlite, db } = migrated;
	process.env.USERPROFILE = home;
	process.env.HOME = home;
	process.env.SUPERSET_HOME_DIR = join(root, "superset-home");
	delete process.env.SUPERSET_PTY_DAEMON_SOCKET;
	// Tests must not inherit a Superset-managed profile from the running session.
	delete process.env.CLAUDE_CONFIG_DIR;
	const log = createRecordingLogger();
	const events: ClaudeAccountEvent[] = [];
	let disposed = false;

	return {
		root,
		home,
		dbPath,
		profilesRoot: join(root, "claude-profiles"),
		db,
		log,
		events,
		async dispose() {
			if (disposed) return;
			disposed = true;
			try {
				sqlite.close();
			} finally {
				restoreEnv("USERPROFILE", previous.USERPROFILE);
				restoreEnv("HOME", previous.HOME);
				restoreEnv("SUPERSET_HOME_DIR", previous.SUPERSET_HOME_DIR);
				restoreEnv(
					"SUPERSET_PTY_DAEMON_SOCKET",
					previous.SUPERSET_PTY_DAEMON_SOCKET,
				);
				restoreEnv("CLAUDE_CONFIG_DIR", previous.CLAUDE_CONFIG_DIR);
				await rm(root, { recursive: true, force: true }).catch(() => {});
			}
		},
	};
}

export interface WireAccount {
	slug: string;
	name: string;
	type: "claude" | "codex";
	enabled: boolean;
	dead: boolean;
	dead_reason: string | null;
	last_success: string | null;
	consecutive_failures: number;
	five_pct: number | null;
	seven_pct: number | null;
	fable_pct: number | null;
	five_resets_at: string | null;
	seven_resets_at: string | null;
	fable_resets_at: string | null;
	in_use: boolean;
	fable_in_use: boolean;
	pc_active: boolean;
}

export function wireAccount(
	slug = "claude12",
	overrides: Partial<WireAccount> = {},
): WireAccount {
	return {
		slug,
		name: slug,
		type: "claude",
		enabled: true,
		dead: false,
		dead_reason: null,
		last_success: new Date().toISOString(),
		consecutive_failures: 0,
		five_pct: 10,
		seven_pct: 10,
		fable_pct: null,
		five_resets_at: null,
		seven_resets_at: null,
		fable_resets_at: null,
		in_use: false,
		fable_in_use: false,
		pc_active: true,
		...overrides,
	};
}

export async function servePiFake(
	root: string,
	accounts: readonly WireAccount[],
) {
	const pushKeyPath = join(root, "push-key.txt");
	await writeFile(pushKeyPath, "test-key\n", "utf8");
	let available = true;
	let tokenAvailable = true;
	let currentAccounts = [...accounts];
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			if (!available) return new Response(null, { status: 503 });
			const path = new URL(request.url).pathname;
			if (path === "/accounts") return Response.json(currentAccounts);
			const slug = path.split("/")[2];
			if (path.endsWith("/token") && slug) {
				if (!tokenAvailable) return new Response(null, { status: 503 });
				return Response.json({
					account: slug,
					claude_ai_oauth: {
						accessToken: `${slug}-token`,
						expiresAt: Date.now() + 2 * 60 * 60 * 1000,
					},
				});
			}
			return new Response(null, { status: 404 });
		},
	});
	return {
		server,
		baseUrl: `http://127.0.0.1:${server.port}`,
		pushKeyPath,
		setAvailable(next: boolean) {
			available = next;
		},
		setTokenAvailable(next: boolean) {
			tokenAvailable = next;
		},
		setAccounts(next: readonly WireAccount[]) {
			currentAccounts = [...next];
		},
	};
}

export function createRecordingLogger(): RecordingLogger {
	const infoEntries: LogEntry[] = [];
	const warnEntries: LogEntry[] = [];
	const errorEntries: LogEntry[] = [];
	return {
		infoEntries,
		warnEntries,
		errorEntries,
		info: (message, fields) =>
			infoEntries.push({ message, ...(fields ? { fields } : {}) }),
		warn: (message, fields) =>
			warnEntries.push({ message, ...(fields ? { fields } : {}) }),
		error: (message, fields) =>
			errorEntries.push({ message, ...(fields ? { fields } : {}) }),
	};
}

export async function writeGlobalClaudeState(
	world: ClaudeTestWorld,
	value: unknown = {
		lastOnboardingVersion: "2.1.0",
		installMethod: "native",
		autoUpdates: true,
		mcpServers: {},
	},
): Promise<void> {
	await writeFile(
		join(world.home, ".claude.json"),
		JSON.stringify(value),
		"utf8",
	);
}

export async function writeGlobalCredentials(
	world: ClaudeTestWorld,
	value: unknown,
): Promise<void> {
	const directory = join(world.home, ".claude");
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, ".credentials.json"),
		JSON.stringify(value),
		"utf8",
	);
}

export async function writeGlobalMirror(
	world: ClaudeTestWorld,
	name: "settings.json" | "settings.local.json" | "CLAUDE.md" | "statusline",
	contents: string,
): Promise<string> {
	const directory = join(world.home, ".claude");
	await mkdir(directory, { recursive: true });
	const path = join(directory, name);
	await writeFile(path, contents, "utf8");
	return path;
}

export async function seedWorkspace(
	world: ClaudeTestWorld,
	options: {
		id?: string;
		worktreePresent?: boolean;
		archivedAt?: number | null;
		claudeAccountSlug?: string | null;
	} = {},
): Promise<{ id: string; worktreePath: string }> {
	const id = options.id ?? randomUUID();
	const worktreePath = join(world.root, "worktrees", id);
	if (options.worktreePresent !== false) {
		await mkdir(worktreePath, { recursive: true });
	}
	world.db
		.insert(workspaces)
		.values({
			id,
			projectId: null,
			worktreePath,
			branch: `test-${id}`,
			name: `test-${id}`,
			type: "session",
			archivedAt: options.archivedAt ?? null,
			claudeAccountSlug: options.claudeAccountSlug ?? null,
		})
		.run();
	return { id, worktreePath };
}

export async function seedProfile(
	manager: ClaudeProfileManager,
	workspaceId: string,
	files: Record<string, string> = { "sentinel.txt": "present" },
): Promise<string> {
	const profile = manager.profileDirFor(workspaceId);
	await mkdir(profile, { recursive: true });
	for (const [name, contents] of Object.entries(files)) {
		await writeFile(join(profile, name), contents, "utf8");
	}
	return profile;
}

export async function seedMarker(
	manager: ClaudeProfileManager,
	workspaceId: string,
	overrides: {
		dbInstanceId?: string;
		terminalIds?: string[];
	} = {},
): Promise<string> {
	const path = manager.markerPathFor(workspaceId);
	await manager.writeMarkerFile(path, {
		workspaceId,
		terminalIds: overrides.terminalIds ?? [],
		dbInstanceId: overrides.dbInstanceId ?? DB_INSTANCE_ID,
		createdAt: Date.now(),
	});
	return path;
}

export async function seedOldStaging(
	manager: ClaudeProfileManager,
	workspaceId: string,
): Promise<string> {
	const path = manager.stagingPathFor(workspaceId);
	await mkdir(path, { recursive: true });
	const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
	await utimes(path, old, old);
	return path;
}

interface CredentialOverrides {
	accessToken?: string;
	expiresAt?: number;
	trayManagedAccount?: string | null;
}

type TestCredentials<TRefreshToken extends string> = Omit<
	ManagedCredentials,
	"claudeAiOauth"
> & {
	claudeAiOauth: Omit<ManagedCredentials["claudeAiOauth"], "refreshToken"> & {
		refreshToken: TRefreshToken;
	};
};

export function managedCredentials<TRefreshToken extends string>(
	slug: string,
	overrides: CredentialOverrides & { refreshToken: TRefreshToken },
): TestCredentials<TRefreshToken>;
export function managedCredentials(
	slug?: string,
	overrides?: CredentialOverrides,
): ManagedCredentials;
export function managedCredentials(
	slug = "claude123",
	overrides: CredentialOverrides & { refreshToken?: string } = {},
) {
	const credentials = credentialsFromToken({
		account: slug,
		accessToken: overrides.accessToken ?? "access-token",
		expiresAt: overrides.expiresAt ?? Date.now() + 2 * 60 * 60 * 1000,
	});
	credentials.trayManagedAccount =
		overrides.trayManagedAccount === undefined
			? slug
			: overrides.trayManagedAccount;
	if (overrides.refreshToken === undefined) return credentials;
	return {
		...credentials,
		claudeAiOauth: {
			...credentials.claudeAiOauth,
			refreshToken: overrides.refreshToken,
		},
	};
}

export async function createJanitorHarness(
	world: ClaudeTestWorld,
	options: {
		dbInstanceId?: string;
		beforeLock?: (workspaceId: string) => void | Promise<void>;
	} = {},
): Promise<{
	manager: ClaudeProfileManager;
	janitor: ClaudeProfileJanitor;
	deleted: Array<{ workspaceId: string; terminalIds: readonly string[] }>;
}> {
	const manager = new ClaudeProfileManager(world.dbPath, world.log);
	await manager.initialize();
	const locks = new WorkspaceLocks();
	const deleted: Array<{
		workspaceId: string;
		terminalIds: readonly string[];
	}> = [];
	const janitor = new ClaudeProfileJanitor({
		db: world.db,
		dbInstanceId: options.dbInstanceId ?? DB_INSTANCE_ID,
		profiles: manager,
		log: world.log,
		withWorkspaceLock: async (workspaceId, fn, lockOptions) => {
			await options.beforeLock?.(workspaceId);
			return locks.withLock(workspaceId, fn, lockOptions);
		},
		deleteProfileWithTerminalIds: async (workspaceId, terminalIds) => {
			deleted.push({ workspaceId, terminalIds: [...terminalIds] });
			await manager.deleteProfileDir(workspaceId);
		},
	});
	return { manager, janitor, deleted };
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
