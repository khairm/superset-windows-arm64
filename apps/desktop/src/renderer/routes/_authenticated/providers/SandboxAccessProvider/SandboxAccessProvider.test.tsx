import { expect, test } from "bun:test";

// (NAV-LOCAL-RENDER) Process-isolated: other suites mock cloud-trpc and the router.
test("sandbox access value keeps identity with the cloud flag off", () => {
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			"test",
			`${import.meta.dir}/fixtures/stable-value.tsx`,
		],
		env: { ...process.env, NODE_ENV: "test" },
	});
	expect(
		result.exitCode,
		result.stdout.toString() + result.stderr.toString(),
	).toBe(0);
});
