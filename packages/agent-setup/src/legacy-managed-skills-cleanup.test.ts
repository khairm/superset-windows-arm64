import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	cleanupLegacyClaudeConfigDir,
	cleanupLegacyManagedSkillsHome,
	LEGACY_MANAGED_SKILL_MARKER,
} from "./legacy-managed-skills-cleanup";

let root: string;
let homeDir: string;
let supersetHomeDir: string;

function write(target: string, content: string): void {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
}

function writeJson(target: string, value: unknown): void {
	write(target, `${JSON.stringify(value, null, 2)}\n`);
}

function seedManagedClaudePlugin(claudeDir: string, name = "superset"): void {
	write(
		path.join(claudeDir, "skills", name, ".superset-managed"),
		`${LEGACY_MANAGED_SKILL_MARKER}\n`,
	);
	write(
		path.join(claudeDir, "skills", name, "skills", "doctor", "SKILL.md"),
		"legacy",
	);
}

function seedManagedAgentSkill(name: string): void {
	write(
		path.join(homeDir, ".agents", "skills", name, "SKILL.md"),
		`${LEGACY_MANAGED_SKILL_MARKER}\nlegacy`,
	);
}

function seedManagedCommands(): void {
	for (const name of ["10x", "doctor", "feedback", "setup"]) {
		write(
			path.join(homeDir, ".agents", "commands", "superset", `${name}.md`),
			`${LEGACY_MANAGED_SKILL_MARKER}\nlegacy`,
		);
	}
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-skill-cleanup-"));
	homeDir = path.join(root, "home");
	supersetHomeDir = path.join(root, "superset-home");
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("legacy managed skill cleanup", () => {
	it("removes marker-owned legacy artifacts and is idempotent", () => {
		const claudeDir = path.join(homeDir, ".claude");
		seedManagedClaudePlugin(claudeDir);
		seedManagedAgentSkill("superset-doctor");
		seedManagedAgentSkill("superset-page");
		seedManagedCommands();
		writeJson(path.join(supersetHomeDir, "disabled-skills.json"), {
			disabledSkillIds: ["doctor"],
		});

		const first = cleanupLegacyManagedSkillsHome({
			homeDir,
			supersetHomeDir,
		});

		expect(first).toHaveLength(9);
		expect(fs.existsSync(path.join(claudeDir, "skills", "superset"))).toBe(
			false,
		);
		expect(
			fs.existsSync(path.join(homeDir, ".agents", "skills", "superset-doctor")),
		).toBe(false);
		expect(
			fs.existsSync(path.join(homeDir, ".agents", "skills", "superset-page")),
		).toBe(false);
		expect(
			fs.existsSync(path.join(homeDir, ".agents", "commands", "superset")),
		).toBe(false);
		expect(
			fs.existsSync(path.join(supersetHomeDir, "disabled-skills.json")),
		).toBe(false);

		expect(
			cleanupLegacyManagedSkillsHome({ homeDir, supersetHomeDir }),
		).toEqual([]);
	});

	it("preserves user files while removing marker-owned siblings", () => {
		const claudeDir = path.join(homeDir, ".claude");
		write(
			path.join(claudeDir, "skills", "superset", ".superset-managed"),
			"user-owned",
		);
		write(
			path.join(homeDir, ".agents", "skills", "superset-doctor", "SKILL.md"),
			"user-owned",
		);
		seedManagedAgentSkill("superset-retired");
		seedManagedCommands();
		write(
			path.join(homeDir, ".agents", "commands", "superset", "mine.md"),
			"user-owned",
		);
		writeJson(path.join(supersetHomeDir, "disabled-skills.json"), {
			disabledSkillIds: ["doctor"],
			mine: true,
		});

		const removed = cleanupLegacyManagedSkillsHome({
			homeDir,
			supersetHomeDir,
		});

		expect(removed).toHaveLength(5);
		expect(fs.existsSync(path.join(claudeDir, "skills", "superset"))).toBe(
			true,
		);
		expect(
			fs.existsSync(path.join(homeDir, ".agents", "skills", "superset-doctor")),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(homeDir, ".agents", "skills", "superset-retired"),
			),
		).toBe(false);
		const commandsDir = path.join(homeDir, ".agents", "commands", "superset");
		expect(fs.existsSync(path.join(commandsDir, "mine.md"))).toBe(true);
		for (const name of ["10x", "doctor", "feedback", "setup"]) {
			expect(fs.existsSync(path.join(commandsDir, `${name}.md`))).toBe(false);
		}
		expect(
			fs.existsSync(path.join(supersetHomeDir, "disabled-skills.json")),
		).toBe(true);
	});

	it("continues independent cleanup steps before reporting failures", () => {
		write(path.join(homeDir, ".claude", "skills"), "not-a-directory");
		seedManagedAgentSkill("superset-doctor");
		seedManagedCommands();
		writeJson(path.join(supersetHomeDir, "disabled-skills.json"), {
			disabledSkillIds: ["doctor"],
		});

		expect(() =>
			cleanupLegacyManagedSkillsHome({ homeDir, supersetHomeDir }),
		).toThrow(AggregateError);
		expect(
			fs.existsSync(path.join(homeDir, ".agents", "skills", "superset-doctor")),
		).toBe(false);
		expect(
			fs.existsSync(path.join(homeDir, ".agents", "commands", "superset")),
		).toBe(false);
		expect(
			fs.existsSync(path.join(supersetHomeDir, "disabled-skills.json")),
		).toBe(false);
	});

	it("cleans direct legacy copies in custom Claude config dirs", () => {
		const customClaudeDir = path.join(root, "claude-profile");
		seedManagedClaudePlugin(customClaudeDir, "superset-retired");

		cleanupLegacyClaudeConfigDir(customClaudeDir);

		expect(
			fs.existsSync(path.join(customClaudeDir, "skills", "superset-retired")),
		).toBe(false);
	});
});
