import type { CheckoutIdentity } from "../../../../../runtime/git/checkout-identity";
import {
	MAX_COLD_ENTRIES,
	MAX_COLD_RETAINED_FILES,
} from "../diff-stats-limits";
import type { GitStatusSnapshot } from "../git-status";
import {
	applyStatusPartial,
	type GitStatusPartial,
	shouldRecomputeInFull,
} from "../git-status-partial";

/**
 * One cached snapshot per (workspace, baseBranch). Readers on the same
 * workspace routinely differ in base branch — the sidebar stats read with
 * none, the Changes tab with the configured one — and only the against-base
 * fields depend on it, so every variant is patched from the same change
 * stream instead of the variants evicting each other.
 */
interface Variant {
	cached: GitStatusSnapshot | null;
	/** Paths changed since `cached`, or null when a full walk is required. */
	pending: Set<string> | null;
	/** Reads on one variant run one at a time so a later read sees the earlier patch. */
	queue: Promise<unknown>;
}

interface ReadInput {
	coldCache?: CheckoutIdentity;
	workspaceId: string;
	baseBranch: string | null;
	computeFull: () => Promise<GitStatusSnapshot>;
	computePartial: (paths: string[]) => Promise<GitStatusPartial>;
	/** (DIFFSTATS-COLD-CACHE) Cold reads only, asked once `computeFull`
	 * resolves: false serves that snapshot and caches nothing. */
	statsComplete?: () => boolean;
}

// (DIFFSTATS-COLD-CACHE)
interface ColdEntry extends CheckoutIdentity {
	workspaceId: string;
	walkStartedAt: number;
	baseRefFetchKey: string | null;
	/** Set at creation and again once the walk resolves, so an in-flight entry
	 * holds its key's coalescing slot only until this passes. */
	expiresAt: number;
	retainedFiles: number;
	release: ReturnType<typeof setTimeout>;
	value: Promise<GitStatusSnapshot>;
}

const COLD_CACHE_TTL_MS = 120_000;
const MAX_CHECKOUT_IDENTITIES = 5_000;

function coldKey(workspaceId: string, baseBranch: string | null): string {
	return JSON.stringify([workspaceId, baseBranch]);
}

function touchNewest<Key, Value>(
	entries: Map<Key, Value>,
	key: Key,
	value: Value,
	limit: number,
): void {
	entries.delete(key);
	entries.set(key, value);
	if (entries.size <= limit) return;
	const oldest = entries.keys().next();
	if (!oldest.done) entries.delete(oldest.value);
}

export class GitStatusStore {
	private readonly cold = new Map<string, ColdEntry>();
	private readonly checkoutIdentities = new Map<string, CheckoutIdentity>();
	private readonly workspaces = new Map<string, Map<string, Variant>>();

	attach(workspaceId: string): void {
		this.invalidateCold(workspaceId);
		if (!this.workspaces.has(workspaceId)) {
			this.workspaces.set(workspaceId, new Map());
		}
	}

	drop(workspaceId: string): void {
		this.invalidateCold(workspaceId);
		this.workspaces.delete(workspaceId);
	}

	forgetDeletedWorkspace(workspaceId: string): void {
		this.invalidateCold(workspaceId);
		this.checkoutIdentities.delete(workspaceId);
	}

	/** Two workspaces can share one checkout, and a mutation on either must drop
	 * both their cold rows, so every read records this and not cold reads alone.
	 * (DIFFSTATS-COLD-CACHE) */
	noteCheckoutIdentity(workspaceId: string, identity: CheckoutIdentity): void {
		touchNewest(
			this.checkoutIdentities,
			workspaceId,
			identity,
			MAX_CHECKOUT_IDENTITIES,
		);
	}

	invalidateCold(workspaceId: string): void {
		const directoryId = this.checkoutIdentities.get(workspaceId)?.directoryId;
		this.dropCold(
			(entry) =>
				entry.workspaceId === workspaceId || entry.directoryId === directoryId,
		);
	}

	noteColdBaseRefFetch(args: {
		workspaceId: string;
		baseBranch: string | null;
		fetchKey: string;
	}): void {
		const entry = this.cold.get(coldKey(args.workspaceId, args.baseBranch));
		if (entry) entry.baseRefFetchKey = args.fetchKey;
	}

	invalidateColdBaseRef(fetchKey: string, landedAt: number): void {
		this.dropCold(
			(entry) =>
				entry.baseRefFetchKey === fetchKey && entry.walkStartedAt <= landedAt,
		);
	}

	recordChange(workspaceId: string, paths: string[] | undefined): void {
		this.invalidateCold(workspaceId);
		const variants = this.workspaces.get(workspaceId);
		if (!variants) return;
		for (const variant of variants.values()) {
			if (paths === undefined || variant.pending === null) {
				variant.pending = null;
				continue;
			}
			for (const path of paths) variant.pending.add(path);
		}
	}

	async read(input: ReadInput): Promise<GitStatusSnapshot> {
		if (input.coldCache) return this.readCold(input, input.coldCache);
		const variants = this.workspaces.get(input.workspaceId);
		if (!variants) return input.computeFull();

		const key = input.baseBranch ?? "";
		let variant = variants.get(key);
		if (!variant) {
			variant = { cached: null, pending: null, queue: Promise.resolve() };
			variants.set(key, variant);
		}

		const run = variant.queue.then(() => this.readVariant(input, variant));
		variant.queue = run.catch(() => {});
		return run;
	}

	private readCold(
		input: ReadInput,
		identity: CheckoutIdentity,
	): Promise<GitStatusSnapshot> {
		this.noteCheckoutIdentity(input.workspaceId, identity);
		const key = coldKey(input.workspaceId, input.baseBranch);
		const cached = this.cold.get(key);
		if (
			cached &&
			cached.worktreePath === identity.worktreePath &&
			cached.directoryId === identity.directoryId &&
			cached.expiresAt > Date.now()
		) {
			touchNewest(this.cold, key, cached, MAX_COLD_ENTRIES);
			return cached.value;
		}

		const computing = Promise.resolve().then(input.computeFull);
		const entry: ColdEntry = {
			...identity,
			workspaceId: input.workspaceId,
			walkStartedAt: Date.now(),
			baseRefFetchKey: null,
			expiresAt: Date.now() + COLD_CACHE_TTL_MS,
			retainedFiles: 0,
			release: this.armColdRelease(key),
			value: computing,
		};
		touchNewest(this.cold, key, entry, MAX_COLD_ENTRIES);
		entry.value = computing.then(
			(snapshot) => {
				if (this.cold.get(key) !== entry) return snapshot;
				if (input.statsComplete?.() === false) {
					this.cold.delete(key);
					return snapshot;
				}
				entry.expiresAt = Date.now() + COLD_CACHE_TTL_MS;
				clearTimeout(entry.release);
				entry.release = this.armColdRelease(key);
				entry.retainedFiles =
					snapshot.againstBase.length +
					snapshot.staged.length +
					snapshot.unstaged.length;
				this.dropColdOverFileBudget(key, entry.retainedFiles);
				return snapshot;
			},
			(error) => {
				if (this.cold.get(key) === entry) this.cold.delete(key);
				throw error;
			},
		);
		return entry.value;
	}

	/** Frees an expired entry once cold reads stop. The timer identity-checks
	 * its slot rather than capturing the entry, so an evicted or invalidated
	 * entry is collectable while its timer is still pending.
	 * (DIFFSTATS-COLD-CACHE) */
	private armColdRelease(key: string): ReturnType<typeof setTimeout> {
		const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
			if (this.cold.get(key)?.release === timer) this.cold.delete(key);
		}, COLD_CACHE_TTL_MS);
		timer.unref();
		return timer;
	}

	private dropCold(match: (entry: ColdEntry) => boolean): void {
		for (const [key, entry] of this.cold) {
			if (match(entry)) this.cold.delete(key);
		}
	}

	/** A walk that blows the whole budget on its own is the one entry dropped:
	 * evicting older entries for it would leave it uncached anyway and re-walk
	 * everything else next poll. (DIFFSTATS-COLD-CACHE) */
	private dropColdOverFileBudget(
		resolvedKey: string,
		resolvedFiles: number,
	): void {
		let retained = 0;
		for (const entry of this.cold.values()) retained += entry.retainedFiles;
		if (retained <= MAX_COLD_RETAINED_FILES) return;
		if (resolvedFiles > MAX_COLD_RETAINED_FILES) {
			this.cold.delete(resolvedKey);
			return;
		}
		for (const [key, entry] of this.cold) {
			if (entry.retainedFiles === 0 || key === resolvedKey) continue;
			this.cold.delete(key);
			retained -= entry.retainedFiles;
			if (retained <= MAX_COLD_RETAINED_FILES) return;
		}
	}

	private async readVariant(
		input: ReadInput,
		variant: Variant,
	): Promise<GitStatusSnapshot> {
		if (!variant.cached || variant.pending === null) {
			return this.readFull(input, variant);
		}
		if (variant.pending.size === 0) return variant.cached;

		const paths = [...variant.pending];
		variant.pending = new Set();

		let partial: GitStatusPartial;
		try {
			partial = await input.computePartial(paths);
		} catch (error) {
			if (variant.pending) for (const path of paths) variant.pending.add(path);
			throw error;
		}

		if (shouldRecomputeInFull(variant.cached, partial)) {
			return this.readFull(input, variant);
		}

		const patched = applyStatusPartial(variant.cached, partial);
		if (this.isLive(input.workspaceId, variant)) variant.cached = patched;
		return patched;
	}

	private async readFull(
		input: ReadInput,
		variant: Variant,
	): Promise<GitStatusSnapshot> {
		variant.pending = new Set();

		let snapshot: GitStatusSnapshot;
		try {
			snapshot = await input.computeFull();
		} catch (error) {
			variant.pending = null;
			throw error;
		}

		// A broad change landed during the walk: the result may predate it.
		if (variant.pending === null) return snapshot;
		if (this.isLive(input.workspaceId, variant)) variant.cached = snapshot;
		return snapshot;
	}

	/** False once the workspace was dropped mid-read; caching would resurrect it. */
	private isLive(workspaceId: string, variant: Variant): boolean {
		const variants = this.workspaces.get(workspaceId);
		if (!variants) return false;
		for (const candidate of variants.values()) {
			if (candidate === variant) return true;
		}
		return false;
	}
}

export const gitStatusStore = new GitStatusStore();
