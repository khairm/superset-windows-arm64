import { expect, test } from "bun:test";

// (NAV-LOCAL-RENDER) Process-isolated: other suites mock the router wholesale.
test("active-route selects match router.matchRoute, settled and pending", () => {
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			"test",
			`${import.meta.dir}/fixtures/route-parity.tsx`,
		],
		env: { ...process.env, NODE_ENV: "test" },
	});
	expect(
		result.exitCode,
		result.stdout.toString() + result.stderr.toString(),
	).toBe(0);
});
