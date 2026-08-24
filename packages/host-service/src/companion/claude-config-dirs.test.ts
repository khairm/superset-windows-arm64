import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeAccountsService } from "../claude-accounts";
import { claudeConfigDirsForWorkspace } from "./index";

const WORKSPACE_ID = "7cde0bcc-223e-4f8d-9374-339410ea1a89";

function service(managed: boolean, profileDir: string): ClaudeAccountsService {
	return {
		getCapability: () => ({ managed, configured: managed }),
		profileDirFor: () => profileDir,
	} as unknown as ClaudeAccountsService;
}

describe("Claude transcript config directories", () => {
	it("rejects invalid workspace ids before deriving a managed profile", () => {
		let called = false;
		const fake = service(true, "unused");
		fake.profileDirFor = () => {
			called = true;
			throw new Error("must not be called");
		};

		expect(claudeConfigDirsForWorkspace(fake, "not-a-uuid")).toEqual([]);
		expect(called).toBe(false);
	});

	it("uses only the global profile on unmanaged hosts", () => {
		const globalDir =
			process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
		expect(
			claudeConfigDirsForWorkspace(service(false, "unused"), WORKSPACE_ID),
		).toEqual([globalDir]);
	});

	it("tries an existing managed profile before the global pre-upgrade profile", () => {
		const dir = mkdtempSync(join(tmpdir(), "companion-claude-profile-"));
		const profileDir = join(dir, WORKSPACE_ID);
		mkdirSync(profileDir);
		try {
			const globalDir =
				process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
			expect(
				claudeConfigDirsForWorkspace(service(true, profileDir), WORKSPACE_ID),
			).toEqual([profileDir, globalDir]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to the global profile when the managed profile is absent", () => {
		const globalDir =
			process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
		expect(
			claudeConfigDirsForWorkspace(
				service(true, join(tmpdir(), "missing-managed-profile")),
				WORKSPACE_ID,
			),
		).toEqual([globalDir]);
	});
});
