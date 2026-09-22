/**
 * Upstream desktop-v1.30.1 moved this module to
 * `renderer/utils/usage/formatResetIn`, which is where the implementation now
 * lives (including the fork-only `formatResetCompact`). This path stays as the
 * fork's own import surface — the Claude-account sidebar chip reaches the
 * compact countdown through it.
 */
export {
	formatResetCompact,
	formatResetIn,
	formatResetLabel,
} from "renderer/utils/usage/formatResetIn";
