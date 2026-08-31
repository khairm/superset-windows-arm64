#!/usr/bin/env node

/**
 * (NO-BUNDLED-SKILLS) Blocks upstream's bundled Superset skill system from
 * returning while leaving user-owned and repo-local skill discovery intact.
 */

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
if (!fs.existsSync(path.join(repoRoot, "package.json"))) {
	console.error(
		"(NO-BUNDLED-SKILLS) run from the repository root; package.json is missing",
	);
	process.exit(1);
}

const FORBIDDEN_PATHS = [
	"plugins/superset",
	"scripts/sync-dev-skills.ts",
	"packages/agent-setup/src/managed-skills.ts",
	"packages/agent-setup/src/disabled-skills.ts",
	"apps/desktop/src/renderer/routes/_authenticated/_dashboard/plugins/components/SkillIcon",
	"apps/desktop/src/renderer/routes/_authenticated/_dashboard/plugins/components/PluginsView/components/SkillsList",
	"apps/desktop/dist/main/templates/plugin",
];

const FORBIDDEN_IDENTIFIERS =
	/\b(?:createManagedSkills|provisionManagedClaudePluginAt|SUPERSET_MANAGED_SKILLS|getBundledPluginDir|getBundledSkillContent|getBundledSkillPath|getBundledSkillIcons|writeBundledSkillContent|getDisabledSkillsStateFilePath|readSharedDisabledSkillIds|resolveDisabledSkillIds|writeSharedDisabledSkillIds|listSkillIcons|getSkillContent|getDisabledSkills|setSkillEnabled|writeSkillContent)\b/;
const SOURCE_ROOTS = [
	"packages/agent-setup/src",
	"apps/desktop/src/lib",
	"apps/desktop/src/main",
	"apps/desktop/src/renderer",
	"apps/desktop/vite",
	"packages/cli/scripts",
	"packages/host-service/src",
	"packages/shared/src/plugins",
];
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".sh", ".ts", ".tsx"]);
const FORBIDDEN_ARTIFACT_SUFFIXES = [
	"main/templates/plugin",
	"lib/agent-templates/plugin",
];
const ARTIFACT_ROOTS = ["apps/desktop/dist", "packages/cli/dist"];

function relativePath(absolute) {
	return path.relative(repoRoot, absolute).split(path.sep).join("/");
}

function listFiles(root) {
	if (!fs.existsSync(root)) return [];
	const files = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const absolute = path.join(root, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === ".cache") continue;
			files.push(...listFiles(absolute));
		} else if (
			entry.isFile() &&
			SOURCE_EXTENSIONS.has(path.extname(entry.name))
		) {
			files.push(absolute);
		}
	}
	return files;
}

function findForbiddenArtifactDirs(root, failures) {
	if (!fs.existsSync(root)) return;
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const absolute = path.join(root, entry.name);
		const relative = relativePath(absolute);
		if (
			FORBIDDEN_ARTIFACT_SUFFIXES.some((suffix) => relative.endsWith(suffix))
		) {
			failures.push(`${relative}: bundled skill artifact exists`);
			continue;
		}
		findForbiddenArtifactDirs(absolute, failures);
	}
}

const failures = [];
for (const forbidden of FORBIDDEN_PATHS) {
	if (fs.existsSync(path.join(repoRoot, forbidden))) {
		failures.push(`${forbidden}: forbidden bundled-skill path exists`);
	}
}

const marketplacePath = path.join(
	repoRoot,
	".claude-plugin",
	"marketplace.json",
);
if (fs.existsSync(marketplacePath)) {
	try {
		const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
		const plugins = Array.isArray(marketplace?.plugins)
			? marketplace.plugins
			: [];
		if (
			plugins.some(
				(plugin) =>
					plugin?.name === "superset" ||
					plugin?.source === "./plugins/superset",
			)
		) {
			failures.push(
				".claude-plugin/marketplace.json: bundled Superset plugin entry exists",
			);
		}
	} catch (error) {
		failures.push(
			`.claude-plugin/marketplace.json: cannot validate marketplace: ${error.message}`,
		);
	}
}

for (const root of SOURCE_ROOTS) {
	for (const absolute of listFiles(path.join(repoRoot, root))) {
		if (FORBIDDEN_IDENTIFIERS.test(fs.readFileSync(absolute, "utf8"))) {
			failures.push(`${relativePath(absolute)}: retired skill provisioner API`);
		}
	}
}

for (const root of ARTIFACT_ROOTS) {
	findForbiddenArtifactDirs(path.join(repoRoot, root), failures);
}

if (failures.length > 0) {
	console.error("(NO-BUNDLED-SKILLS) forbidden Superset skill code found:");
	for (const failure of [...new Set(failures)].sort()) {
		console.error(`- ${failure}`);
	}
	process.exit(1);
}

console.log("(NO-BUNDLED-SKILLS) no bundled Superset skills found");
