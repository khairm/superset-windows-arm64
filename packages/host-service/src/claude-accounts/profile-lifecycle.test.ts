import { afterEach, describe, expect, test } from "bun:test";
import {
	lstat,
	mkdir,
	readFile,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
	type ClaudeTestWorld,
	createClaudeTestWorld,
	managedCredentials,
	WORKSPACE_IDS,
	writeGlobalClaudeState,
	writeGlobalCredentials,
	writeGlobalMirror,
} from "../../test/helpers/claude-accounts-fixture";
import {
	BlankedCredentialsError,
	ClaudeProfileManager,
} from "./profile-manager";

const worlds: ClaudeTestWorld[] = [];

afterEach(async () => {
	for (const world of worlds.splice(0).reverse()) await world.dispose();
});

async function setup() {
	const world = await createClaudeTestWorld("claude-profile-lifecycle-");
	worlds.push(world);
	const manager = new ClaudeProfileManager(world.dbPath, world.log);
	await manager.initialize();
	const worktree = join(world.root, "worktree");
	await mkdir(worktree);
	return { world, manager, worktree };
}

describe("Claude workspace profile lifecycle", () => {
	test("mints with the valid subset when global seed state is missing", async () => {
		const { world, manager, worktree } = await setup();

		const profile = await manager.mintProfile(WORKSPACE_IDS[0], worktree, null);
		const seed = JSON.parse(
			await readFile(join(profile, ".claude.json"), "utf8"),
		);

		expect(seed.hasCompletedOnboarding).toBe(true);
		expect(seed.projects[worktree.replaceAll("\\", "/")]).toBeDefined();
		expect(seed.lastOnboardingVersion).toBeUndefined();
		expect(
			world.log.warnEntries.some((entry) => entry.message.includes("optional")),
		).toBe(true);
	});

	test("mints when the global seed file contains malformed JSON", async () => {
		const { world, manager, worktree } = await setup();
		await writeFile(join(world.home, ".claude.json"), "{not-json", "utf8");

		const profile = await manager.mintProfile(WORKSPACE_IDS[0], worktree, null);

		expect((await lstat(join(profile, ".claude.json"))).isFile()).toBe(true);
		expect(
			world.log.warnEntries.some((entry) => entry.message.includes("optional")),
		).toBe(true);
	});

	test("omits invalid optional seed fields without blocking the mint", async () => {
		const { world, manager, worktree } = await setup();
		await writeGlobalClaudeState(world, {
			lastOnboardingVersion: "2.1.0",
			installMethod: 42,
			autoUpdates: false,
			mcpServers: [],
		});

		const profile = await manager.mintProfile(WORKSPACE_IDS[0], worktree, null);
		const seed = JSON.parse(
			await readFile(join(profile, ".claude.json"), "utf8"),
		);

		expect(seed.lastOnboardingVersion).toBe("2.1.0");
		expect(seed.autoUpdates).toBe(false);
		expect(seed.installMethod).toBeUndefined();
		expect(seed.mcpServers).toBeUndefined();
	});

	test("removes crashed staging residue and completes the mint", async () => {
		const { world, manager, worktree } = await setup();
		await writeGlobalClaudeState(world);
		const staging = manager.stagingPathFor(WORKSPACE_IDS[0]);
		await mkdir(staging);
		await writeFile(join(staging, "partial.txt"), "crash residue", "utf8");

		const profile = await manager.mintProfile(WORKSPACE_IDS[0], worktree, null);

		await expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await lstat(profile)).isDirectory()).toBe(true);
	});

	test("re-mints a vanished profile with selected credentials", async () => {
		const { world, manager, worktree } = await setup();
		await writeGlobalClaudeState(world);
		const credentials = managedCredentials("claude123", {
			accessToken: "selected-token",
		});
		const first = await manager.mintProfile(
			WORKSPACE_IDS[0],
			worktree,
			credentials,
		);
		await rm(first, { recursive: true });

		const reminted = await manager.mintProfile(
			WORKSPACE_IDS[0],
			worktree,
			credentials,
		);

		expect(await manager.readProfileCredentials(WORKSPACE_IDS[0])).toEqual(
			credentials,
		);
		expect((await lstat(reminted)).isDirectory()).toBe(true);
	});

	test("removes a copied mirror after its global source disappears", async () => {
		const { world, manager, worktree } = await setup();
		await writeGlobalClaudeState(world);
		const source = await writeGlobalMirror(
			world,
			"CLAUDE.md",
			"global rules\n",
		);
		const profile = await manager.mintProfile(WORKSPACE_IDS[0], worktree, null);
		expect(await readFile(join(profile, "CLAUDE.md"), "utf8")).toBe(
			"global rules\n",
		);

		await unlink(source);
		await manager.refreshProfile(profile);

		await expect(lstat(join(profile, "CLAUDE.md"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	for (const settingsSource of ["present", "absent"] as const) {
		test(`does not rewrite unchanged ${settingsSource} global settings`, async () => {
			const { world, manager, worktree } = await setup();
			await writeGlobalClaudeState(world);
			if (settingsSource === "present") {
				await writeGlobalMirror(
					world,
					"settings.json",
					JSON.stringify({ permissions: { allow: ["Read"] } }),
				);
			}
			const profile = await manager.mintProfile(
				WORKSPACE_IDS[0],
				worktree,
				null,
			);
			const settingsPath = join(profile, "settings.json");
			const before = await lstat(settingsPath);
			const contents = await readFile(settingsPath, "utf8");

			await manager.refreshProfile(profile);

			const after = await lstat(settingsPath);
			expect(after.mtimeMs).toBe(before.mtimeMs);
			expect(await readFile(settingsPath, "utf8")).toBe(contents);
		});
	}

	test("reports a CLI-blanked credentials file as blanked, not foreign", async () => {
		const { world, manager, worktree } = await setup();
		await writeGlobalClaudeState(world);
		const profile = await manager.mintProfile(
			WORKSPACE_IDS[0],
			worktree,
			managedCredentials("claude123"),
		);
		await writeFile(
			join(profile, ".credentials.json"),
			JSON.stringify({
				claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 },
				trayManagedAccount: "claude123",
			}),
			"utf8",
		);

		const failure = await manager
			.readProfileCredentials(WORKSPACE_IDS[0])
			.then(
				() => null,
				(error: unknown) => error,
			);

		expect(failure).toBeInstanceOf(BlankedCredentialsError);
		expect((failure as BlankedCredentialsError).trayManagedAccount).toBe(
			"claude123",
		);
	});

	test("treats signed-out JSON without claudeAiOauth as absent", async () => {
		const { world, manager } = await setup();
		await writeGlobalCredentials(world, { signedOutAt: Date.now() });

		await expect(manager.readGlobalIdentity()).resolves.toEqual({
			kind: "absent",
		});
	});
});
