/**
 * (CLOUD-SEVERANCE-P2) The auth token store is READ-ONLY now.
 *
 * Upstream's suite here covered saving, clearing, membership compare-and-swap,
 * the OAuth callback and deep-link parsing — all of which are deleted, because
 * with no cloud the store's only remaining influence is over which identity the
 * host-service runs under, and nothing should be able to change that at
 * runtime. What is left to test is the reading path that survives: a
 * pre-severance install still has this file, and main reads its organization
 * ids to break a tie when the machine holds more than one host database.
 */

import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalSupersetHomeDir = process.env.SUPERSET_HOME_DIR;
const testSupersetHomeDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "auth-functions-test-"),
);
process.env.SUPERSET_HOME_DIR = testSupersetHomeDir;
const tokenFile = path.join(testSupersetHomeDir, "auth-token.enc");

// Keep this unit test independent from suite-global host-info mocks. The
// behaviour under test only needs a reversible storage boundary.
mock.module("./crypto-storage", () => ({
	encrypt: (plaintext: string) => Buffer.from(plaintext),
	decrypt: (data: Buffer) => data.toString("utf8"),
}));

const { loadToken } = await import("./auth-functions");

/** Quarantining logs a warning by design; keep test output readable. */
async function quietly<Result>(run: () => Promise<Result>): Promise<Result> {
	const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
	try {
		return await run();
	} finally {
		warnSpy.mockRestore();
	}
}

function writeStoredAuth(contents: unknown): void {
	fs.writeFileSync(tokenFile, Buffer.from(JSON.stringify(contents)), {
		mode: 0o600,
	});
}

function quarantinedTokenPaths(): string[] {
	const prefix = `${path.basename(tokenFile)}.corrupt-`;
	return fs
		.readdirSync(testSupersetHomeDir)
		.filter((name) => name.startsWith(prefix))
		.map((name) => path.join(testSupersetHomeDir, name));
}

beforeEach(() => {
	process.env.SUPERSET_HOME_DIR = testSupersetHomeDir;
	for (const entry of fs.readdirSync(testSupersetHomeDir)) {
		fs.rmSync(path.join(testSupersetHomeDir, entry), {
			recursive: true,
			force: true,
		});
	}
});

afterAll(() => {
	fs.rmSync(testSupersetHomeDir, { recursive: true, force: true });
	if (originalSupersetHomeDir === undefined) {
		delete process.env.SUPERSET_HOME_DIR;
	} else {
		process.env.SUPERSET_HOME_DIR = originalSupersetHomeDir;
	}
});

describe("auth token storage (read-only)", () => {
	test("reads a pre-severance token, including its organization ids", async () => {
		writeStoredAuth({
			token: "token",
			expiresAt: "2099-01-01",
			organizationIds: ["30e16b5a-e2af-4874-b126-acc7b3f17aa9"],
			organizationIdsRevision: 3,
		});

		expect(await loadToken()).toEqual({
			token: "token",
			expiresAt: "2099-01-01",
			organizationIds: ["30e16b5a-e2af-4874-b126-acc7b3f17aa9"],
			organizationIdsRevision: 3,
		});
	});

	test("reports a missing token without logging a failure", async () => {
		// loadToken swallows everything it throws, so an internal crash would
		// otherwise be indistinguishable from "no token stored".
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});

		try {
			expect(await loadToken()).toEqual({
				token: null,
				expiresAt: null,
				organizationIds: null,
				organizationIdsRevision: 0,
			});
			expect(errorSpy).not.toHaveBeenCalled();
		} finally {
			errorSpy.mockRestore();
		}
	});

	test("quarantines unusable storage instead of reading through it", async () => {
		fs.writeFileSync(tokenFile, Buffer.from("not json at all"));

		expect(await quietly(() => loadToken())).toEqual({
			token: null,
			expiresAt: null,
			organizationIds: null,
			organizationIdsRevision: 0,
		});
		expect(quarantinedTokenPaths()).toHaveLength(1);
		expect(fs.existsSync(tokenFile)).toBe(false);
	});

	test("never writes: a read leaves the stored bytes untouched", async () => {
		// The whole point of the severance is that this file cannot change
		// underneath the host-service. A read must not rewrite it.
		writeStoredAuth({ token: "token", expiresAt: "2099-01-01" });
		const before = fs.readFileSync(tokenFile);

		await loadToken();

		expect(fs.readFileSync(tokenFile)).toEqual(before);
		expect(
			fs.readdirSync(testSupersetHomeDir).some((name) => name.endsWith(".tmp")),
		).toBe(false);
	});
});
