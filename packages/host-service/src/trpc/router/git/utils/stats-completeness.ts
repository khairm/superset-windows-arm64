/**
 * Collects every stat a status walk could not read. The walk still reports the
 * file — only its numbers are missing — so a caller that must not pin wrong
 * numbers serves the snapshot once and caches nothing. (DIFFSTATS-COLD-CACHE)
 */
export interface StatsCompleteness {
	readonly incomplete: string[];
	degrade(scope: string, error: unknown): void;
}

export function createStatsCompleteness(): StatsCompleteness {
	const incomplete: string[] = [];
	return {
		incomplete,
		degrade(scope, error) {
			incomplete.push(
				`${scope}: ${error instanceof Error ? error.message : String(error)}`,
			);
		},
	};
}
