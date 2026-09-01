import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { discoverClaudeProfiles } from "../profiles";
import type { ModelProvider, UsageAgent } from "../types";
import { collectUsageEntries } from "./entries";
import { collectLogFiles, dedupeLogFiles } from "./logs";
import { inferModelProvider } from "./model-provider";
import type { UsageLogEntry } from "./parse";
import { parseClaudeLogFile } from "./parse";
import {
	cacheSavingsUsd,
	costUsd,
	matchModelRate,
	PRICING_TABLE_UPDATED,
} from "./pricing";

export interface UsageDailyBucket {
	/** Local calendar day, `YYYY-MM-DD` in the host's timezone. */
	day: string;
	agents: Partial<Record<UsageAgent, { usd: number; tokens: number }>>;
	usd: number;
	tokens: number;
}

export interface UsageModelBreakdown {
	agent: UsageAgent;
	modelProvider: ModelProvider;
	model: string;
	usd: number;
	tokens: number;
	approximate: boolean;
}

/** Maps a filesystem prefix to a display label for cwd attribution. */
export interface CwdLabel {
	prefix: string;
	label: string;
	kind: "workspace" | "project";
	/** Owning project's display name — groups workspaces under a project. */
	group?: string | null;
}

export interface UsageProjectBreakdown {
	/** Workspace/project name when the cwd matched a known worktree or repo
	 * path; otherwise a directory-derived fallback. */
	project: string;
	kind: "workspace" | "project" | "other";
	/** Owning project's display name, when known. */
	group: string | null;
	usd: number;
	tokens: number;
}

export interface UsageSessionBreakdown {
	id: string;
	/** First user prompt of the session, when one was found. */
	label: string | null;
	agent: UsageAgent;
	usd: number;
	tokens: number;
	lastMs: number;
}

export interface UsageDrilldownSlice {
	day: string;
	usd: number;
	tokens: number;
}

export interface UsageDrilldownEntry {
	/** Sparse daily series — client zero-fills against the range's days. */
	days: UsageDrilldownSlice[];
	/** Cross-breakdown: models for a workspace, workspaces for a model. */
	breakdown: Array<{
		label: string;
		agent: UsageAgent;
		usd: number;
		tokens: number;
	}>;
	/** Per-session costs — present on workspace cubes only. */
	sessions?: UsageSessionBreakdown[];
	usd: number;
	tokens: number;
}

export interface UsageHistory {
	days: number;
	buckets: UsageDailyBucket[];
	models: UsageModelBreakdown[];
	projects: UsageProjectBreakdown[];
	/** Drilldown cubes, keyed by project label / `agent|model`. Bounded to
	 * the top projects by cost so the payload stays small. */
	projectDetails: Record<string, UsageDrilldownEntry>;
	modelDetails: Record<string, UsageDrilldownEntry>;
	totals: {
		usd: number;
		tokens: number;
		uncachedInput: number;
		cachedInput: number;
		cacheWrite: number;
		output: number;
		reasoningOutput: number;
		cacheSavingsUsd: number;
		/** True when any usage was priced with a fallback rate. */
		approximate: boolean;
	};
	scannedFiles: number;
	pricingTableUpdated: string;
}

/** Local-timezone calendar day, matching what the user's clock says. */
function dayKey(timestampMs: number): string {
	const date = new Date(timestampMs);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function entryTokens(entry: UsageLogEntry): number {
	return (
		entry.uncachedInput +
		entry.cachedInput +
		entry.cacheWrite5m +
		entry.cacheWrite1h +
		entry.output
	);
}

/**
 * Attributes a transcript cwd to a workspace/project. Known prefixes (the
 * host's own workspace worktrees and project repos) win via longest-prefix
 * match; unknown paths fall back to the worktree-name segment or basename.
 */
function attributeCwd(
	cwd: string,
	labelsByLength: CwdLabel[],
): {
	label: string;
	kind: UsageProjectBreakdown["kind"];
	group: string | null;
} {
	for (const { prefix, label, kind, group } of labelsByLength) {
		if (
			cwd === prefix ||
			(cwd.startsWith(prefix) && cwd[prefix.length] === "/")
		) {
			return { label, kind, group: group ?? null };
		}
	}
	// `…/worktrees/<container>/<workspace-name>/…` → the workspace name.
	const segments = cwd.split("/");
	const worktreesIndex = segments.lastIndexOf("worktrees");
	if (worktreesIndex >= 0 && segments.length > worktreesIndex + 2) {
		const name = segments[worktreesIndex + 2];
		if (name) return { label: name, kind: "other", group: null };
	}
	return { label: basename(cwd), kind: "other", group: null };
}

/** Real paths of the `projects/` dirs behind a set of Claude home dirs. */
async function resolveClaudeProjectRoots(
	homes: Iterable<string>,
): Promise<string[]> {
	const resolved = await Promise.all(
		[...homes].map(async (home) => {
			try {
				return await realpath(join(home, "projects"));
			} catch {
				return null; // Dir absent — collectLogFiles would find nothing.
			}
		}),
	);
	return [...new Set(resolved.filter((root): root is string => root !== null))];
}

/**
 * (CLAUDE-ACCOUNTS) Claude transcripts living under the fork's per-workspace
 * profile dirs, which `collectUsageEntries` has no way to discover.
 *
 * Roots it already scans are filtered out by real path, so an entry is never
 * counted twice — the whole reason this is a filtered supplement rather than a
 * plain second scan.
 */
async function collectWorkspaceClaudeEntries(
	workspaceClaudeHomes: string[],
	days: number,
	cutoffMs: number,
	sessionLabels: Map<string, string>,
): Promise<{ entries: UsageLogEntry[]; scannedFiles: number }> {
	const extraHomes = workspaceClaudeHomes
		.map((dir) => dir.trim())
		.filter((dir) => dir.length > 0);
	if (extraHomes.length === 0) return { entries: [], scannedFiles: 0 };

	const home = homedir();
	// Mirrors the discovery `collectUsageEntries` performs for Claude.
	const covered = new Set<string>([
		join(home, ".claude"),
		join(home, ".config", "claude"),
	]);
	for (const dir of (process.env.CLAUDE_CONFIG_DIR ?? "").split(",")) {
		if (dir.trim()) covered.add(dir.trim());
	}
	for (const profile of await discoverClaudeProfiles()) {
		covered.add(profile.configDir);
	}
	const coveredRoots = new Set(await resolveClaudeProjectRoots(covered));
	const roots = (await resolveClaudeProjectRoots(extraHomes)).filter(
		(root) => !coveredRoots.has(root),
	);
	if (roots.length === 0) return { entries: [], scannedFiles: 0 };

	const fileGroups = await Promise.all(
		roots.map((root) => collectLogFiles(root, days + 1)),
	);
	const files = dedupeLogFiles(fileGroups.flat());
	const entries: UsageLogEntry[] = [];
	// One map across every extra root: the same message reached through two
	// profile paths must collapse, exactly as it does inside the helper.
	const entriesByMessage = new Map<string, UsageLogEntry>();
	for (const file of files) {
		await parseClaudeLogFile(
			file,
			entriesByMessage,
			cutoffMs,
			entries,
			sessionLabels,
		);
	}
	entries.push(...entriesByMessage.values());
	return { entries, scannedFiles: files.length };
}

export async function computeUsageHistory(
	days: number,
	cwdLabels: CwdLabel[],
	workspaceClaudeHomes: string[],
): Promise<UsageHistory> {
	const labelsByLength = [...cwdLabels].sort(
		(a, b) => b.prefix.length - a.prefix.length,
	);
	const cutoffMs = (() => {
		// Align to local midnight `days - 1` days ago, so totals equal the sum
		// of the daily buckets shown.
		const start = new Date();
		start.setHours(0, 0, 0, 0);
		start.setDate(start.getDate() - (days - 1));
		return start.getTime();
	})();

	const { entries, sessionLabels, scannedFiles } = await collectUsageEntries(
		days,
		cutoffMs,
		{ cwdCandidates: cwdLabels.map((label) => label.prefix) },
	);

	// (CLAUDE-ACCOUNTS) `collectUsageEntries` finds Claude homes by looking at
	// dot-dirs under ~ and ~/.config, which can never see a per-workspace profile
	// at `<db-dir>/claude-profiles/<uuid>` — without this second pass every
	// pinned account's history vanishes from Usage. It parses ONLY the roots the
	// helper did not already cover: shared-history profiles symlink their
	// `projects/` into ~/.claude, so scanning them again would re-read the same
	// transcripts and double-count. Real paths are compared, which is how the
	// helper dedupes its own roots.
	const workspaceClaude = await collectWorkspaceClaudeEntries(
		workspaceClaudeHomes,
		days,
		cutoffMs,
		sessionLabels,
	);
	entries.push(...workspaceClaude.entries);
	const totalScannedFiles = scannedFiles + workspaceClaude.scannedFiles;

	const bucketsByDay = new Map<string, UsageDailyBucket>();
	const modelsByKey = new Map<string, UsageModelBreakdown>();
	const projectsByKey = new Map<string, UsageProjectBreakdown>();

	// Drilldown accumulators: entity → day slices and cross-breakdowns.
	interface Slice {
		usd: number;
		tokens: number;
	}
	const projectDays = new Map<string, Map<string, Slice>>();
	const projectModels = new Map<
		string,
		Map<string, Slice & { agent: UsageAgent }>
	>();
	const modelDays = new Map<string, Map<string, Slice>>();
	const modelProjects = new Map<
		string,
		Map<string, Slice & { agent: UsageAgent }>
	>();
	const projectSessions = new Map<
		string,
		Map<string, Slice & { agent: UsageAgent; lastMs: number }>
	>();
	const bump = <K>(
		map: Map<K, Slice>,
		key: K,
		usd: number,
		tokens: number,
	): Slice => {
		let slice = map.get(key);
		if (!slice) {
			slice = { usd: 0, tokens: 0 };
			map.set(key, slice);
		}
		slice.usd += usd;
		slice.tokens += tokens;
		return slice;
	};
	const nested = <V>(map: Map<string, Map<string, V>>, key: string) => {
		let inner = map.get(key);
		if (!inner) {
			inner = new Map();
			map.set(key, inner);
		}
		return inner;
	};
	const totals = {
		usd: 0,
		tokens: 0,
		uncachedInput: 0,
		cachedInput: 0,
		cacheWrite: 0,
		output: 0,
		reasoningOutput: 0,
		cacheSavingsUsd: 0,
		approximate: false,
	};

	for (const entry of entries) {
		const rate = matchModelRate(
			entry.agent,
			entry.model,
			entry.uncachedInput + entry.cachedInput,
		);
		// A harness-reported real cost beats the API-list-rate estimate, and an
		// entry priced by its own harness is never "approximate".
		const estimated = entry.costUsd === undefined;
		const usd = entry.costUsd ?? costUsd(rate, entry);
		const tokens = entryTokens(entry);

		const day = dayKey(entry.timestampMs);
		let bucket = bucketsByDay.get(day);
		if (!bucket) {
			bucket = { day, agents: {}, usd: 0, tokens: 0 };
			bucketsByDay.set(day, bucket);
		}
		let agentSlot = bucket.agents[entry.agent];
		if (!agentSlot) {
			agentSlot = { usd: 0, tokens: 0 };
			bucket.agents[entry.agent] = agentSlot;
		}
		agentSlot.usd += usd;
		agentSlot.tokens += tokens;
		bucket.usd += usd;
		bucket.tokens += tokens;

		const modelKey = `${entry.agent}|${entry.model}`;
		let model = modelsByKey.get(modelKey);
		if (!model) {
			model = {
				agent: entry.agent,
				modelProvider: inferModelProvider(entry.agent, entry.model),
				model: entry.model,
				usd: 0,
				tokens: 0,
				approximate: false,
			};
			modelsByKey.set(modelKey, model);
		}
		model.approximate ||= estimated && rate.approximate;
		model.usd += usd;
		model.tokens += tokens;

		bump(nested(modelDays, modelKey), day, usd, tokens);

		if (entry.cwd) {
			const { label, kind, group } = attributeCwd(entry.cwd, labelsByLength);
			let projectRow = projectsByKey.get(label);
			if (!projectRow) {
				projectRow = { project: label, kind, group, usd: 0, tokens: 0 };
				projectsByKey.set(label, projectRow);
			}
			projectRow.usd += usd;
			projectRow.tokens += tokens;

			bump(nested(projectDays, label), day, usd, tokens);
			const modelSlice = bump(
				nested(projectModels, label),
				modelKey,
				usd,
				tokens,
			) as Slice & { agent: UsageAgent };
			modelSlice.agent = entry.agent;
			const projectSlice = bump(
				nested(modelProjects, modelKey),
				label,
				usd,
				tokens,
			) as Slice & { agent: UsageAgent };
			projectSlice.agent = entry.agent;
			const sessionSlice = bump(
				nested(projectSessions, label),
				entry.sessionId,
				usd,
				tokens,
			) as Slice & { agent: UsageAgent; lastMs: number };
			sessionSlice.agent = entry.agent;
			sessionSlice.lastMs = Math.max(
				sessionSlice.lastMs ?? 0,
				entry.timestampMs,
			);
		}

		totals.usd += usd;
		totals.tokens += tokens;
		totals.uncachedInput += entry.uncachedInput;
		totals.cachedInput += entry.cachedInput;
		totals.cacheWrite += entry.cacheWrite5m + entry.cacheWrite1h;
		totals.output += entry.output;
		totals.reasoningOutput += entry.reasoningOutput;
		// Savings are rate-derived; for harness-priced entries the matched rate
		// may be a fallback, so only estimate savings where the cost itself is
		// a rate estimate too.
		if (estimated) {
			totals.cacheSavingsUsd += cacheSavingsUsd(rate, entry);
			totals.approximate ||= rate.approximate;
		}
	}

	// Emit a contiguous day series so charts show gaps as zero, not missing.
	const buckets: UsageDailyBucket[] = [];
	for (let i = 0; i < days; i++) {
		const date = new Date(cutoffMs);
		date.setDate(date.getDate() + i);
		const key = dayKey(date.getTime());
		buckets.push(
			bucketsByDay.get(key) ?? { day: key, agents: {}, usd: 0, tokens: 0 },
		);
	}

	const sortedModels = [...modelsByKey.values()].sort((a, b) => b.usd - a.usd);
	const sortedProjects = [...projectsByKey.values()].sort(
		(a, b) => b.usd - a.usd,
	);

	// Drilldown cubes for the top projects and every model — bounded so the
	// payload stays small while the drill pages render without a re-scan.
	const TOP_PROJECT_DETAILS = 24;
	const buildDetail = (
		dayMap: Map<string, Slice> | undefined,
		crossMap: Map<string, Slice & { agent: UsageAgent }> | undefined,
	): UsageDrilldownEntry => {
		const daySlices = [...(dayMap ?? new Map<string, Slice>()).entries()]
			.map(([day, slice]) => ({ day, usd: slice.usd, tokens: slice.tokens }))
			.sort((a, b) => a.day.localeCompare(b.day));
		const breakdown = [
			...(
				crossMap ?? new Map<string, Slice & { agent: UsageAgent }>()
			).entries(),
		]
			.map(([label, slice]) => ({
				label,
				agent: slice.agent,
				usd: slice.usd,
				tokens: slice.tokens,
			}))
			.sort((a, b) => b.usd - a.usd);
		return {
			days: daySlices,
			breakdown,
			usd: daySlices.reduce((sum, slice) => sum + slice.usd, 0),
			tokens: daySlices.reduce((sum, slice) => sum + slice.tokens, 0),
		};
	};

	const TOP_SESSIONS = 20;
	const projectDetails: Record<string, UsageDrilldownEntry> = {};
	for (const row of sortedProjects.slice(0, TOP_PROJECT_DETAILS)) {
		const detail = buildDetail(
			projectDays.get(row.project),
			projectModels.get(row.project),
		);
		detail.sessions = [...(projectSessions.get(row.project) ?? new Map())]
			.map(([id, slice]) => ({
				id,
				label: sessionLabels.get(id) ?? null,
				agent: slice.agent,
				usd: slice.usd,
				tokens: slice.tokens,
				lastMs: slice.lastMs,
			}))
			.sort((a, b) => b.usd - a.usd)
			.slice(0, TOP_SESSIONS);
		projectDetails[row.project] = detail;
	}
	const modelDetails: Record<string, UsageDrilldownEntry> = {};
	for (const row of sortedModels) {
		const key = `${row.agent}|${row.model}`;
		modelDetails[key] = buildDetail(modelDays.get(key), modelProjects.get(key));
	}

	return {
		days,
		buckets,
		models: sortedModels,
		projects: sortedProjects,
		projectDetails,
		modelDetails,
		totals,
		scannedFiles: totalScannedFiles,
		pricingTableUpdated: PRICING_TABLE_UPDATED,
	};
}
