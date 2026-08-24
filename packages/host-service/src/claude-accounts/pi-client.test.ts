import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountSlugSchema, PiClient, PiRequestError } from "./pi-client";
import type { ClaudeAccountsLogger } from "./types";

const log: ClaudeAccountsLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

const scratchPaths: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const path of scratchPaths.splice(0)) {
		await rm(path, { recursive: true, force: true });
	}
});

describe("accountSlugSchema", () => {
	test("rejects surrounding whitespace", () => {
		expect(accountSlugSchema.safeParse(" account").success).toBe(false);
		expect(accountSlugSchema.safeParse("account ").success).toBe(false);
		expect(accountSlugSchema.safeParse("account").success).toBe(true);
	});
});

function accountWire(overrides: Record<string, unknown> = {}) {
	return {
		slug: "claude12",
		name: "Claude 12",
		type: "claude",
		enabled: true,
		dead: false,
		dead_reason: null,
		last_success: new Date().toISOString(),
		consecutive_failures: 0,
		five_pct: 25,
		seven_pct: 30,
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

describe("PiClient configuration", () => {
	test("rejects a relative push-key path", () => {
		expect(
			() => new PiClient(log, { pushKeyPath: "relative/push-key.txt" }),
		).toThrow("must be absolute");
	});

	test("reloads a cached key after authentication failure", async () => {
		const scratch = join(tmpdir(), `claude-pi-client-${randomUUID()}`);
		scratchPaths.push(scratch);
		await mkdir(scratch);
		const keyPath = join(scratch, "push-key.txt");
		await writeFile(keyPath, "﻿first\n", "utf8");
		const original = await stat(keyPath);
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			fetch: async (request) => {
				requests += 1;
				const authorization = request.headers.get("authorization");
				if (requests === 1) {
					expect(authorization).toBe("Bearer first");
					await writeFile(keyPath, "﻿other\n", "utf8");
					await utimes(keyPath, original.atime, original.mtime);
					return new Response(null, { status: 401 });
				}
				expect(authorization).toBe("Bearer other");
				return Response.json([]);
			},
		});
		servers.push(server);
		const client = new PiClient(log, {
			baseUrl: `http://127.0.0.1:${server.port}`,
			pushKeyPath: keyPath,
		});

		await expect(client.fetchAccounts()).rejects.toBeInstanceOf(PiRequestError);
		await expect(client.fetchAccounts()).resolves.toEqual([]);
		expect(requests).toBe(2);
	});
});

describe("PiClient response compatibility", () => {
	test("accepts added account fields and filters unsupported account types", async () => {
		const scratch = join(tmpdir(), `claude-pi-client-${randomUUID()}`);
		scratchPaths.push(scratch);
		await mkdir(scratch);
		const keyPath = join(scratch, "push-key.txt");
		await writeFile(keyPath, "secret\n", "utf8");
		const server = Bun.serve({
			port: 0,
			fetch: () =>
				Response.json([
					accountWire({ added_by_new_pi: { nested: true } }),
					accountWire({ slug: "future1", name: "Future", type: "future" }),
				]),
		});
		servers.push(server);
		const client = new PiClient(log, {
			baseUrl: `http://127.0.0.1:${server.port}`,
			pushKeyPath: keyPath,
		});

		const accounts = await client.fetchAccounts();

		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.slug).toBe("claude12");
		expect(client.getAccountsLastGood()).toEqual(accounts);
	});

	for (const scenario of [
		{
			name: "top-level token field",
			body: {
				account: "claude12",
				claude_ai_oauth: {
					accessToken: "token",
					expiresAt: Date.now() + 2 * 60 * 60 * 1000,
				},
				unexpected: true,
			},
		},
		{
			name: "nested oauth field",
			body: {
				account: "claude12",
				claude_ai_oauth: {
					accessToken: "token",
					expiresAt: Date.now() + 2 * 60 * 60 * 1000,
					unexpected: true,
				},
			},
		},
	]) {
		test(`keeps token envelopes strict for an added ${scenario.name}`, async () => {
			const scratch = join(tmpdir(), `claude-pi-client-${randomUUID()}`);
			scratchPaths.push(scratch);
			await mkdir(scratch);
			const keyPath = join(scratch, "push-key.txt");
			await writeFile(keyPath, "secret\n", "utf8");
			const server = Bun.serve({
				port: 0,
				fetch: () => Response.json(scenario.body),
			});
			servers.push(server);
			const client = new PiClient(log, {
				baseUrl: `http://127.0.0.1:${server.port}`,
				pushKeyPath: keyPath,
			});

			await expect(client.fetchToken("claude12")).rejects.toBeInstanceOf(
				PiRequestError,
			);
		});
	}
});
