/**
 * (WORKTREE-EXIT-CLEANUP) Retiring a workspace the user has exited: every
 * terminal stops and any pinned Claude account goes back, on a host that
 * cannot reach the Pi.
 *
 * The interactive switch deliberately still refuses to unpin while the Pi is
 * down (it has no roster to promise a working token from). Retirement is not
 * interactive — the workspace is finished either way — so it must not inherit
 * that refusal, and these tests hold both behaviours together.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
	type ClaudeTestWorld,
	createClaudeTestWorld,
	seedWorkspace,
	servePiFake,
	WORKSPACE_IDS,
	wireAccount,
	writeGlobalClaudeState,
	writeGlobalCredentials,
} from "../../test/helpers/claude-accounts-fixture";
import { registerClaudeAccountsService } from "../claude-accounts-runtime";
import { terminalSessions, workspaces } from "../db/schema";
import { createTerminalSessionInternal } from "../terminal/terminal";
import {
	beginWorkspaceRetirement,
	isWorkspaceRetirementActive,
	readWorkspaceLaunchEpoch,
} from "../terminal/workspace-launch-fence";
import {
	type ClaudeAccountsService,
	createClaudeAccountsService,
} from "./index";

const worlds: ClaudeTestWorld[] = [];
const services: ClaudeAccountsService[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(async () => {
	for (const service of services.splice(0)) service.stop();
	for (const server of servers.splice(0)) server.stop(true);
	for (const world of worlds.splice(0).reverse()) await world.dispose();
});

async function setupService() {
	const world = await createClaudeTestWorld("claude-retirement-");
	worlds.push(world);
	await writeGlobalClaudeState(world);
	await writeGlobalCredentials(world, {});
	const pi = await servePiFake(world.root, [wireAccount("claude123")]);
	servers.push(pi.server);
	const service = createClaudeAccountsService({
		db: world.db,
		dbPath: world.dbPath,
		emit: (event) => world.events.push(event),
		log: world.log,
		awaitInitialBackgroundWork: true,
		piBaseUrl: pi.baseUrl,
		pushKeyPath: pi.pushKeyPath,
	});
	services.push(service);
	await service.start();
	return { world, service, pi };
}

function seedTerminal(
	world: ClaudeTestWorld,
	terminalId: string,
	workspaceId: string,
): string {
	world.db
		.insert(terminalSessions)
		.values({ id: terminalId, originWorkspaceId: workspaceId })
		.run();
	return terminalId;
}

function slugOf(world: ClaudeTestWorld, workspaceId: string): string | null {
	const row = world.db.query.workspaces
		.findFirst({ where: eq(workspaces.id, workspaceId) })
		.sync();
	if (!row) throw new Error(`Workspace ${workspaceId} disappeared`);
	return row.claudeAccountSlug;
}

function statusOf(world: ClaudeTestWorld, terminalId: string): string {
	const row = world.db.query.terminalSessions
		.findFirst({ where: eq(terminalSessions.id, terminalId) })
		.sync();
	if (!row) throw new Error(`Terminal ${terminalId} disappeared`);
	return row.status;
}

describe("workspace runtime retirement", () => {
	test("stops every terminal and unpins with the Pi stopped, where the interactive switch still refuses", async () => {
		const { world, service, pi } = await setupService();
		const workspaceId = WORKSPACE_IDS[0];
		await seedWorkspace(world, { id: workspaceId });
		await service.setWorkspaceAccount(workspaceId, "claude123");
		const credentialPath = join(
			service.profileDirFor(workspaceId),
			".credentials.json",
		);
		expect((await lstat(credentialPath)).isFile()).toBe(true);
		seedTerminal(world, "retire-live-1", workspaceId);
		seedTerminal(world, "retire-live-2", workspaceId);
		pi.server.stop(true);
		servers.length = 0;

		await expect(
			service.setWorkspaceAccount(workspaceId, null),
		).rejects.toThrow(
			"Cannot switch this workspace to Following while the Pi is unavailable",
		);
		expect(slugOf(world, workspaceId)).toBe("claude123");

		const result = await service.retireWorkspaceRuntime(workspaceId);

		expect(result.foundWorkspace).toBe(true);
		expect(result.terminated.sort()).toEqual([
			"retire-live-1",
			"retire-live-2",
		]);
		expect(result.failed).toEqual([]);
		expect(result.accountReleased).toBe(true);
		expect(slugOf(world, workspaceId)).toBeNull();
		expect(statusOf(world, "retire-live-1")).toBe("disposed");
		expect(statusOf(world, "retire-live-2")).toBe("disposed");
		// The pinned token cannot outlive the pin, in the file or in the cache.
		await expect(lstat(credentialPath)).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect((await service.getWorkspaceState(workspaceId)).state).toBe(
			"following",
		);
		// The profile folder itself stays; only its credentials went.
		expect(
			(await lstat(service.profileDirFor(workspaceId))).isDirectory(),
		).toBe(true);
		expect(
			world.events.filter(
				(event) =>
					event.type === "claude-account-state-changed" &&
					event.cause === "system",
			),
		).toHaveLength(1);
	});

	test("is a no-op the second time and for a workspace that was already Following", async () => {
		const { world, service } = await setupService();
		const workspaceId = WORKSPACE_IDS[0];
		await seedWorkspace(world, { id: workspaceId });
		await service.setWorkspaceAccount(workspaceId, "claude123");

		const first = await service.retireWorkspaceRuntime(workspaceId);
		world.events.length = 0;
		const second = await service.retireWorkspaceRuntime(workspaceId);

		expect(first.accountReleased).toBe(true);
		expect(second).toEqual({
			foundWorkspace: true,
			terminated: [],
			failed: [],
			accountReleased: false,
		});
		expect(slugOf(world, workspaceId)).toBeNull();
		expect(
			world.events.filter(
				(event) => event.type === "claude-account-state-changed",
			),
		).toHaveLength(0);
	});

	test("reports foundWorkspace false for a workspace this host does not have", async () => {
		const { service } = await setupService();

		await expect(service.retireWorkspaceRuntime(randomUUID())).resolves.toEqual(
			{
				foundWorkspace: false,
				terminated: [],
				failed: [],
				accountReleased: false,
			},
		);
	});

	test("clears a stale pin on an unmanaged host", async () => {
		const world = await createClaudeTestWorld("claude-retirement-unmanaged-");
		worlds.push(world);
		const service = createClaudeAccountsService({
			db: world.db,
			dbPath: world.dbPath,
			emit: (event) => world.events.push(event),
			log: world.log,
			awaitInitialBackgroundWork: true,
			pushKeyPath: join(world.root, "missing-key"),
		});
		services.push(service);
		await service.start();
		expect(service.getCapability().managed).toBe(false);
		// A pin left behind by an era when this host was still Pi-capable.
		const workspaceId = WORKSPACE_IDS[0];
		await seedWorkspace(world, {
			id: workspaceId,
			claudeAccountSlug: "claude123",
		});
		seedTerminal(world, "retire-unmanaged", workspaceId);

		const result = await service.retireWorkspaceRuntime(workspaceId);

		expect(result.accountReleased).toBe(true);
		expect(result.terminated).toEqual(["retire-unmanaged"]);
		expect(slugOf(world, workspaceId)).toBeNull();
		expect(statusOf(world, "retire-unmanaged")).toBe("disposed");
	});

	test("refuses a terminal launch that straddles the retirement", async () => {
		const { world, service } = await setupService();
		const workspaceId = WORKSPACE_IDS[0];
		await seedWorkspace(world, { id: workspaceId });
		await service.setWorkspaceAccount(workspaceId, "claude123");
		registerClaudeAccountsService(world.db, service);
		expect(service.getCapability().managed).toBe(true);
		// The fence is process-wide, so every assertion here is relative to
		// where this test found it.
		const epochBefore = readWorkspaceLaunchEpoch(workspaceId);

		// Hold the workspace lock so both callers queue behind it in order:
		// the retirement first, then a launch that read the epoch before it.
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const holding = service.withWorkspaceLock(workspaceId, () => gate);
		const retirement = service.retireWorkspaceRuntime(workspaceId);
		const launch = createTerminalSessionInternal({
			terminalId: "retire-inflight",
			workspaceId,
			db: world.db,
		});
		release?.();
		await holding;

		expect(await launch).toMatchObject({ kind: "WORKSPACE_RETIRED" });
		expect((await retirement).foundWorkspace).toBe(true);
		expect(
			world.db.query.terminalSessions
				.findFirst({ where: eq(terminalSessions.id, "retire-inflight") })
				.sync(),
		).toBeUndefined();
		// One retirement, one bump: a launch starting now reads the same value
		// twice and is not fenced, so a restored card can open terminals again.
		expect(readWorkspaceLaunchEpoch(workspaceId)).toBe(epochBefore + 1);
	});

	test("fences an unmanaged host's launches, which take no workspace lock", async () => {
		const world = await createClaudeTestWorld("claude-retirement-fence-");
		worlds.push(world);
		const service = createClaudeAccountsService({
			db: world.db,
			dbPath: world.dbPath,
			emit: (event) => world.events.push(event),
			log: world.log,
			awaitInitialBackgroundWork: true,
			pushKeyPath: join(world.root, "missing-key"),
		});
		services.push(service);
		await service.start();
		expect(service.getCapability().managed).toBe(false);
		const workspaceId = WORKSPACE_IDS[0];
		await seedWorkspace(world, { id: workspaceId });
		const otherWorkspaceId = WORKSPACE_IDS[1];
		await seedWorkspace(world, { id: otherWorkspaceId });
		// What a launch on an unmanaged host reads when it begins. It reaches
		// its row insert with no lock ever taken, so this value is the only
		// thing standing between it and a terminal in an exited workspace.
		const launchEpoch = readWorkspaceLaunchEpoch(workspaceId);
		const otherEpoch = readWorkspaceLaunchEpoch(otherWorkspaceId);

		await service.retireWorkspaceRuntime(workspaceId);

		expect(readWorkspaceLaunchEpoch(workspaceId)).toBe(launchEpoch + 1);
		// Only the retired workspace is fenced, and only once, so unrelated and
		// later launches are never refused.
		expect(readWorkspaceLaunchEpoch(otherWorkspaceId)).toBe(otherEpoch);

		await service.retireWorkspaceRuntime(workspaceId);

		expect(readWorkspaceLaunchEpoch(workspaceId)).toBe(launchEpoch + 2);
	});

	test("refuses a launch that BEGINS mid-retirement, and allows one after the window closes", async () => {
		const world = await createClaudeTestWorld("claude-retirement-window-");
		worlds.push(world);
		const workspaceId = WORKSPACE_IDS[0];
		await seedWorkspace(world, { id: workspaceId });

		// The straddle test covers a launch that read the epoch BEFORE the
		// retirement. This is the other half: a launch that starts while the
		// retirement is still disposing terminals and rewriting credentials, and
		// so reads the post-bump epoch and would otherwise sail through.
		const closeWindow = beginWorkspaceRetirement(workspaceId);
		const epochDuring = readWorkspaceLaunchEpoch(workspaceId);
		expect(isWorkspaceRetirementActive(workspaceId)).toBe(true);

		const refused = await createTerminalSessionInternal({
			terminalId: "retire-during-window",
			workspaceId,
			db: world.db,
		});

		expect(refused).toMatchObject({ kind: "WORKSPACE_RETIRED" });
		expect(
			world.db.query.terminalSessions
				.findFirst({ where: eq(terminalSessions.id, "retire-during-window") })
				.sync(),
		).toBeUndefined();

		closeWindow();

		// A restored card starts terminals normally: the window is shut and the
		// epoch is stable, so a launch reads one value twice and is not fenced.
		expect(isWorkspaceRetirementActive(workspaceId)).toBe(false);
		expect(readWorkspaceLaunchEpoch(workspaceId)).toBe(epochDuring);
	});

	test("refuses a managed launch during retirement WITHOUT queuing on the workspace lock", async () => {
		const { world, service } = await setupService();
		const workspaceId = WORKSPACE_IDS[0];
		await seedWorkspace(world, { id: workspaceId });
		registerClaudeAccountsService(world.db, service);
		expect(service.getCapability().managed).toBe(true);

		// The lock held for the length of a real retirement: every terminal
		// disposed, then the account released.
		let release: (() => void) | undefined;
		const holding = service.withWorkspaceLock(
			workspaceId,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const closeWindow = beginWorkspaceRetirement(workspaceId);

		// Answered while the lock is STILL HELD, which is the whole assertion: a
		// launch that queued would not resolve until `release` below.
		expect(
			await createTerminalSessionInternal({
				terminalId: "retire-before-lock",
				workspaceId,
				db: world.db,
			}),
		).toMatchObject({ kind: "WORKSPACE_RETIRED" });

		closeWindow();
		release?.();
		await holding;
	});

	test("closes the retirement window even when the account release throws", async () => {
		const { world, service } = await setupService();
		const workspaceId = WORKSPACE_IDS[0];
		await seedWorkspace(world, { id: workspaceId });

		await service.retireWorkspaceRuntime(workspaceId);

		// A window left open would refuse this workspace's terminals for the life
		// of the process — the failure mode a restored card would never recover
		// from.
		expect(isWorkspaceRetirementActive(workspaceId)).toBe(false);
	});
});
