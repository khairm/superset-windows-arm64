import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claudeAccountWire,
	createPiFakeServer,
} from "../../test/helpers/claude-accounts-fixture";
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
		let original: Awaited<ReturnType<typeof stat>>;
		let requests = 0;
		const pi = await createPiFakeServer(
			scratch,
			async (request) => {
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
			{ pushKeyContents: "﻿first\n" },
		);
		original = await stat(keyPath);
		servers.push(pi.server);
		const client = new PiClient(log, {
			baseUrl: pi.baseUrl,
			pushKeyPath: pi.pushKeyPath,
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
		const pi = await createPiFakeServer(scratch, () =>
			Response.json([
				claudeAccountWire("claude12", {
					added_by_new_pi: { nested: true },
				}),
				claudeAccountWire("future1", {
					name: "Future",
					type: "future",
				}),
			]),
		);
		servers.push(pi.server);
		const client = new PiClient(log, {
			baseUrl: pi.baseUrl,
			pushKeyPath: pi.pushKeyPath,
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
			const pi = await createPiFakeServer(scratch, () =>
				Response.json(scenario.body),
			);
			servers.push(pi.server);
			const client = new PiClient(log, {
				baseUrl: pi.baseUrl,
				pushKeyPath: pi.pushKeyPath,
			});

			await expect(client.fetchToken("claude12")).rejects.toBeInstanceOf(
				PiRequestError,
			);
		});
	}
});
