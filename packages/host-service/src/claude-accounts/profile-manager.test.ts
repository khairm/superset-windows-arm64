import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeProfileManager } from "./profile-manager";
import type { ClaudeAccountsLogger } from "./types";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const log: ClaudeAccountsLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};
const scratchPaths: string[] = [];

afterEach(async () => {
	for (const path of scratchPaths.splice(0)) {
		await rm(path, { recursive: true, force: true });
	}
});

describe("ClaudeProfileManager deletion", () => {
	test("unlinks junctions without deleting their targets", async () => {
		const scratch = join(tmpdir(), `claude-profile-delete-${randomUUID()}`);
		scratchPaths.push(scratch);
		await mkdir(scratch);
		const manager = new ClaudeProfileManager(join(scratch, "host.db"), log);
		await manager.initialize();
		const profileDir = manager.profileDirFor(WORKSPACE_ID);
		const targetDir = join(scratch, "shared-skills");
		await mkdir(profileDir);
		await mkdir(targetDir);
		await writeFile(join(targetDir, "survives.txt"), "safe", "utf8");
		await symlink(targetDir, join(profileDir, "skills"), "junction");
		await writeFile(join(profileDir, "settings.json"), "{}", "utf8");

		await manager.deleteProfileDir(WORKSPACE_ID);

		await expect(lstat(profileDir)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(targetDir, "survives.txt"), "utf8")).toBe(
			"safe",
		);
	});
});
