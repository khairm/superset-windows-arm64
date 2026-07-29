/**
 * (KEEP-AWAKE) The gate decides whether a fork user's machine may be pinned out
 * of sleep at all, so every branch of it is covered here — most importantly the
 * two that must NOT read as "open": bridge disabled, and a device index that
 * could not be read.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPANION_ENABLE_ENV, pollCompanionGate } from "./companion-gate";

const ENABLED: NodeJS.ProcessEnv = { [COMPANION_ENABLE_ENV]: "1" };
const DISABLED: NodeJS.ProcessEnv = {};

function record(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		deviceId: "AAAAAAAAAAAAAAAAAAAAAA",
		label: "Pixel",
		surface: "phone",
		pairedAtMs: 1,
		lastSeenMs: null,
		keyRef: "k",
		fcmToken: null,
		fcmTokenUpdatedMs: null,
		writeEnabled: true,
		revokedAtMs: null,
		revokeReason: null,
		...overrides,
	};
}

let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "keep-awake-gate-"));
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeIndex(name: string, body: string): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, body, "utf8");
	return path;
}

describe("pollCompanionGate", () => {
	it("is closed, and reads no disk, when the bridge is disabled", async () => {
		const gate = await pollCompanionGate(
			DISABLED,
			join(dir, "never-read.json"),
		);
		expect(gate).toEqual({
			ok: true,
			open: false,
			bridgeEnabled: false,
			pairedDeviceCount: 0,
		});
	});

	it('treats an env value other than exactly "1" as disabled', async () => {
		const gate = await pollCompanionGate(
			{ [COMPANION_ENABLE_ENV]: "true" },
			join(dir, "never-read.json"),
		);
		expect(gate).toEqual({
			ok: true,
			open: false,
			bridgeEnabled: false,
			pairedDeviceCount: 0,
		});
	});

	it("is closed when the device index does not exist", async () => {
		const gate = await pollCompanionGate(ENABLED, join(dir, "absent.json"));
		expect(gate).toEqual({
			ok: true,
			open: false,
			bridgeEnabled: true,
			pairedDeviceCount: 0,
		});
	});

	it("is closed when every device is revoked", async () => {
		const path = await writeIndex(
			"revoked.json",
			JSON.stringify([
				record({ revokedAtMs: 123, revokeReason: "panic" }),
				record({
					deviceId: "BBBBBBBBBBBBBBBBBBBBBB",
					revokedAtMs: 456,
					revokeReason: "user",
				}),
			]),
		);
		const gate = await pollCompanionGate(ENABLED, path);
		expect(gate).toEqual({
			ok: true,
			open: false,
			bridgeEnabled: true,
			pairedDeviceCount: 0,
		});
	});

	it("is open when at least one device is live", async () => {
		const path = await writeIndex(
			"mixed.json",
			JSON.stringify([
				record({ revokedAtMs: 123, revokeReason: "user" }),
				record({ deviceId: "BBBBBBBBBBBBBBBBBBBBBB" }),
			]),
		);
		const gate = await pollCompanionGate(ENABLED, path);
		expect(gate).toEqual({
			ok: true,
			open: true,
			bridgeEnabled: true,
			pairedDeviceCount: 1,
		});
	});

	it("fails rather than reporting a closed gate on unparsable JSON", async () => {
		const path = await writeIndex("broken.json", "{not json");
		const gate = await pollCompanionGate(ENABLED, path);
		expect(gate.ok).toBe(false);
	});

	it("fails rather than reporting a closed gate on a non-array document", async () => {
		const path = await writeIndex(
			"object.json",
			JSON.stringify({ devices: [] }),
		);
		const gate = await pollCompanionGate(ENABLED, path);
		expect(gate.ok).toBe(false);
	});

	it("fails rather than silently skipping a record with a bad revokedAtMs", async () => {
		const path = await writeIndex(
			"bad-revoked.json",
			JSON.stringify([record({ revokedAtMs: "yesterday" })]),
		);
		const gate = await pollCompanionGate(ENABLED, path);
		expect(gate.ok).toBe(false);
	});

	it("counts an empty index as zero pairings, not as a failure", async () => {
		const path = await writeIndex("empty.json", "[]");
		const gate = await pollCompanionGate(ENABLED, path);
		expect(gate).toEqual({
			ok: true,
			open: false,
			bridgeEnabled: true,
			pairedDeviceCount: 0,
		});
	});
});
