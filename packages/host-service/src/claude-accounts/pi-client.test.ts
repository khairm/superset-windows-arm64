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
