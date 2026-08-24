import { randomUUID } from "node:crypto";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import type { HostDb } from "../db";
import { hostSettings, workspaces } from "../db/schema";
import type { EventBus } from "../events";
import { mapConcurrent } from "../lib/map-concurrent";
import { listUndisposedTerminalIdsByWorkspaceId } from "../terminal/terminal";
import { clearLegacyClaudeDefaultAccount } from "../trpc/router/usage/default-account";
import { FallbackPolicy, type TrayTriggers } from "./fallback";
import {
	ClaudeProfileJanitor,
	type DisposalFailureMode,
	disposeTerminalIds,
} from "./janitor";
import { WorkspaceLockBusyError, WorkspaceLocks } from "./locks";
import { PiClient, validateAccountSlug } from "./pi-client";
import {
	ClaudeProfileManager,
	type CredentialFileState,
	credentialsFromToken,
	isWorkspaceUuid,
} from "./profile-manager";
import type {
	ClaudeAccessToken,
	ClaudeAccountEvent,
	ClaudeAccountRosterEntry,
	ClaudeAccountsLogger,
	GlobalIdentity,
	ManagedCredentials,
	PiAccount,
} from "./types";

const TICK_INTERVAL_MS = 60_000;
const RENEW_HEADROOM_MS = 55 * 60 * 1000;
const MAX_TOKEN_BACKOFF_MS = 15 * 60 * 1000;
const HOST_SETTINGS_ID = 1;
const GLOBAL_WARNING_KEY = "__global__";
const WORKSPACE_REFRESH_CONCURRENCY = 6;
const ROSTER_REFRESH_EVERY_TICKS = 5;
const SILENT_WORKSPACE_CAUSES = new Set(["renewal"]);

export interface ClaudeAccountsServiceDeps {
	db: HostDb;
	dbPath: string;
	emit: (event: ClaudeAccountEvent) => void;
	log: ClaudeAccountsLogger;
	eventBus?: EventBus;
	piBaseUrl?: string;
	pushKeyPath?: string;
	awaitInitialBackgroundWork?: boolean;
}

export interface WorkspaceClaudeAccountState {
	workspaceId: string;
	state: "following" | "pinned";
	slug: string | null;
	warning: { kind: "credential-health"; message: string } | null;
}

export interface WorkspaceDeletionTarget {
	workspaceId: string;
	terminalIds: readonly string[];
}

export interface ClaudeAccountsService {
	start(): Promise<void>;
	stop(): void;
	mintProfileForNewWorkspace(workspaceId: string): Promise<void>;
	ensureProfileForLaunch(workspaceId: string): Promise<string>;
	profileDirFor(workspaceId: string): string;
	configDirCandidatesFor(workspaceId: string): string[];
	setWorkspaceAccount(workspaceId: string, slug: string | null): Promise<void>;
	getWorkspaceState(
		workspaceId: string,
	): Promise<Omit<WorkspaceClaudeAccountState, "workspaceId">>;
	getWorkspaceStates(): Promise<WorkspaceClaudeAccountState[]>;
	getRoster(): Promise<{
		trayDefaultSlug: string | null;
		accounts: ClaudeAccountRosterEntry[];
	}>;
	getCapability(): { managed: boolean; configured: boolean };
	withWorkspaceDeletion<T>(
		targets: readonly WorkspaceDeletionTarget[],
		fn: () => Promise<T>,
		opts: { disposalMode: DisposalFailureMode; timeoutMs?: number },
	): Promise<T>;
	withWorkspaceLocks<T>(
		workspaceIds: string[],
		fn: () => Promise<T>,
		opts?: { timeoutMs?: number },
	): Promise<T>;
	withWorkspaceLock<T>(
		workspaceId: string,
		fn: () => Promise<T>,
		opts?: { tryOnly?: boolean; timeoutMs?: number },
	): Promise<T>;
}

interface TokenBackoff {
	failures: number;
	nextAttemptAt: number;
}

type CredentialTransition =
	| { credentialAction: "write"; credentials: ManagedCredentials }
	| { credentialAction: "remove" }
	| { credentialAction: "keep" };

interface AccountTransitionBase {
	desiredSlug: string | null;
	ensureProfile?: { worktreePath: string; knownExists?: boolean };
	database?:
		| { kind: "set"; currentSlug: string | null }
		| { kind: "compare-and-set"; expectedSlug: string };
	cause: "manual" | "auto-fallback" | "system";
}

type AccountTransition = AccountTransitionBase & CredentialTransition;

class ClaudeAccountsServiceImpl implements ClaudeAccountsService {
	private readonly locks = new WorkspaceLocks();
	private readonly profiles: ClaudeProfileManager;
	private readonly pi: PiClient;
	private readonly fallback: FallbackPolicy;
	private janitor: ClaudeProfileJanitor | null = null;
	private dbInstanceId: string | null = null;
	private configured = false;
	private managed = false;
	private managedLatchPersisted = false;
	private started = false;
	private degraded = false;
	private stopped = false;
	private interval: ReturnType<typeof setInterval> | null = null;
	private credentialsWatcher: FSWatcher | null = null;
	private tickInFlight: Promise<void> | null = null;
	private tickCount = 0;
	private readonly tokenBackoffs = new Map<string, TokenBackoff>();
	private readonly credentialCache = new Map<
		string,
		ManagedCredentials | null
	>();
	private readonly warningCauses = new Map<string, Map<string, string>>();

	constructor(private readonly deps: ClaudeAccountsServiceDeps) {
		this.profiles = new ClaudeProfileManager(deps.dbPath, deps.log);
		this.pi = new PiClient(deps.log, {
			...(deps.piBaseUrl !== undefined ? { baseUrl: deps.piBaseUrl } : {}),
			...(deps.pushKeyPath !== undefined
				? { pushKeyPath: deps.pushKeyPath }
				: {}),
		});
		this.fallback = new FallbackPolicy(deps.log);
	}

	async start(): Promise<void> {
		if (this.started && !this.stopped) return;
		if (this.stopped) {
			throw new Error(
				"Claude accounts service cannot be restarted after stop()",
			);
		}
		const settings = this.ensureDatabaseInstance();
		this.dbInstanceId = settings.dbInstanceId;
		this.managedLatchPersisted = settings.managedLatch;
		const workspaceRows = this.deps.db.select().from(workspaces).all();
		let profileStateExists: boolean;
		try {
			await this.profiles.initialize();
			profileStateExists = await this.hasManagedProfileState();
		} catch (error) {
			this.degraded = true;
			this.deps.log.error(
				"Claude profile storage failed to initialize; account management is disabled",
				{ error },
			);
			this.setWarningCause(
				null,
				"profile-root",
				"Claude workspace profile storage is unavailable. Account management is disabled.",
			);
			this.managed = false;
			this.configured = await this.refreshPushKeyHealth({ emitWarning: false });
			this.started = true;
			return;
		}
		const pushKeyPathExists = existsSync(this.pi.getPushKeyPath());
		this.configured = await this.refreshPushKeyHealth({ emitWarning: false });
		const pinnedStateExists = workspaceRows.some(
			(row) => row.claudeAccountSlug !== null,
		);
		if ((profileStateExists || pinnedStateExists) && !settings.managedLatch) {
			this.persistManagedLatch();
		}
		this.managed =
			pushKeyPathExists ||
			settings.managedLatch ||
			profileStateExists ||
			pinnedStateExists;

		this.janitor = new ClaudeProfileJanitor({
			db: this.deps.db,
			dbInstanceId: this.dbInstanceId,
			profiles: this.profiles,
			log: this.deps.log,
			withWorkspaceLock: (workspaceId, fn, opts) =>
				this.withWorkspaceLock(workspaceId, fn, opts),
			deleteProfileWithTerminalIds: (workspaceId, terminalIds) =>
				this.deleteProfileWithTerminalIds(workspaceId, terminalIds),
		});

		if (this.managed) {
			clearLegacyClaudeDefaultAccount(this.deps.db);
			this.startCredentialsWatcher();
			if (!this.configured) {
				this.setWarningCause(
					null,
					"push-key",
					"Claude account management is active, but the Pi push key is unavailable or invalid.",
				);
			}
		}

		this.started = true;
		const initialWork = this.runInitialBackgroundWork(
			workspaceRows.map((row) => row.id),
		);
		if (this.deps.awaitInitialBackgroundWork) await initialWork;
		else void initialWork;
		this.interval = setInterval(() => {
			void this.runTick().catch((error) => {
				this.deps.log.error("Claude account keep-fresh tick failed", { error });
			});
		}, TICK_INTERVAL_MS);
		this.interval.unref();
	}

	private async runInitialBackgroundWork(
		workspaceIds: readonly string[],
	): Promise<void> {
		if (this.managed) {
			const tasks = [
				{
					name: "profile sweep",
					run: () => this.profiles.sweepProfiles(workspaceIds),
				},
				{
					name: "credential cache seed",
					run: () => this.seedTokenCache(workspaceIds),
				},
				{
					name: "profile janitor",
					run: () => this.requireJanitor().run(true),
				},
			] as const;
			for (const task of tasks) {
				try {
					await task.run();
				} catch (error) {
					this.deps.log.error(`Claude account startup ${task.name} failed`, {
						error,
					});
				}
			}
		}
		try {
			await this.runTick();
		} catch (error) {
			this.deps.log.error("Initial Claude account keep-fresh tick failed", {
				error,
			});
		}
	}

	stop(): void {
		this.stopped = true;
		if (this.interval) clearInterval(this.interval);
		this.interval = null;
		this.credentialsWatcher?.close();
		this.credentialsWatcher = null;
	}

	async mintProfileForNewWorkspace(workspaceId: string): Promise<void> {
		if (!this.getCapability().managed) return;
		await this.ensureProfileForLaunch(workspaceId);
	}

	async ensureProfileForLaunch(workspaceId: string): Promise<string> {
		if (!this.managed) {
			throw new Error(
				"Claude workspace profiles are not configured on this host",
			);
		}
		return this.withWorkspaceLock(workspaceId, async () => {
			const row = this.requireWorkspace(workspaceId);
			const profileExists = await this.profiles.profileExists(workspaceId);
			const current = await this.readProfileCredentialsForCache(
				workspaceId,
				profileExists,
			);
			const credentialTransition =
				row.claudeAccountSlug !== null
					? this.credentialsForPinnedLaunch(
							workspaceId,
							row.claudeAccountSlug,
							current,
						)
					: await this.credentialsForFollowingLaunch(workspaceId);
			await this.applyWorkspaceAccountTransition(workspaceId, {
				desiredSlug: row.claudeAccountSlug,
				...credentialTransition,
				ensureProfile: {
					worktreePath: row.worktreePath,
					knownExists: profileExists,
				},
				cause: "system",
			});
			this.latchManaged();
			return this.profiles.profileDirFor(workspaceId);
		});
	}

	profileDirFor(workspaceId: string): string {
		return this.profiles.profileDirFor(workspaceId);
	}

	configDirCandidatesFor(workspaceId: string): string[] {
		if (!isWorkspaceUuid(workspaceId)) return [];
		const globalDir =
			process.env.CLAUDE_CONFIG_DIR ?? this.profiles.globalClaudeDir;
		if (!this.managed) return [globalDir];
		const workspaceDir = this.profiles.profileDirFor(workspaceId);
		const candidates = existsSync(workspaceDir)
			? [workspaceDir, globalDir]
			: [globalDir];
		return [...new Set(candidates)];
	}

	async setWorkspaceAccount(
		workspaceId: string,
		slug: string | null,
	): Promise<void> {
		if (!this.managed) {
			throw new Error(
				"Claude account switching is not configured on this host",
			);
		}
		await this.withWorkspaceLock(workspaceId, async () => {
			const row = this.requireWorkspace(workspaceId);
			if (row.claudeAccountSlug !== slug)
				this.credentialCache.delete(workspaceId);
			let credentialTransition: CredentialTransition;
			if (slug !== null) {
				validateAccountSlug(slug);
				const roster = await this.pi.fetchAccounts();
				const account = findClaudeAccount(roster, slug);
				if (!account)
					throw new Error(`Claude account ${slug} is not in the Pi roster`);
				const accountHealth = accountHealthMessage(
					"Claude account",
					slug,
					account,
				);
				if (accountHealth) throw new Error(accountHealth);
				const token = await this.pi.fetchToken(slug);
				credentialTransition = {
					credentialAction: "write",
					credentials: credentialsFromToken(token),
				};
			} else {
				let identity: GlobalIdentity;
				try {
					identity = await this.profiles.readGlobalIdentity();
				} catch (error) {
					this.setWarningCause(
						workspaceId,
						"machine-default",
						"The machine-default Claude credentials are unreadable. The account change was not saved.",
					);
					throw new Error(
						"Cannot switch this workspace to Following while the machine-default Claude credentials are unreadable",
						{ cause: error },
					);
				}
				credentialTransition =
					identity.kind === "absent"
						? { credentialAction: "keep" }
						: {
								credentialAction: "write",
								credentials: identity.credentials,
							};
				this.setWarningCause(
					workspaceId,
					"machine-default",
					identity.kind === "absent"
						? "The machine default is signed out. This workspace will keep its last-good token."
						: null,
				);
			}
			await this.applyWorkspaceAccountTransition(workspaceId, {
				desiredSlug: slug,
				...credentialTransition,
				ensureProfile: { worktreePath: row.worktreePath },
				database: { kind: "set", currentSlug: row.claudeAccountSlug },
				cause: "manual",
			});
			this.latchManaged();
		});
	}

	async getWorkspaceState(
		workspaceId: string,
	): Promise<Omit<WorkspaceClaudeAccountState, "workspaceId">> {
		const row = this.requireWorkspace(workspaceId);
		const { workspaceId: _workspaceId, ...state } = this.mapWorkspaceState(
			workspaceId,
			row.claudeAccountSlug,
		);
		return state;
	}

	async getWorkspaceStates(): Promise<WorkspaceClaudeAccountState[]> {
		return this.deps.db
			.select({
				workspaceId: workspaces.id,
				slug: workspaces.claudeAccountSlug,
			})
			.from(workspaces)
			.where(isNull(workspaces.archivedAt))
			.all()
			.map((row) => this.mapWorkspaceState(row.workspaceId, row.slug));
	}

	async getRoster(): Promise<{
		trayDefaultSlug: string | null;
		accounts: ClaudeAccountRosterEntry[];
	}> {
		let accounts: PiAccount[];
		try {
			accounts = await this.pi.fetchAccounts();
		} catch (error) {
			const lastGood = this.pi.getAccountsLastGood();
			if (!lastGood) throw error;
			this.deps.log.warn(
				"Serving last-good Claude account roster after Pi failure",
				{
					error,
				},
			);
			accounts = lastGood;
		}
		let trayDefaultSlug: string | null = null;
		try {
			const identity = await this.profiles.readGlobalIdentity();
			trayDefaultSlug = identity.kind === "tray" ? identity.slug : null;
		} catch (error) {
			this.deps.log.warn(
				"Could not resolve tray default for Claude account roster",
				{
					error,
				},
			);
		}
		return {
			trayDefaultSlug,
			accounts: accounts
				.filter((account) => account.type === "claude")
				.map(
					({
						type: _type,
						fableResetsAt: _fableReset,
						fableInUse: _fableInUse,
						...account
					}) => account,
				),
		};
	}

	getCapability(): { managed: boolean; configured: boolean } {
		return {
			managed: this.managed,
			configured: this.configured,
		};
	}

	async withWorkspaceDeletion<T>(
		targets: readonly WorkspaceDeletionTarget[],
		fn: () => Promise<T>,
		opts: { disposalMode: DisposalFailureMode; timeoutMs?: number },
	): Promise<T> {
		if (!this.started) {
			throw new Error("Claude accounts service has not started");
		}
		const deletionTargets = targets.map((target) => ({
			workspaceId: target.workspaceId,
			terminalIds: [...target.terminalIds],
		}));
		const workspaceIds = deletionTargets.map((target) => target.workspaceId);
		if (new Set(workspaceIds).size !== workspaceIds.length) {
			throw new Error(
				"Workspace deletion targets contain a duplicate workspace id",
			);
		}
		const disposalOptions = this.disposalOptions(opts.disposalMode);
		return this.withWorkspaceLocks(
			workspaceIds,
			async () => {
				if (this.degraded) {
					this.deps.log.warn(
						"Claude profile storage is unavailable; workspace deletion will continue without profile markers",
						{ workspaceIds },
					);
					await disposeTerminalIds(
						this.deps.db,
						deletionTargets.flatMap((target) => target.terminalIds),
						disposalOptions,
					);
					return fn();
				}
				const janitor = this.requireJanitor();
				const preparedIds: string[] = [];
				try {
					for (const target of deletionTargets) {
						await janitor.prepareWorkspaceDeletion(
							target.workspaceId,
							target.terminalIds,
						);
						preparedIds.push(target.workspaceId);
					}
					await disposeTerminalIds(
						this.deps.db,
						deletionTargets.flatMap((target) => target.terminalIds),
						disposalOptions,
					);
				} catch (error) {
					await this.clearDeletionMarkersOrThrow(preparedIds, error);
					throw error;
				}

				let result: T;
				try {
					result = await fn();
				} catch (error) {
					const rolledBackIds = preparedIds.filter((workspaceId) => {
						const row = this.deps.db.query.workspaces
							.findFirst({ where: eq(workspaces.id, workspaceId) })
							.sync();
						return row !== undefined;
					});
					await this.clearDeletionMarkersOrThrow(rolledBackIds, error);
					throw error;
				}

				const deletions = await Promise.allSettled(
					preparedIds.map((workspaceId) =>
						this.deletePreparedProfile(workspaceId),
					),
				);
				for (const [index, deletion] of deletions.entries()) {
					if (deletion.status === "fulfilled") continue;
					this.deps.log.warn(
						"Workspace was deleted but its Claude profile remains for janitor retry",
						{
							workspaceId: preparedIds[index],
							error: deletion.reason,
						},
					);
				}
				return result;
			},
			opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : undefined,
		);
	}

	withWorkspaceLocks<T>(
		workspaceIds: string[],
		fn: () => Promise<T>,
		opts?: { timeoutMs?: number },
	): Promise<T> {
		for (const workspaceId of workspaceIds) {
			if (!isWorkspaceUuid(workspaceId)) {
				return Promise.reject(
					new Error(`Invalid workspace UUID: ${workspaceId}`),
				);
			}
		}
		return this.locks.withLocks(workspaceIds, fn, opts);
	}

	withWorkspaceLock<T>(
		workspaceId: string,
		fn: () => Promise<T>,
		opts?: { tryOnly?: boolean; timeoutMs?: number },
	): Promise<T> {
		if (!isWorkspaceUuid(workspaceId)) {
			return Promise.reject(
				new Error(`Invalid workspace UUID: ${workspaceId}`),
			);
		}
		return this.locks.withLock(workspaceId, fn, opts);
	}

	private runTick(): Promise<void> {
		if (!this.managed || this.stopped) return Promise.resolve();
		if (this.tickInFlight) return this.tickInFlight;
		const tick = this.executeTick().finally(() => {
			if (this.tickInFlight === tick) this.tickInFlight = null;
		});
		this.tickInFlight = tick;
		return tick;
	}

	private async executeTick(): Promise<void> {
		this.tickCount += 1;
		this.configured = await this.refreshPushKeyHealth({ emitWarning: true });

		let identity: GlobalIdentity | null = null;
		try {
			identity = await this.profiles.readGlobalIdentity();
			if (identity.kind === "tray") {
				this.pi.rememberToken({
					account: identity.slug,
					accessToken: identity.credentials.claudeAiOauth.accessToken,
					expiresAt: identity.credentials.claudeAiOauth.expiresAt,
					...(identity.credentials.claudeAiOauth.scopes
						? { scopes: identity.credentials.claudeAiOauth.scopes }
						: {}),
				});
			}
		} catch (error) {
			this.deps.log.warn("Could not read machine-default Claude credentials", {
				error,
			});
		}

		const rows = this.deps.db
			.select({
				id: workspaces.id,
				claudeAccountSlug: workspaces.claudeAccountSlug,
			})
			.from(workspaces)
			.where(isNull(workspaces.archivedAt))
			.all();
		const hasPinnedWorkspace = rows.some(
			(row) => row.claudeAccountSlug !== null,
		);
		const triggers = hasPinnedWorkspace
			? await this.fallback.readTriggers()
			: null;
		const rosterRequired =
			rows.some((row) => this.workspaceNeedsRoster(row, identity)) ||
			triggers !== null ||
			this.tickCount % ROSTER_REFRESH_EVERY_TICKS === 0;
		let roster: PiAccount[] | null = null;
		if (this.configured && rosterRequired) {
			try {
				roster = await this.pi.fetchAccounts();
				this.setWarningCause(null, "pi-roster", null);
			} catch (error) {
				this.setWarningCause(
					null,
					"pi-roster",
					"Claude account management cannot reach the Pi. Workspaces will keep their last-good credentials.",
				);
				this.deps.log.warn(
					"Claude account roster refresh failed; preserving last-good state",
					{
						error,
					},
				);
			}
		} else {
			this.setWarningCause(null, "pi-roster", null);
		}
		await mapConcurrent(rows, WORKSPACE_REFRESH_CONCURRENCY, (row) =>
			this.refreshWorkspace(row.id, identity, roster),
		);
		this.clearGlobalRenewalWarningIfHealthy(rows.map((row) => row.id));
		if (roster && triggers) {
			await this.runFallbacks(rows, identity, roster, triggers);
		}

		if (this.tickCount % 60 === 0) {
			await this.requireJanitor().run(false);
		}
	}

	private workspaceNeedsRoster(
		row: { id: string; claudeAccountSlug: string | null },
		identity: GlobalIdentity | null,
	): boolean {
		const tokenSlug =
			row.claudeAccountSlug ??
			(identity?.kind === "tray" ? identity.slug : null);
		if (!tokenSlug) return false;
		const credentials = this.credentialCache.get(row.id);
		return (
			!credentials ||
			credentials.trayManagedAccount !== tokenSlug ||
			credentials.claudeAiOauth.expiresAt - Date.now() <= RENEW_HEADROOM_MS
		);
	}

	private async refreshWorkspace(
		workspaceId: string,
		identity: GlobalIdentity | null,
		roster: PiAccount[] | null,
	): Promise<void> {
		try {
			await this.withWorkspaceLock(
				workspaceId,
				async () => {
					const row = this.deps.db.query.workspaces
						.findFirst({ where: eq(workspaces.id, workspaceId) })
						.sync();
					if (!row || row.archivedAt !== null) return;
					if (!(await this.profiles.profileExists(workspaceId))) return;
					const current = await this.readProfileCredentialsForCache(
						workspaceId,
						true,
					);
					if (row.claudeAccountSlug === null) {
						await this.refreshFollowing(workspaceId, identity, roster, current);
					} else {
						await this.refreshPinned(
							workspaceId,
							row.claudeAccountSlug,
							roster,
							current,
						);
					}
				},
				{ tryOnly: true },
			);
		} catch (error) {
			if (error instanceof WorkspaceLockBusyError) {
				this.deps.log.info("Claude keep-fresh skipped locked workspace", {
					workspaceId,
				});
				return;
			}
			this.deps.log.error("Claude keep-fresh failed for workspace", {
				workspaceId,
				error,
			});
		}
	}

	private async refreshFollowing(
		workspaceId: string,
		identity: GlobalIdentity | null,
		roster: PiAccount[] | null,
		current: ManagedCredentials | null,
	): Promise<void> {
		if (!identity || identity.kind === "absent") {
			this.setWarningCause(
				workspaceId,
				"machine-default",
				"The machine default is signed out or unreadable. This workspace is using its last-good token.",
			);
			return;
		}
		this.setWarningCause(workspaceId, "machine-default", null);
		if (identity.kind === "unmanaged") {
			if (!sameAccessToken(current, identity.credentials)) {
				await this.applyWorkspaceAccountTransition(workspaceId, {
					desiredSlug: null,
					credentialAction: "write",
					credentials: identity.credentials,
					cause: "system",
				});
			}
			this.setWarningCause(
				workspaceId,
				"unmanaged",
				"This workspace is following a personal Claude login. Superset can mirror its access token but cannot renew it.",
			);
			this.setWarningCause(workspaceId, "renewal", null);
			return;
		}
		this.setWarningCause(workspaceId, "unmanaged", null);
		if (!sameAccessToken(current, identity.credentials)) {
			await this.applyWorkspaceAccountTransition(workspaceId, {
				desiredSlug: null,
				credentialAction: "write",
				credentials: identity.credentials,
				cause: "system",
			});
			current = identity.credentials;
		}
		const account = roster
			? findClaudeAccount(roster, identity.slug)
			: undefined;
		if (roster && !account) {
			this.setWarningCause(
				workspaceId,
				"roster",
				`The machine-default Claude account '${identity.slug}' is missing from the Pi roster. The last-good token is unchanged.`,
			);
			return;
		}
		if (roster) this.setWarningCause(workspaceId, "roster", null);
		const accountHealth = account
			? accountHealthMessage(
					"The machine-default Claude account",
					identity.slug,
					account,
				)
			: null;
		if (accountHealth) {
			this.setWarningCause(workspaceId, "account-health", accountHealth);
			return;
		}
		if (account) this.setWarningCause(workspaceId, "account-health", null);
		if (
			current?.trayManagedAccount !== identity.slug ||
			current.claudeAiOauth.expiresAt - Date.now() <= RENEW_HEADROOM_MS
		) {
			await this.renewWorkspace(workspaceId, null, identity.slug);
		} else {
			this.setWarningCause(workspaceId, "renewal", null);
		}
	}

	private async refreshPinned(
		workspaceId: string,
		slug: string,
		roster: PiAccount[] | null,
		current: ManagedCredentials | null,
	): Promise<void> {
		this.setWarningCause(workspaceId, "machine-default", null);
		this.setWarningCause(workspaceId, "unmanaged", null);
		if (current && current.trayManagedAccount !== slug) {
			await this.applyWorkspaceAccountTransition(workspaceId, {
				desiredSlug: slug,
				credentialAction: "remove",
				cause: "system",
			});
			current = null;
			this.deps.log.warn(
				"Removed mismatched Claude credentials from pinned workspace profile",
				{ workspaceId, pinnedSlug: slug },
			);
		}
		const account = roster ? findClaudeAccount(roster, slug) : undefined;
		if (roster && !account) {
			this.setWarningCause(
				workspaceId,
				"roster",
				`Pinned Claude account '${slug}' is missing from the Pi roster. The last-good token is unchanged.`,
			);
			return;
		}
		if (roster) this.setWarningCause(workspaceId, "roster", null);
		const accountHealth = account
			? accountHealthMessage("Pinned Claude account", slug, account)
			: null;
		if (accountHealth) {
			this.setWarningCause(workspaceId, "account-health", accountHealth);
			return;
		}
		if (account) this.setWarningCause(workspaceId, "account-health", null);
		if (
			current?.trayManagedAccount === slug &&
			current.claudeAiOauth.expiresAt - Date.now() > RENEW_HEADROOM_MS
		) {
			this.setWarningCause(workspaceId, "renewal", null);
			return;
		}
		await this.renewWorkspace(workspaceId, slug, slug);
	}

	private async renewWorkspace(
		workspaceId: string,
		desiredSlug: string | null,
		tokenSlug: string,
	): Promise<void> {
		try {
			const token = await this.fetchTokenWithBackoff(tokenSlug);
			await this.applyWorkspaceAccountTransition(workspaceId, {
				desiredSlug,
				credentialAction: "write",
				credentials: credentialsFromToken(token),
				cause: "system",
			});
			this.setWarningCause(workspaceId, "renewal", null);
		} catch (error) {
			this.setWarningCause(
				workspaceId,
				"renewal",
				`Claude token renewal failed for '${tokenSlug}'. This workspace is using its last-good token.`,
			);
			this.setWarningCause(
				null,
				"pi-renewal",
				"Claude account token renewal is failing. Workspaces will keep their last-good credentials.",
			);
			this.deps.log.warn(
				"Claude token renewal failed; preserving last-good credentials",
				{
					workspaceId,
					slug: tokenSlug,
					error,
				},
			);
		}
	}

	private async runFallbacks(
		rows: Array<{ id: string; claudeAccountSlug: string | null }>,
		identity: GlobalIdentity | null,
		roster: PiAccount[],
		triggers: TrayTriggers,
	): Promise<void> {
		if (!identity || identity.kind !== "tray") {
			for (const row of rows) {
				if (row.claudeAccountSlug !== null) {
					this.deps.log.info(
						"Claude auto-fallback suppressed: machine default identity is unknown",
						{ workspaceId: row.id },
					);
				}
			}
			return;
		}
		const defaultAccount = findClaudeAccount(roster, identity.slug);
		if (!defaultAccount) {
			this.deps.log.warn(
				"Claude auto-fallback suppressed: machine default is missing from the Pi roster",
				{ machineDefaultSlug: identity.slug },
			);
			return;
		}
		const defaultAccountHealth = accountHealthMessage(
			"The machine-default Claude account",
			identity.slug,
			defaultAccount,
		);
		if (defaultAccountHealth) {
			for (const row of rows) {
				if (row.claudeAccountSlug === null) continue;
				this.setWarningCause(row.id, "account-health", defaultAccountHealth);
			}
			this.deps.log.warn(
				"Claude auto-fallback suppressed: machine default is unavailable",
				{ machineDefaultSlug: identity.slug },
			);
			return;
		}
		const candidates: Array<{
			workspaceId: string;
			pinnedSlug: string;
			reason: string;
		}> = [];
		for (const row of rows) {
			const slug = row.claudeAccountSlug;
			if (slug === null) continue;
			if (slug === identity.slug) {
				this.deps.log.info(
					"Claude auto-fallback suppressed: pinned account is the machine default",
					{ workspaceId: row.id, slug },
				);
				continue;
			}
			const account = findClaudeAccount(roster, slug);
			if (!account) {
				this.deps.log.warn(
					"Claude auto-fallback suppressed: pinned account is absent from roster",
					{ workspaceId: row.id, slug },
				);
				continue;
			}
			const accountHealth = accountHealthMessage(
				"Pinned Claude account",
				slug,
				account,
			);
			if (accountHealth) {
				this.setWarningCause(row.id, "account-health", accountHealth);
				this.deps.log.info(
					"Claude auto-fallback suppressed: pinned account is unavailable",
					{ workspaceId: row.id, slug },
				);
				continue;
			}
			const evaluation = this.fallback.evaluate(account, triggers);
			if (evaluation.action === "suppress") {
				this.deps.log.info("Claude auto-fallback suppressed", {
					workspaceId: row.id,
					slug,
					reason: evaluation.reason,
				});
				continue;
			}
			candidates.push({
				workspaceId: row.id,
				pinnedSlug: slug,
				reason: evaluation.reason,
			});
		}
		if (candidates.length === 0) return;

		for (const candidate of candidates) {
			await this.commitFallback(
				candidate.workspaceId,
				candidate.pinnedSlug,
				identity,
				triggers,
				candidate.reason,
			);
		}
	}

	private async commitFallback(
		workspaceId: string,
		pinnedSlug: string,
		evaluatedIdentity: Extract<GlobalIdentity, { kind: "tray" }>,
		evaluatedTriggers: TrayTriggers,
		reason: string,
	): Promise<void> {
		try {
			await this.withWorkspaceLock(
				workspaceId,
				async () => {
					const row = this.requireWorkspace(workspaceId);
					if (row.claudeAccountSlug !== pinnedSlug) {
						this.deps.log.info(
							"Claude auto-fallback discarded: workspace account changed",
							{ workspaceId },
						);
						return;
					}
					let identity: GlobalIdentity;
					let triggers: TrayTriggers | null;
					try {
						[identity, triggers] = await Promise.all([
							this.profiles.readGlobalIdentity(),
							this.fallback.readTriggers(),
						]);
					} catch (error) {
						this.deps.log.warn(
							"Claude auto-fallback candidate discarded: revalidation failed",
							{ workspaceId, error },
						);
						return;
					}
					if (
						identity.kind !== "tray" ||
						identity.slug !== evaluatedIdentity.slug ||
						identity.slug === pinnedSlug ||
						!triggers ||
						triggers.five !== evaluatedTriggers.five ||
						triggers.seven !== evaluatedTriggers.seven
					) {
						this.deps.log.info(
							"Claude auto-fallback candidate discarded by locked revalidation",
							{ workspaceId },
						);
						return;
					}
					const updated = await this.applyWorkspaceAccountTransition(
						workspaceId,
						{
							desiredSlug: null,
							credentialAction: "write",
							credentials: identity.credentials,
							database: {
								kind: "compare-and-set",
								expectedSlug: pinnedSlug,
							},
							cause: "auto-fallback",
						},
					);
					if (!updated) {
						this.deps.log.info(
							"Claude auto-fallback CAS lost; state unchanged",
							{ workspaceId },
						);
						return;
					}
					this.deps.log.warn(
						"Claude workspace permanently fell back to Following",
						{
							workspaceId,
							pinnedSlug,
							machineDefaultSlug: identity.slug,
							reason,
						},
					);
				},
				{ tryOnly: true },
			);
		} catch (error) {
			if (error instanceof WorkspaceLockBusyError) {
				this.deps.log.info("Claude auto-fallback skipped locked workspace", {
					workspaceId,
				});
				return;
			}
			throw error;
		}
	}

	private async fetchTokenWithBackoff(
		slug: string,
	): Promise<ClaudeAccessToken> {
		const backoff = this.tokenBackoffs.get(slug);
		if (backoff && backoff.nextAttemptAt > Date.now()) {
			throw new Error(
				`Token fetch for ${slug} is backed off until ${new Date(backoff.nextAttemptAt).toISOString()}`,
			);
		}
		try {
			const token = await this.pi.fetchToken(slug);
			this.tokenBackoffs.delete(slug);
			return token;
		} catch (error) {
			const failures = (backoff?.failures ?? 0) + 1;
			const delay = Math.min(
				TICK_INTERVAL_MS * 2 ** Math.min(failures - 1, 8),
				MAX_TOKEN_BACKOFF_MS,
			);
			this.tokenBackoffs.set(slug, {
				failures,
				nextAttemptAt: Date.now() + delay,
			});
			throw error;
		}
	}

	private credentialsForPinnedLaunch(
		workspaceId: string,
		slug: string,
		current: ManagedCredentials | null,
	): CredentialTransition {
		if (
			current?.trayManagedAccount === slug &&
			current.claudeAiOauth.accessToken
		) {
			this.setWarningCause(workspaceId, "renewal", null);
			return { credentialAction: "write", credentials: current };
		}
		const lastGood = this.pi.getTokenLastGood(slug);
		if (lastGood) {
			this.setWarningCause(workspaceId, "renewal", null);
			return {
				credentialAction: "write",
				credentials: credentialsFromToken(lastGood),
			};
		}
		this.setWarningCause(
			workspaceId,
			"renewal",
			`Pinned Claude account '${slug}' has no last-good token. The workspace profile is intentionally credential-less until keep-fresh recovers.`,
			{ emit: true },
		);
		return { credentialAction: "remove" };
	}

	private async credentialsForFollowingLaunch(
		workspaceId: string,
	): Promise<CredentialTransition> {
		const identity = await this.readGlobalIdentityOrWarn(workspaceId);
		if (!identity || identity.kind === "absent") {
			return { credentialAction: "keep" };
		}
		if (identity.kind === "unmanaged") {
			this.setWarningCause(
				workspaceId,
				"unmanaged",
				"This workspace is following a personal Claude login. Superset can mirror its access token but cannot renew it.",
			);
		} else {
			this.setWarningCause(workspaceId, "unmanaged", null);
			this.pi.rememberToken({
				account: identity.slug,
				accessToken: identity.credentials.claudeAiOauth.accessToken,
				expiresAt: identity.credentials.claudeAiOauth.expiresAt,
			});
		}
		return {
			credentialAction: "write",
			credentials: identity.credentials,
		};
	}

	private async readGlobalIdentityOrWarn(
		workspaceId: string,
	): Promise<GlobalIdentity | null> {
		try {
			const identity = await this.profiles.readGlobalIdentity();
			this.setWarningCause(
				workspaceId,
				"machine-default",
				identity.kind === "absent"
					? "The machine default is signed out. This workspace will keep its last-good token."
					: null,
			);
			return identity;
		} catch (error) {
			this.setWarningCause(
				workspaceId,
				"machine-default",
				"The machine-default Claude credentials are unreadable. This workspace will keep its last-good token.",
			);
			this.deps.log.warn("Machine-default Claude credentials are unreadable", {
				workspaceId,
				error,
			});
			return null;
		}
	}

	private async readProfileCredentialsForCache(
		workspaceId: string,
		knownExists?: boolean,
	): Promise<ManagedCredentials | null> {
		const profileExists =
			knownExists ?? (await this.profiles.profileExists(workspaceId));
		if (!profileExists) {
			this.credentialCache.delete(workspaceId);
			return null;
		}
		if (this.credentialCache.has(workspaceId)) {
			return this.credentialCache.get(workspaceId) ?? null;
		}
		try {
			const credentials =
				await this.profiles.readProfileCredentials(workspaceId);
			if (credentials) this.cacheCredentials(workspaceId, credentials);
			else this.credentialCache.set(workspaceId, null);
			return credentials;
		} catch (error) {
			this.credentialCache.set(workspaceId, null);
			this.deps.log.warn(
				"Existing Claude profile credentials could not seed last-good cache",
				{
					workspaceId,
					error,
				},
			);
			return null;
		}
	}

	private cacheCredentials(
		workspaceId: string,
		credentials: ManagedCredentials,
	): void {
		this.credentialCache.set(workspaceId, credentials);
		if (credentials.trayManagedAccount) {
			this.pi.rememberToken({
				account: credentials.trayManagedAccount,
				accessToken: credentials.claudeAiOauth.accessToken,
				expiresAt: credentials.claudeAiOauth.expiresAt,
			});
		}
	}

	private async applyWorkspaceAccountTransition(
		workspaceId: string,
		transition: AccountTransition,
	): Promise<boolean> {
		if (!transition.database) {
			await this.applyCredentialTransition(workspaceId, transition);
			return true;
		}

		const priorCredentialState = await this.profiles.captureCredentialFileState(
			this.profiles.profileDirFor(workspaceId),
		);
		await this.applyCredentialTransition(workspaceId, transition);
		let updated: { id: string } | undefined;
		try {
			if (transition.database.kind === "set") {
				updated = this.deps.db
					.update(workspaces)
					.set({ claudeAccountSlug: transition.desiredSlug })
					.where(eq(workspaces.id, workspaceId))
					.returning({ id: workspaces.id })
					.get();
			} else {
				updated = this.deps.db
					.update(workspaces)
					.set({ claudeAccountSlug: transition.desiredSlug })
					.where(
						and(
							eq(workspaces.id, workspaceId),
							eq(
								workspaces.claudeAccountSlug,
								transition.database.expectedSlug,
							),
						),
					)
					.returning({ id: workspaces.id })
					.get();
			}
		} catch (error) {
			await this.restoreCredentialStateAfterDatabaseFailure(
				workspaceId,
				priorCredentialState,
				error,
			);
			throw error;
		}
		if (!updated) {
			await this.restoreCredentialStateAfterDatabaseFailure(
				workspaceId,
				priorCredentialState,
				new Error("Workspace account database compare-and-set did not update"),
			);
			return false;
		}

		this.setWarningCause(workspaceId, "credential-compensation", null);
		this.setWarningCause(workspaceId, "renewal", null);
		this.setWarningCause(workspaceId, "roster", null);
		if (transition.desiredSlug !== null) {
			this.setWarningCause(workspaceId, "machine-default", null);
			this.setWarningCause(workspaceId, "unmanaged", null);
		}
		const stateChanged =
			transition.database.kind === "compare-and-set" ||
			transition.database.currentSlug !== transition.desiredSlug;
		if (stateChanged) {
			this.deps.emit({
				type: "claude-account-state-changed",
				workspaceId,
				state: transition.desiredSlug === null ? "following" : "pinned",
				slug: transition.desiredSlug,
				cause: transition.cause,
			});
		}
		return true;
	}

	private async applyCredentialTransition(
		workspaceId: string,
		transition: AccountTransition,
	): Promise<void> {
		if (transition.ensureProfile) {
			await this.profiles.mintProfile(
				workspaceId,
				transition.ensureProfile.worktreePath,
				null,
				transition.ensureProfile.knownExists,
			);
		}
		switch (transition.credentialAction) {
			case "write":
				await this.writeWorkspaceCredentials(
					workspaceId,
					transition.credentials,
				);
				return;
			case "remove":
				await this.removeWorkspaceCredentials(workspaceId);
				return;
			case "keep":
				return;
		}
	}

	private async restoreCredentialStateAfterDatabaseFailure(
		workspaceId: string,
		priorState: CredentialFileState,
		databaseError: unknown,
	): Promise<void> {
		try {
			await this.profiles.restoreCredentialFileState(
				this.profiles.profileDirFor(workspaceId),
				priorState,
			);
			this.credentialCache.delete(workspaceId);
		} catch (restoreError) {
			this.setWarningCause(
				workspaceId,
				"credential-compensation",
				"The workspace account change failed and its prior credential file could not be restored.",
			);
			throw new AggregateError(
				[databaseError, restoreError],
				"Workspace account database write failed and credential compensation also failed",
			);
		}
	}

	private async writeWorkspaceCredentials(
		workspaceId: string,
		credentials: ManagedCredentials,
	): Promise<void> {
		await this.profiles.writeCredentials(
			this.profiles.profileDirFor(workspaceId),
			credentials,
		);
		this.cacheCredentials(workspaceId, credentials);
	}

	private async removeWorkspaceCredentials(workspaceId: string): Promise<void> {
		await this.profiles.removeCredentials(
			this.profiles.profileDirFor(workspaceId),
		);
		this.credentialCache.set(workspaceId, null);
	}

	private async seedTokenCache(workspaceIds: readonly string[]): Promise<void> {
		await mapConcurrent(
			workspaceIds,
			WORKSPACE_REFRESH_CONCURRENCY,
			async (workspaceId) => {
				await this.readProfileCredentialsForCache(workspaceId);
			},
		);
	}

	private requireWorkspace(workspaceId: string) {
		if (!isWorkspaceUuid(workspaceId)) {
			throw new Error(`Invalid workspace UUID: ${workspaceId}`);
		}
		const row = this.deps.db.query.workspaces
			.findFirst({ where: eq(workspaces.id, workspaceId) })
			.sync();
		if (!row) throw new Error(`Workspace ${workspaceId} does not exist`);
		return row;
	}

	private disposalOptions(mode: DisposalFailureMode): {
		mode: DisposalFailureMode;
		log: ClaudeAccountsLogger;
		eventBus?: EventBus;
	} {
		return {
			mode,
			log: this.deps.log,
			...(this.deps.eventBus ? { eventBus: this.deps.eventBus } : {}),
		};
	}

	private async clearDeletionMarkersOrThrow(
		workspaceIds: readonly string[],
		originalError: unknown,
	): Promise<void> {
		const janitor = this.requireJanitor();
		const clearResults = await Promise.allSettled(
			workspaceIds.map((workspaceId) =>
				janitor.clearDeletionMarker(workspaceId),
			),
		);
		const clearErrors = clearResults.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (clearErrors.length > 0) {
			throw new AggregateError(
				[originalError, ...clearErrors],
				"Workspace deletion failed and one or more Claude profile markers could not be cleared",
			);
		}
	}

	private async deletePreparedProfile(workspaceId: string): Promise<void> {
		const janitor = this.requireJanitor();
		const marker = await janitor.readDeletionMarker(workspaceId);
		if (!marker) {
			throw new Error(
				`Claude profile deletion marker disappeared for ${workspaceId}`,
			);
		}
		await this.deleteProfileWithTerminalIds(workspaceId, marker.terminalIds);
		await janitor.clearDeletionMarker(workspaceId);
	}

	private async deleteProfileWithTerminalIds(
		workspaceId: string,
		terminalIds: readonly string[],
	): Promise<void> {
		const disposalOptions = this.disposalOptions("warn-and-continue");
		await disposeTerminalIds(this.deps.db, terminalIds, disposalOptions);
		try {
			await this.profiles.deleteProfileDir(workspaceId);
		} catch (error) {
			if (!isBusyFsError(error)) throw error;
			const retryIds = [
				...terminalIds,
				...listUndisposedTerminalIdsByWorkspaceId(workspaceId, this.deps.db),
			];
			await disposeTerminalIds(this.deps.db, retryIds, disposalOptions);
			await this.profiles.deleteProfileDir(workspaceId);
		}
		this.credentialCache.delete(workspaceId);
		for (const cause of this.warningCauses.get(workspaceId)?.keys() ?? []) {
			this.setWarningCause(workspaceId, cause, null, { emit: false });
		}
		const referencedSlugs = new Set(
			this.deps.db
				.select({ slug: workspaces.claudeAccountSlug })
				.from(workspaces)
				.all()
				.flatMap((row) => (row.slug ? [row.slug] : [])),
		);
		for (const credentials of this.credentialCache.values()) {
			if (credentials?.trayManagedAccount) {
				referencedSlugs.add(credentials.trayManagedAccount);
			}
		}
		for (const slug of this.tokenBackoffs.keys()) {
			if (!referencedSlugs.has(slug)) this.tokenBackoffs.delete(slug);
		}
	}

	private ensureDatabaseInstance(): {
		dbInstanceId: string;
		managedLatch: boolean;
	} {
		const existing = this.deps.db
			.select({
				dbInstanceId: hostSettings.claudeAccountsDbInstanceId,
				managedLatch: hostSettings.claudeAccountsManaged,
			})
			.from(hostSettings)
			.where(eq(hostSettings.id, HOST_SETTINGS_ID))
			.get();
		const dbInstanceId = existing?.dbInstanceId ?? randomUUID();
		if (!existing?.dbInstanceId) {
			this.deps.db
				.insert(hostSettings)
				.values({
					id: HOST_SETTINGS_ID,
					claudeAccountsDbInstanceId: dbInstanceId,
				})
				.onConflictDoUpdate({
					target: hostSettings.id,
					set: { claudeAccountsDbInstanceId: dbInstanceId },
				})
				.run();
		}
		return {
			dbInstanceId,
			managedLatch: existing?.managedLatch === true,
		};
	}

	private persistManagedLatch(): void {
		if (this.managedLatchPersisted) return;
		this.deps.db
			.insert(hostSettings)
			.values({ id: HOST_SETTINGS_ID, claudeAccountsManaged: true })
			.onConflictDoUpdate({
				target: hostSettings.id,
				set: { claudeAccountsManaged: true },
			})
			.run();
		this.managedLatchPersisted = true;
	}

	private latchManaged(): void {
		if (!this.managed) this.managed = true;
		this.persistManagedLatch();
	}

	private async refreshPushKeyHealth(options: {
		emitWarning: boolean;
	}): Promise<boolean> {
		let configured = true;
		try {
			await this.pi.validatePushKey();
		} catch {
			configured = false;
		}
		this.setWarningCause(
			null,
			"push-key",
			configured
				? null
				: "Claude account management is active, but the Pi push key is unavailable or invalid.",
			{ emit: options.emitWarning },
		);
		return configured;
	}

	private clearGlobalRenewalWarningIfHealthy(
		activeWorkspaceIds: readonly string[],
	): void {
		const activeIds = new Set(activeWorkspaceIds);
		const inactiveRenewalWorkspaceIds = [...this.warningCauses]
			.filter(
				([key, causes]) =>
					key !== GLOBAL_WARNING_KEY &&
					!activeIds.has(key) &&
					causes.has("renewal"),
			)
			.map(([key]) => key);
		for (const workspaceId of inactiveRenewalWorkspaceIds) {
			this.setWarningCause(workspaceId, "renewal", null);
		}
		const renewalFailureRemains = [...activeIds].some((workspaceId) =>
			this.warningCauses.get(workspaceId)?.has("renewal"),
		);
		if (!renewalFailureRemains) {
			this.setWarningCause(null, "pi-renewal", null);
		}
	}

	private async hasManagedProfileState(): Promise<boolean> {
		const entries = await readdir(this.profiles.profilesRoot, {
			withFileTypes: true,
		});
		return entries.some(
			(entry) => entry.isDirectory() && isWorkspaceUuid(entry.name),
		);
	}

	private startCredentialsWatcher(): void {
		const parent = dirname(this.profiles.globalCredentialsPath);
		const filename = basename(this.profiles.globalCredentialsPath);
		try {
			this.credentialsWatcher = watch(parent, (eventType, changed) => {
				if (changed?.toString() !== filename) return;
				this.deps.log.info("Machine-default Claude credentials changed", {
					eventType,
				});
				const followingRows = this.deps.db
					.select({ id: workspaces.id })
					.from(workspaces)
					.where(isNull(workspaces.claudeAccountSlug))
					.all();
				for (const row of followingRows) this.credentialCache.delete(row.id);
				void this.runTick().catch((error) => {
					this.deps.log.error("Claude credential mirror tick failed", {
						error,
					});
				});
			});
			this.credentialsWatcher.on("error", (error) => {
				this.deps.log.warn(
					"Machine-default Claude credential watcher failed; 60-second polling remains active",
					{ error },
				);
			});
		} catch (error) {
			this.deps.log.warn(
				"Could not start machine-default Claude credential watcher; 60-second polling remains active",
				{ error },
			);
		}
	}

	private setWarningCause(
		workspaceId: string | null,
		cause: string,
		message: string | null,
		options?: { emit?: boolean },
	): void {
		const key = workspaceId ?? GLOBAL_WARNING_KEY;
		const previous = this.renderWarning(workspaceId);
		let causes = this.warningCauses.get(key);
		if (!causes) {
			causes = new Map();
			this.warningCauses.set(key, causes);
		}
		if (message === null) causes.delete(cause);
		else causes.set(cause, message);
		if (causes.size === 0) this.warningCauses.delete(key);
		const rendered = this.renderWarning(workspaceId);
		const emit =
			options?.emit ??
			(workspaceId === null || !SILENT_WORKSPACE_CAUSES.has(cause));
		if (rendered === previous || !emit) return;
		const eventMessage = rendered ?? previous;
		if (eventMessage === null) return;
		this.deps.emit({
			type: "claude-account-warning",
			workspaceId,
			kind: "credential-health",
			message: eventMessage,
			active: rendered !== null,
		});
	}

	private mapWorkspaceState(
		workspaceId: string,
		slug: string | null,
	): WorkspaceClaudeAccountState {
		const message = this.renderWarning(workspaceId);
		return {
			workspaceId,
			state: slug === null ? "following" : "pinned",
			slug,
			warning: message ? { kind: "credential-health", message } : null,
		};
	}

	private renderWarning(workspaceId: string | null): string | null {
		const key = workspaceId ?? GLOBAL_WARNING_KEY;
		const messages = [...(this.warningCauses.get(key)?.values() ?? [])];
		if (workspaceId !== null && this.managed && !this.configured) {
			messages.push(
				"The Pi push key is unavailable. This workspace will keep its last-good Claude token.",
			);
		}
		return messages.length > 0 ? messages.join(" ") : null;
	}

	private requireJanitor(): ClaudeProfileJanitor {
		if (!this.janitor) {
			throw new Error("Claude accounts service has not started");
		}
		return this.janitor;
	}
}

function accountHealthMessage(
	prefix: string,
	slug: string,
	account: PiAccount,
): string | null {
	if (account.dead) {
		return `${prefix} '${slug}' needs re-login${account.deadReason ? `: ${account.deadReason}` : "."}`;
	}
	return account.enabled ? null : `${prefix} '${slug}' is disabled.`;
}

function findClaudeAccount(
	roster: readonly PiAccount[],
	slug: string,
): PiAccount | undefined {
	return roster.find(
		(account) => account.type === "claude" && account.slug === slug,
	);
}

function sameAccessToken(
	left: ManagedCredentials | null,
	right: ManagedCredentials,
): boolean {
	return (
		left?.claudeAiOauth.accessToken === right.claudeAiOauth.accessToken &&
		left.claudeAiOauth.expiresAt === right.claudeAiOauth.expiresAt &&
		left.trayManagedAccount === right.trayManagedAccount
	);
}

function isBusyFsError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "EBUSY"
	);
}

export function createClaudeAccountsService(
	deps: ClaudeAccountsServiceDeps,
): ClaudeAccountsService {
	return new ClaudeAccountsServiceImpl(deps);
}
