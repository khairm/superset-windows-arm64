import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSupersetHomeDir } from "./paths";

// (NO-BUNDLED-SKILLS) Remove only artifacts written by the retired provisioner.
export const LEGACY_MANAGED_SKILL_MARKER = "<!-- superset-managed-skill v1 -->";

export type LegacyManagedSkillsCleanupOptions =
	| {
			homeDir?: undefined;
			supersetHomeDir?: string;
	  }
	| {
			homeDir: string;
			supersetHomeDir: string;
	  };

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

function lstatIfExists(target: string): fs.Stats | null {
	try {
		return fs.lstatSync(target);
	} catch (error) {
		if (isNotFound(error)) return null;
		throw error;
	}
}

function readRegularFile(target: string): string | null {
	const stat = lstatIfExists(target);
	if (stat === null || !stat.isFile() || stat.isSymbolicLink()) return null;
	return fs.readFileSync(target, "utf8");
}

function readDirectory(target: string): fs.Dirent[] {
	try {
		return fs.readdirSync(target, { withFileTypes: true });
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
}

function isRealDirectory(target: string): boolean {
	const stat = lstatIfExists(target);
	return stat !== null && stat.isDirectory() && !stat.isSymbolicLink();
}

function removePath(target: string, removed: string[]): void {
	try {
		fs.rmSync(target, {
			recursive: true,
			force: true,
			maxRetries: 3,
			retryDelay: 100,
		});
		removed.push(target);
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(
	content: string | null,
): Record<string, unknown> | null {
	if (content === null) return null;
	try {
		const parsed: unknown = JSON.parse(content);
		return isPlainObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Removes marker-owned plugins from one Claude config directory. */
export function cleanupLegacyClaudeConfigDir(configDir: string): string[] {
	const removed: string[] = [];
	const skillsRoot = path.join(path.resolve(configDir), "skills");

	for (const entry of readDirectory(skillsRoot)) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const target = path.join(skillsRoot, entry.name);
		const sentinel = readRegularFile(path.join(target, ".superset-managed"));
		if (sentinel?.includes(LEGACY_MANAGED_SKILL_MARKER)) {
			removePath(target, removed);
		}
	}

	return removed;
}

function cleanupAgentSkillDirs(homeDir: string, removed: string[]): void {
	const skillsRoot = path.join(homeDir, ".agents", "skills");
	for (const entry of readDirectory(skillsRoot)) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const target = path.join(skillsRoot, entry.name);
		const skill = readRegularFile(path.join(target, "SKILL.md"));
		if (skill?.includes(LEGACY_MANAGED_SKILL_MARKER)) {
			removePath(target, removed);
		}
	}
}

function cleanupAgentCommands(homeDir: string, removed: string[]): void {
	const commandsDir = path.join(homeDir, ".agents", "commands", "superset");
	if (!isRealDirectory(commandsDir)) return;

	for (const entry of readDirectory(commandsDir)) {
		if (
			!entry.isFile() ||
			entry.isSymbolicLink() ||
			!entry.name.endsWith(".md")
		) {
			continue;
		}
		const target = path.join(commandsDir, entry.name);
		const content = readRegularFile(target);
		if (content?.includes(LEGACY_MANAGED_SKILL_MARKER)) {
			removePath(target, removed);
		}
	}

	if (readDirectory(commandsDir).length === 0) {
		removePath(commandsDir, removed);
	}
}

function cleanupDisabledSkillsState(
	supersetHomeDir: string,
	removed: string[],
): void {
	const target = path.join(supersetHomeDir, "disabled-skills.json");
	const state = parseJsonObject(readRegularFile(target));
	if (state === null) return;

	const keys = Object.keys(state);
	const disabledSkillIds = state.disabledSkillIds;
	if (
		keys.length === 1 &&
		keys[0] === "disabledSkillIds" &&
		Array.isArray(disabledSkillIds) &&
		disabledSkillIds.every((value) => typeof value === "string")
	) {
		removePath(target, removed);
	}
}

function runCleanupStep(action: () => void, errors: unknown[]): void {
	try {
		action();
	} catch (error) {
		errors.push(error);
	}
}

/** Removes machine-wide copies left by released versions of the old provisioner. */
export function cleanupLegacyManagedSkillsHome(
	options: LegacyManagedSkillsCleanupOptions = {},
): string[] {
	const homeDir = options.homeDir ?? os.homedir();
	const supersetHomeDir = options.supersetHomeDir ?? resolveSupersetHomeDir();
	const removed: string[] = [];
	const errors: unknown[] = [];

	runCleanupStep(() => {
		removed.push(
			...cleanupLegacyClaudeConfigDir(path.join(homeDir, ".claude")),
		);
	}, errors);
	runCleanupStep(() => cleanupAgentSkillDirs(homeDir, removed), errors);
	runCleanupStep(() => cleanupAgentCommands(homeDir, removed), errors);
	runCleanupStep(
		() => cleanupDisabledSkillsState(supersetHomeDir, removed),
		errors,
	);

	if (errors.length > 0) {
		throw new AggregateError(
			errors,
			"One or more retired managed-skill paths could not be removed",
		);
	}
	return removed;
}
