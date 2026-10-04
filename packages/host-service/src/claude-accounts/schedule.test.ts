import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import {
	type ClaudeTestWorld,
	createClaudeTestWorld,
	managedCredentials,
	seedWorkspace,
	servePiFake,
	type WireAccount,
	wireAccount,
	writeGlobalClaudeState,
	writeGlobalCredentials,
} from "../../test/helpers/claude-accounts-fixture";
import { claudeAccountSchedules, workspaces } from "../db/schema";
import { FallbackPolicy } from "./fallback";
import {
	type ClaudeAccountsService,
	createClaudeAccountsService,
	PI_FAILURE_GRACE_MS,
} from "./index";
import { PiClient } from "./pi-client";
import { ClaudeProfileManager } from "./profile-manager";
import type { ScheduleTimer } from "./schedule";
import type { ClaudeAccessToken, ManagedCredentials } from "./types";

const A = "claude123";
const B = "claude456";
const C = "claude789";
const DEFAULT = "claude12";
const MINUTE = 60_000;
const WINDOW = 30 * MINUTE;

type PiFake = Awaited<ReturnType<typeof servePiFake>>;

const worlds: ClaudeTestWorld[] = [];
const services: ClaudeAccountsService[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const spies: Array<{ mockRestore(): void }> = [];

afterEach(async () => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	for (const service of services.splice(0)) service.stop();
	for (const server of servers.splice(0)) server.stop(true);
	for (const world of worlds.splice(0).reverse()) await world.dispose();
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function createFakeTimer() {
	let armed: { run: () => Promise<void>; delayMs: number } | null = null;
	const timer: ScheduleTimer = (run, delayMs) => {
		const entry = { run, delayMs };
		armed = entry;
		return () => {
			if (armed === entry) armed = null;
		};
	};
	return {
		timer,
		get armed() {
			return armed;
		},
		async fire(): Promise<void> {
			const entry = armed;
			if (!entry) throw new Error("The schedule timer is idle");
			armed = null;
			await entry.run();
		},
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

async function createScheduleWorld(
	options: {
		roster?: WireAccount[];
		defaultSlug?: string;
		triggers?: boolean;
	} = {},
): Promise<{ world: ClaudeTestWorld; pi: PiFake }> {
	const world = await createClaudeTestWorld("claude-schedule-");
	worlds.push(world);
	await writeGlobalClaudeState(world);
	await writeGlobalCredentials(
		world,
		options.defaultSlug
			? managedCredentials(options.defaultSlug, {
					accessToken: `${options.defaultSlug}-default-token`,
					refreshToken: "real-token-stays-global",
				})
			: {},
	);
	if (options.triggers) {
		const trayDirectory = join(world.home, ".usage-display");
		await mkdir(trayDirectory, { recursive: true });
		await writeFile(
			join(trayDirectory, "tray-state.json"),
			JSON.stringify({ trigger_five_pct: 80, trigger_seven_pct: 80 }),
			"utf8",
		);
	}
	const pi = await servePiFake(
		world.root,
		options.roster ?? [wireAccount(A), wireAccount(B), wireAccount(C)],
	);
	servers.push(pi.server);
	return { world, pi };
}

async function startService(
	world: ClaudeTestWorld,
	pi: PiFake,
	options: { now: () => number; awaitInitialBackgroundWork?: boolean },
) {
	const timer = createFakeTimer();
	const service = createClaudeAccountsService({
		db: world.db,
		dbPath: world.dbPath,
		emit: (event) => world.events.push(event),
		log: world.log,
		awaitInitialBackgroundWork: options.awaitInitialBackgroundWork ?? true,
		piBaseUrl: pi.baseUrl,
		pushKeyPath: pi.pushKeyPath,
		now: options.now,
		scheduleTimer: timer.timer,
	});
	services.push(service);
	await service.start();
	return { service, timer };
}

async function seedPinned(
	world: ClaudeTestWorld,
	options: {
		slug: string | null;
		installed?: string | ManagedCredentials;
		archivedAt?: number;
	},
): Promise<string> {
	const workspace = await seedWorkspace(world, {
		claudeAccountSlug: options.slug,
		archivedAt: options.archivedAt ?? null,
	});
	if (options.installed !== undefined) {
		const manager = new ClaudeProfileManager(world.dbPath, world.log);
		await manager.initialize();
		await manager.mintProfile(
			workspace.id,
			workspace.worktreePath,
			typeof options.installed === "string"
				? managedCredentials(options.installed)
				: options.installed,
		);
	}
	return workspace.id;
}

function seedSchedule(
	world: ClaudeTestWorld,
	workspaceId: string,
	options: { targetSlug: string | null; fireAt: number; failed?: boolean },
): string {
	const scheduleId = randomUUID();
	world.db
		.insert(claudeAccountSchedules)
		.values({
			workspaceId,
			scheduleId,
			targetSlug: options.targetSlug,
			fireAt: options.fireAt,
			...(options.failed
				? {
						status: "failed" as const,
						failedAt: options.fireAt + WINDOW,
						failure: "target-unavailable" as const,
					}
				: { status: "pending" as const }),
		})
		.run();
	return scheduleId;
}

function scheduleRow(world: ClaudeTestWorld, workspaceId: string) {
	return world.db
		.select()
		.from(claudeAccountSchedules)
		.where(eq(claudeAccountSchedules.workspaceId, workspaceId))
		.get();
}

function workspaceRow(world: ClaudeTestWorld, workspaceId: string) {
	const row = world.db.query.workspaces
		.findFirst({ where: eq(workspaces.id, workspaceId) })
		.sync();
	if (!row) throw new Error(`Workspace ${workspaceId} disappeared`);
	return row;
}

function credentialsPath(
	service: ClaudeAccountsService,
	workspaceId: string,
): string {
	return join(service.profileDirFor(workspaceId), ".credentials.json");
}

async function installedAccount(
	service: ClaudeAccountsService,
	workspaceId: string,
): Promise<string | null> {
	return JSON.parse(
		await readFile(credentialsPath(service, workspaceId), "utf8"),
	).trayManagedAccount;
}

function scheduledStateChanges(world: ClaudeTestWorld, workspaceId: string) {
	return world.events.filter(
		(event) =>
			event.type === "claude-account-state-changed" &&
			event.workspaceId === workspaceId &&
			event.cause === "scheduled",
	);
}

function controlsChanges(world: ClaudeTestWorld, workspaceId: string) {
	return world.events.filter(
		(event) =>
			event.type === "claude-account-controls-changed" &&
			event.workspaceId === workspaceId,
	);
}

function holdNextTokenFetch() {
	const requested = deferred<string>();
	const release = deferred<ClaudeAccessToken>();
	spies.push(
		spyOn(PiClient.prototype, "fetchToken").mockImplementationOnce(
			async (slug) => {
				requested.resolve(slug);
				return release.promise;
			},
		),
	);
	return {
		requested: requested.promise,
		release: (slug: string) =>
			release.resolve({
				account: slug,
				accessToken: `${slug}-held-token`,
				expiresAt: Date.now() + 2 * 60 * MINUTE,
			}),
	};
}

function holdFirstTriggerRead() {
	const reached = deferred<void>();
	const gate = deferred<void>();
	spies.push(
		spyOn(FallbackPolicy.prototype, "readTriggers").mockImplementationOnce(
			async () => {
				reached.resolve();
				await gate.promise;
				return { five: 80, seven: 80 };
			},
		),
	);
	return { reached: reached.promise, release: () => gate.resolve() };
}

describe("scheduled Claude account switch fire", () => {
	test("fires with Auto-switch off and records the scheduled cause", async () => {
		let now = Date.now();
		const { world, pi } = await createScheduleWorld();
		const id = await seedPinned(world, { slug: B, installed: B });
		world.db
			.update(workspaces)
			.set({ claudeAutoSwitch: false })
			.where(eq(workspaces.id, id))
			.run();
		const { service, timer } = await startService(world, pi, {
			now: () => now,
		});

		await service.scheduleSwitch(
			id,
			{ kind: "account", slug: A },
			now + MINUTE,
		);
		now += MINUTE;
		await timer.fire();

		expect(workspaceRow(world, id)).toMatchObject({
			claudeAccountSlug: A,
			claudeAutoSwitch: false,
			claudeScheduleFiredAt: now,
		});
		expect(scheduleRow(world, id)).toBeUndefined();
		expect(await installedAccount(service, id)).toBe(A);
		expect(world.events).toContainEqual({
			type: "claude-account-state-changed",
			workspaceId: id,
			state: "pinned",
			slug: A,
			cause: "scheduled",
		});
		expect(controlsChanges(world, id)).toHaveLength(1);
	});

	test("already on the target consumes without a token fetch or a credential write", async () => {
		let now = Date.now();
		const { world, pi } = await createScheduleWorld();
		const id = await seedPinned(world, { slug: A, installed: A });
		const { service, timer } = await startService(world, pi, {
			now: () => now,
		});
		await service.scheduleSwitch(
			id,
			{ kind: "account", slug: A },
			now + MINUTE,
		);
		const before = await readFile(credentialsPath(service, id), "utf8");
		const fetchToken = spyOn(PiClient.prototype, "fetchToken");
		spies.push(fetchToken);

		now += MINUTE;
		await timer.fire();

		expect(fetchToken).not.toHaveBeenCalled();
		expect(await readFile(credentialsPath(service, id), "utf8")).toBe(before);
		expect(scheduleRow(world, id)).toBeUndefined();
		expect(workspaceRow(world, id).claudeScheduleFiredAt).toBe(now);
		expect(scheduledStateChanges(world, id)).toHaveLength(0);
	});

	for (const installed of ["other account", "blanked"] as const) {
		test(`a saved pin on the target with ${installed} credentials still switches`, async () => {
			let now = Date.now();
			const { world, pi } = await createScheduleWorld();
			const id = await seedPinned(world, { slug: A, installed: A });
			const { service, timer } = await startService(world, pi, {
				now: () => now,
			});
			await writeFile(
				credentialsPath(service, id),
				JSON.stringify(
					installed === "blanked"
						? {
								claudeAiOauth: {
									accessToken: "",
									refreshToken: "",
									expiresAt: 0,
								},
								trayManagedAccount: A,
							}
						: managedCredentials(B),
				),
				"utf8",
			);
			await service.scheduleSwitch(
				id,
				{ kind: "account", slug: A },
				now + MINUTE,
			);
			const fetchToken = spyOn(PiClient.prototype, "fetchToken");
			spies.push(fetchToken);

			now += MINUTE;
			await timer.fire();

			expect(fetchToken).toHaveBeenCalledWith(A);
			expect(
				JSON.parse(await readFile(credentialsPath(service, id), "utf8")),
			).toMatchObject({
				claudeAiOauth: { accessToken: `${A}-token` },
				trayManagedAccount: A,
			});
			expect(scheduleRow(world, id)).toBeUndefined();
			expect(workspaceRow(world, id).claudeScheduleFiredAt).toBe(now);
		});
	}

	for (const scenario of [
		{ outcome: "Following consumes as a no-op", slug: null, signedIn: true },
		{ outcome: "pinned switches to Following", slug: B, signedIn: true },
		{
			outcome: "signed out fails as default-unavailable",
			slug: B,
			signedIn: false,
		},
	] as const) {
		test(`Default (tray): ${scenario.outcome}`, async () => {
			let now = Date.now();
			const { world, pi } = await createScheduleWorld(
				scenario.signedIn ? { defaultSlug: DEFAULT } : {},
			);
			const id = await seedPinned(world, {
				slug: scenario.slug,
				installed: scenario.slug ?? DEFAULT,
			});
			const fireAt = now + MINUTE;
			seedSchedule(world, id, { targetSlug: null, fireAt });
			const { service, timer } = await startService(world, pi, {
				now: () => now,
			});

			now = fireAt;
			await timer.fire();

			if (!scenario.signedIn) {
				expect(scheduleRow(world, id)?.status).toBe("pending");
				now = fireAt + WINDOW;
				await timer.fire();
				expect(scheduleRow(world, id)).toMatchObject({
					status: "failed",
					failure: "default-unavailable",
					lastError: "The machine default is signed out",
				});
				expect(workspaceRow(world, id).claudeAccountSlug).toBe(B);
				return;
			}
			expect(scheduleRow(world, id)).toBeUndefined();
			expect(workspaceRow(world, id)).toMatchObject({
				claudeAccountSlug: null,
				claudeScheduleFiredAt: fireAt,
			});
			expect(scheduledStateChanges(world, id)).toHaveLength(
				scenario.slug === null ? 0 : 1,
			);
			if (scenario.slug !== null) {
				expect(await installedAccount(service, id)).toBe(DEFAULT);
			}
		});
	}
});

describe("scheduled switch and the fallback cooldown", () => {
	test("a same-slug fire holds the fallback for 10 minutes, across a restart", async () => {
		const fireAt = Date.now();
		const { world, pi } = await createScheduleWorld({
			roster: [wireAccount(DEFAULT), wireAccount(A, { five_pct: 95 })],
			defaultSlug: DEFAULT,
			triggers: true,
		});
		const id = await seedPinned(world, { slug: A, installed: A });
		seedSchedule(world, id, { targetSlug: A, fireAt });
		const triggerRead = holdFirstTriggerRead();
		const first = await startService(world, pi, {
			now: () => fireAt,
			awaitInitialBackgroundWork: false,
		});

		await triggerRead.reached;
		await first.timer.fire();
		expect(scheduleRow(world, id)).toBeUndefined();
		expect(workspaceRow(world, id).claudeScheduleFiredAt).toBe(fireAt);
		triggerRead.release();
		await waitFor(
			() =>
				world.log.infoEntries.some(
					(entry) =>
						entry.message ===
						"Claude auto-fallback discarded: a scheduled switch fired less than 10 minutes ago",
				),
			"the locked fallback re-check did not discard the candidate",
		);
		expect(workspaceRow(world, id).claudeAccountSlug).toBe(A);
		first.service.stop();

		const second = await startService(world, pi, {
			now: () => fireAt + 9 * MINUTE,
		});
		expect(
			world.log.infoEntries.some(
				(entry) =>
					entry.message ===
					"Claude auto-fallback suppressed: a scheduled switch fired less than 10 minutes ago",
			),
		).toBe(true);
		expect(workspaceRow(world, id).claudeAccountSlug).toBe(A);
		second.service.stop();

		await startService(world, pi, { now: () => fireAt + 10 * MINUTE });
		expect(workspaceRow(world, id).claudeAccountSlug).toBeNull();
		expect(world.events).toContainEqual(
			expect.objectContaining({
				type: "claude-account-state-changed",
				workspaceId: id,
				cause: "auto-fallback",
			}),
		);
	});
});

describe("scheduled switch retries and failures", () => {
	test("an unreachable Pi retries and fires once it recovers", async () => {
		let now = Date.now();
		const { world, pi } = await createScheduleWorld();
		const id = await seedPinned(world, { slug: B, installed: B });
		const { service, timer } = await startService(world, pi, {
			now: () => now,
		});
		await service.scheduleSwitch(
			id,
			{ kind: "account", slug: A },
			now + MINUTE,
		);
		now += MINUTE;
		pi.setAvailable(false);

		await timer.fire();
		expect(scheduleRow(world, id)?.status).toBe("pending");
		expect(workspaceRow(world, id).claudeAccountSlug).toBe(B);
		expect(timer.armed?.delayMs).toBe(15_000);

		now += 5 * MINUTE;
		pi.setAvailable(true);
		await timer.fire();
		expect(scheduleRow(world, id)).toBeUndefined();
		expect(workspaceRow(world, id).claudeAccountSlug).toBe(A);
	});

	for (const scenario of ["HTTP 429", "a token under 30 minutes"] as const) {
		test(`${scenario} retries`, async () => {
			let now = Date.now();
			const { world, pi } = await createScheduleWorld();
			const id = await seedPinned(world, { slug: B, installed: B });
			const { service, timer } = await startService(world, pi, {
				now: () => now,
			});
			await service.scheduleSwitch(
				id,
				{ kind: "account", slug: A },
				now + MINUTE,
			);
			now += MINUTE;
			if (scenario === "HTTP 429") {
				pi.setFailureStatus(429);
				pi.setAvailable(false);
			} else {
				pi.setTokenLifetimeMs(20 * MINUTE);
			}

			await timer.fire();
			expect(scheduleRow(world, id)?.status).toBe("pending");
			expect(workspaceRow(world, id).claudeAccountSlug).toBe(B);

			pi.setAvailable(true);
			pi.setTokenLifetimeMs(2 * 60 * MINUTE);
			now += 30_000;
			await timer.fire();
			expect(scheduleRow(world, id)).toBeUndefined();
			expect(workspaceRow(world, id).claudeAccountSlug).toBe(A);
		});
	}

	test("a target that stays dead fails as target-unavailable at the deadline", async () => {
		let now = Date.now();
		const { world, pi } = await createScheduleWorld();
		const id = await seedPinned(world, { slug: B, installed: B });
		const { service, timer } = await startService(world, pi, {
			now: () => now,
		});
		const fireAt = now + MINUTE;
		await service.scheduleSwitch(id, { kind: "account", slug: A }, fireAt);
		pi.setAccounts([
			wireAccount(A, { dead: true, dead_reason: "login expired" }),
			wireAccount(B),
		]);
		now = fireAt;

		await timer.fire();
		expect(scheduleRow(world, id)?.status).toBe("pending");

		now = fireAt + WINDOW;
		await timer.fire();
		expect(scheduleRow(world, id)).toMatchObject({
			status: "failed",
			failure: "target-unavailable",
			failedAt: now,
		});
		expect(scheduleRow(world, id)?.lastError).toContain("needs re-login");
		expect(workspaceRow(world, id).claudeAccountSlug).toBe(B);
		expect(await installedAccount(service, id)).toBe(B);
		expect(timer.armed).toBeNull();
	});

	test("Pi HTTP 401 fails as error on the first attempt", async () => {
		let now = Date.now();
		const { world, pi } = await createScheduleWorld();
		const id = await seedPinned(world, { slug: B, installed: B });
		const { service, timer } = await startService(world, pi, {
			now: () => now,
		});
		await service.scheduleSwitch(
			id,
			{ kind: "account", slug: A },
			now + MINUTE,
		);
		now += MINUTE;
		pi.setFailureStatus(401);
		pi.setAvailable(false);

		await timer.fire();

		expect(scheduleRow(world, id)).toMatchObject({
			status: "failed",
			failure: "error",
			lastError: "Pi request /accounts returned HTTP 401",
		});
		expect(workspaceRow(world, id).claudeAccountSlug).toBe(B);
		expect(controlsChanges(world, id)).toHaveLength(1);
	});

	test("an empty profile login file stays pending, then expires as profile-unavailable", async () => {
		let now = Date.now();
		const { world, pi } = await createScheduleWorld();
		const id = await seedPinned(world, { slug: B, installed: B });
		const { service, timer } = await startService(world, pi, {
			now: () => now,
		});
		const fireAt = now + MINUTE;
		await service.scheduleSwitch(id, { kind: "account", slug: A }, fireAt);
		await writeFile(credentialsPath(service, id), "", "utf8");
		now = fireAt;

		await timer.fire();
		expect(scheduleRow(world, id)?.status).toBe("pending");

		now = fireAt + WINDOW;
		await timer.fire();
		expect(scheduleRow(world, id)).toMatchObject({
			status: "failed",
			failure: "profile-unavailable",
		});
		expect(scheduleRow(world, id)?.lastError).toContain(
			"Claude credentials file is empty",
		);
		expect(workspaceRow(world, id).claudeAccountSlug).toBe(B);
		expect(await readFile(credentialsPath(service, id), "utf8")).toBe("");
	});

	test("an unexpected error fails as error at once, with no retry", async () => {
		let now = Date.now();
		const { world, pi } = await createScheduleWorld();
		const id = await seedPinned(world, { slug: B, installed: B });
		const { service, timer } = await startService(world, pi, {
			now: () => now,
		});
		await service.scheduleSwitch(
			id,
			{ kind: "account", slug: A },
			now + MINUTE,
		);
		now += MINUTE;
		spies.push(
			spyOn(
				ClaudeProfileManager.prototype,
				"profileExists",
			).mockRejectedValueOnce(new Error("disk exploded")),
		);

		await timer.fire();

		expect(scheduleRow(world, id)).toMatchObject({
			status: "failed",
			failure: "error",
			lastError: "disk exploded",
		});
		expect(workspaceRow(world, id).claudeAccountSlug).toBe(B);
		expect(timer.armed).toBeNull();
	});

	test("a host started more than 30 minutes late fails it as not-run", async () => {
		const scheduledAt = Date.now();
		const { world, pi } = await createScheduleWorld();
		const id = await seedPinned(world, { slug: B, installed: B });
		const first = await startService(world, pi, { now: () => scheduledAt });
		const fireAt = scheduledAt + MINUTE;
		await first.service.scheduleSwitch(
			id,
			{ kind: "account", slug: A },
			fireAt,
		);
		first.service.stop();

		const second = await startService(world, pi, {
			now: () => fireAt + 31 * MINUTE,
		});
		await second.timer.fire();

		expect(scheduleRow(world, id)).toMatchObject({
			status: "failed",
			failure: "not-run",
			lastError: null,
		});
		expect(workspaceRow(world, id).claudeAccountSlug).toBe(B);
	});
});

describe("scheduled switch races", () => {
	test("a user pick during the fire's token fetch wins", async () => {
		let now = Date.now();
		const { world, pi } = await createScheduleWorld();
		const id = await seedPinned(world, { slug: C, installed: C });
		const { service, timer } = await startService(world, pi, {
			now: () => now,
		});
		await service.scheduleSwitch(
			id,
			{ kind: "account", slug: A },
			now + MINUTE,
		);
		now += MINUTE;
		const token = holdNextTokenFetch();

		const pass = timer.fire();
		expect(await token.requested).toBe(A);
		await service.setWorkspaceAccount(id, B);
		token.release(A);
		await pass;

		expect(workspaceRow(world, id).claudeAccountSlug).toBe(B);
		expect(await installedAccount(service, id)).toBe(B);
		expect(scheduleRow(world, id)).toBeUndefined();
		expect(scheduledStateChanges(world, id)).toHaveLength(0);
	});

	for (const oldOutcome of ["commit", "expiry"] as const) {
		test(`a replacement survives the old schedule's ${oldOutcome}`, async () => {
			let now = Date.now();
			const { world, pi } = await createScheduleWorld();
			const id = await seedPinned(world, { slug: B, installed: B });
			const { service, timer } = await startService(world, pi, {
				now: () => now,
			});
			const old = await service.scheduleSwitch(
				id,
				{ kind: "account", slug: A },
				now + MINUTE,
			);
			now += MINUTE;
			const token = holdNextTokenFetch();

			const pass = timer.fire();
			await token.requested;
			if (oldOutcome === "expiry") now += WINDOW;
			const replacement = await service.scheduleSwitch(
				id,
				{ kind: "account", slug: C },
				now + 60 * MINUTE,
			);
			token.release(A);
			await pass;

			const expectReplacementIntact = async () => {
				expect(scheduleRow(world, id)).toMatchObject({
					scheduleId: replacement.scheduleId,
					status: "pending",
					targetSlug: C,
				});
				expect(workspaceRow(world, id).claudeAccountSlug).toBe(B);
				expect(await installedAccount(service, id)).toBe(B);
			};
			await expectReplacementIntact();
			await service.clearScheduledSwitch(id, old.scheduleId);
			await expectReplacementIntact();
		});
	}

	test("Cancel while the fire is mid-commit restores the credentials", async () => {
		let now = Date.now();
		const { world, pi } = await createScheduleWorld();
		const id = await seedPinned(world, { slug: B, installed: B });
		const { service, timer } = await startService(world, pi, {
			now: () => now,
		});
		const schedule = await service.scheduleSwitch(
			id,
			{ kind: "account", slug: A },
			now + MINUTE,
		);
		now += MINUTE;
		const before = await readFile(credentialsPath(service, id), "utf8");
		let cancelledAfterWrite = false;
		const write = ClaudeProfileManager.prototype.writeCredentials;
		spies.push(
			spyOn(
				ClaudeProfileManager.prototype,
				"writeCredentials",
			).mockImplementationOnce(async function (
				this: ClaudeProfileManager,
				profileDir: string,
				credentials: ManagedCredentials,
			) {
				await write.call(this, profileDir, credentials);
				await service.clearScheduledSwitch(id, schedule.scheduleId);
				cancelledAfterWrite = true;
			}),
		);

		await timer.fire();

		expect(cancelledAfterWrite).toBe(true);
		expect(await readFile(credentialsPath(service, id), "utf8")).toBe(before);
		expect(scheduleRow(world, id)).toBeUndefined();
		expect(workspaceRow(world, id)).toMatchObject({
			claudeAccountSlug: B,
			claudeScheduleFiredAt: null,
		});
		expect(scheduledStateChanges(world, id)).toHaveLength(0);
	});

	for (const halt of ["stop", "expiry"] as const) {
		test(`a ${halt} during the credential write restores the credentials without consuming`, async () => {
			let now = Date.now();
			const { world, pi } = await createScheduleWorld();
			const id = await seedPinned(world, { slug: B, installed: B });
			const { service, timer } = await startService(world, pi, {
				now: () => now,
			});
			const fireAt = now + MINUTE;
			await service.scheduleSwitch(id, { kind: "account", slug: A }, fireAt);
			now = fireAt;
			const before = await readFile(credentialsPath(service, id), "utf8");
			let haltedAfterWrite = false;
			const write = ClaudeProfileManager.prototype.writeCredentials;
			spies.push(
				spyOn(
					ClaudeProfileManager.prototype,
					"writeCredentials",
				).mockImplementationOnce(async function (
					this: ClaudeProfileManager,
					profileDir: string,
					credentials: ManagedCredentials,
				) {
					await write.call(this, profileDir, credentials);
					if (halt === "stop") service.stop();
					else now = fireAt + WINDOW;
					haltedAfterWrite = true;
				}),
			);

			await timer.fire();

			expect(haltedAfterWrite).toBe(true);
			expect(await readFile(credentialsPath(service, id), "utf8")).toBe(before);
			expect(workspaceRow(world, id)).toMatchObject({
				claudeAccountSlug: B,
				claudeScheduleFiredAt: null,
			});
			expect(scheduledStateChanges(world, id)).toHaveLength(0);
			if (halt === "stop") {
				expect(scheduleRow(world, id)?.status).toBe("pending");
				expect(timer.armed).toBeNull();
			} else {
				expect(scheduleRow(world, id)).toMatchObject({
					status: "failed",
					failure: "not-run",
					lastError: null,
				});
			}
		});
	}

	test("a slow fire does not hold back another workspace's due schedule", async () => {
		let now = Date.now();
		const { world, pi } = await createScheduleWorld();
		const slow = await seedPinned(world, { slug: B, installed: B });
		const fast = await seedPinned(world, { slug: B, installed: B });
		const { service, timer } = await startService(world, pi, {
			now: () => now,
		});
		await service.scheduleSwitch(
			slow,
			{ kind: "account", slug: A },
			now + MINUTE,
		);
		await service.scheduleSwitch(
			fast,
			{ kind: "account", slug: C },
			now + 2 * MINUTE,
		);
		now += MINUTE;
		const token = holdNextTokenFetch();

		const slowPass = timer.fire();
		expect(await token.requested).toBe(A);
		now += MINUTE;
		await timer.fire();

		expect(scheduleRow(world, fast)).toBeUndefined();
		expect(workspaceRow(world, fast).claudeAccountSlug).toBe(C);
		expect(scheduleRow(world, slow)?.status).toBe("pending");

		token.release(A);
		await slowPass;
		expect(scheduleRow(world, slow)).toBeUndefined();
		expect(workspaceRow(world, slow).claudeAccountSlug).toBe(A);
	});
});

describe("scheduled switch cancellation and cleanup", () => {
	for (const failed of [false, true]) {
		test(`a pick that changes the account deletes a ${failed ? "failed" : "pending"} row`, async () => {
			const now = Date.now();
			const { world, pi } = await createScheduleWorld();
			const id = await seedPinned(world, { slug: A, installed: A });
			seedSchedule(world, id, {
				targetSlug: C,
				fireAt: now + MINUTE,
				failed,
			});
			world.db
				.update(workspaces)
				.set({ claudeScheduleFiredAt: now - MINUTE })
				.where(eq(workspaces.id, id))
				.run();
			const { service } = await startService(world, pi, { now: () => now });

			await service.setWorkspaceAccount(id, B);

			expect(scheduleRow(world, id)).toBeUndefined();
			expect(workspaceRow(world, id)).toMatchObject({
				claudeAccountSlug: B,
				claudeScheduleFiredAt: null,
			});
			expect(controlsChanges(world, id)).toHaveLength(1);
		});
	}

	test("a re-pick of the same account and an activation pin keep the row", async () => {
		const now = Date.now();
		const { world, pi } = await createScheduleWorld({ defaultSlug: B });
		const repicked = await seedPinned(world, { slug: A, installed: A });
		const activated = await seedPinned(world, { slug: A, installed: A });
		const repickedSchedule = seedSchedule(world, repicked, {
			targetSlug: C,
			fireAt: now + MINUTE,
		});
		const activatedSchedule = seedSchedule(world, activated, {
			targetSlug: C,
			fireAt: now + MINUTE,
		});
		const { service } = await startService(world, pi, { now: () => now });

		await service.setWorkspaceAccount(repicked, A);
		await service.pinWorkspaceToMachineDefault(activated);

		expect(scheduleRow(world, repicked)?.scheduleId).toBe(repickedSchedule);
		expect(workspaceRow(world, activated).claudeAccountSlug).toBe(B);
		expect(scheduleRow(world, activated)?.scheduleId).toBe(activatedSchedule);
	});

	test("retirement deletes the row even when credential removal throws", async () => {
		const now = Date.now();
		const { world, pi } = await createScheduleWorld();
		const scheduled = await seedPinned(world, { slug: A, installed: A });
		const unscheduled = await seedPinned(world, { slug: A, installed: A });
		seedSchedule(world, scheduled, { targetSlug: C, fireAt: now + MINUTE });
		const { service } = await startService(world, pi, { now: () => now });
		spies.push(
			spyOn(
				ClaudeProfileManager.prototype,
				"removeCredentials",
			).mockRejectedValueOnce(new Error("remove failed")),
		);

		await expect(service.retireWorkspaceRuntime(scheduled)).rejects.toThrow(
			"remove failed",
		);
		await service.retireWorkspaceRuntime(unscheduled);

		expect(scheduleRow(world, scheduled)).toBeUndefined();
		expect(controlsChanges(world, scheduled)).toHaveLength(1);
		expect(controlsChanges(world, unscheduled)).toHaveLength(0);
	});

	test("a successful deletion deletes the row", async () => {
		const now = Date.now();
		const { world, pi } = await createScheduleWorld();
		const id = await seedPinned(world, { slug: A, installed: A });
		seedSchedule(world, id, { targetSlug: C, fireAt: now + MINUTE });
		const { service } = await startService(world, pi, { now: () => now });

		await service.withWorkspaceDeletion(
			[{ workspaceId: id, terminalIds: [] }],
			async () => {
				world.db
					.update(workspaces)
					.set({ archivedAt: now })
					.where(eq(workspaces.id, id))
					.run();
			},
			{ disposalMode: "warn-and-continue" },
		);

		expect(scheduleRow(world, id)).toBeUndefined();
	});

	test("a degraded-mode deletion deletes the row", async () => {
		const now = Date.now();
		const world = await createClaudeTestWorld("claude-schedule-degraded-");
		worlds.push(world);
		const unusableParent = join(world.root, "unusable-storage");
		await mkdir(unusableParent, { recursive: true });
		await writeFile(
			join(unusableParent, "claude-profiles"),
			"blocking file",
			"utf8",
		);
		const id = await seedPinned(world, { slug: null });
		seedSchedule(world, id, { targetSlug: C, fireAt: now + MINUTE });
		const service = createClaudeAccountsService({
			db: world.db,
			dbPath: join(unusableParent, "host.db"),
			emit: (event) => world.events.push(event),
			log: world.log,
			awaitInitialBackgroundWork: true,
			pushKeyPath: join(world.root, "missing-key"),
			now: () => now,
			scheduleTimer: createFakeTimer().timer,
		});
		services.push(service);
		await service.start();

		await service.withWorkspaceDeletion(
			[{ workspaceId: id, terminalIds: [] }],
			async () => {
				world.db
					.update(workspaces)
					.set({ archivedAt: now })
					.where(eq(workspaces.id, id))
					.run();
			},
			{ disposalMode: "warn-and-continue" },
		);

		expect(scheduleRow(world, id)).toBeUndefined();
	});

	test("a failed deletion keeps the row, which fires after un-archive", async () => {
		let now = Date.now();
		const { world, pi } = await createScheduleWorld();
		const id = await seedPinned(world, { slug: B, installed: B });
		const { service, timer } = await startService(world, pi, {
			now: () => now,
		});
		await service.scheduleSwitch(
			id,
			{ kind: "account", slug: A },
			now + MINUTE,
		);

		await expect(
			service.withWorkspaceDeletion(
				[{ workspaceId: id, terminalIds: [] }],
				async () => {
					world.db
						.update(workspaces)
						.set({ archivedAt: now })
						.where(eq(workspaces.id, id))
						.run();
					throw new Error("destroy failed");
				},
				{ disposalMode: "warn-and-continue" },
			),
		).rejects.toThrow("destroy failed");
		now += MINUTE;
		await timer.fire();
		expect(scheduleRow(world, id)?.status).toBe("pending");
		expect(workspaceRow(world, id).claudeAccountSlug).toBe(B);

		world.db
			.update(workspaces)
			.set({ archivedAt: null })
			.where(eq(workspaces.id, id))
			.run();
		await timer.fire();
		expect(scheduleRow(world, id)).toBeUndefined();
		expect(workspaceRow(world, id).claudeAccountSlug).toBe(A);
	});

	test("a throwing schedule delete leaves the deletion successful", async () => {
		const now = Date.now();
		const { world, pi } = await createScheduleWorld();
		const id = await seedPinned(world, { slug: A, installed: A });
		seedSchedule(world, id, { targetSlug: C, fireAt: now + MINUTE });
		const { service } = await startService(world, pi, { now: () => now });
		world.db.run(
			sql.raw(`
				CREATE TRIGGER refuse_schedule_delete
				BEFORE DELETE ON claude_account_schedules
				BEGIN
					SELECT RAISE(ABORT, 'schedule delete refused');
				END
			`),
		);

		await expect(
			service.withWorkspaceDeletion(
				[{ workspaceId: id, terminalIds: [] }],
				async () => {
					world.db
						.update(workspaces)
						.set({ archivedAt: now })
						.where(eq(workspaces.id, id))
						.run();
					return "destroyed";
				},
				{ disposalMode: "warn-and-continue" },
			),
		).resolves.toBe("destroyed");

		expect(workspaceRow(world, id).archivedAt).toBe(now);
		expect(scheduleRow(world, id)?.status).toBe("pending");
		expect(
			world.log.warnEntries.some((entry) =>
				entry.message.includes("expiry retires it"),
			),
		).toBe(true);
	});

	test("a stranded archived row never fires and expires as not-run", async () => {
		let now = Date.now();
		const { world, pi } = await createScheduleWorld();
		const id = await seedPinned(world, {
			slug: B,
			installed: B,
			archivedAt: now - MINUTE,
		});
		const fireAt = now - 1_000;
		seedSchedule(world, id, { targetSlug: A, fireAt });
		const { timer } = await startService(world, pi, { now: () => now });

		await timer.fire();
		expect(scheduleRow(world, id)?.status).toBe("pending");
		expect(workspaceRow(world, id).claudeAccountSlug).toBe(B);
		expect(timer.armed?.delayMs).toBe(15_000);

		now = fireAt + WINDOW;
		await timer.fire();
		expect(scheduleRow(world, id)).toMatchObject({
			status: "failed",
			failure: "not-run",
		});
		expect(workspaceRow(world, id).claudeAccountSlug).toBe(B);
		expect(timer.armed).toBeNull();
	});
});

describe("scheduleSwitch refusals", () => {
	for (const scenario of [
		{
			name: "Default (tray) while Following",
			slug: null,
			target: { kind: "default" as const },
			error: "already follows the tray default",
		},
		{
			name: "a disabled account",
			slug: B,
			target: { kind: "account" as const, slug: A },
			error: `Claude account '${A}' is disabled`,
		},
	]) {
		test(`refuses ${scenario.name}`, async () => {
			const now = Date.now();
			const { world, pi } = await createScheduleWorld();
			const id = await seedPinned(world, { slug: scenario.slug });
			const { service } = await startService(world, pi, { now: () => now });
			pi.setAccounts([
				wireAccount(A, { enabled: false }),
				wireAccount(B),
				wireAccount(C),
			]);

			await expect(
				service.scheduleSwitch(id, scenario.target, now + MINUTE),
			).rejects.toThrow(scenario.error);
			expect(scheduleRow(world, id)).toBeUndefined();
		});
	}
});

describe("setAutoSwitch", () => {
	test("is refused while Following", async () => {
		const now = Date.now();
		const { world, pi } = await createScheduleWorld();
		const id = await seedPinned(world, { slug: null });
		const { service } = await startService(world, pi, { now: () => now });
		const before = workspaceRow(world, id).claudeAutoSwitch;

		await expect(service.setAutoSwitch(id, !before)).rejects.toThrow(
			"Auto-switch applies only to a pinned account",
		);
		expect(workspaceRow(world, id).claudeAutoSwitch).toBe(before);
	});
});

describe("scheduled switch and the token failure clock", () => {
	for (const fired of [true, false]) {
		test(`a pick ${fired ? "after a fire is accepted in grace" : "without a fire throws"} once the token clock is stale`, async () => {
			let now = Date.now();
			const { world, pi } = await createScheduleWorld();
			await seedPinned(world, {
				slug: A,
				installed: managedCredentials(A, {
					expiresAt: Date.now() + 40 * MINUTE,
				}),
			});
			const target = await seedPinned(world, { slug: B, installed: B });
			const picked = await seedPinned(world, { slug: B, installed: B });
			pi.setTokenAvailable(false);
			const { service, timer } = await startService(world, pi, {
				now: () => now,
			});
			expect(
				world.log.warnEntries.some((entry) =>
					entry.message.includes("Claude token renewal failed"),
				),
			).toBe(true);

			now += PI_FAILURE_GRACE_MS;
			pi.setTokenAvailable(true);
			if (fired) {
				await service.scheduleSwitch(
					target,
					{ kind: "account", slug: A },
					now + 1_000,
				);
				now += 1_000;
				await timer.fire();
				expect(workspaceRow(world, target).claudeAccountSlug).toBe(A);
			}
			pi.setAvailable(false);

			const pick = service.setWorkspaceAccount(picked, A);
			if (fired) {
				await expect(pick).resolves.toBeUndefined();
				expect(workspaceRow(world, picked).claudeAccountSlug).toBe(A);
			} else {
				await expect(pick).rejects.toThrow();
				expect(workspaceRow(world, picked).claudeAccountSlug).toBe(B);
			}
		});
	}
});
