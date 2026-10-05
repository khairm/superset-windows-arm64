import { expect, test } from "bun:test";

// (NAV-LOCAL-RENDER) Process-isolated: other suites mock auth-client wholesale.
test("severed auth results and the collections context keep identity", () => {
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			"test",
			`${import.meta.dir}/fixtures/auth-client-cache.tsx`,
		],
		env: { ...process.env, NODE_ENV: "test" },
	});
	expect(
		result.exitCode,
		result.stdout.toString() + result.stderr.toString(),
	).toBe(0);
});
