import { afterEach, describe, expect, test } from "bun:test";
import { lstat } from "node:fs/promises";
import {
	type ClaudeTestWorld,
	createClaudeTestWorld,
	createJanitorHarness,
	DB_INSTANCE_ID,
	OTHER_DB_INSTANCE_ID,
	seedMarker,
	seedOldStaging,
	seedProfile,
	seedWorkspace,
	WORKSPACE_IDS,
} from "../../test/helpers/claude-accounts-fixture";

const worlds: ClaudeTestWorld[] = [];

afterEach(async () => {
	for (const world of worlds.splice(0).reverse()) await world.dispose();
});

async function world() {
	const value = await createClaudeTestWorld("claude-janitor-");
	worlds.push(value);
	return value;
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

type RowState = "live" | "archived" | "absent";
type ExpectedProfile = "present" | "deleted" | "quarantined";

const matrix: Array<{
	name: string;
	marker: boolean;
	row: RowState;
	worktreePresent: boolean;
	expectedProfile: ExpectedProfile;
	expectedMarker: boolean;
}> = [
	{
		name: "live row without marker",
		marker: false,
		row: "live",
		worktreePresent: true,
		expectedProfile: "present",
		expectedMarker: false,
	},
	{
		name: "live row clears stale marker",
		marker: true,
		row: "live",
		worktreePresent: true,
		expectedProfile: "present",
		expectedMarker: false,
	},
	{
		name: "archived row keeps profile while worktree exists",
		marker: false,
		row: "archived",
		worktreePresent: true,
		expectedProfile: "present",
		expectedMarker: false,
	},
	{
		name: "archived row keeps marker while worktree exists",
		marker: true,
		row: "archived",
		worktreePresent: true,
		expectedProfile: "present",
		expectedMarker: true,
	},
	{
		name: "archived row deletes profile after worktree disappears",
		marker: false,
		row: "archived",
		worktreePresent: false,
		expectedProfile: "deleted",
		expectedMarker: false,
	},
	{
		name: "archived row consumes marker after worktree disappears",
		marker: true,
		row: "archived",
		worktreePresent: false,
		expectedProfile: "deleted",
		expectedMarker: false,
	},
	{
		name: "absent row quarantines unmarked profile",
		marker: false,
		row: "absent",
		worktreePresent: false,
		expectedProfile: "quarantined",
		expectedMarker: false,
	},
	{
		name: "absent row consumes committed marker",
		marker: true,
		row: "absent",
		worktreePresent: false,
		expectedProfile: "deleted",
		expectedMarker: false,
	},
];

describe("Claude profile janitor reconciliation", () => {
	for (const scenario of matrix) {
		test(scenario.name, async () => {
			const testWorld = await world();
			await seedWorkspace(testWorld, { id: WORKSPACE_IDS[2] });
			const { manager, janitor, deleted } =
				await createJanitorHarness(testWorld);
			const profile = await seedProfile(manager, WORKSPACE_IDS[0]);
			if (scenario.row !== "absent") {
				await seedWorkspace(testWorld, {
					id: WORKSPACE_IDS[0],
					worktreePresent: scenario.worktreePresent,
					archivedAt: scenario.row === "archived" ? Date.now() : null,
				});
			}
			if (scenario.marker) await seedMarker(manager, WORKSPACE_IDS[0]);

			await janitor.run();

			const marker = manager.markerPathFor(WORKSPACE_IDS[0]);
			const quarantine = manager.quarantinePathFor(WORKSPACE_IDS[0]);
			expect(await exists(marker)).toBe(scenario.expectedMarker);
			if (scenario.expectedProfile === "present") {
				expect(await exists(profile)).toBe(true);
				expect(await exists(quarantine)).toBe(false);
			} else if (scenario.expectedProfile === "quarantined") {
				expect(await exists(profile)).toBe(false);
				expect(await exists(quarantine)).toBe(true);
			} else {
				expect(await exists(profile)).toBe(false);
				expect(await exists(quarantine)).toBe(false);
			}
			expect(deleted.length > 0).toBe(scenario.expectedProfile === "deleted");
		});
	}

	test("rechecks an empty snapshot under the lock before deleting a recreated UUID", async () => {
		const testWorld = await world();
		let recreated = false;
		const { manager, janitor, deleted } = await createJanitorHarness(
			testWorld,
			{
				beforeLock: async (workspaceId) => {
					if (recreated || workspaceId !== WORKSPACE_IDS[0]) return;
					recreated = true;
					await seedWorkspace(testWorld, { id: WORKSPACE_IDS[0] });
				},
			},
		);
		const profile = await seedProfile(manager, WORKSPACE_IDS[0]);
		const marker = await seedMarker(manager, WORKSPACE_IDS[0]);

		await janitor.run();

		expect(deleted).toHaveLength(0);
		expect(await exists(profile)).toBe(true);
		expect(await exists(marker)).toBe(false);
	});

	test("refuses to quarantine an unmarked profile when the database snapshot has zero rows", async () => {
		const testWorld = await world();
		const { manager, janitor, deleted } = await createJanitorHarness(testWorld);
		const profile = await seedProfile(manager, WORKSPACE_IDS[0]);

		await janitor.run();

		expect(deleted).toHaveLength(0);
		expect(await exists(profile)).toBe(true);
		expect(await exists(manager.quarantinePathFor(WORKSPACE_IDS[0]))).toBe(
			false,
		);
	});

	test("stands down when a zero-row marker belongs to another database", async () => {
		const testWorld = await world();
		const { manager, janitor, deleted } = await createJanitorHarness(
			testWorld,
			{
				dbInstanceId: DB_INSTANCE_ID,
			},
		);
		const profile = await seedProfile(manager, WORKSPACE_IDS[0]);
		const marker = await seedMarker(manager, WORKSPACE_IDS[0], {
			dbInstanceId: OTHER_DB_INSTANCE_ID,
		});

		await janitor.run();

		expect(deleted).toHaveLength(0);
		expect(await exists(profile)).toBe(true);
		expect(await exists(marker)).toBe(true);
	});

	test("ages out staging only after a complete nonempty snapshot", async () => {
		const testWorld = await world();
		await seedWorkspace(testWorld, { id: WORKSPACE_IDS[1] });
		const { manager, janitor } = await createJanitorHarness(testWorld);
		const staging = await seedOldStaging(manager, WORKSPACE_IDS[0]);

		await janitor.run();

		expect(await exists(staging)).toBe(false);
	});

	test("keeps old staging when the workspace snapshot has zero rows", async () => {
		const testWorld = await world();
		const { manager, janitor } = await createJanitorHarness(testWorld);
		const staging = await seedOldStaging(manager, WORKSPACE_IDS[0]);

		await janitor.run();

		expect(await exists(staging)).toBe(true);
	});
});
