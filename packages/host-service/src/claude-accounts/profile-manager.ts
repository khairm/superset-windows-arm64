import { createHash, randomUUID } from "node:crypto";
import { type Dirent, existsSync } from "node:fs";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ensureClaudeManagedHooksAt } from "@superset/agent-setup";
import { z } from "zod";
import { mapConcurrent } from "../lib/map-concurrent";
import type {
	ClaudeAccessToken,
	ClaudeAccountsLogger,
	GlobalIdentity,
	ManagedCredentials,
} from "./types";
import { SENTINEL_REFRESH_TOKEN } from "./types";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JUNCTION_NAMES = [
	"skills",
	"plugins",
	"hooks",
	"agents",
	"commands",
] as const;
const COPY_NAMES = [
	"settings.json",
	"settings.local.json",
	"CLAUDE.md",
	"statusline",
] as const;
const PROFILE_SWEEP_CONCURRENCY = 6;

interface MirrorSource {
	name: (typeof COPY_NAMES)[number];
	bytes: Buffer;
	hash: string;
	mode: number;
	mtimeMs: number;
	size: number;
}

interface DestinationMirrorState {
	sourceHash: string;
	mtimeMs: number;
	size: number;
}

const oauthSchema = z
	.object({
		accessToken: z.string().min(1),
		expiresAt: z.number().int().positive(),
		refreshToken: z.string().optional(),
		scopes: z.array(z.string().min(1)).optional(),
		subscriptionType: z.string().min(1).optional(),
		rateLimitTier: z.string().min(1).optional(),
	})
	.passthrough();
const globalCredentialsSchema = z
	.object({
		claudeAiOauth: oauthSchema,
		trayManagedAccount: z.string().min(1).optional(),
	})
	.passthrough();
const managedCredentialsSchema = z
	.object({
		claudeAiOauth: oauthSchema.extend({
			refreshToken: z.literal(SENTINEL_REFRESH_TOKEN),
		}),
		trayManagedAccount: z.string().min(1).nullable(),
	})
	.passthrough();

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
}

function assertUuid(workspaceId: string): void {
	if (!UUID_PATTERN.test(workspaceId)) {
		throw new Error(`Invalid workspace UUID: ${workspaceId}`);
	}
}

function normalizeClaudeProjectPath(path: string): string {
	if (!isAbsolute(path))
		throw new Error(`Worktree path is not absolute: ${path}`);
	return resolve(path).replaceAll("\\", "/");
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function toManagedCredentials(
	oauth: {
		accessToken: string;
		expiresAt: number;
		scopes?: string[];
		subscriptionType?: string;
		rateLimitTier?: string;
	},
	slug: string | null,
): ManagedCredentials {
	return {
		claudeAiOauth: {
			accessToken: oauth.accessToken,
			expiresAt: oauth.expiresAt,
			refreshToken: SENTINEL_REFRESH_TOKEN,
			...(oauth.scopes ? { scopes: oauth.scopes } : {}),
			...(oauth.subscriptionType
				? { subscriptionType: oauth.subscriptionType }
				: {}),
			...(oauth.rateLimitTier ? { rateLimitTier: oauth.rateLimitTier } : {}),
		},
		trayManagedAccount: slug,
	};
}

export function credentialsFromToken(
	token: ClaudeAccessToken,
): ManagedCredentials {
	return toManagedCredentials(token, token.account);
}

export class ClaudeProfileManager {
	readonly globalClaudeDir = join(homedir(), ".claude");
	readonly globalCredentialsPath = join(
		this.globalClaudeDir,
		".credentials.json",
	);
	readonly profilesRoot: string;
	private initialized = false;
	private readonly mirrorSourceCache = new Map<
		(typeof COPY_NAMES)[number],
		MirrorSource
	>();
	private readonly destinationMirrorCache = new Map<
		string,
		DestinationMirrorState
	>();

	constructor(
		dbPath: string,
		private readonly log: ClaudeAccountsLogger,
	) {
		if (!dbPath.trim() || !isAbsolute(dbPath)) {
			throw new Error(
				`dbPath must be a non-empty absolute path, got ${dbPath}`,
			);
		}
		this.profilesRoot = resolve(dirname(dbPath), "claude-profiles");
	}

	async initialize(): Promise<void> {
		await mkdir(this.profilesRoot, { recursive: true });
		const canonical = await realpath(this.profilesRoot);
		if (resolve(canonical) !== this.profilesRoot) {
			throw new Error(
				`Claude profiles root ${this.profilesRoot} resolves unexpectedly to ${canonical}`,
			);
		}
		this.initialized = true;
	}

	profileDirFor(workspaceId: string): string {
		assertUuid(workspaceId);
		const candidate = resolve(this.profilesRoot, workspaceId);
		const rel = relative(this.profilesRoot, candidate);
		if (rel !== workspaceId || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
			throw new Error(
				`Workspace profile path escaped profiles root: ${workspaceId}`,
			);
		}
		return candidate;
	}

	markerPathFor(workspaceId: string): string {
		return `${this.profileDirFor(workspaceId)}.delete-intent`;
	}

	stagingPathFor(workspaceId: string): string {
		return `${this.profileDirFor(workspaceId)}.tmp`;
	}

	quarantinePathFor(workspaceId: string): string {
		return `${this.profileDirFor(workspaceId)}.orphaned`;
	}

	async profileExists(workspaceId: string): Promise<boolean> {
		const path = this.profileDirFor(workspaceId);
		try {
			const metadata = await lstat(path);
			if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
				throw new Error(`Claude profile path is not a real directory: ${path}`);
			}
			return true;
		} catch (error) {
			if (isMissing(error)) return false;
			throw error;
		}
	}

	async mintProfile(
		workspaceId: string,
		worktreePath: string,
		credentials: ManagedCredentials | null,
	): Promise<string> {
		this.assertInitialized();
		const finalDir = this.profileDirFor(workspaceId);
		if (await this.profileExists(workspaceId)) {
			await this.refreshProfile(finalDir);
			if (credentials) await this.writeCredentials(finalDir, credentials);
			return finalDir;
		}

		const stagingDir = this.stagingPathFor(workspaceId);
		if (existsSync(stagingDir)) {
			throw new Error(
				`Claude profile staging folder already exists for ${workspaceId}: ${stagingDir}`,
			);
		}
		await mkdir(stagingDir);
		try {
			const mirrorSources = await this.loadMirrorSources();
			await this.ensureJunctions(stagingDir);
			await this.refreshCopiedFiles(stagingDir, mirrorSources);
			await this.writeSeedState(stagingDir, worktreePath);
			if (credentials) await this.writeCredentials(stagingDir, credentials);
			ensureClaudeManagedHooksAt(stagingDir);
			await rename(stagingDir, finalDir);
			this.clearProfileCaches(stagingDir);
			this.log.info("Minted Claude workspace profile", {
				workspaceId,
				profileDir: finalDir,
				credentialed: credentials !== null,
			});
			return finalDir;
		} catch (error) {
			await this.deleteContainedDirectory(
				stagingDir,
				`${workspaceId}.tmp`,
			).catch((cleanupError) => {
				this.log.error("Could not clean failed Claude profile staging folder", {
					workspaceId,
					stagingDir,
					cleanupError,
				});
			});
			throw error;
		}
	}

	async refreshProfile(profileDir: string): Promise<void> {
		const mirrorSources = await this.loadMirrorSources();
		await this.refreshProfileWithSources(profileDir, mirrorSources);
	}

	async sweepProfiles(workspaceIds: readonly string[]): Promise<void> {
		const mirrorSources = await this.loadMirrorSources();
		await mapConcurrent(
			workspaceIds,
			PROFILE_SWEEP_CONCURRENCY,
			async (workspaceId) => {
				if (!(await this.profileExists(workspaceId))) return;
				await this.refreshProfileWithSources(
					this.profileDirFor(workspaceId),
					mirrorSources,
				);
			},
		);
	}

	async readGlobalIdentity(): Promise<GlobalIdentity> {
		let text: string;
		try {
			text = await readFile(this.globalCredentialsPath, "utf8");
		} catch (error) {
			if (isMissing(error)) return { kind: "absent" };
			throw new Error(
				`Cannot read machine-default Claude credentials at ${this.globalCredentialsPath}`,
				{ cause: error },
			);
		}
		if (!text.trim()) return { kind: "absent" };
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch (error) {
			throw new Error(
				`Machine-default Claude credentials are invalid JSON at ${this.globalCredentialsPath}`,
				{ cause: error },
			);
		}
		const parsed = globalCredentialsSchema.safeParse(raw);
		if (!parsed.success) {
			throw new Error(
				`Machine-default Claude credentials failed validation: ${z.prettifyError(parsed.error)}`,
			);
		}
		const slug = parsed.data.trayManagedAccount;
		const credentials = toManagedCredentials(
			parsed.data.claudeAiOauth,
			slug ?? null,
		);
		return slug
			? { kind: "tray", slug, credentials }
			: { kind: "unmanaged", credentials };
	}

	async readProfileCredentials(
		workspaceId: string,
	): Promise<ManagedCredentials | null> {
		const path = join(this.profileDirFor(workspaceId), ".credentials.json");
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			if (isMissing(error)) return null;
			throw new Error(`Cannot read Claude credentials at ${path}`, {
				cause: error,
			});
		}
		if (!text.trim()) {
			throw new Error(`Claude credentials file is empty at ${path}`);
		}
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch (error) {
			throw new Error(`Claude credentials are invalid JSON at ${path}`, {
				cause: error,
			});
		}
		const parsed = managedCredentialsSchema.safeParse(raw);
		if (!parsed.success) {
			throw new Error(
				`Claude credentials failed validation at ${path}: ${z.prettifyError(parsed.error)}`,
			);
		}
		return toManagedCredentials(
			parsed.data.claudeAiOauth,
			parsed.data.trayManagedAccount,
		);
	}

	async writeCredentials(
		profileDir: string,
		credentials: ManagedCredentials,
	): Promise<void> {
		this.assertContainedProfileDir(profileDir, true);
		const parsed = managedCredentialsSchema.safeParse(credentials);
		if (!parsed.success) {
			throw new Error(
				`Refusing to write invalid or empty Claude credentials: ${z.prettifyError(parsed.error)}`,
			);
		}
		await this.atomicWriteJson(
			join(profileDir, ".credentials.json"),
			credentials,
		);
	}

	async removeCredentials(profileDir: string): Promise<void> {
		this.assertContainedProfileDir(profileDir, true);
		try {
			await unlink(join(profileDir, ".credentials.json"));
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
	}

	async writeMarkerFile(path: string, value: unknown): Promise<void> {
		this.assertRootChild(path);
		await this.atomicWriteJson(path, value);
	}

	async deleteProfileDir(workspaceId: string): Promise<void> {
		const profileDir = this.profileDirFor(workspaceId);
		await this.deleteContainedDirectory(profileDir, workspaceId);
		this.clearProfileCaches(profileDir);
	}

	async deleteStagingDir(workspaceId: string): Promise<void> {
		const stagingDir = this.stagingPathFor(workspaceId);
		await this.deleteContainedDirectory(stagingDir, `${workspaceId}.tmp`);
		this.clearProfileCaches(stagingDir);
	}

	async quarantineProfile(workspaceId: string): Promise<void> {
		const source = this.profileDirFor(workspaceId);
		const destination = this.quarantinePathFor(workspaceId);
		this.assertRootChild(destination);
		await rename(source, destination);
		this.clearProfileCaches(source);
	}

	private async writeSeedState(
		profileDir: string,
		worktreePath: string,
	): Promise<void> {
		const globalStatePath = join(homedir(), ".claude.json");
		let globalState: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(
				await readFile(globalStatePath, "utf8"),
			);
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed)
			) {
				throw new Error("root is not an object");
			}
			globalState = parsed as Record<string, unknown>;
		} catch (error) {
			throw new Error(`Cannot seed Claude profile from ${globalStatePath}`, {
				cause: error,
			});
		}
		const lastOnboardingVersion = globalState.lastOnboardingVersion;
		const installMethod = globalState.installMethod;
		const autoUpdates = globalState.autoUpdates;
		const mcpServers = globalState.mcpServers;
		if (
			typeof lastOnboardingVersion !== "string" ||
			!lastOnboardingVersion ||
			typeof installMethod !== "string" ||
			!installMethod ||
			typeof autoUpdates !== "boolean" ||
			typeof mcpServers !== "object" ||
			mcpServers === null ||
			Array.isArray(mcpServers)
		) {
			throw new Error(
				`Claude state at ${globalStatePath} lacks required onboarding fields`,
			);
		}
		const projectPath = normalizeClaudeProjectPath(worktreePath);
		await this.atomicWriteJson(join(profileDir, ".claude.json"), {
			hasCompletedOnboarding: true,
			lastOnboardingVersion,
			installMethod,
			autoUpdates,
			mcpServers,
			projects: {
				[projectPath]: {
					allowedTools: [],
					mcpContextUris: [],
					mcpServers: {},
					enabledMcpjsonServers: [],
					disabledMcpjsonServers: [],
					hasTrustDialogAccepted: true,
					projectOnboardingSeenCount: 0,
					hasCompletedProjectOnboarding: true,
				},
			},
		});
	}

	private async ensureJunctions(profileDir: string): Promise<void> {
		for (const name of JUNCTION_NAMES) {
			const target = join(this.globalClaudeDir, name);
			const link = join(profileDir, name);
			await mkdir(target, { recursive: true });
			const linkMetadata = await lstat(link).catch(async (error) => {
				if (!isMissing(error)) throw error;
				await symlink(resolve(target), link, "junction");
				return null;
			});
			if (!linkMetadata) continue;
			if (!linkMetadata.isSymbolicLink()) {
				throw new Error(
					`Expected junction at ${link}, found another entry type`,
				);
			}
			const expectedTarget = await realpath(target);
			let actualTarget: string;
			try {
				actualTarget = await realpath(link);
			} catch (error) {
				if (!isMissing(error)) throw error;
				await unlink(link);
				await symlink(resolve(target), link, "junction");
				this.log.warn("Recreated dangling Claude profile junction", {
					link,
					target,
				});
				continue;
			}
			if (actualTarget.toLowerCase() !== expectedTarget.toLowerCase()) {
				const rawTarget = await readlink(link);
				throw new Error(
					`Junction ${link} targets ${rawTarget}, expected ${target}`,
				);
			}
		}
	}

	private async refreshProfileWithSources(
		profileDir: string,
		mirrorSources: readonly MirrorSource[],
	): Promise<void> {
		this.assertContainedProfileDir(profileDir);
		await this.ensureJunctions(profileDir);
		await this.refreshCopiedFiles(profileDir, mirrorSources);
		ensureClaudeManagedHooksAt(profileDir);
	}

	private async loadMirrorSources(): Promise<MirrorSource[]> {
		const sources = await Promise.all(
			COPY_NAMES.map(async (name): Promise<MirrorSource | null> => {
				const path = join(this.globalClaudeDir, name);
				try {
					const metadata = await stat(path);
					if (!metadata.isFile()) {
						throw new Error(
							`Claude mirror source does not resolve to a file: ${path}`,
						);
					}
					const cached = this.mirrorSourceCache.get(name);
					if (
						cached?.mtimeMs === metadata.mtimeMs &&
						cached.size === metadata.size
					) {
						return cached;
					}
					const bytes = await readFile(path);
					const source: MirrorSource = {
						name,
						bytes,
						hash: sha256(bytes),
						mode: metadata.mode,
						mtimeMs: metadata.mtimeMs,
						size: metadata.size,
					};
					this.mirrorSourceCache.set(name, source);
					return source;
				} catch (error) {
					if (isMissing(error)) {
						this.mirrorSourceCache.delete(name);
						return null;
					}
					throw error;
				}
			}),
		);
		return sources.filter((source): source is MirrorSource => source !== null);
	}

	private async refreshCopiedFiles(
		profileDir: string,
		mirrorSources: readonly MirrorSource[],
	): Promise<void> {
		for (const source of mirrorSources) {
			const destination = join(profileDir, source.name);
			let unchanged = false;
			try {
				const destinationStat = await lstat(destination);
				if (!destinationStat.isFile()) {
					throw new Error(
						`Claude copied mirror destination is not a file: ${destination}`,
					);
				}
				const cached = this.destinationMirrorCache.get(destination);
				if (
					cached?.sourceHash === source.hash &&
					cached.mtimeMs === destinationStat.mtimeMs &&
					cached.size === destinationStat.size
				) {
					unchanged = true;
				} else if (destinationStat.size === source.size) {
					unchanged = source.hash === sha256(await readFile(destination));
					if (unchanged) {
						this.destinationMirrorCache.set(destination, {
							sourceHash: source.hash,
							mtimeMs: destinationStat.mtimeMs,
							size: destinationStat.size,
						});
					}
				}
			} catch (error) {
				this.destinationMirrorCache.delete(destination);
				if (!isMissing(error)) throw error;
			}
			if (unchanged) continue;
			const temporary = `${destination}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, source.bytes, { mode: source.mode });
				await rename(temporary, destination);
				const destinationStat = await lstat(destination);
				this.destinationMirrorCache.set(destination, {
					sourceHash: source.hash,
					mtimeMs: destinationStat.mtimeMs,
					size: destinationStat.size,
				});
			} catch (error) {
				await unlink(temporary).catch((cleanupError) => {
					if (!isMissing(cleanupError)) {
						this.log.warn("Could not remove failed mirror temporary file", {
							temporary,
							cleanupError,
						});
					}
				});
				throw error;
			}
		}
	}

	private async atomicWriteJson(path: string, value: unknown): Promise<void> {
		const temporary = `${path}.${randomUUID()}.tmp`;
		const text = `${JSON.stringify(value, null, 2)}\n`;
		if (!text.trim())
			throw new Error(`Refusing to write empty JSON file at ${path}`);
		try {
			await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
			await rename(temporary, path);
		} catch (error) {
			await unlink(temporary).catch((cleanupError) => {
				if (!isMissing(cleanupError)) {
					this.log.warn("Could not remove failed atomic-write temporary file", {
						temporary,
						cleanupError,
					});
				}
			});
			throw error;
		}
	}

	private async deleteContainedDirectory(
		path: string,
		expectedRootName: string,
	): Promise<void> {
		this.assertRootChild(path, expectedRootName);
		let entries: Dirent[];
		try {
			const rootStat = await lstat(path);
			if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
				throw new Error(
					`Refusing to delete non-directory Claude profile path ${path}`,
				);
			}
			entries = await readdir(path, { withFileTypes: true });
		} catch (error) {
			if (isMissing(error)) return;
			throw error;
		}
		for (const entry of entries) {
			const entryPath = join(path, entry.name);
			const entryStat = await lstat(entryPath);
			if (entryStat.isSymbolicLink()) {
				await unlink(entryPath);
				continue;
			}
			if (!entryStat.isDirectory() && !entryStat.isFile()) {
				throw new Error(
					`Refusing to delete Claude profile with unexpected entry type: ${entryPath}`,
				);
			}
		}
		const remaining = await readdir(path, { withFileTypes: true });
		for (const entry of remaining) {
			if ((await lstat(join(path, entry.name))).isSymbolicLink()) {
				throw new Error(
					`Refusing recursive delete while reparse point remains: ${join(path, entry.name)}`,
				);
			}
		}
		await rm(path, { recursive: true });
	}

	private clearProfileCaches(profileDir: string): void {
		const prefix = `${profileDir}${sep}`;
		for (const destination of this.destinationMirrorCache.keys()) {
			if (destination.startsWith(prefix)) {
				this.destinationMirrorCache.delete(destination);
			}
		}
	}

	private assertContainedProfileDir(
		profileDir: string,
		allowStaging = false,
	): void {
		const name = relative(this.profilesRoot, resolve(profileDir));
		const valid =
			UUID_PATTERN.test(name) || (allowStaging && name.endsWith(".tmp"));
		if (
			!valid ||
			name.includes(sep) ||
			name.startsWith("..") ||
			isAbsolute(name)
		) {
			throw new Error(
				`Path is not a contained Claude profile folder: ${profileDir}`,
			);
		}
	}

	private assertRootChild(path: string, expectedName?: string): void {
		const rel = relative(this.profilesRoot, resolve(path));
		if (
			!rel ||
			rel.includes(sep) ||
			rel.startsWith("..") ||
			isAbsolute(rel) ||
			(expectedName !== undefined && rel !== expectedName)
		) {
			throw new Error(
				`Path is not an expected child of profiles root: ${path}`,
			);
		}
	}

	private assertInitialized(): void {
		if (!this.initialized) {
			throw new Error(
				"Claude profile manager was used before initialize() completed",
			);
		}
	}
}

export function isWorkspaceUuid(value: string): boolean {
	return UUID_PATTERN.test(value);
}

export function isMissingFsError(error: unknown): boolean {
	return isMissing(error);
}
