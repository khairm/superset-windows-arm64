import { expect, test } from "bun:test";

// (NAV-LOCAL-RENDER) Process-isolated: other suites mock React hooks wholesale.
test("selection context keeps identity across navigations", () => {
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			"test",
			`${import.meta.dir}/fixtures/selection-identity.tsx`,
		],
		env: { ...process.env, NODE_ENV: "test" },
	});
	expect(
		result.exitCode,
		result.stdout.toString() + result.stderr.toString(),
	).toBe(0);
});
