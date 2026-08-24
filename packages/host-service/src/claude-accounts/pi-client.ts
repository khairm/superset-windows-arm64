import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type {
	ClaudeAccessToken,
	ClaudeAccountsLogger,
	PiAccount,
} from "./types";

export const DEFAULT_PI_BASE_URL = "http://100.126.215.29:8126";
export const DEFAULT_PUSH_KEY_PATH = join(
	homedir(),
	".usage-display",
	"push-key.txt",
);
const ACCOUNTS_TIMEOUT_MS = 10_000;
const TOKEN_TIMEOUT_MS = 35_000;
const MIN_TOKEN_VALIDITY_MS = 30 * 60 * 1000;

function isKnownAccountType(value: string): value is PiAccount["type"] {
	return value === "claude" || value === "codex";
}

const isoTimestamp = z
	.string()
	.min(1)
	.refine(
		(value) => Number.isFinite(Date.parse(value)),
		"invalid ISO timestamp",
	);
const percentage = z.number().finite().nonnegative().nullable();

function hasAsciiControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

export const accountSlugSchema = z
	.string()
	.min(1)
	.max(128)
	.refine(
		(slug) => slug === slug.trim(),
		"leading or trailing whitespace in slug",
	)
	.refine(
		(slug) => !hasAsciiControlCharacter(slug),
		"control character in slug",
	);

export function validateAccountSlug(slug: string): void {
	const parsed = accountSlugSchema.safeParse(slug);
	if (!parsed.success) {
		throw new Error(`Invalid Claude account slug: ${JSON.stringify(slug)}`);
	}
}

const accountSchema = z
	.object({
		slug: accountSlugSchema,
		name: z.string().min(1),
		type: z.string().min(1),
		enabled: z.boolean(),
		dead: z.boolean(),
		dead_reason: z.string().min(1).nullable(),
		last_success: isoTimestamp.nullable(),
		consecutive_failures: z.number().int().nonnegative(),
		five_pct: percentage,
		seven_pct: percentage,
		fable_pct: percentage,
		five_resets_at: isoTimestamp.nullable(),
		seven_resets_at: isoTimestamp.nullable(),
		fable_resets_at: isoTimestamp.nullable(),
		in_use: z.boolean(),
		fable_in_use: z.boolean(),
		pc_active: z.boolean(),
	})
	.passthrough();
const accountsSchema = z.array(accountSchema);

const tokenEnvelopeSchema = z
	.object({
		account: accountSlugSchema,
		claude_ai_oauth: z
			.object({
				accessToken: z.string().min(1),
				expiresAt: z.number().int().positive(),
				scopes: z.array(z.string().min(1)).optional(),
				subscriptionType: z.string().min(1).optional(),
				rateLimitTier: z.string().min(1).optional(),
			})
			.strict(),
	})
	.strict();

export class PiRequestError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PiRequestError";
	}
}

export class PiClient {
	private readonly baseUrl: string;
	private readonly pushKeyPath: string;
	private cachedPushKey: {
		value: string;
		mtimeMs: number;
		size: number;
	} | null = null;
	private accountsInFlight: Promise<PiAccount[]> | null = null;
	private readonly tokensInFlight = new Map<
		string,
		Promise<ClaudeAccessToken>
	>();
	private lastGoodAccounts: PiAccount[] | null = null;
	private readonly lastGoodTokens = new Map<string, ClaudeAccessToken>();

	constructor(
		private readonly log: ClaudeAccountsLogger,
		config?: { baseUrl?: string; pushKeyPath?: string },
	) {
		const baseUrl = config?.baseUrl ?? DEFAULT_PI_BASE_URL;
		let parsed: URL;
		try {
			parsed = new URL(baseUrl);
		} catch (error) {
			throw new Error(`Invalid Pi base URL: ${baseUrl}`, { cause: error });
		}
		if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
			throw new Error(`Pi base URL must use HTTP or HTTPS: ${baseUrl}`);
		}
		if (parsed.username || parsed.password || parsed.search || parsed.hash) {
			throw new Error(
				`Pi base URL must not contain credentials, query, or fragment`,
			);
		}
		this.baseUrl = parsed.toString().replace(/\/$/, "");
		this.pushKeyPath = config?.pushKeyPath ?? DEFAULT_PUSH_KEY_PATH;
		if (!isAbsolute(this.pushKeyPath)) {
			throw new Error(`Pi push-key path must be absolute: ${this.pushKeyPath}`);
		}
	}

	getPushKeyPath(): string {
		return this.pushKeyPath;
	}

	async validatePushKey(): Promise<void> {
		await this.readPushKey();
	}

	getAccountsLastGood(): PiAccount[] | null {
		return this.lastGoodAccounts?.map((account) => ({ ...account })) ?? null;
	}

	getTokenLastGood(slug: string): ClaudeAccessToken | null {
		const token = this.lastGoodTokens.get(slug);
		return token ? { ...token } : null;
	}

	rememberToken(token: ClaudeAccessToken): void {
		if (!token.accessToken || !Number.isFinite(token.expiresAt)) {
			throw new Error(`Cannot remember invalid token for ${token.account}`);
		}
		const current = this.lastGoodTokens.get(token.account);
		if (!current || token.expiresAt >= current.expiresAt) {
			this.lastGoodTokens.set(token.account, { ...token });
		}
	}

	fetchAccounts(): Promise<PiAccount[]> {
		if (this.accountsInFlight) return this.accountsInFlight;
		const request = this.requestAccounts().finally(() => {
			if (this.accountsInFlight === request) this.accountsInFlight = null;
		});
		this.accountsInFlight = request;
		return request;
	}

	fetchToken(slug: string): Promise<ClaudeAccessToken> {
		try {
			validateAccountSlug(slug);
		} catch (error) {
			return Promise.reject(error);
		}
		const existing = this.tokensInFlight.get(slug);
		if (existing) return existing;
		const request = this.requestToken(slug).finally(() => {
			if (this.tokensInFlight.get(slug) === request) {
				this.tokensInFlight.delete(slug);
			}
		});
		this.tokensInFlight.set(slug, request);
		return request;
	}

	private async requestAccounts(): Promise<PiAccount[]> {
		const raw = await this.getJson("/accounts", ACCOUNTS_TIMEOUT_MS);
		const parsed = accountsSchema.safeParse(raw);
		if (!parsed.success) {
			throw new PiRequestError(
				`Pi /accounts response failed validation: ${z.prettifyError(parsed.error)}`,
			);
		}
		const supported = parsed.data.filter((account) => {
			if (isKnownAccountType(account.type)) return true;
			this.log.info("Ignoring Pi account with unsupported type", {
				slug: account.slug,
				type: account.type,
			});
			return false;
		});
		const accounts = supported.map(
			(account): PiAccount => ({
				slug: account.slug,
				displayName: account.name,
				type: account.type as PiAccount["type"],
				enabled: account.enabled,
				dead: account.dead,
				deadReason: account.dead_reason,
				lastSuccess: account.last_success,
				fivePct: account.five_pct,
				sevenPct: account.seven_pct,
				fablePct: account.fable_pct,
				fiveResetsAt: account.five_resets_at,
				sevenResetsAt: account.seven_resets_at,
				fableResetsAt: account.fable_resets_at,
				fableInUse: account.fable_in_use,
			}),
		);
		this.lastGoodAccounts = accounts;
		return accounts.map((account) => ({ ...account }));
	}

	private async requestToken(slug: string): Promise<ClaudeAccessToken> {
		const raw = await this.getJson(
			`/accounts/${encodeURIComponent(slug)}/token`,
			TOKEN_TIMEOUT_MS,
		);
		const parsed = tokenEnvelopeSchema.safeParse(raw);
		if (!parsed.success) {
			throw new PiRequestError(
				`Pi token response for ${slug} failed validation: ${z.prettifyError(parsed.error)}`,
			);
		}
		if (parsed.data.account !== slug) {
			throw new PiRequestError(
				`Pi token response account ${parsed.data.account} did not match requested account ${slug}`,
			);
		}
		const oauth = parsed.data.claude_ai_oauth;
		if (oauth.expiresAt - Date.now() < MIN_TOKEN_VALIDITY_MS) {
			throw new PiRequestError(
				`Pi token for ${slug} has less than 30 minutes of validity`,
			);
		}
		const token: ClaudeAccessToken = {
			account: slug,
			accessToken: oauth.accessToken,
			expiresAt: oauth.expiresAt,
			...(oauth.scopes ? { scopes: oauth.scopes } : {}),
			...(oauth.subscriptionType
				? { subscriptionType: oauth.subscriptionType }
				: {}),
			...(oauth.rateLimitTier ? { rateLimitTier: oauth.rateLimitTier } : {}),
		};
		this.rememberToken(token);
		return { ...token };
	}

	private async readPushKey(): Promise<string> {
		let metadata: Awaited<ReturnType<typeof stat>>;
		try {
			metadata = await stat(this.pushKeyPath);
		} catch (error) {
			this.cachedPushKey = null;
			throw new PiRequestError(
				`Cannot read Claude account push key at ${this.pushKeyPath}`,
				{ cause: error },
			);
		}
		if (!metadata.isFile()) {
			this.cachedPushKey = null;
			throw new PiRequestError(
				`Claude account push key path is not a file: ${this.pushKeyPath}`,
			);
		}
		if (
			this.cachedPushKey &&
			this.cachedPushKey.mtimeMs === metadata.mtimeMs &&
			this.cachedPushKey.size === metadata.size
		) {
			return this.cachedPushKey.value;
		}
		let rawKey: string;
		try {
			rawKey = await readFile(this.pushKeyPath, "utf8");
		} catch (error) {
			this.cachedPushKey = null;
			throw new PiRequestError(
				`Cannot read Claude account push key at ${this.pushKeyPath}`,
				{ cause: error },
			);
		}
		const value = rawKey.replace(/^﻿/, "").trim();
		if (!value) {
			this.cachedPushKey = null;
			throw new PiRequestError(
				`Claude account push key at ${this.pushKeyPath} is empty`,
			);
		}
		this.cachedPushKey = {
			value,
			mtimeMs: metadata.mtimeMs,
			size: metadata.size,
		};
		return value;
	}

	private async getJson(path: string, timeoutMs: number): Promise<unknown> {
		const key = await this.readPushKey();
		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}${path}`, {
				headers: { Authorization: `Bearer ${key}` },
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			throw new PiRequestError(`Pi request ${path} failed`, { cause: error });
		}
		if (response.status === 401 || response.status === 403) {
			this.cachedPushKey = null;
		}
		if (!response.ok) {
			throw new PiRequestError(
				`Pi request ${path} returned HTTP ${response.status}`,
			);
		}
		try {
			return await response.json();
		} catch (error) {
			this.log.error("Pi returned invalid JSON", { path, error });
			throw new PiRequestError(`Pi request ${path} returned invalid JSON`, {
				cause: error,
			});
		}
	}
}
