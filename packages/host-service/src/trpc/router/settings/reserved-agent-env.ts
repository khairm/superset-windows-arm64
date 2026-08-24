export const RESERVED_CLAUDE_ENV_KEY = "CLAUDE_CONFIG_DIR";

let didLogIgnoredReservedClaudeEnv = false;

export function sanitizeStoredAgentEnv(
	env: Record<string, string>,
): Record<string, string> {
	if (!Object.hasOwn(env, RESERVED_CLAUDE_ENV_KEY)) return env;
	if (!didLogIgnoredReservedClaudeEnv) {
		didLogIgnoredReservedClaudeEnv = true;
		console.warn(
			`[agent-configs] ignoring stored ${RESERVED_CLAUDE_ENV_KEY}; Claude accounts are managed per workspace`,
		);
	}
	const { [RESERVED_CLAUDE_ENV_KEY]: _ignored, ...sanitized } = env;
	return sanitized;
}
