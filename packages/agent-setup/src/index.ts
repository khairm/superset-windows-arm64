import fs from "node:fs";
import {
	runSetupAction,
	setupAgentCapabilities,
	setupSingleAgent,
	teardownSingleAgent,
} from "./agent-setup";
import { resolveDisabledAgentIds } from "./disabled-agent-hooks";
import { cleanupLegacyManagedSkillsHome } from "./legacy-managed-skills-cleanup";
import {
	getBashDir,
	getBinDir,
	getHooksDir,
	getOpenCodePluginDir,
	getZshDir,
} from "./paths";
import {
	createBashWrapper,
	createPwshWrapper,
	createZshWrapper,
	getCommandShellArgs,
	getShellArgs,
	getShellEnv,
} from "./shell-wrappers";

/**
 * Provisions everything Superset manages in the user's environment for the
 * supported terminal agents: lifecycle hooks, binary wrappers, and shell
 * integration. Agents in `options.disabledAgentIds` get their global-config
 * footprint removed instead. Runs on every host that serves terminals — the
 * Electron main process and the standalone (CLI-launched) host-service alike.
 *
 * Callers without their own settings store (headless hosts) omit
 * `disabledAgentIds`; the shared ~/.superset agent-hooks.json mirror and its
 * SUPERSET_DISABLED_AGENT_HOOKS env override apply instead, so a machine
 * running both the desktop and CLI hosts converges on one disable set.
 */
export function setupAgentIntegrations(
	options: { disabledAgentIds?: readonly string[] } = {},
): void {
	console.log("[agent-setup] Provisioning agent integrations...");
	const disabledAgentIds = resolveDisabledAgentIds(options.disabledAgentIds);

	// Keep the legacy disk sweep off the synchronous Electron startup path.
	// Unexpected failures stay uncaught so stale injected skills cannot persist
	// behind a warning that never reaches the user.
	setImmediate(() => {
		const removed = cleanupLegacyManagedSkillsHome();
		if (removed.length > 0) {
			console.log(
				`[agent-setup] Removed ${removed.length} retired managed-skill path(s)`,
			);
		}
	});

	fs.mkdirSync(getBinDir(), { recursive: true });
	fs.mkdirSync(getHooksDir(), { recursive: true });
	fs.mkdirSync(getZshDir(), { recursive: true });
	fs.mkdirSync(getBashDir(), { recursive: true });
	fs.mkdirSync(getOpenCodePluginDir(), { recursive: true });

	setupAgentCapabilities({ disabledAgentIds });

	runSetupAction("zsh-wrapper", createZshWrapper);
	runSetupAction("bash-wrapper", createBashWrapper);
	// (AY) PowerShell integration profile (OSC 133 C/D/A markers for the
	// shell-running blue dot). Written on every launch like the others.
	runSetupAction("pwsh-wrapper", createPwshWrapper);

	console.log("[agent-setup] Agent integrations provisioned");
}

export { setupSingleAgent, teardownSingleAgent };

export {
	ensureClaudeManagedHooksAt,
	ensureCodexManagedHooksAt,
} from "./agent-wrappers-claude-codex-opencode";
export {
	type ProfileProvisionReport,
	provisionClaudeProfile,
	provisionCodexProfile,
	resolveAmbientCodexHome,
} from "./provider-profiles";

export { getCommandShellArgs, getShellArgs, getShellEnv };

export {
	getAgentSetupTemplatesDir,
	setAgentSetupTemplatesDir,
} from "./config";
export {
	readSharedDisabledAgentIds,
	writeSharedDisabledAgentIds,
} from "./disabled-agent-hooks";
export {
	readExternallyConfiguredMcpServers,
	type SyncManagedMcpServersOptions,
	syncManagedMcpServers,
} from "./managed-mcp-servers";
export { getBinDir, resolveSupersetHomeDir } from "./paths";
