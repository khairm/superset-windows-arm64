import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { basename, join } from "node:path";
import {
	SUPERSET_HOME_DIR,
	SUPERSET_HOME_DIR_MODE,
	SUPERSET_SENSITIVE_FILE_MODE,
} from "main/lib/app-environment";
import { lock } from "proper-lockfile";
import { decrypt } from "./crypto-storage";

interface StoredAuth {
	token: string;
	expiresAt: string;
	organizationIds?: string[];
	organizationIdsRevision?: number;
}

interface LoadedAuth {
	token: string | null;
	expiresAt: string | null;
	organizationIds: string[] | null;
	organizationIdsRevision: number;
}

const TOKEN_FILE_NAME = "auth-token.enc";
const EMPTY_LOADED_AUTH: LoadedAuth = {
	token: null,
	expiresAt: null,
	organizationIds: null,
	organizationIdsRevision: 0,
};

type InspectedTokenStorage =
	| { status: "missing" }
	| { status: "valid"; storedAuth: StoredAuth }
	| { status: "invalid"; reason: string };

function getTokenFile(): string {
	return join(
		process.env.SUPERSET_HOME_DIR || SUPERSET_HOME_DIR,
		TOKEN_FILE_NAME,
	);
}

async function withAuthLock<Result>(
	operation: () => Promise<Result>,
): Promise<Result> {
	const release = await lock(getTokenFile(), {
		realpath: false,
		stale: 10_000,
		retries: { retries: 10, factor: 1, minTimeout: 25, maxTimeout: 250 },
	});
	try {
		return await operation();
	} finally {
		await release();
	}
}

function parseStoredAuth(data: Buffer): StoredAuth {
	const parsed: unknown = JSON.parse(decrypt(data));
	if (!parsed || typeof parsed !== "object") {
		throw new Error("Invalid stored auth payload");
	}
	const candidate = parsed as Record<string, unknown>;
	if (
		typeof candidate.token !== "string" ||
		candidate.token.length === 0 ||
		typeof candidate.expiresAt !== "string" ||
		candidate.expiresAt.length === 0 ||
		Number.isNaN(Date.parse(candidate.expiresAt))
	) {
		throw new Error("Invalid stored auth payload");
	}
	return {
		token: candidate.token,
		expiresAt: candidate.expiresAt,
		organizationIds: Array.isArray(candidate.organizationIds)
			? candidate.organizationIds.filter(
					(value): value is string =>
						typeof value === "string" && value.length > 0,
				)
			: undefined,
		organizationIdsRevision:
			typeof candidate.organizationIdsRevision === "number" &&
			Number.isSafeInteger(candidate.organizationIdsRevision) &&
			candidate.organizationIdsRevision >= 0
				? candidate.organizationIdsRevision
				: undefined,
	};
}

function describePathType(stats: Awaited<ReturnType<typeof fs.lstat>>): string {
	if (stats.isDirectory()) return "directory";
	if (stats.isSymbolicLink()) return "symbolic link";
	return "special file";
}

async function inspectTokenStorage(
	tokenFile: string,
): Promise<InspectedTokenStorage> {
	let stats: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		stats = await fs.lstat(tokenFile);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { status: "missing" };
		}
		throw error;
	}

	if (!stats.isFile()) {
		return {
			status: "invalid",
			reason: `path is a ${describePathType(stats)}`,
		};
	}

	const encrypted = await fs.readFile(tokenFile);
	try {
		return { status: "valid", storedAuth: parseStoredAuth(encrypted) };
	} catch {
		return {
			status: "invalid",
			reason: "contents could not be decrypted or parsed",
		};
	}
}

async function quarantineInvalidTokenStorage(
	tokenFile: string,
	reason: string,
): Promise<string> {
	const quarantinePath = `${tokenFile}.corrupt-${Date.now()}-${randomUUID()}`;
	await fs.rename(tokenFile, quarantinePath);
	console.warn(
		`[auth] Quarantined invalid auth token storage (${reason}) as ${basename(quarantinePath)}`,
	);
	return quarantinePath;
}

/** Returns the stored auth, quarantining the file if it is unusable. */
async function readStoredAuth(): Promise<StoredAuth | null> {
	const tokenFile = getTokenFile();
	const inspected = await inspectTokenStorage(tokenFile);
	if (inspected.status === "missing") return null;
	if (inspected.status === "invalid") {
		await quarantineInvalidTokenStorage(tokenFile, inspected.reason);
		return null;
	}
	return inspected.storedAuth;
}

/**
 * (CLOUD-SEVERANCE-P2) Everything that WROTE this file is gone: the OAuth
 * callback that saved a token, the sign-out that cleared it, the membership
 * cache that appended organization ids, the deep-link parser that fed the
 * callback, and the event emitter the renderer subscribed to. With no cloud
 * there is nothing to store, and the store's only remaining influence is over
 * which identity the host-service runs under — so it is read-only by
 * construction rather than by convention.
 *
 * The file itself is left alone rather than deleted. A pre-severance install
 * still has one, and main reads its organization ids to break a tie when this
 * machine holds more than one host database.
 */

/**
 * Load token from encrypted disk storage.
 */
export async function loadToken(): Promise<LoadedAuth> {
	const tokenFile = getTokenFile();
	try {
		const storedAuth = await readStoredAuth();
		if (!storedAuth) return EMPTY_LOADED_AUTH;

		await fs
			.chmod(tokenFile, SUPERSET_SENSITIVE_FILE_MODE)
			.catch((error) =>
				console.warn("[auth] Failed to repair auth token permissions", error),
			);
		return {
			token: storedAuth.token,
			expiresAt: storedAuth.expiresAt,
			organizationIds: storedAuth.organizationIds ?? null,
			organizationIdsRevision: storedAuth.organizationIdsRevision ?? 0,
		};
	} catch (error) {
		console.error("[auth] Failed to inspect auth token storage", error);
		return EMPTY_LOADED_AUTH;
	}
}
