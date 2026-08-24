import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import {
	type ClaudeTestWorld,
	createClaudeTestWorld,
	managedCredentials,
	seedWorkspace,
	WORKSPACE_IDS,
	writeGlobalClaudeState,
	writeGlobalCredentials,
} from "../../test/helpers/claude-accounts-fixture";
import { terminalSessions, workspaces } from "../db/schema";
import {
	type ClaudeAccountsService,
	createClaudeAccountsService,
} from "./index";
import { ClaudeProfileManager } from "./profile-manager";

const worlds: ClaudeTestWorld[] = [];
const services: ClaudeAccountsService[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(async () => {
	for (const service of services.splice(0)) service.stop();
	for (const server of servers.splice(0)) server.stop(true);
	for (const world of worlds.splice(0).reverse()) await world.dispose();
});

function account(slug: string, overrides: Record<string, unknown> = {}) {
	return {
		slug,
		name: slug,
		type: "claude",
		enabled: true,
		dead: false,
		dead_reason: null,
		last_success: new Date().toISOString(),
		consecutive_failures: 0,
		five_pct: 10,
		seven_pct: 10,
		fable_pct: null,
		five_resets_at: null,
		seven_resets_at: null,
		fable_resets_at: null,
		in_use: false,
		fable_in_use: false,
		pc_active: true,
		...overrides,
	};
}

async function waitFor(
	predicate: () => boolean,
	message: string,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(message);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function setupService() {
	const world = await createClaudeTestWorld("claude-service-regression-");
	worlds.push(world);
	await writeGlobalClaudeState(world);
	await writeGlobalCredentials(world, {});
	const pushKeyPath = join(world.root, "push-key.txt");
	await writeFile(pushKeyPath, "test-key\n", "utf8");
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/accounts") {
				return Response.json([account("claude123"), account("claude456")]);
			}
			const slug = url.pathname.split("/")[2];
			if (url.pathname.endsWith("/token") && slug) {
				return Response.json({
					account: slug,
					claude_ai_oauth: {
						accessToken: `${slug}-token`,
						expiresAt: Date.now() + 2 * 60 * 60 * 1000,
					},
				});
			}
			return new Response(null, { status: 404 });
		},
	});
	servers.push(server);
	const service = createClaudeAccountsService({
		db: world.db,
		dbPath: world.dbPath,
		emit: (event) => world.events.push(event),
		log: world.log,
		awaitInitialBackgroundWork: true,
		piBaseUrl: `http://127.0.0.1:${server.port}`,
		pushKeyPath,
	});
	services.push(service);
	await service.start();
	return { world, service };
}

async function setupFallbackService(options: {
	roster: unknown[];
	workspaceSlugs: string[];
	onEmit?: (
		event: ClaudeTestWorld["events"][number],
		world: ClaudeTestWorld,
	) => void;
}) {
	const world = await createClaudeTestWorld("claude-fallback-regression-");
	worlds.push(world);
	await writeGlobalClaudeState(world);
	await writeGlobalCredentials(world, machineDefaultCredentials("claude12"));
	const trayDirectory = join(world.home, ".usage-display");
	await mkdir(trayDirectory, { recursive: true });
	await writeFile(
		join(trayDirectory, "tray-state.json"),
		JSON.stringify({ trigger_five_pct: 80, trigger_seven_pct: 80 }),
		"utf8",
	);
	const pushKeyPath = join(world.root, "push-key.txt");
	await writeFile(pushKeyPath, "test-key\n", "utf8");
	const manager = new ClaudeProfileManager(world.dbPath, world.log);
	await manager.initialize();
	for (const [index, slug] of options.workspaceSlugs.entries()) {
		const id = WORKSPACE_IDS[index];
		if (!id) throw new Error(`No stable workspace UUID for index ${index}`);
		const row = await seedWorkspace(world, { id, claudeAccountSlug: slug });
		await manager.mintProfile(
			row.id,
			row.worktreePath,
			managedCredentials(slug),
		);
	}
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/accounts") return Response.json(options.roster);
			return new Response(null, { status: 404 });
		},
	});
	servers.push(server);
	const service = createClaudeAccountsService({
		db: world.db,
		dbPath: world.dbPath,
		emit: (event) => {
			world.events.push(event);
			options.onEmit?.(event, world);
		},
		log: world.log,
		awaitInitialBackgroundWork: true,
		piBaseUrl: `http://127.0.0.1:${server.port}`,
		pushKeyPath,
	});
	services.push(service);
	await service.start();
	return { world, service };
}

function machineDefaultCredentials(slug: string) {
	return {
		claudeAiOauth: {
			accessToken: `${slug}-default-token`,
			expiresAt: Date.now() + 2 * 60 * 60 * 1000,
			refreshToken: "real-token-stays-global",
		},
		trayManagedAccount: slug,
	};
}

describe("Claude account service transitions", () => {
	test("signed-out Following preserves the pinned workspace's last-good credentials", async () => {
		const { world, service } = await setupService();
		await seedWorkspace(world, { id: WORKSPACE_IDS[0] });
		await service.setWorkspaceAccount(WORKSPACE_IDS[0], "claude123");
		const credentialPath = join(
			service.profileDirFor(WORKSPACE_IDS[0]),
			".credentials.json",
		);
		const before = await readFile(credentialPath, "utf8");

		await service.setWorkspaceAccount(WORKSPACE_IDS[0], null);

		expect(await readFile(credentialPath, "utf8")).toBe(before);
		expect(
			world.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, WORKSPACE_IDS[0]) })
				.sync()?.claudeAccountSlug,
		).toBeNull();
	});

	test("does not emit a state-change event when the desired account is unchanged", async () => {
		const { world, service } = await setupService();
		await seedWorkspace(world, { id: WORKSPACE_IDS[0] });
		await service.setWorkspaceAccount(WORKSPACE_IDS[0], "claude123");
		world.events.length = 0;

		await service.setWorkspaceAccount(WORKSPACE_IDS[0], "claude123");

		expect(
			world.events.filter(
				(event) => event.type === "claude-account-state-changed",
			),
		).toHaveLength(0);
	});

	test("re-mints an externally deleted pinned profile with pinned credentials", async () => {
		const { world, service } = await setupService();
		await seedWorkspace(world, { id: WORKSPACE_IDS[0] });
		await service.setWorkspaceAccount(WORKSPACE_IDS[0], "claude123");
		const profile = service.profileDirFor(WORKSPACE_IDS[0]);
		await rm(profile, { recursive: true });

		await service.ensureProfileForLaunch(WORKSPACE_IDS[0]);

		const credentials = JSON.parse(
			await readFile(join(profile, ".credentials.json"), "utf8"),
		);
		expect(credentials.trayManagedAccount).toBe("claude123");
		expect(credentials.claudeAiOauth.accessToken).toBe("claude123-token");
	});

	test("restores the exact credential file when the database update throws", async () => {
		const { world, service } = await setupService();
		await seedWorkspace(world, { id: WORKSPACE_IDS[0] });
		await service.setWorkspaceAccount(WORKSPACE_IDS[0], "claude123");
		const credentialPath = join(
			service.profileDirFor(WORKSPACE_IDS[0]),
			".credentials.json",
		);
		const before = await readFile(credentialPath, "utf8");
		world.db.run(
			sql.raw(`
				CREATE TRIGGER fail_claude_account_update
				BEFORE UPDATE OF claude_account_slug ON workspaces
				WHEN NEW.claude_account_slug = 'claude456'
				BEGIN
					SELECT RAISE(ABORT, 'forced account update failure');
				END
			`),
		);

		await expect(
			service.setWorkspaceAccount(WORKSPACE_IDS[0], "claude456"),
		).rejects.toThrow("forced account update failure");

		expect(await readFile(credentialPath, "utf8")).toBe(before);
		expect(
			world.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, WORKSPACE_IDS[0]) })
				.sync()?.claudeAccountSlug,
		).toBe("claude123");
	});

	test("rejects malformed machine-default credentials before changing database state", async () => {
		const { world, service } = await setupService();
		await seedWorkspace(world, { id: WORKSPACE_IDS[0] });
		await service.setWorkspaceAccount(WORKSPACE_IDS[0], "claude123");
		await writeFile(
			join(world.home, ".claude", ".credentials.json"),
			"{not-json",
			"utf8",
		);

		await expect(
			service.setWorkspaceAccount(WORKSPACE_IDS[0], null),
		).rejects.toThrow("Cannot switch this workspace to Following");
		expect(
			world.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, WORKSPACE_IDS[0]) })
				.sync()?.claudeAccountSlug,
		).toBe("claude123");
	});

	test("warns on the first renewal failure with one global outage event", async () => {
		const world = await createClaudeTestWorld("claude-renewal-warning-");
		worlds.push(world);
		await writeGlobalClaudeState(world);
		await writeGlobalCredentials(world, {});
		const pushKeyPath = join(world.root, "push-key.txt");
		await writeFile(pushKeyPath, "test-key\n", "utf8");
		const rows = await Promise.all(
			WORKSPACE_IDS.slice(0, 2).map((id) =>
				seedWorkspace(world, { id, claudeAccountSlug: "claude123" }),
			),
		);
		const manager = new ClaudeProfileManager(world.dbPath, world.log);
		await manager.initialize();
		const expiring = managedCredentials("claude123", "last-good-token");
		expiring.claudeAiOauth.expiresAt = Date.now() + 40 * 60 * 1000;
		for (const row of rows) {
			await manager.mintProfile(row.id, row.worktreePath, expiring);
		}
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const path = new URL(request.url).pathname;
				if (path === "/accounts") return Response.json([account("claude123")]);
				if (path.endsWith("/token")) return new Response(null, { status: 503 });
				return new Response(null, { status: 404 });
			},
		});
		servers.push(server);
		const service = createClaudeAccountsService({
			db: world.db,
			dbPath: world.dbPath,
			emit: (event) => world.events.push(event),
			log: world.log,
			awaitInitialBackgroundWork: true,
			piBaseUrl: `http://127.0.0.1:${server.port}`,
			pushKeyPath,
		});
		services.push(service);

		await service.start();
		await waitFor(
			() =>
				world.events.some(
					(event) =>
						event.type === "claude-account-warning" &&
						event.workspaceId === null &&
						event.active,
				),
			"renewal outage warning was not emitted",
		);

		const globalWarnings = world.events.filter(
			(event) =>
				event.type === "claude-account-warning" &&
				event.workspaceId === null &&
				event.active &&
				event.message.includes("renewal"),
		);
		expect(globalWarnings).toHaveLength(1);
		const states = await service.getWorkspaceStates();
		expect(states).toHaveLength(2);
		expect(
			states.every((state) =>
				state.warning?.message.includes("renewal failed"),
			),
		).toBe(true);
	});
});

describe("Claude automatic fallback safeguards", () => {
	test("suppresses the whole pass when the machine default is missing from the roster", async () => {
		const { world } = await setupFallbackService({
			roster: [account("claude123", { five_pct: 95 })],
			workspaceSlugs: ["claude123"],
		});
		await waitFor(
			() =>
				world.log.warnEntries.some((entry) =>
					entry.message.includes("machine default is missing"),
				),
			"missing machine-default roster suppression was not observed",
		);

		expect(
			world.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, WORKSPACE_IDS[0]) })
				.sync()?.claudeAccountSlug,
		).toBe("claude123");
		expect(
			world.events.some(
				(event) =>
					event.type === "claude-account-state-changed" &&
					event.cause === "auto-fallback",
			),
		).toBe(false);
	});

	test("revalidates each candidate under its lock before committing", async () => {
		let changedIdentity = false;
		const { world } = await setupFallbackService({
			roster: [
				account("claude12"),
				account("claude123", { five_pct: 95 }),
				account("claude456", { five_pct: 95 }),
			],
			workspaceSlugs: ["claude123", "claude456"],
			onEmit: (event, testWorld) => {
				if (
					changedIdentity ||
					event.type !== "claude-account-state-changed" ||
					event.cause !== "auto-fallback"
				) {
					return;
				}
				changedIdentity = true;
				writeFileSync(
					join(testWorld.home, ".claude", ".credentials.json"),
					JSON.stringify(machineDefaultCredentials("claude456")),
					"utf8",
				);
			},
		});
		await waitFor(
			() =>
				world.log.infoEntries.some((entry) =>
					entry.message.includes("discarded by locked revalidation"),
				),
			"second fallback candidate was not discarded",
		);

		const slugs = world.db
			.select({ slug: workspaces.claudeAccountSlug })
			.from(workspaces)
			.all()
			.map((row) => row.slug);
		expect(slugs.filter((slug) => slug === null)).toHaveLength(1);
		expect(slugs.filter((slug) => slug !== null)).toHaveLength(1);
		expect(
			world.events.filter(
				(event) =>
					event.type === "claude-account-state-changed" &&
					event.cause === "auto-fallback",
			),
		).toHaveLength(1);
	});

	test("warns for a dead pinned account without falling back", async () => {
		const { world, service } = await setupFallbackService({
			roster: [
				account("claude12"),
				account("claude123", {
					dead: true,
					dead_reason: "login expired",
					five_pct: 95,
				}),
			],
			workspaceSlugs: ["claude123"],
		});
		await waitFor(
			() =>
				world.events.some(
					(event) =>
						event.type === "claude-account-warning" &&
						event.workspaceId === WORKSPACE_IDS[0] &&
						event.active,
				),
			"dead-account warning was not emitted",
		);

		const state = await service.getWorkspaceState(WORKSPACE_IDS[0]);
		expect(state.state).toBe("pinned");
		expect(state.slug).toBe("claude123");
		expect(state.warning?.message).toContain("needs re-login");
		expect(
			world.events.some(
				(event) =>
					event.type === "claude-account-state-changed" &&
					event.cause === "auto-fallback",
			),
		).toBe(false);
	});

	test("does not fall back onto a dead machine-default account", async () => {
		const { world, service } = await setupFallbackService({
			roster: [
				account("claude12", { dead: true, dead_reason: "login expired" }),
				account("claude123", { five_pct: 95 }),
			],
			workspaceSlugs: ["claude123"],
		});
		await waitFor(
			() =>
				world.log.warnEntries.some((entry) =>
					entry.message.includes("machine default is unavailable"),
				),
			"dead machine-default suppression was not observed",
		);

		const state = await service.getWorkspaceState(WORKSPACE_IDS[0]);
		expect(state.state).toBe("pinned");
		expect(state.warning?.message).toContain("needs re-login");
	});
});

describe("Claude workspace deletion choreography", () => {
	test("writes the marker, disposes terminals, commits, then removes the profile", async () => {
		const { world, service } = await setupService();
		await seedWorkspace(world, { id: WORKSPACE_IDS[0] });
		await service.setWorkspaceAccount(WORKSPACE_IDS[0], "claude123");
		world.db
			.insert(terminalSessions)
			.values({
				id: "terminal-delete-order",
				originWorkspaceId: WORKSPACE_IDS[0],
			})
			.run();
		const profile = service.profileDirFor(WORKSPACE_IDS[0]);
		const marker = `${profile}.delete-intent`;
		let callbackObservedDisposed = false;

		await service.withWorkspaceDeletion(
			[
				{
					workspaceId: WORKSPACE_IDS[0],
					terminalIds: ["terminal-delete-order"],
				},
			],
			async () => {
				expect((await lstat(marker)).isFile()).toBe(true);
				callbackObservedDisposed =
					world.db.query.terminalSessions
						.findFirst({
							where: eq(terminalSessions.id, "terminal-delete-order"),
						})
						.sync()?.status === "disposed";
				world.db
					.delete(workspaces)
					.where(eq(workspaces.id, WORKSPACE_IDS[0]))
					.run();
			},
			{ disposalMode: "abort" },
		);

		expect(callbackObservedDisposed).toBe(true);
		await expect(lstat(profile)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	for (const scenario of [
		{ mode: "abort" as const, callbackRuns: false },
		{ mode: "warn-and-continue" as const, callbackRuns: true },
	]) {
		test(`${scenario.mode} handles a superseded terminal disposal`, async () => {
			const { world, service } = await setupService();
			await seedWorkspace(world, { id: WORKSPACE_IDS[0] });
			await service.setWorkspaceAccount(WORKSPACE_IDS[0], "claude123");
			const terminalId = `terminal-superseded-${scenario.mode}`;
			world.db
				.insert(terminalSessions)
				.values({ id: terminalId, originWorkspaceId: WORKSPACE_IDS[0] })
				.run();
			world.db.run(
				sql.raw(`
					CREATE TRIGGER clear_dispose_stamp
					AFTER UPDATE OF dispose_requested_at ON terminal_sessions
					WHEN NEW.id = '${terminalId}' AND NEW.dispose_requested_at IS NOT NULL
					BEGIN
						UPDATE terminal_sessions
						SET dispose_requested_at = NULL
						WHERE id = NEW.id;
					END
				`),
			);
			const profile = service.profileDirFor(WORKSPACE_IDS[0]);
			const marker = `${profile}.delete-intent`;
			let callbackRan = false;
			const deletion = service.withWorkspaceDeletion(
				[{ workspaceId: WORKSPACE_IDS[0], terminalIds: [terminalId] }],
				async () => {
					callbackRan = true;
					world.db
						.delete(workspaces)
						.where(eq(workspaces.id, WORKSPACE_IDS[0]))
						.run();
				},
				{ disposalMode: scenario.mode },
			);

			if (scenario.mode === "abort") {
				await expect(deletion).rejects.toThrow("terminal disposals failed");
				expect((await lstat(profile)).isDirectory()).toBe(true);
				await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
			} else {
				await expect(deletion).resolves.toBeUndefined();
				await expect(lstat(profile)).rejects.toMatchObject({ code: "ENOENT" });
				await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
			}
			expect(callbackRan).toBe(scenario.callbackRuns);
		});
	}

	test("clears the marker and keeps the profile when the callback rolls back", async () => {
		const { world, service } = await setupService();
		await seedWorkspace(world, { id: WORKSPACE_IDS[0] });
		await service.setWorkspaceAccount(WORKSPACE_IDS[0], "claude123");
		const profile = service.profileDirFor(WORKSPACE_IDS[0]);
		const marker = `${profile}.delete-intent`;

		await expect(
			service.withWorkspaceDeletion(
				[{ workspaceId: WORKSPACE_IDS[0], terminalIds: [] }],
				async () => {
					throw new Error("rollback");
				},
				{ disposalMode: "warn-and-continue" },
			),
		).rejects.toThrow("rollback");

		expect((await lstat(profile)).isDirectory()).toBe(true);
		await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("Claude account service startup", () => {
	test("resolves in unmanaged mode when profile storage cannot initialize", async () => {
		const world = await createClaudeTestWorld("claude-service-degraded-");
		worlds.push(world);
		const unusableParent = join(world.root, "unusable-storage");
		await mkdir(unusableParent, { recursive: true });
		await writeFile(
			join(unusableParent, "claude-profiles"),
			"blocking file",
			"utf8",
		);
		const unusableDbPath = join(unusableParent, "host.db");
		await seedWorkspace(world, { id: WORKSPACE_IDS[0] });
		const service = createClaudeAccountsService({
			db: world.db,
			dbPath: unusableDbPath,
			emit: (event) => world.events.push(event),
			log: world.log,
			awaitInitialBackgroundWork: true,
			pushKeyPath: join(world.root, "missing-key"),
		});
		services.push(service);

		await expect(service.start()).resolves.toBeUndefined();

		expect(service.getCapability().managed).toBe(false);
		expect(
			world.log.errorEntries.some((entry) =>
				entry.message.includes("failed to initialize"),
			),
		).toBe(true);

		await service.withWorkspaceDeletion(
			[{ workspaceId: WORKSPACE_IDS[0], terminalIds: [] }],
			async () => {
				world.db
					.delete(workspaces)
					.where(eq(workspaces.id, WORKSPACE_IDS[0]))
					.run();
			},
			{ disposalMode: "warn-and-continue" },
		);
		expect(
			world.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, WORKSPACE_IDS[0]) })
				.sync(),
		).toBeUndefined();
	});
});
