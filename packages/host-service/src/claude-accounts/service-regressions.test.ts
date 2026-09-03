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
	servePiFake,
	type WireAccount,
	WORKSPACE_IDS,
	wireAccount,
	writeGlobalClaudeState,
	writeGlobalCredentials,
} from "../../test/helpers/claude-accounts-fixture";
import { terminalSessions, workspaces } from "../db/schema";
import {
	type ClaudeAccountsService,
	createClaudeAccountsService,
	PI_FAILURE_GRACE_MS,
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

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	message: string,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error(message);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function hasActiveGlobalWarning(
	world: ClaudeTestWorld,
	messageIncludes?: string,
): boolean {
	return world.events.some(
		(event) =>
			event.type === "claude-account-warning" &&
			event.workspaceId === null &&
			event.active &&
			(messageIncludes === undefined ||
				event.message.includes(messageIncludes)),
	);
}

async function setupService(options: { now?: () => number } = {}) {
	const world = await createClaudeTestWorld("claude-service-regression-");
	worlds.push(world);
	await writeGlobalClaudeState(world);
	await writeGlobalCredentials(world, {});
	const pi = await servePiFake(world.root, [
		wireAccount("claude123"),
		wireAccount("claude456"),
	]);
	servers.push(pi.server);
	const service = createClaudeAccountsService({
		db: world.db,
		dbPath: world.dbPath,
		emit: (event) => world.events.push(event),
		log: world.log,
		awaitInitialBackgroundWork: true,
		piBaseUrl: pi.baseUrl,
		pushKeyPath: pi.pushKeyPath,
		...(options.now ? { now: options.now } : {}),
	});
	services.push(service);
	await service.start();
	return { world, service, pi };
}

async function setupFallbackService(options: {
	roster: WireAccount[];
	workspaceSlugs: string[];
	onEmit?: (
		event: ClaudeTestWorld["events"][number],
		world: ClaudeTestWorld,
	) => void;
}) {
	const world = await createClaudeTestWorld("claude-fallback-regression-");
	worlds.push(world);
	await writeGlobalClaudeState(world);
	await writeGlobalCredentials(
		world,
		managedCredentials("claude12", {
			accessToken: "claude12-default-token",
			refreshToken: "real-token-stays-global",
		}),
	);
	const trayDirectory = join(world.home, ".usage-display");
	await mkdir(trayDirectory, { recursive: true });
	await writeFile(
		join(trayDirectory, "tray-state.json"),
		JSON.stringify({ trigger_five_pct: 80, trigger_seven_pct: 80 }),
		"utf8",
	);
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
	const pi = await servePiFake(world.root, options.roster);
	servers.push(pi.server);
	const service = createClaudeAccountsService({
		db: world.db,
		dbPath: world.dbPath,
		emit: (event) => {
			world.events.push(event);
			options.onEmit?.(event, world);
		},
		log: world.log,
		awaitInitialBackgroundWork: true,
		piBaseUrl: pi.baseUrl,
		pushKeyPath: pi.pushKeyPath,
	});
	services.push(service);
	await service.start();
	return { world, service };
}

describe("Claude transcript config directories", () => {
	test("rejects invalid workspaces and uses the global folder when unmanaged", async () => {
		const world = await createClaudeTestWorld("claude-config-dirs-unmanaged-");
		worlds.push(world);
		const service = createClaudeAccountsService({
			db: world.db,
			dbPath: world.dbPath,
			emit: (event) => world.events.push(event),
			log: world.log,
			pushKeyPath: join(world.root, "missing-key"),
		});
		services.push(service);

		expect(service.configDirCandidatesFor("not-a-uuid")).toEqual([]);
		expect(service.configDirCandidatesFor(WORKSPACE_IDS[0])).toEqual([
			join(world.home, ".claude"),
		]);
	});

	test("prefers an existing managed folder and deduplicates the global folder", async () => {
		const { world, service } = await setupService();
		await seedWorkspace(world, { id: WORKSPACE_IDS[0] });
		await seedWorkspace(world, { id: WORKSPACE_IDS[1] });
		await service.setWorkspaceAccount(WORKSPACE_IDS[0], "claude123");
		const profile = service.profileDirFor(WORKSPACE_IDS[0]);
		const globalDir = join(world.home, ".claude");

		expect(service.configDirCandidatesFor(WORKSPACE_IDS[0])).toEqual([
			profile,
			globalDir,
		]);
		expect(service.configDirCandidatesFor(WORKSPACE_IDS[1])).toEqual([
			globalDir,
		]);

		const previous = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = profile;
		try {
			expect(service.configDirCandidatesFor(WORKSPACE_IDS[0])).toEqual([
				profile,
			]);
		} finally {
			if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = previous;
		}
	});
});

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

	test("applies a manual switch to Following during a short Pi outage", async () => {
		const { world, service, pi } = await setupService();
		await seedWorkspace(world, { id: WORKSPACE_IDS[0] });
		await service.setWorkspaceAccount(WORKSPACE_IDS[0], "claude123");
		const credentialPath = join(
			service.profileDirFor(WORKSPACE_IDS[0]),
			".credentials.json",
		);
		await writeGlobalCredentials(world, managedCredentials("claude456"));
		pi.setAvailable(false);
		world.events.length = 0;

		await service.setWorkspaceAccount(WORKSPACE_IDS[0], null);

		expect(
			world.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, WORKSPACE_IDS[0]) })
				.sync()?.claudeAccountSlug,
		).toBeNull();
		expect(
			JSON.parse(await readFile(credentialPath, "utf8")).trayManagedAccount,
		).toBe("claude456");
		expect(
			world.events.some(
				(event) =>
					event.type === "claude-account-state-changed" &&
					event.workspaceId === WORKSPACE_IDS[0] &&
					event.state === "following",
			),
		).toBe(true);
	});

	test("refuses a new manual switch after ten minutes of Pi failures", async () => {
		let now = 1_000_000;
		const { world, service, pi } = await setupService({ now: () => now });
		await seedWorkspace(world, { id: WORKSPACE_IDS[0] });
		await service.setWorkspaceAccount(WORKSPACE_IDS[0], "claude123");
		pi.setAvailable(false);
		await service.getRoster();
		now += PI_FAILURE_GRACE_MS;

		await expect(
			service.setWorkspaceAccount(WORKSPACE_IDS[0], null),
		).rejects.toThrow(
			"Cannot switch this workspace to Following while the Pi is unavailable",
		);
		expect(
			world.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, WORKSPACE_IDS[0]) })
				.sync()?.claudeAccountSlug,
		).toBe("claude123");
	});

	test("delays the Pi warning until ten continuous minutes have failed", async () => {
		let now = 1_000_000;
		const { world, service, pi } = await setupService({ now: () => now });
		await service.getRoster();
		world.events.length = 0;
		pi.setAvailable(false);

		await service.getRoster();
		now += PI_FAILURE_GRACE_MS - 1;
		await service.getRoster();
		expect(hasActiveGlobalWarning(world)).toBe(false);

		pi.setAvailable(true);
		await service.getRoster();
		pi.setAvailable(false);
		await service.getRoster();
		now += PI_FAILURE_GRACE_MS;
		await service.getRoster();

		const warnings = world.events.filter(
			(event) =>
				event.type === "claude-account-warning" &&
				event.workspaceId === null &&
				event.active &&
				event.message.includes("cannot reach the Pi"),
		);
		expect(warnings).toHaveLength(1);
	});

	test("queues a pinned switch and applies it when the Pi recovers", async () => {
		const { world, service, pi } = await setupService();
		await seedWorkspace(world, { id: WORKSPACE_IDS[0] });
		await service.setWorkspaceAccount(WORKSPACE_IDS[0], "claude123");
		const credentialPath = join(
			service.profileDirFor(WORKSPACE_IDS[0]),
			".credentials.json",
		);
		pi.setAvailable(false);
		world.events.length = 0;

		await service.setWorkspaceAccount(WORKSPACE_IDS[0], "claude456");

		expect(
			world.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, WORKSPACE_IDS[0]) })
				.sync()?.claudeAccountSlug,
		).toBe("claude456");
		expect(
			JSON.parse(await readFile(credentialPath, "utf8")).trayManagedAccount,
		).toBe("claude123");
		expect(hasActiveGlobalWarning(world)).toBe(false);
		expect(
			world.events.some(
				(event) =>
					event.type === "claude-account-warning" &&
					event.workspaceId === WORKSPACE_IDS[0] &&
					event.active &&
					event.message.includes("waiting for the Pi"),
			),
		).toBe(true);

		pi.setAvailable(true);
		await writeGlobalCredentials(world, { changedAt: Date.now() });
		await waitFor(
			async () =>
				JSON.parse(await readFile(credentialPath, "utf8"))
					.trayManagedAccount === "claude456",
			"queued Claude account switch did not complete after Pi recovery",
		);
		expect(
			(await service.getWorkspaceState(WORKSPACE_IDS[0])).warning,
		).toBeNull();
	});

	test("removes old credentials when a queued account becomes unavailable", async () => {
		const { world, service, pi } = await setupService();
		await seedWorkspace(world, { id: WORKSPACE_IDS[0] });
		await service.setWorkspaceAccount(WORKSPACE_IDS[0], "claude123");
		const credentialPath = join(
			service.profileDirFor(WORKSPACE_IDS[0]),
			".credentials.json",
		);
		pi.setAvailable(false);
		await service.setWorkspaceAccount(WORKSPACE_IDS[0], "claude456");

		pi.setAccounts([wireAccount("claude123")]);
		pi.setAvailable(true);
		await writeGlobalCredentials(world, { changedAt: Date.now() });
		await waitFor(
			async () =>
				(
					await service.getWorkspaceState(WORKSPACE_IDS[0])
				).warning?.message.includes("no usable credentials") === true,
			"invalid queued Claude account switch was not reported",
		);

		await expect(lstat(credentialPath)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	test("removes old credentials after a queued token fails for ten minutes", async () => {
		let now = 1_000_000;
		const { world, service, pi } = await setupService({ now: () => now });
		await seedWorkspace(world, { id: WORKSPACE_IDS[0] });
		await service.setWorkspaceAccount(WORKSPACE_IDS[0], "claude123");
		const credentialPath = join(
			service.profileDirFor(WORKSPACE_IDS[0]),
			".credentials.json",
		);
		pi.setTokenAvailable(false);
		await service.setWorkspaceAccount(WORKSPACE_IDS[0], "claude456");
		now += PI_FAILURE_GRACE_MS;

		await writeGlobalCredentials(world, { changedAt: Date.now() });
		await waitFor(
			async () =>
				(
					await service.getWorkspaceState(WORKSPACE_IDS[0])
				).warning?.message.includes("could not finish after 10 minutes") ===
				true,
			"expired queued Claude account switch was not reported",
		);

		await expect(lstat(credentialPath)).rejects.toMatchObject({
			code: "ENOENT",
		});

		pi.setTokenAvailable(true);
		await writeGlobalCredentials(world, { recoveredAt: Date.now() });
		await waitFor(async () => {
			if (!(await Bun.file(credentialPath).exists())) return false;
			return (
				JSON.parse(await readFile(credentialPath, "utf8"))
					.trayManagedAccount === "claude456"
			);
		}, "queued Claude account switch did not recover after old credentials were removed");
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

	test("warns after ten minutes of renewal failures with one global outage event", async () => {
		let now = 1_000_000;
		const world = await createClaudeTestWorld("claude-renewal-warning-");
		worlds.push(world);
		await writeGlobalClaudeState(world);
		await writeGlobalCredentials(world, {});
		const rows = await Promise.all(
			WORKSPACE_IDS.slice(0, 2).map((id) =>
				seedWorkspace(world, { id, claudeAccountSlug: "claude123" }),
			),
		);
		const manager = new ClaudeProfileManager(world.dbPath, world.log);
		await manager.initialize();
		const expiring = managedCredentials("claude123", {
			accessToken: "last-good-token",
			expiresAt: Date.now() + 40 * 60 * 1000,
		});
		for (const row of rows) {
			await manager.mintProfile(row.id, row.worktreePath, expiring);
		}
		const pushKeyPath = join(world.root, "push-key.txt");
		await writeFile(pushKeyPath, "test-key\n", "utf8");
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const path = new URL(request.url).pathname;
				if (path === "/accounts") {
					return Response.json([wireAccount("claude123")]);
				}
				if (path.endsWith("/token")) {
					return new Response(null, { status: 503 });
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
			now: () => now,
		});
		services.push(service);

		await service.start();
		expect(hasActiveGlobalWarning(world, "renewal")).toBe(false);
		now += PI_FAILURE_GRACE_MS;
		await writeGlobalCredentials(world, { changedAt: Date.now() });
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
			roster: [wireAccount("claude123", { five_pct: 95 })],
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
				wireAccount("claude12"),
				wireAccount("claude123", { five_pct: 95 }),
				wireAccount("claude456", { five_pct: 95 }),
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
					JSON.stringify(
						managedCredentials("claude456", {
							accessToken: "claude456-default-token",
							refreshToken: "real-token-stays-global",
						}),
					),
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

	test("permanently falls back from a dead pinned account", async () => {
		const { world, service } = await setupFallbackService({
			roster: [
				wireAccount("claude12"),
				wireAccount("claude123", {
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
						event.type === "claude-account-state-changed" &&
						event.cause === "auto-fallback",
				),
			"dead-account fallback was not emitted",
		);

		const state = await service.getWorkspaceState(WORKSPACE_IDS[0]);
		expect(state.state).toBe("following");
		expect(state.slug).toBeNull();
	});

	test("does not fall back onto a dead machine-default account", async () => {
		const { world, service } = await setupFallbackService({
			roster: [
				wireAccount("claude12", {
					dead: true,
					dead_reason: "login expired",
				}),
				wireAccount("claude123", { five_pct: 95 }),
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
	test("rejects workspace deletion before the service starts", async () => {
		const world = await createClaudeTestWorld("claude-service-not-started-");
		worlds.push(world);
		const service = createClaudeAccountsService({
			db: world.db,
			dbPath: world.dbPath,
			emit: (event) => world.events.push(event),
			log: world.log,
			pushKeyPath: join(world.root, "missing-key"),
		});
		services.push(service);

		await expect(
			service.withWorkspaceDeletion([], async () => {}, {
				disposalMode: "abort",
			}),
		).rejects.toThrow("Claude accounts service has not started");
	});

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
