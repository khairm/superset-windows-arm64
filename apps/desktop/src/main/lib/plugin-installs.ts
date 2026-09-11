import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { syncManagedMcpServers } from "@superset/agent-setup";
import { settings } from "@superset/local-db";
import {
	getPluginByName,
	type InstalledPlugin,
	type PluginMcpServerConfig,
} from "@superset/shared/plugins";
import log from "electron-log/main";
import { resolveBundledCliPath } from "main/lib/bundled-cli";
import { localDb } from "main/lib/local-db";
import { createSerialQueue } from "main/lib/serial-queue";

/**
 * Installed-plugin state and its materialization into agent configs. State
 * lives on the local-db settings singleton (not renderer localStorage)
 * because the boot-time sync below runs in main before any renderer exists.
 * Sync is declarative: every call converges agent configs on the full
 * installed set, so installs and uninstalls both land on app restart even if
 * a mid-session sync was missed.
 */

const execFileAsync = promisify(execFile);

const pluginCliQueue = createSerialQueue();

function queuePluginCli(args: string[]): Promise<void> {
	return pluginCliQueue(() => runPluginCli(args));
}

async function runPluginCli(args: string[]): Promise<void> {
	const cli = resolveBundledCliPath();
	if (!cli) {
		log.warn("[plugins] no bundled CLI; skills were not provisioned");
		return;
	}

	try {
		await execFileAsync(cli, ["plugins", ...args, "--json"], {
			timeout: 60_000,
		});
	} catch (error) {
		log.warn(
			`[plugins] ${args.join(" ")} failed; skills may be stale:`,
			error instanceof Error ? error.message : error,
		);
	}
}

export function getInstalledPlugins(): InstalledPlugin[] {
	return localDb.select().from(settings).get()?.installedPlugins ?? [];
}

function saveInstalledPlugins(next: InstalledPlugin[]): void {
	localDb
		.insert(settings)
		.values({ id: 1, installedPlugins: next })
		.onConflictDoUpdate({
			target: settings.id,
			set: { installedPlugins: next },
		})
		.run();
}

function desiredMcpServers(
	installed: InstalledPlugin[],
): Record<string, PluginMcpServerConfig> {
	const desired: Record<string, PluginMcpServerConfig> = {};
	for (const install of installed) {
		// Disabled installs and unknown names (a catalog entry removed after
		// install) contribute nothing, so their servers reap on the next sync.
		// Per-agent skipping of servers the user configured themselves happens
		// inside syncManagedMcpServers, scoped to each agent's own config.
		if (install.enabled === false) continue;
		const plugin = getPluginByName(install.name);
		if (!plugin) continue;
		Object.assign(desired, plugin.mcpServers);
	}
	return desired;
}

export function syncInstalledPluginMcpServers(): void {
	syncManagedMcpServers(desiredMcpServers(getInstalledPlugins()));
}

/** Returns the updated install list; unknown plugin names return null. */
export function installPlugin(name: string): InstalledPlugin[] | null {
	const plugin = getPluginByName(name);
	if (!plugin) return null;

	const installed = getInstalledPlugins();
	const existing = installed.find((entry) => entry.name === name);
	const record: InstalledPlugin = {
		name: plugin.name,
		version: plugin.version,
		installedAt: existing?.installedAt ?? new Date().toISOString(),
		...(existing?.enabled === false ? { enabled: false } : {}),
	};
	const next = existing
		? installed.map((entry) => (entry.name === name ? record : entry))
		: [...installed, record];

	saveInstalledPlugins(next);
	syncInstalledPluginMcpServers();
	void queuePluginCli(["install", name, "--update"]);
	return next;
}

export function uninstallPlugin(name: string): InstalledPlugin[] {
	const next = getInstalledPlugins().filter((entry) => entry.name !== name);
	saveInstalledPlugins(next);
	syncInstalledPluginMcpServers();
	void queuePluginCli(["uninstall", name]);
	return next;
}

/**
 * Toggling re-syncs immediately: disable reaps, enable rewrites. A plugin
 * present only via the user's own config has no record yet — toggling adopts
 * it (creates the record) so the choice has somewhere to live.
 */
export function setPluginEnabled(
	name: string,
	enabled: boolean,
): InstalledPlugin[] {
	const installed = getInstalledPlugins();
	const hasRecord = installed.some((entry) => entry.name === name);
	const plugin = getPluginByName(name);
	const next = hasRecord
		? installed.map((entry) =>
				entry.name === name ? { ...entry, enabled } : entry,
			)
		: plugin
			? [
					...installed,
					{
						name: plugin.name,
						version: plugin.version,
						installedAt: new Date().toISOString(),
						enabled,
					},
				]
			: installed;
	saveInstalledPlugins(next);
	syncInstalledPluginMcpServers();
	// installed_plugins.json is the only `enabled` flag provisioning reads, and
	// local-db is not it: without this the skills stay materialized while the
	// MCP servers are reaped, leaving the plugin half on.
	void queuePluginCli([enabled ? "enable" : "disable", name]);
	return next;
}
