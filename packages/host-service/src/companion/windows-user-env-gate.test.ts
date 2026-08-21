/**
 * (WIN-USER-ENV) The gate half of the Windows user-environment merge.
 *
 * `packages/shared/src/windows-user-env.test.ts` proves the read, parse and
 * merge. This proves the thing that actually broke: the merged env reaches
 * `isCompanionBridgeEnabled()`, so a process whose parent handed it an env
 * block WITHOUT `SUPERSET_COMPANION_BRIDGE` still starts the bridge when
 * `HKCU\Environment` has it set.
 *
 * The incident: an installer-driven relaunch dropped the variable, the registry
 * held "1" the whole time, the gate answered false, and the phone reported
 * "Superset isn't running" with nothing in the log but a shell-env warning.
 */

import { describe, expect, it } from "bun:test";
import { applyWindowsUserEnvToProcess } from "@superset/shared/windows-user-env";
import { isCompanionBridgeEnabled } from "./config";

const USER_ENV_WITH_BRIDGE = JSON.stringify({
	s: {
		SUPERSET_COMPANION_BRIDGE: "1",
		JAVA_HOME: "C:\\Users\\khair\\dev-tools\\jdk-21",
	},
	e: {},
});

const USER_ENV_WITHOUT_BRIDGE = JSON.stringify({
	s: { JAVA_HOME: "C:\\Users\\khair\\dev-tools\\jdk-21" },
	e: {},
});

/**
 * The registry permits a value named with a leading space, and it is a
 * DIFFERENT variable — Windows never puts it in an env block under the trimmed
 * name. If the reader trimmed names, this alone would open an
 * internet-reachable listener.
 */
const USER_ENV_LEADING_SPACE_ONLY = JSON.stringify({
	s: { " SUPERSET_COMPANION_BRIDGE": "1" },
	e: {},
});

/** The module logs the names it merged; these tests assert on env, not logs. */
async function silently(run: () => Promise<void>): Promise<void> {
	const log = console.log;
	console.log = () => {};
	try {
		await run();
	} finally {
		console.log = log;
	}
}

async function applyTo(
	env: NodeJS.ProcessEnv,
	readerOutput: string,
): Promise<void> {
	await silently(async () => {
		await applyWindowsUserEnvToProcess({
			targetEnv: env,
			platform: "win32",
			read: async () => readerOutput,
		});
	});
}

describe("(WIN-USER-ENV) companion gate", () => {
	it("opens the gate when the parent env lacked the flag but the registry has it", async () => {
		// Exactly what the installer relaunch handed the host-service.
		const env: NodeJS.ProcessEnv = {
			PATH: "C:\\Windows",
			SystemRoot: "C:\\Windows",
			ORGANIZATION_ID: "00000000-0000-0000-0000-000000000000",
		};

		expect(isCompanionBridgeEnabled(env)).toBe(false);

		await applyTo(env, USER_ENV_WITH_BRIDGE);

		expect(isCompanionBridgeEnabled(env)).toBe(true);
	});

	it("keeps the gate shut when neither the parent env nor the registry sets it", async () => {
		const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };

		await applyTo(env, USER_ENV_WITHOUT_BRIDGE);

		expect(isCompanionBridgeEnabled(env)).toBe(false);
	});

	it("does not let the registry re-enable a flag the launcher turned off", async () => {
		// process.env wins: an operator who launched with the bridge explicitly
		// off must not have a stale registry value switch it back on.
		const env: NodeJS.ProcessEnv = { SUPERSET_COMPANION_BRIDGE: "0" };

		await applyTo(env, USER_ENV_WITH_BRIDGE);

		expect(env.SUPERSET_COMPANION_BRIDGE).toBe("0");
		expect(isCompanionBridgeEnabled(env)).toBe(false);
	});

	it("does not let a leading-space registry name open the gate", async () => {
		const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };

		await applyTo(env, USER_ENV_LEADING_SPACE_ONLY);

		expect(env[" SUPERSET_COMPANION_BRIDGE"]).toBe("1");
		expect(isCompanionBridgeEnabled(env)).toBe(false);
	});

	it("leaves the gate untouched off win32", async () => {
		const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

		await applyWindowsUserEnvToProcess({
			targetEnv: env,
			platform: "darwin",
			read: async () => USER_ENV_WITH_BRIDGE,
		});

		expect(isCompanionBridgeEnabled(env)).toBe(false);
	});
});
